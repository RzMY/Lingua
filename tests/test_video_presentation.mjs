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
  return { w, doc, app, video, player, calls, cues, rotate, turn };
}

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
