import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../web/js/engine.js';

test('manual scrolling cancels follow until explicitly pinned again', () => {
  const engine = new Engine({ reader: { activeS: 3 }, vlist: { scrollTargetFor: () => 240 } });
  engine.kick = () => {};
  const changes = [];
  engine.onFollowChange = (on) => changes.push(on);
  engine._target = 500;
  engine.noteUserScroll({ unpin: true });
  assert.equal(engine.follow, false);
  assert.equal(engine._target, -1);
  engine.noteUserScroll({ unpin: true });
  assert.deepEqual(changes, [false]);
  engine.setFollow(true);
  assert.equal(engine.follow, true);
  assert.equal(engine._target, 240);
  assert.deepEqual(changes, [false, true]);
});

test('a subtitle press or seek-bar drag only interrupts current scroll animation', () => {
  const engine = new Engine({});
  engine._target = 500;
  engine.noteUserScroll();
  assert.equal(engine.follow, true);
  assert.equal(engine._target, -1);
});

test('subtitle management suspension prevents late events from restarting the reader', () => {
  const engine = new Engine({});
  engine.setSuspended(true);
  engine.kick(); engine.markScrollDirty();
  assert.equal(engine._raf, 0);
  assert.equal(engine.follow, true);
});

test('hidden presentation parks rendering but keeps loop handling and resumes at the media clock', (t) => {
  let frames = 0;
  const old = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => ++frames;
  t.after(() => { if (old) globalThis.requestAnimationFrame = old; else delete globalThis.requestAnimationFrame; });
  const engine = new Engine({ audio: { paused: false, currentTime: 15 } });
  engine.track = {}; engine.presentationHidden = true;
  const calls = [];
  engine._loops = (time) => calls.push(['loop', time]);
  engine._sync = (time) => calls.push(['paint', time]);
  engine._paintSeek = engine._autoScroll = () => {};
  engine._needV = false;
  engine._frame(1000);
  assert.equal(frames, 0); assert.deepEqual(calls, [['loop', 15]]);
  engine.audio.currentTime = 22; engine.backgroundTick();
  assert.deepEqual(calls.at(-1), ['loop', 22]);
  engine.repeat = 1; engine._frame(1100); assert.equal(frames, 1);
  engine.repeat = 0; engine.presentationHidden = false; engine._frame(1200);
  assert.ok(calls.some(([name, time]) => name === 'paint' && time === 22));
});
