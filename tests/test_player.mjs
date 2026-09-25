import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProgressSaver, resumeAt, setupMediaSession } from '../web/js/player.js';

function fixture(t, { ios = false, standalone = false, metadata = true,
  supported = true, limited = false } = {}) {
  const handlers = new Map(), positions = [], steps = [];
  const ms = {
    playbackState: 'none',
    setActionHandler(action, fn) {
      if (limited && action === 'seekto') throw new Error('Unsupported');
      handlers.set(action, fn);
    },
    setPositionState(state) {
      if (limited) throw new Error('Unsupported');
      positions.push(state);
    },
  };
  const audio = Object.assign(new EventTarget(), {
    src: 'blob:test-audio', paused: true, duration: 120, currentTime: 27,
    playbackRate: 1, ended: false,
    play() {
      this.paused = false;
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    },
    load() { throw new Error('Playback must not reload the audio'); },
  });
  const engine = {
    track: {}, step: (direction) => steps.push(direction),
    seek(time) {
      audio.currentTime = Math.max(0, Math.min(time, audio.duration));
      audio.dispatchEvent(new Event('seeked'));
    },
  };
  const doc = Object.assign(new EventTarget(), { hidden: true, getElementById: () => null });
  const win = new EventTarget();
  const diagnostics = { storageReads: 0, sessionReads: 0 };
  Object.defineProperty(win, 'sessionStorage', { get() { diagnostics.storageReads++; return {}; } });
  if (metadata) win.MediaMetadata = class { constructor(data) { Object.assign(this, data); } };
  for (const [key, value] of Object.entries({
    navigator: { mediaSession: supported ? ms : undefined, standalone,
      platform: ios ? 'iPhone' : 'Win32', userAgent: ios ? 'iPhone' : 'Desktop',
      get audioSession() { diagnostics.sessionReads++; return {}; } },
    document: doc, window: win,
    requestAnimationFrame: () => { throw new Error('System controls must not depend on rAF'); },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const media = setupMediaSession({ audio, engine });
  media.setTrack({ title: 'Test audio' });
  return { audio, ms, handlers, positions, steps, engine, media, doc, win, diagnostics };
}

for (const [name, options] of [
  ['desktop', {}], ['iOS Safari', { ios: true }], ['WebClip', { ios: true, standalone: true }],
]) {
  test(`${name} system controls retain position and speed across repeated pause and play`, async (t) => {
    const { audio, ms, handlers, positions } = fixture(t, options);
    audio.playbackRate = 1.5;
    for (let i = 0; i < 5; i++) {
      const at = audio.currentTime;
      const pending = handlers.get('play')();
      assert.equal(audio.paused, false, 'play must start synchronously in the user action');
      await pending;
      assert.equal(ms.playbackState, 'playing');
      assert.equal(audio.currentTime, at);
      audio.currentTime += 2;
      handlers.get('pause')();
      assert.equal(audio.paused, true);
      assert.equal(ms.playbackState, 'paused');
      assert.equal(positions.at(-1).position, at + 2);
      assert.equal(audio.playbackRate, 1.5);
      assert.equal(audio.src, 'blob:test-audio');
    }
    assert.equal(ms.metadata.title, 'Test audio');
  });
}

test('page controls and native media events synchronize the same session', async (t) => {
  const { audio, ms, media } = fixture(t);
  await media.play();
  assert.equal(ms.playbackState, 'playing');
  audio.pause();
  assert.equal(ms.playbackState, 'paused');
  await audio.play();
  assert.equal(ms.playbackState, 'playing');
  media.pause();
  assert.equal(audio.paused, true);
  assert.equal(ms.playbackState, 'paused');
});

test('frequent progress events are throttled but seeks and pause synchronize immediately', (t) => {
  const { audio, positions } = fixture(t);
  audio.dispatchEvent(new Event('timeupdate'));
  const count = positions.length;
  for (let i = 0; i < 100; i++) { audio.currentTime += 0.01; audio.dispatchEvent(new Event('timeupdate')); }
  assert.equal(positions.length, count);
  audio.currentTime = 80; audio.dispatchEvent(new Event('seeked'));
  assert.equal(positions.at(-1).position, 80);
  audio.pause(); assert.equal(positions.length, count + 2);
});

test('system seeking and sentence controls use the engine', (t) => {
  const { audio, handlers, steps, engine } = fixture(t, { ios: true });
  handlers.get('seekbackward')({});
  assert.equal(audio.currentTime, 22);
  handlers.get('seekforward')({ seekOffset: 10 });
  assert.equal(audio.currentTime, 32);
  handlers.get('seekto')({ seekTime: 80 });
  handlers.get('seekto')({ seekTime: NaN });
  assert.equal(audio.currentTime, 80);
  handlers.get('previoustrack')();
  handlers.get('nexttrack')();
  assert.deepEqual(steps, [-1, 1]);
  engine.track = null;
  handlers.get('nexttrack')();
  assert.deepEqual(steps, [-1, 1]);
});

test('position follows progress, speed, page restoration and source removal', async (t) => {
  const { audio, ms, positions, media, doc, win } = fixture(t);
  await media.play();
  audio.currentTime = 40;
  audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(positions.at(-1).position, 40);
  audio.playbackRate = 1.25;
  audio.dispatchEvent(new Event('ratechange'));
  assert.equal(positions.at(-1).playbackRate, 1.25);
  audio.currentTime = 63;
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(positions.at(-1).position, 63);
  audio.currentTime = 200;
  win.dispatchEvent(new Event('pageshow'));
  assert.equal(positions.at(-1).position, 120);
  audio.ended = true;
  audio.dispatchEvent(new Event('ended'));
  assert.equal(ms.playbackState, 'paused');
  audio.duration = NaN;
  audio.src = '';
  audio.dispatchEvent(new Event('emptied'));
  assert.equal(positions.at(-1), undefined);
  assert.equal(ms.playbackState, 'none');
});

test('missing MediaMetadata does not disable system actions', async (t) => {
  const { audio, handlers } = fixture(t, { metadata: false });
  await handlers.get('play')();
  assert.equal(audio.paused, false);
  handlers.get('pause')();
  assert.equal(audio.paused, true);
});

test('unsupported actions and position API do not disable supported controls', async (t) => {
  const { audio, handlers } = fixture(t, { limited: true });
  assert.equal(handlers.has('seekto'), false);
  await handlers.get('play')();
  assert.equal(audio.paused, false);
  handlers.get('pause')();
  assert.equal(audio.paused, true);
});

test('page playback works without MediaSession', async (t) => {
  const { audio, media } = fixture(t, { supported: false });
  await media.play();
  assert.equal(audio.paused, false);
  media.pause();
  assert.equal(audio.paused, true);
});

for (const synchronous of [false, true]) {
  test(`${synchronous ? 'thrown' : 'rejected'} play errors are handled and allow another attempt`, async (t) => {
    const { audio, ms, media } = fixture(t);
    const original = audio.play;
    audio.play = () => {
      const error = new DOMException('Unsupported format', 'NotSupportedError');
      if (synchronous) throw error;
      return Promise.reject(error);
    };
    await media.play();
    assert.equal(audio.paused, true);
    assert.equal(ms.playbackState, 'paused');
    audio.play = original;
    await media.play();
    assert.equal(audio.paused, false);
  });
}

for (const changeSource of [false, true]) {
  test(`a late play rejection cannot interrupt ${changeSource ? 'another source' : 'a newer play request'}`, async (t) => {
    const { audio, media } = fixture(t);
    const original = audio.play;
    let reject;
    audio.play = () => new Promise((_, fail) => { reject = fail; });
    const pending = media.play();
    media.pause();
    if (changeSource) {
      audio.src = 'blob:next-audio';
      audio.currentTime = 0;
      media.setTrack({ title: 'Next audio' });
    }
    audio.play = original;
    await media.play();
    reject(new DOMException('Old request', 'AbortError'));
    await pending;
    assert.equal(audio.paused, false);
    assert.equal(audio.currentTime, changeSource ? 0 : 27);
  });
}

test('a stalled clock and page lifecycle events never trigger recovery or diagnostic storage', async (t) => {
  const { audio, media, doc, win, diagnostics } = fixture(t, { ios: true, standalone: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const play = t.mock.method(audio, 'play');
  const pause = t.mock.method(audio, 'pause');
  await media.play();
  t.mock.timers.tick(30000);
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('pagehide'));
  win.dispatchEvent(new Event('pageshow'));
  assert.equal(play.mock.callCount(), 1);
  assert.equal(pause.mock.callCount(), 0);
  assert.equal(scheduled.mock.callCount(), 0);
  assert.equal(audio.currentTime, 27);
  assert.equal(audio.src, 'blob:test-audio');
  assert.equal(diagnostics.storageReads, 0);
  assert.equal(diagnostics.sessionReads, 0);
});


/* ---------------------------------------------------------------- 播放进度 */

test('resume position skips the head and the tail of a track', () => {
  assert.equal(resumeAt(0, 600), 0);
  assert.equal(resumeAt(3, 600), 0, '开头 3 秒内不值得续播');
  assert.equal(resumeAt(3.5, 600), 3.5);
  assert.equal(resumeAt(596.9, 600), 596.9);
  assert.equal(resumeAt(597, 600), 0, '结尾 3 秒内算听完了, 下次从头放');
  assert.equal(resumeAt(undefined, 600), 0);
  assert.equal(resumeAt(-4, 600), 0);
  assert.equal(resumeAt('12.5', 600), 12.5, '存档读回来是数字, 但字符串也认');
  assert.equal(resumeAt(50, 0), 50, '时长未知时只能按开头判断');
  assert.equal(resumeAt(50, NaN), 50);
});

/** 进度落库只用到 audio 的事件与 document/window 的生命周期事件. */
function progressFixture(t, save) {
  const audio = Object.assign(new EventTarget(), { currentTime: 0, ended: false });
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const win = new EventTarget();
  for (const [key, value] of Object.entries({ document: doc, window: win })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const writes = [];
  const saver = createProgressSaver(audio, save
    || ((id, seconds) => { writes.push([id, seconds]); }));
  saver.begin('lesson');
  return { audio, doc, win, writes, saver };
}

test('progress is written on a coarse cadence and flushed on every exit', (t) => {
  const { audio, doc, win, writes, saver } = progressFixture(t);
  audio.currentTime = 12;
  audio.dispatchEvent(new Event('timeupdate'));
  assert.deepEqual(writes, [['lesson', 12]]);

  audio.currentTime = 12.2;                    // 半秒以内的抖动不写
  audio.dispatchEvent(new Event('timeupdate'));
  audio.currentTime = 40;                      // 5 秒节流窗口内也不写
  audio.dispatchEvent(new Event('timeupdate'));
  assert.deepEqual(writes, [['lesson', 12]]);

  audio.dispatchEvent(new Event('pause'));     // 暂停立刻补一次
  assert.deepEqual(writes.at(-1), ['lesson', 40]);

  audio.currentTime = 63;
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(writes.at(-1), ['lesson', 63]);

  audio.currentTime = 88;
  win.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(writes.at(-1), ['lesson', 88]);

  audio.ended = true;
  audio.dispatchEvent(new Event('ended'));     // 听完 = 下次从头放
  assert.deepEqual(writes.at(-1), ['lesson', 0]);

  saver.begin('');                             // 还没挂上音频就不写
  audio.currentTime = 5;
  audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(writes.length, 5);
});

test('a failing progress write never disturbs playback', (t) => {
  const { audio } = progressFixture(t, () => { throw new Error('quota'); });
  assert.doesNotThrow(() => audio.dispatchEvent(new Event('timeupdate')));
  assert.doesNotThrow(() => audio.dispatchEvent(new Event('pause')));
});
