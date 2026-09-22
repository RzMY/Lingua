import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({ stdin: { contents: `
  export { NativeAudio } from './web/js/native-audio.js';
  export { NativeVideo } from './web/js/native-video.js';
  export { setupMediaSession } from './web/js/player.js';
  export { setupNativeCaptionPip } from './web/js/native-caption-pip.js';
  export { Engine } from './web/js/engine.js';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'NativeAudioTest' });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, overrides = {}, { video: withVideo = false } = {}) {
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://localhost/player.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [], chunks = [];
  w.Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new w.FileReader();
      reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
  let state = {}, now = 1000, serial = 0;
  Object.defineProperty(w.performance, 'now', { value: () => now });
  const snapshot = (patch = {}) => ({ ...state, ...patch, serial: ++serial });
  const bridge = {
    async begin(value) {
      calls.push(['begin', value]); serial = 0;
      state = { session: value.session, position: 0, duration: 120, rate: 1, paused: true, ended: false,
        waiting: false, seeking: false, ready: false, revision: 0 };
    },
    async append(value) { calls.push(['append', value]); chunks.push(Buffer.from(value.data, 'base64')); },
    async prepare(value) { calls.push(['prepare', value]); state.ready = true; return snapshot(); },
    async command(value) {
      calls.push(['command', value]); state.revision = value.revision;
      if (value.action === 'play') { state.paused = false; state.ended = false; }
      if (value.action === 'pause') state.paused = true;
      if (value.action === 'rate') state.rate = value.rate;
      if (value.action === 'seek') { state.position = value.position; state.seeking = false; }
      return snapshot();
    },
    async state() { calls.push(['state']); return snapshot(); },
    async release(value) { calls.push(['release', value]); },
    ...overrides,
  };
  w.eval(outputFiles[0].text);
  const video = w.document.createElement('video');
  let visualPaused = true, visualPosition = 0, visualSeeking = false, seekVersion = 0;
  const seeks = [];
  Object.defineProperties(video, { readyState: { value: 4 }, paused: { get: () => visualPaused },
    duration: { value: 120 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 },
    seeking: { get: () => visualSeeking },
    currentTime: { get: () => visualPosition, set: (value) => {
      visualPosition = value; visualSeeking = true; seeks.push(value);
      const version = ++seekVersion;
      video.dispatchEvent(new w.Event('seeking'));
      queueMicrotask(() => {
        if (version !== seekVersion) return;
        visualSeeking = false; video.dispatchEvent(new w.Event('seeked'));
      });
    } } });
  video.play = () => { if (visualPaused) { visualPaused = false; video.dispatchEvent(new w.Event('play')); } return Promise.resolve(); };
  video.pause = () => { if (!visualPaused) { visualPaused = true; video.dispatchEvent(new w.Event('pause')); } };
  video.load = () => {};
  let blobID = 0;
  w.URL.createObjectURL = () => 'blob:video-' + ++blobID;
  w.URL.revokeObjectURL = () => {};
  const audio = withVideo ? new w.NativeAudioTest.NativeVideo(bridge, video) : new w.NativeAudioTest.NativeAudio(bridge);
  t.after(async () => { await audio.release(); w.close(); });
  return { w, audio, video, bridge, calls, chunks, seeks,
    frame: (position) => { visualPosition = position; },
    advance: (ms) => { now += ms; },
    state: () => state,
    emit(patch) {
      state = { ...state, ...patch };
      w.dispatchEvent(new w.CustomEvent('native-audio-state', { detail: snapshot() }));
    },
    async attach(bytes = new Uint8Array([1, 2, 3])) {
      await audio.attach(new w.Blob([bytes]), { title: 'Lesson', audio: { name: 'lesson.wav' } });
    },
  };
}

test('audio bytes are transferred in bounded, ordered chunks without changing them', async (t) => {
  const h = harness(t);
  const bytes = Uint8Array.from({ length: 900000 }, (_, i) => i % 251);
  await h.attach(bytes);
  assert.deepEqual(Buffer.concat(h.chunks), Buffer.from(bytes));
  const uploads = h.calls.filter(([name]) => name === 'append').map(([, value]) => value);
  assert.equal(uploads.length, 3);
  assert.deepEqual(uploads.map((v) => v.offset), [0, 384 * 1024, 768 * 1024]);
  assert.ok(h.chunks.every((b) => b.length <= 384 * 1024));
  assert.equal(h.audio.readyState, 4); assert.equal(h.audio.duration, 120);
  assert.equal(h.calls[0][1].extension, 'wav');
});

test('native clock and rate continue across backgrounding without pause or a second audio element', async (t) => {
  const h = harness(t); await h.attach(); await h.audio.play();
  h.audio.playbackRate = 1.5; await flush(); h.advance(2000);
  assert.equal(h.audio.currentTime, 3);
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: true });
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  h.advance(10000); assert.equal(h.audio.currentTime, 18); assert.equal(h.audio.paused, false);
  assert.equal(h.calls.filter(([name, value]) => name === 'command' && value.action === 'pause').length, 0);
  assert.equal(h.w.document.querySelectorAll('audio,video').length, 0);
  h.state().position = 32;
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: false });
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await flush();
  assert.equal(h.audio.currentTime, 32);
});

test('native system events control play state, finish state and buffering without JS recovery', async (t) => {
  const h = harness(t); await h.attach(); await h.audio.play();
  const events = [];
  for (const name of ['play', 'pause', 'ended', 'waiting', 'playing']) h.audio.addEventListener(name, () => events.push(name));
  h.emit({ paused: true, position: 12 }); h.advance(3000); assert.equal(h.audio.currentTime, 12);
  h.emit({ paused: false, waiting: true }); h.advance(3000); assert.equal(h.audio.currentTime, 12);
  h.emit({ waiting: false }); h.advance(1000); assert.equal(h.audio.currentTime, 13);
  h.emit({ paused: true, ended: true, position: 120 });
  assert.deepEqual(events, ['pause', 'play', 'waiting', 'playing', 'pause', 'ended']);
  assert.equal(h.audio.ended, true);
});

test('queued user commands ignore stale native snapshots and preserve final pause/seek intent', async (t) => {
  const h = harness(t); await h.attach();
  let release;
  const original = h.bridge.command;
  h.bridge.command = async (value) => {
    if (value.action === 'play') await new Promise((resolve) => { release = resolve; });
    return original(value);
  };
  const play = h.audio.play(); await flush();
  h.audio.currentTime = 40; h.audio.playbackRate = 2; h.audio.pause();
  release(); await play; await flush(); await flush();
  assert.equal(h.audio.currentTime, 40); assert.equal(h.audio.playbackRate, 2); assert.equal(h.audio.paused, true);
  assert.deepEqual(h.calls.filter(([name]) => name === 'command').map(([, value]) => value.action), ['play', 'seek', 'rate', 'pause']);
});

test('source replacement, incomplete imports and page exit release native temporary media', async (t) => {
  const h = harness(t); await h.attach(); const first = h.audio.src;
  await h.attach(new Uint8Array([4, 5])); const second = h.audio.src;
  assert.notEqual(first, second);
  assert.ok(h.calls.some(([name, value]) => name === 'release' && value.session === first));
  h.bridge.append = async () => { throw new Error('write failed'); };
  await assert.rejects(h.attach(), /write failed/);
  assert.equal(h.audio.readyState, 0); assert.equal(h.audio.src, '');
  assert.ok(h.calls.filter(([name]) => name === 'release').length >= 3);
});

test('navigation during upload cancels remaining chunks and a late command cannot corrupt a new source', async (t) => {
  const h = harness(t);
  let releaseUpload;
  const append = h.bridge.append;
  h.bridge.append = async (value) => { await new Promise((resolve) => { releaseUpload = resolve; }); return append(value); };
  const loading = h.attach(new Uint8Array(500000));
  while (!releaseUpload) await flush();
  const rejected = assert.rejects(loading, (error) => error.name === 'AbortError');
  h.w.dispatchEvent(new h.w.Event('pagehide')); releaseUpload(); await rejected;
  assert.equal(h.audio.readyState, 0); assert.equal(h.audio.src, '');
  assert.equal(h.calls.filter(([name]) => name === 'append').length, 1);
  h.bridge.append = append; await h.attach();
  let releasePlay;
  h.bridge.command = () => new Promise((_, reject) => { releasePlay = reject; });
  const playing = h.audio.play(); await flush();
  const cancelled = assert.rejects(playing, (error) => error.name === 'AbortError');
  await h.attach(); releasePlay(Error('old native failure')); await cancelled;
  assert.equal(h.audio.error, null); assert.equal(h.audio.readyState, 4);
});

test('paused bfcache restoration preserves position, rate and loop without resuming audio', async (t) => {
  const h = harness(t); await h.attach();
  h.audio.currentTime = 27; h.audio.playbackRate = 1.5; h.audio.setLoop({ start: 20, end: 30, all: false });
  await flush(); await flush();
  h.w.dispatchEvent(new h.w.Event('pagehide')); await flush();
  h.w.dispatchEvent(new h.w.Event('pageshow'));
  while (!h.audio.readyState) await flush(); await flush(); await flush();
  assert.equal(h.audio.currentTime, 27); assert.equal(h.audio.playbackRate, 1.5); assert.equal(h.audio.paused, true);
  assert.equal(h.calls.at(-1)[1].action, 'loop'); assert.equal(h.calls.at(-1)[1].start, 20);
});

test('native audio owns lock-screen control registration and supplies its session to native captions', async (t) => {
  const h = harness(t); await h.attach();
  h.w.navigator.mediaSession = { setActionHandler() { throw Error('WebKit must not own native remote controls'); } };
  const session = h.w.NativeAudioTest.setupMediaSession({ audio: h.audio, engine: {} });
  session.setTrack({ title: 'Updated title' }); await flush();
  assert.ok(h.calls.some(([name, value]) => name === 'command' && value.action === 'metadata' && value.title === 'Updated title'));
  let payload;
  const pip = h.w.NativeAudioTest.setupNativeCaptionPip({ bridge: {
    open: async (value) => { payload = value; }, update: async () => {}, close: async () => {},
  }, media: h.audio, engine: { track: { sentences: [], sStart: [] } } });
  await pip.open(); assert.equal(payload.nativeAudioSession, h.audio.src); await pip.close();
});

test('loop settings are forwarded to native audio so background repetition does not need rAF', async (t) => {
  const h = harness(t); await h.attach();
  const engine = new h.w.NativeAudioTest.Engine({ audio: h.audio, reader: { activeS: 1 } });
  engine.kick = () => {}; engine.track = { S: 2, sStart: [0, 10], sEnd: [10, 20] };
  engine.setRepeat(1); await flush();
  assert.ok(h.calls.some(([name, value]) => name === 'command' && value.action === 'loop' && value.start === 10 && value.end === 20));
  engine.setRepeat(2); await flush(); assert.equal(h.calls.at(-1)[1].all, true);
  engine.setRepeat(0); await flush(); assert.equal(h.calls.at(-1)[1].all, false); assert.equal(h.calls.at(-1)[1].start, null);
});

test('native playback errors reach the user instead of being hidden by a synthetic pause', async (t) => {
  const h = harness(t, { command: async () => { throw Error('AVAudioSession could not activate'); } });
  await h.attach();
  h.w.document.body.innerHTML = '<div id="toast"></div>';
  const controls = h.w.NativeAudioTest.setupMediaSession({ audio: h.audio, engine: {} });
  await controls.play();
  assert.match(h.w.document.getElementById('toast').textContent, /AVAudioSession could not activate/);
});

test('video frames stay muted and background WebKit pauses never stop the native sound', async (t) => {
  const h = harness(t, {}, { video: true }); await h.attach(); await flush();
  await h.audio.play(); await flush();
  assert.equal(h.video.muted, true); assert.equal(h.video.paused, false);
  h.audio.currentTime = 12; h.audio.playbackRate = 1.5; await flush(); await flush();
  assert.equal(h.video.currentTime, 12); assert.equal(h.video.playbackRate, 1.5);
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: true });
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  assert.equal(h.video.paused, true); assert.equal(h.audio.paused, false);
  h.advance(10000); assert.equal(h.audio.currentTime, 27);
  assert.equal(h.calls.some(([name, value]) => name === 'command' && value.action === 'pause'), false);
  h.state().position = 38;
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: false });
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await flush();
  assert.equal(h.video.currentTime, 38); assert.equal(h.video.paused, false);
  h.audio.pause(); await flush(); assert.equal(h.video.paused, true);
  h.audio.muted = true; await flush();
  assert.equal(h.calls.at(-1)[1].action, 'volume'); assert.equal(h.calls.at(-1)[1].muted, true);
  h.video.muted = false; h.video.dispatchEvent(new h.w.Event('volumechange'));
  assert.equal(h.video.muted, true);
});

test('native video captions follow AVPlayer; repeated close/open leaves sound and frame ownership intact', async (t) => {
  const h = harness(t, {}, { video: true }); await h.attach(); await flush(); await h.audio.play();
  const payloads = [];
  const pip = h.w.NativeAudioTest.setupNativeCaptionPip({ bridge: {
    open: async (value) => payloads.push(value), update: async () => {}, close: async () => {},
  }, media: h.audio, engine: { track: { sentences: [], sStart: [] } } });
  for (let i = 0; i < 3; i++) {
    await pip.open(); assert.equal(h.video.disablePictureInPicture, true);
    assert.equal(payloads.at(-1).nativeAudioSession, h.audio.nativeSession);
    await pip.close(); assert.equal(h.video.disablePictureInPicture, false);
    assert.equal(h.audio.paused, false); assert.equal(h.video.muted, true);
  }
  assert.equal(new Set(payloads.map((p) => p.session)).size, 3);
});

test('video PiP controls reach native audio but returning inline cannot pause it', async (t) => {
  const h = harness(t, {}, { video: true }); await h.attach(); await flush(); await h.audio.play(); await flush();
  h.video.webkitPresentationMode = 'picture-in-picture';
  h.video.dispatchEvent(new h.w.Event('webkitpresentationmodechanged'));
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: true });
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  assert.equal(h.video.paused, false);
  h.video.pause(); await flush(); assert.equal(h.audio.paused, true);
  await h.video.play(); await flush(); assert.equal(h.audio.paused, false);
  h.video.currentTime = 48; h.video.dispatchEvent(new h.w.Event('seeking')); await flush();
  assert.equal(h.audio.currentTime, 48);
  h.video.playbackRate = 2; h.video.dispatchEvent(new h.w.Event('ratechange')); await flush();
  assert.equal(h.audio.playbackRate, 2);
  h.video.webkitPresentationMode = 'inline';
  h.video.dispatchEvent(new h.w.Event('webkitpresentationmodechanged'));
  assert.equal(h.video.paused, true); assert.equal(h.audio.paused, false);
  await h.audio.release(); assert.equal(h.video.getAttribute('src'), null); assert.equal(h.audio.src, '');
});

test('resume waits for fresh native time and decoder latency does not cause repeated seeks', async (t) => {
  const h = harness(t, {}, { video: true }); await h.attach(); await h.audio.play(); await flush();
  const visibility = (hidden) => {
    Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: hidden });
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  };
  visibility(true); h.advance(30000);
  let resolveState;
  const readState = h.bridge.state;
  h.bridge.state = () => new Promise((resolve) => { resolveState = async () => resolve(await readState()); });
  h.state().position = 45;
  const before = h.seeks.length;
  visibility(false);
  assert.equal(h.seeks.length, before, 'do not seek to the old extrapolated 30s clock');
  assert.equal(h.video.paused, true);
  await resolveState(); await flush();
  assert.deepEqual(h.seeks.slice(before), [45]);
  assert.equal(h.video.paused, false);
  // Frames resume 300ms behind the native clock, at its 10Hz update cadence.
  for (let i = 1; i <= 40; i++) {
    h.advance(100); h.frame(45 + i / 10 - 0.3);
    h.emit({ position: 45 + i / 10 });
  }
  assert.equal(h.seeks.length, before + 1, 'small drift must not repeatedly reset the decoder');
  assert.ok(h.video.playbackRate > 1 && h.video.playbackRate <= 1.05);
  assert.equal(h.audio.playbackRate, 1, 'visual correction must not alter sound speed');
  h.frame(49);
  h.emit({ position: 49 });
  assert.equal(h.video.playbackRate, 1);
  // Explicit seeks still align immediately, even within the recovery cooldown.
  h.audio.currentTime = 70; await flush();
  assert.equal(h.video.currentTime, 70);
});

test('large visual drift has a seek cooldown and native loop jumps still align immediately', async (t) => {
  const h = harness(t, {}, { video: true }); await h.attach(); await h.audio.play(); await flush();
  h.advance(2000); h.frame(0); h.emit({ position: 10 }); await flush();
  const count = h.seeks.length;
  for (let i = 0; i < 10; i++) {
    h.advance(100); h.frame(0); h.emit({ position: 10 + i / 10 });
  }
  assert.equal(h.seeks.length, count);
  h.emit({ position: 3, seeking: true });
  h.emit({ position: 3, seeking: false }); await flush();
  assert.equal(h.video.currentTime, 3);
});

test('a foreground refresh completed after backgrounding again cannot restart frames', async (t) => {
  const h = harness(t, {}, { video: true }); await h.attach(); await h.audio.play(); await flush();
  const visibility = (hidden) => {
    Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: hidden });
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  };
  visibility(true);
  const readState = h.bridge.state;
  let finish;
  h.bridge.state = () => new Promise((resolve) => { finish = async () => resolve(await readState()); });
  visibility(false); visibility(true);
  await finish(); await flush();
  assert.equal(h.video.paused, true); assert.equal(h.audio.paused, false);
  h.bridge.state = readState; h.state().position = 25;
  visibility(false); await flush();
  assert.equal(h.video.currentTime, 25); assert.equal(h.video.paused, false);
});

test('a play promise suspended by WebKit does not block frames on the next foreground', async (t) => {
  const h = harness(t, {}, { video: true }); await h.attach();
  const play = h.video.play;
  let finish;
  h.video.play = () => new Promise((resolve) => { finish = resolve; });
  await h.audio.play();
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: true });
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  h.video.play = play;
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, value: false });
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await flush();
  assert.equal(h.video.paused, false); assert.equal(h.audio.paused, false);
  finish(); await flush();
});

test('visual rate correction in system PiP never changes the native playback rate', async (t) => {
  const h = harness(t, {}, { video: true }); await h.attach(); await h.audio.play(); await flush();
  h.video.webkitPresentationMode = 'picture-in-picture';
  h.advance(2000); h.frame(1.7); h.emit({ position: 2 });
  assert.ok(h.video.playbackRate > 1);
  h.video.dispatchEvent(new h.w.Event('ratechange')); await flush();
  assert.equal(h.audio.playbackRate, 1);
  h.video.playbackRate = 1.5; h.video.dispatchEvent(new h.w.Event('ratechange')); await flush();
  assert.equal(h.audio.playbackRate, 1.5);
});

test('MP4 video transfers only its lossless audio track and unsupported remux falls back', async (t) => {
  const h = harness(t, {}, { video: true });
  const atom = (type, ...parts) => {
    const body = Buffer.concat(parts), b = Buffer.alloc(body.length + 8);
    b.writeUInt32BE(b.length); b.write(type, 4); body.copy(b, 8); return b;
  };
  const words = (...values) => {
    const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v, i * 4)); return b;
  };
  const ftyp = atom('ftyp', Buffer.from('isom0000'));
  const audioBytes = Buffer.from([7, 8, 9, 10]);
  const entry = Buffer.alloc(28); entry.writeUInt16BE(2, 16); entry.writeUInt32BE(48000 * 65536, 24);
  const audioTrack = atom('trak', atom('mdia', atom('mdhd', words(0, 0, 0, 48000, 1024)),
    atom('hdlr', words(0, 0), Buffer.from('soun')), atom('minf', atom('stbl',
      atom('stsd', words(0, 1), atom('mp4a', entry)), atom('stsz', words(0, 4, 1)),
      atom('stsc', words(0, 1, 1, 1, 1)), atom('stco', words(0, 1, ftyp.length + 8))))));
  const videoTrack = atom('trak', atom('mdia', atom('hdlr', words(0, 0), Buffer.from('vide'))));
  const bytes = Buffer.concat([ftyp, atom('mdat', audioBytes, Buffer.alloc(2 * 1024 * 1024)),
    atom('moov', atom('mvhd', Buffer.alloc(100)), videoTrack, audioTrack)]);
  await h.audio.attach(new h.w.Blob([bytes], { type: 'video/mp4' }), { audio: { name: 'movie.mp4' } });
  const transferred = Buffer.concat(h.chunks);
  assert.ok(transferred.length < 1024, `${bytes.length} video bytes must not cross the bridge`);
  assert.equal(h.calls.find(([name]) => name === 'begin')[1].extension, 'm4a');
  assert.equal(transferred.includes(Buffer.from('vide')), false);
  assert.deepEqual(transferred.subarray(-4), audioBytes);
  const fragmented = Buffer.concat([ftyp, atom('moof'), atom('mdat', audioBytes)]);
  h.chunks.length = 0;
  await h.audio.attach(new h.w.Blob([fragmented]), { audio: { name: 'fragmented.mp4' } });
  assert.deepEqual(Buffer.concat(h.chunks), fragmented);
  assert.equal(h.calls.filter(([name]) => name === 'begin').at(-1)[1].extension, 'mp4');
});
