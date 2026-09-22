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
