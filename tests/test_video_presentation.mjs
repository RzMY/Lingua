import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const { outputFiles } = await build({ stdin: { contents: `
  export { setupVideo } from './web/js/video-player.js';
  export { trackCfg } from './web/js/trackcfg.js';`, resolveDir: root },
  bundle: true, write: false, format: 'iife', globalName: 'VideoTest' });
const html = await readFile(new URL('../web/player.html', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, { native = true, wakeRequest } = {}) {
  const dom = new JSDOM(html, { url: 'https://localhost/player.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, doc = w.document, calls = [];
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); });
  const landscape = new w.EventTarget(); landscape.matches = false;
  w.matchMedia = () => landscape;
  w.LinguaNative = native ? { platform: 'ios' } : undefined;
  doc.documentElement.requestFullscreen = async () => { calls.push('fullscreen'); };
  w.screen.orientation = { lock: async () => { calls.push('lock'); }, unlock() {} };
  if (wakeRequest) w.navigator.wakeLock = { request: wakeRequest };
  w.eval(outputFiles[0].text);
  const app = doc.getElementById('app'), video = doc.getElementById('video');
  app.classList.add('has-video');
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 2 },
    videoWidth: { configurable: true, value: 1280 },
    videoHeight: { configurable: true, value: 720 },
  });
  const track = { S: 1, sStart: [0], sEnd: [4], sentences: [{ text: 'Hello.', translation: '你好。' }] };
  const cues = { mode: 'disabled', addCue() {}, removeCue() {} };
  video.addTextTrack = () => cues;
  w.VTTCue = class { constructor(start, end, text) { Object.assign(this, { startTime: start, endTime: end, text }); } };
  video.webkitPresentationMode = 'inline';
  video.webkitSetPresentationMode = (mode) => {
    video.webkitPresentationMode = mode;
    video.dispatchEvent(new w.Event('webkitpresentationmodechanged'));
  };
  const player = w.VideoTest.setupVideo({ app, video, engine: { track }, toggle() {}, onLayout() {},
    overlayOpen: () => false, openSettings() {} });
  const rotate = async () => { doc.getElementById('btnVideoRotate').click(); await flush(); };
  const turn = async (horizontal) => {
    landscape.matches = horizontal;
    landscape.dispatchEvent(new w.Event('change')); await flush();
  };
  const pointer = (target, type) => target.dispatchEvent(Object.assign(new w.Event(type, { bubbles: true, cancelable: true }),
    { pointerId: 1, button: 0, isPrimary: true, clientX: 160, clientY: 90 }));
  return { w, doc, app, video, player, calls, cues, rotate, turn, pointer };
}

test('PiP waits for a video frame before probing Safari support, then opens on the next tap', async (t) => {
  const h = harness(t);
  let probes = 0, requests = 0;
  h.video.webkitSupportsPresentationMode = () => { probes++; return h.video.readyState >= 2; };
  h.video.webkitSetPresentationMode = (mode) => { requests++; h.video.webkitPresentationMode = mode; };
  for (const readyState of [0, 1]) {
    Object.defineProperty(h.video, 'readyState', { configurable: true, value: readyState });
    await h.player.pip.toggle();
    assert.match(h.doc.getElementById('toast').textContent, /视频正在加载/);
    assert.equal(probes, 0);
    assert.equal(requests, 0);
  }
  Object.defineProperty(h.video, 'readyState', { configurable: true, value: 2 });
  await h.player.pip.toggle();
  assert.equal(requests, 1);
  assert.equal(h.player.pip.isActive(), true);
  // Closing an existing PiP must still work if the media becomes unready.
  Object.defineProperty(h.video, 'readyState', { configurable: true, value: 0 });
  await h.player.pip.toggle();
  assert.equal(h.player.pip.isActive(), false);
});

test('loading media does not request standard or Document PiP, or exit landscape', async (t) => {
  const h = harness(t, { native: false });
  let requests = 0;
  h.w.documentPictureInPicture = { requestWindow() { requests++; } };
  h.video.requestPictureInPicture = () => { requests++; };
  await h.rotate();
  Object.defineProperty(h.video, 'readyState', { configurable: true, value: 1 });
  await h.player.pip.toggle();
  assert.equal(requests, 0);
  assert.equal(h.player.isImmersive(), true);
  assert.match(h.doc.getElementById('toast').textContent, /视频正在加载/);
});

test('ready media without a PiP interface still reports unsupported; media errors report a load failure', async (t) => {
  const h = harness(t);
  h.video.webkitSetPresentationMode = undefined;
  await h.player.pip.toggle();
  assert.match(h.doc.getElementById('toast').textContent, /不支持画中画/);
  Object.defineProperty(h.video, 'error', { value: { code: 3 } });
  await h.player.pip.toggle();
  assert.match(h.doc.getElementById('toast').textContent, /视频加载失败/);
});

test('portrait toolbar presses do not reveal video controls or consume button clicks', (t) => {
  const h = harness(t);
  for (const id of ['btnPin', 'btnExplain', 'btnRepeat', 'btnSpeed', 'btnPlay', 'btnDisplay', 'seek']) {
    const button = h.doc.getElementById(id);
    let clicks = 0;
    button.addEventListener('click', () => { clicks++; });
    const target = button.firstElementChild || button;
    assert.equal(h.pointer(target, 'pointerdown'), true, `${id} must retain its default input handling`);
    assert.equal(h.app.classList.contains('controls-visible'), false, `${id} must not reveal video controls`);
    h.pointer(target, 'pointerup'); target.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
    assert.equal(clicks, 1);
  }
});

