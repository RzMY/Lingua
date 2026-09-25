import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityPipControls } from '../web/js/media-controls.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(bridge) {
  const media = Object.assign(new EventTarget(), { src: 'blob:lesson', duration: 30, currentTime: 12, paused: true, playbackRate: 1.5,
    play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); },
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); } });
  const engine = { track: {}, seek: (time) => { media.currentTime = Math.max(0, Math.min(30, time)); } };
  return { media, engine, controls: activityPipControls(bridge, media, engine, 'current') };
}

test('Android actions operate the original media, retain rate, and ignore retired sessions', async () => {
  const calls = [], h = harness({ updatePip: async (state) => calls.push(state) });
  h.controls.activate(true); await flush();
  const command = (action, session = 'current') => h.controls.control({ action, session });
  command('play', 'old'); assert.equal(h.media.paused, true);
  command('play'); assert.equal(h.media.paused, false); await flush();
  assert.equal(calls.at(-1).playing, true);
  command('pause'); assert.equal(h.media.paused, true); await flush();
  assert.equal(calls.at(-1).playing, false);
  command('seekbackward'); assert.equal(h.media.currentTime, 7);
  command('seekforward'); assert.equal(h.media.currentTime, 12);
  h.media.currentTime = 29; command('seekforward'); assert.equal(h.media.currentTime, 30);
  h.media.currentTime = 2; command('seekbackward'); assert.equal(h.media.currentTime, 0);
  assert.equal(h.media.playbackRate, 1.5);
  h.controls.activate(false); command('play'); assert.equal(h.media.paused, true);
  h.controls.dispose();
});

test('PiP state sends no progress traffic and coalesces in-flight state changes', async () => {
  const calls = []; let finish;
  const h = harness({ updatePip: (state) => { calls.push(state); return new Promise((resolve) => { finish = resolve; }); } });
  h.controls.activate(true);
  for (let i = 0; i < 240; i++) h.media.dispatchEvent(new Event('timeupdate'));
  assert.equal(calls.length, 1);
  await h.media.play(); h.media.pause(); await h.media.play();
  assert.equal(calls.length, 1);
  finish(); await flush();
  assert.equal(calls.length, 2); assert.equal(calls[1].playing, true);
  assert.ok(calls[1].sequence > calls[0].sequence);
  finish(); await flush();
  h.media.src = ''; h.media.dispatchEvent(new Event('emptied'));
  assert.equal(calls.at(-1).seekable, false);
  finish(); h.controls.dispose(); await flush();
});
