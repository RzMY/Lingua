import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const { outputFiles } = await build({ stdin: { contents: `
  export { setupAudioPip } from './web/js/audio-pip.js';
  export { setupVideo } from './web/js/video-player.js';
  export { openTrackSheet } from './web/js/ui.js';
  export { initTrackCfg, trackCfg, setVideoCfg, readTrackCfg } from './web/js/trackcfg.js';`, resolveDir: root },
  bundle: true, write: false, format: 'iife', globalName: 'PipTest' });
const html = await readFile(new URL('../web/player.html', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, { kind = 'audio', ios = true, supported = true, bridgeOverrides = {} } = {}) {
  const dom = new JSDOM(html, { url: 'https://localhost/player.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, doc = w.document, calls = [];
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); });
  w.console.warn = () => {};
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.screen.orientation = { unlock() {} };
  Object.defineProperty(w.HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return this._paused !== false; } });
  w.HTMLMediaElement.prototype.play = function () {
    if (this.paused) { this._paused = false; this.dispatchEvent(new w.Event('play')); }
    return Promise.resolve();
  };
  w.HTMLMediaElement.prototype.pause = function () {
    if (!this.paused) { this._paused = true; this.dispatchEvent(new w.Event('pause')); }
  };
  const bridge = {
    open: async (value) => { calls.push(['open', value]); },
    update: async (value) => { calls.push(['update', value]); },
    close: async (value) => { calls.push(['close', value]); }, ...bridgeOverrides,
  };
  if (ios) w.LinguaNative = { platform: 'ios', captionPip: supported ? bridge : null };
  w.eval(outputFiles[0].text);
  const api = w.PipTest, app = doc.getElementById('app'), media = doc.getElementById(kind);
  Object.defineProperties(media, { readyState: { configurable: true, value: 2 }, duration: { value: 30 },
    videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
  const track = { S: 2, sStart: [0, 10], sEnd: [10, 30], title: 'Lesson',
    sentences: [{ text: 'First sentence.', translation: '第一句。' }, { text: 'Second sentence.', translation: '第二句。' }],
    layerOrder: [], layers: {}, supports: () => false };
  const engine = { track, reader: { activeS: 0 }, seek: (t) => { media.currentTime = t; } };
  api.initTrackCfg('lesson', 'en'); doc.documentElement.dataset.tr = '1';
  media.src = 'blob:lesson'; media.currentTime = 12; media.playbackRate = 1.5;
  const togglePlayback = () => { if (media.paused) media.play(); else media.pause(); };
  let videoPlayer;
  if (kind === 'video') {
    app.classList.add('has-video');
    videoPlayer = api.setupVideo({ video: media, app, engine, toggle: togglePlayback, onLayout() {}, overlayOpen: () => false, openSettings() {} });
  }
  const pip = videoPlayer?.audioPip || api.setupAudioPip({ media, engine, app, togglePlayback });
  return { w, doc, api, app, media, track, pip, videoPlayer, calls, bridge };
}

for (const kind of ['audio', 'video']) test(`${kind}: native captions use the original clock and leave playback intact`, async (t) => {
  const h = harness(t, { kind }); await h.media.play();
  const count = h.doc.querySelectorAll('video').length;
  await h.pip.toggle(); await flush();
  assert.equal(h.pip.isActive(), true); assert.equal(h.pip.supported(), true);
  if (kind === 'video') assert.equal(h.doc.getElementById('btnAudioPip').hidden, false);
  const open = h.calls.find(([name]) => name === 'open')[1];
  assert.equal(open.position, 12); assert.equal(open.rate, 1.5); assert.equal(open.paused, false);
  assert.equal(open.sentences[1].text, 'Second sentence.'); assert.equal(open.sentences[1].translation, '第二句。');
  assert.equal(open.captionSize, 20); assert.ok(open.session);
  assert.equal(h.media.disablePictureInPicture, true);
  assert.equal(h.doc.querySelectorAll('video').length, count);
  h.media.pause(); await flush();
  assert.equal(h.calls.at(-1)[1].paused, true);
  await h.media.play(); h.media.currentTime = 24; h.media.dispatchEvent(new h.w.Event('seeked')); await flush();
  assert.equal(h.calls.at(-1)[1].position, 24);
  h.media.playbackRate = 2; h.media.dispatchEvent(new h.w.Event('ratechange')); await flush();
  assert.equal(h.calls.at(-1)[1].rate, 2);
  h.api.setVideoCfg({ captionSize: 28 }); h.pip.refresh(); await flush();
  assert.equal(h.calls.at(-1)[1].captionSize, 28);
  h.track.sentences[1].translation = '更新译文'; h.pip.refresh(); await flush();
  assert.equal(h.calls.at(-1)[1].sentences[1].translation, '更新译文');
  h.doc.documentElement.dataset.tr = '0'; await flush();
  assert.equal(h.calls.at(-1)[1].showTranslation, false);
  h.media.dispatchEvent(new h.w.Event('waiting')); await flush(); assert.equal(h.calls.at(-1)[1].paused, true);
  h.media.dispatchEvent(new h.w.Event('playing')); await flush(); assert.equal(h.calls.at(-1)[1].paused, false);
  assert.equal(await h.pip.close(), true);
  assert.equal(h.pip.isActive(), false); assert.equal(h.media.paused, false);
  assert.equal(h.media.currentTime, 24); assert.equal(h.media.playbackRate, 2); assert.equal(h.media.src, 'blob:lesson');
  assert.equal(h.media.disablePictureInPicture, false);
});

test('unsupported browsers and old iOS binaries hide the entry even with video PiP APIs present', async (t) => {
  for (const ios of [false, true]) {
    const h = harness(t, { ios, supported: false, kind: 'video' });
    let requested = 0;
    h.w.documentPictureInPicture = { requestWindow: () => requested++ };
    h.media.webkitSetPresentationMode = () => requested++;
    assert.equal(h.pip.supported(), false); assert.equal(h.doc.getElementById('btnAudioPip').hidden, true);
    await h.pip.toggle(); assert.equal(requested, 0); assert.equal(h.calls.length, 0);
  }
});

test('native rejection never falls back to a black video, and can retry', async (t) => {
  const h = harness(t, { bridgeOverrides: { open: async () => { throw new Error('denied'); } } });
  await h.media.play(); await h.pip.toggle();
  assert.equal(h.pip.isActive(), false); assert.equal(h.media.paused, false);
  assert.match(h.doc.getElementById('toast').textContent, /字幕小窗启动失败.*重试/);
  assert.doesNotMatch(h.doc.getElementById('toast').textContent, /denied/);
  assert.equal(h.doc.querySelector('.audio-pip-carrier, .ios-caption-carrier'), null);
  h.bridge.open = async () => {}; await h.pip.toggle(); assert.equal(h.pip.isActive(), true);
});

test('capability changes reveal and hide the entry, while an active window keeps its close button', async (t) => {
  const h = harness(t, { supported: false, kind: 'video' });
  const button = h.doc.getElementById('btnAudioPip');
  assert.equal(button.hidden, true);
  h.w.LinguaNative.captionPip = h.bridge;
  h.w.dispatchEvent(new h.w.Event('native-caption-capabilities'));
  assert.equal(button.hidden, false);
  await h.pip.toggle();
  h.w.LinguaNative.captionPip = null;
  h.w.dispatchEvent(new h.w.Event('native-caption-capabilities'));
  assert.equal(button.hidden, false);
  await h.pip.close();
  assert.equal(button.hidden, true);
});

test('native startup failure remains visible when the stop event arrives before rejection', async (t) => {
  const h = harness(t);
  h.bridge.open = async ({ session }) => {
    h.w.dispatchEvent(new h.w.CustomEvent('native-caption-pip', { detail: { session, active: false } }));
    throw new Error('native content source rejected');
  };
  await h.pip.toggle();
  assert.equal(h.pip.isActive(), false);
  assert.match(h.doc.getElementById('toast').textContent, /字幕小窗启动失败.*重试/);
});

test('startup timeout waits for native teardown and shows a timeout message for retry', async (t) => {
  let cleanup;
  const h = harness(t, { bridgeOverrides: {
    open: async () => { throw Object.assign(new Error('已请求系统小窗，但没有收到启动回调（PIP_START_NO_CALLBACK）'),
      { code: 'PIP_START_NO_CALLBACK' }); },
    close: () => new Promise((resolve) => { cleanup = resolve; }),
  } });
  const pending = h.pip.toggle(); await flush();
  assert.equal(h.pip.isBusy(), true);
  assert.equal(h.pip.isActive(), false);
  assert.equal(h.media.disablePictureInPicture, true);
  cleanup(); await pending;
  assert.equal(h.pip.isBusy(), false);
  assert.equal(h.media.disablePictureInPicture, false);
  const message = h.doc.getElementById('toast').textContent;
  assert.match(message, /字幕小窗启动超时.*重试/);
  assert.doesNotMatch(message, /PIP_START_NO_CALLBACK|权限/);
  h.bridge.open = async () => {}; h.bridge.close = async () => {};
  await h.pip.toggle(); assert.equal(h.pip.isActive(), true);
});

test('close failure retains the active state until the matching system close event arrives', async (t) => {
  const h = harness(t, { bridgeOverrides: { close: async () => { throw new Error('use system close'); } } });
  await h.pip.toggle(); const session = h.calls[0][1].session;
  assert.equal(await h.pip.close(), false); assert.equal(h.pip.isActive(), true);
  h.w.dispatchEvent(new h.w.CustomEvent('native-caption-pip', { detail: { session: 'old-session', active: false } }));
  assert.equal(h.pip.isActive(), true);
  h.w.dispatchEvent(new h.w.CustomEvent('native-caption-pip', { detail: { session, active: false } }));
  assert.equal(h.pip.isActive(), false); assert.equal(h.media.disablePictureInPicture, false);
});

test('navigation cancels pending native PiP and stale completion cannot reopen it', async (t) => {
  let resolve;
  const h = harness(t, { bridgeOverrides: { open: () => new Promise((r) => { resolve = r; }) } });
  const pending = h.pip.toggle(); await h.pip.toggle();
  h.w.dispatchEvent(new h.w.Event('pagehide')); await flush();
  resolve(); await pending;
  assert.equal(h.pip.isActive(), false); assert.equal(h.app.classList.contains('is-audio-pip'), false);
  assert.ok(h.calls.some(([name]) => name === 'close'));
});

test('only a confirmed system PiP is reported active, never the pending request', async (t) => {
  let resolve;
  const h = harness(t, { kind: 'video', bridgeOverrides: {
    open: (value) => { h.calls.push(['open', value]); return new Promise((r) => { resolve = r; }); },
  } });
  const opening = h.pip.toggle();
  await flush();
  assert.equal(h.pip.isActive(), false);
  assert.equal(h.pip.hasSession(), true);
  assert.equal(h.pip.isBusy(), true);
  assert.equal(h.app.classList.contains('is-audio-pip'), false);
  assert.equal(h.doc.getElementById('videoPipNote').hidden, true);
  assert.equal(h.doc.getElementById('btnAudioPip').getAttribute('aria-pressed'), 'false');
  assert.equal(h.doc.getElementById('btnAudioPip').getAttribute('aria-busy'), 'true');
  resolve(); await opening;
  assert.equal(h.pip.isActive(), true);
  assert.equal(h.pip.isBusy(), false);
  assert.equal(h.app.classList.contains('is-audio-pip'), true);
  assert.equal(h.doc.getElementById('videoPipNote').hidden, false);
});

test('switching apps preserves system PiP and keeps sending media state without stopping playback', async (t) => {
  const h = harness(t);
  await h.media.play(); await h.pip.toggle(); await flush();
  const session = h.calls.find(([name]) => name === 'open')[1].session;
  Object.defineProperty(h.doc, 'hidden', { configurable: true, value: true });
  h.doc.dispatchEvent(new h.w.Event('visibilitychange')); await flush();
  assert.equal(h.pip.isActive(), true);
  assert.equal(h.media.paused, false);
  assert.equal(h.calls.some(([name]) => name === 'close'), false);
  h.media.currentTime = 22; h.media.dispatchEvent(new h.w.Event('seeked')); await flush();
  assert.equal(h.calls.at(-1)[1].position, 22);
  assert.equal(h.calls.at(-1)[1].session, session);
  Object.defineProperty(h.doc, 'hidden', { configurable: true, value: false });
  h.doc.dispatchEvent(new h.w.Event('visibilitychange')); await flush();
  assert.equal(h.pip.isActive(), true);
  assert.equal(h.calls.filter(([name]) => name === 'open').length, 1);
  h.w.dispatchEvent(new h.w.CustomEvent('native-caption-pip', { detail: { session, active: false } }));
  assert.equal(h.pip.isActive(), false);
  assert.equal(h.media.paused, false);
});

test('queued clock updates preserve translations and use monotonic sequence numbers', async (t) => {
  let release, block = false;
  const updates = [];
  const h = harness(t, { bridgeOverrides: { update: async (value) => {
    updates.push(value); if (block) { block = false; await new Promise((r) => { release = r; }); }
  } } });
  await h.pip.toggle(); await flush();
  block = true; h.media.dispatchEvent(new h.w.Event('pause'));
  h.track.sentences[1].translation = '译文到达'; h.pip.refresh();
  h.media.currentTime = 18; h.media.dispatchEvent(new h.w.Event('seeked'));
  release(); await flush(); await flush();
  assert.equal(updates.at(-1).position, 18); assert.equal(updates.at(-1).sentences[1].translation, '译文到达');
  assert.ok(updates.every((u, i) => !i || u.sequence > updates[i - 1].sequence));
});

test('system close animation blocks new requests, then multiple reopen cycles accept only their own callbacks', async (t) => {
  const h = harness(t); await h.media.play();
  let old = '';
  for (let i = 0; i < 3; i++) {
    await h.pip.toggle(); await flush();
    const session = h.calls.filter(([name]) => name === 'open').at(-1)[1].session;
    if (old) {
      h.w.dispatchEvent(new h.w.CustomEvent('native-caption-pip', { detail: { session: old, active: false } }));
      assert.equal(h.pip.isActive(), true);
    }
    h.w.dispatchEvent(new h.w.CustomEvent('native-caption-pip', { detail: { session, active: true, closing: true } }));
    assert.equal(h.pip.isBusy(), true);
    await h.pip.toggle();
    assert.equal(h.calls.filter(([name]) => name === 'open').length, i + 1);
    assert.equal(h.calls.filter(([name]) => name === 'close').length, 0);
    h.w.dispatchEvent(new h.w.CustomEvent('native-caption-pip', { detail: { session, active: false } }));
    assert.equal(h.pip.isBusy(), false); assert.equal(h.pip.hasSession(), false);
    assert.equal(h.media.disablePictureInPicture, false); assert.equal(h.media.paused, false);
    old = session;
  }
});

test('audio and video expose caption overrides next to subtitle fonts', (t) => {
  const h = harness(t);
  for (const video of [undefined, {}]) {
    h.api.openTrackSheet(h.track, { video });
    const rows = [...h.doc.querySelectorAll('.row')].filter((row) => row.querySelector('b')?.textContent === '系统字幕字号');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].previousElementSibling.querySelector('b').textContent, '字幕字号');
    rows[0].click();
    assert.ok(h.doc.querySelector('.caption-preview'));
    const input = h.doc.querySelector('.sheet input'); input.value = '28'; input.dispatchEvent(new h.w.Event('change'));
    assert.equal(h.api.readTrackCfg('lesson').video.captionSize, 28);
    assert.equal(h.doc.querySelector('.caption-preview-text').style.fontSize, '28px');
  }
});