test('a toolbar press cancels a pending video single tap while immersive controls remain usable', async (t) => {
  const h = harness(t);
  h.video.setPointerCapture = h.video.releasePointerCapture = () => {};
  h.video.getBoundingClientRect = () => ({ left: 0, top: 0, right: 320, width: 320, height: 180 });
  h.pointer(h.video, 'pointerdown'); h.pointer(h.video, 'pointerup');
  h.pointer(h.doc.getElementById('btnSpeed'), 'pointerdown');
  await new Promise((resolve) => h.w.setTimeout(resolve, 350));
  assert.equal(h.app.classList.contains('controls-visible'), false);
  await h.rotate(); h.player.showControls();
  h.pointer(h.video, 'pointerdown'); h.pointer(h.video, 'pointerup');
  h.pointer(h.doc.getElementById('btnToolSettings'), 'pointerdown');
  await new Promise((resolve) => h.w.setTimeout(resolve, 350));
  assert.equal(h.app.classList.contains('controls-visible'), true);
});

test('native iOS manually enters and leaves full-canvas playback without WebKit fullscreen or orientation lock', async (t) => {
  const h = harness(t);
  for (let i = 0; i < 3; i++) {
    await h.rotate();
    assert.equal(h.player.isImmersive(), true);
    assert.equal(h.doc.body.classList.contains('video-rotated'), true);
    assert.equal(h.doc.documentElement.classList.contains('video-immersive'), true);
    await h.rotate();
    assert.equal(h.player.isImmersive(), false);
    assert.equal(h.doc.body.classList.contains('video-rotated'), false);
    assert.equal(h.doc.documentElement.classList.contains('video-immersive'), false);
  }
  assert.deepEqual(h.calls, []);
});

test('physical landscape followed by portrait clears the manual landscape override', async (t) => {
  const h = harness(t);
  await h.rotate(); await h.turn(true);
  assert.equal(h.player.isImmersive(), true);
  assert.equal(h.doc.body.classList.contains('video-rotated'), false);
  await h.turn(false);
  assert.equal(h.player.isImmersive(), false);
  assert.equal(h.doc.body.classList.contains('video-rotated'), false);
  assert.deepEqual(h.calls, []);
});

test('browser fullscreen is retained and audio-only pages never request it on rotation', async (t) => {
  const h = harness(t, { native: false });
  await h.rotate();
  assert.deepEqual(h.calls, ['fullscreen', 'lock']);
  await h.rotate(); h.calls.length = 0;
  h.app.classList.remove('has-video'); await h.turn(true);
  assert.deepEqual(h.calls, []);
  assert.equal(h.player.isImmersive(), false);
});

test('automatic iOS PiP releases immersion and respects subtitle visibility on refresh', async (t) => {
  const h = harness(t);
  await h.rotate();
  h.video.webkitSetPresentationMode('picture-in-picture'); await flush();
  assert.equal(h.player.isImmersive(), false);
  assert.equal(h.doc.body.classList.contains('video-rotated'), false);
  assert.equal(h.cues.mode, 'showing');
  h.w.VideoTest.trackCfg.video.subtitles = 0; h.player.apply();
  assert.equal(h.cues.mode, 'disabled');
  h.w.VideoTest.trackCfg.video.subtitles = 1; h.player.apply();
  assert.equal(h.cues.mode, 'showing');
  await h.turn(true);
  assert.equal(h.player.isImmersive(), false);
  h.video.webkitSetPresentationMode('inline'); await flush();
  assert.equal(h.cues.mode, 'disabled');
  assert.equal(h.player.isImmersive(), true);
});

test('native back exits manual landscape without navigating away', async (t) => {
  const h = harness(t);
  await h.rotate();
  assert.equal(h.w.dispatchEvent(new h.w.CustomEvent('native-back', { cancelable: true })), false);
  await flush(); assert.equal(h.player.isImmersive(), false);
  assert.equal(h.w.dispatchEvent(new h.w.CustomEvent('native-back', { cancelable: true })), true);
});

test('a late wake-lock result is released after leaving immersion', async (t) => {
  let resolveLock, released = 0;
  const h = harness(t, { wakeRequest: () => new Promise((resolve) => { resolveLock = resolve; }) });
  await h.rotate(); await h.rotate();
  resolveLock({ release: async () => { released++; } }); await flush();
  assert.equal(released, 1);
});

test('returning from the background reacquires the immersive wake lock', async (t) => {
  let requests = 0, released = 0;
  const h = harness(t, { wakeRequest: async () => { requests++; return { release: async () => { released++; } }; } });
  await h.rotate();
  Object.defineProperty(h.doc, 'hidden', { configurable: true, value: true });
  h.doc.dispatchEvent(new h.w.Event('visibilitychange')); await flush();
  Object.defineProperty(h.doc, 'hidden', { configurable: true, value: false });
  h.doc.dispatchEvent(new h.w.Event('visibilitychange')); await flush();
  assert.equal(requests, 2); assert.equal(released, 1);
});
