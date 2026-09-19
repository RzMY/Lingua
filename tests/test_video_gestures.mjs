import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doubleTapAction, swipeTime, setupVideoGestures } from '../web/js/video-gestures.js';

test('double tap zones leave a central playback target, and swipe time is bounded', () => {
  assert.equal(doubleTapAction(.1), 'back');
  assert.equal(doubleTapAction(.5), 'toggle');
  assert.equal(doubleTapAction(.9), 'forward');
  assert.equal(swipeTime(20, -1000, 500, 30), 0);
  assert.equal(swipeTime(20, 1000, 500, 30), 30);
  assert.equal(swipeTime(100, 250, 500, 7200), 160);
});

test('hold rate and scrubbing are restored on cancellation, pause and page exit', (t) => {
  const win = new EventTarget(), doc = new EventTarget();
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = win; globalThis.document = doc;
  t.after(() => Object.assign(globalThis, previous));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const video = Object.assign(new EventTarget(), { paused: false, currentTime: 10, duration: 100,
    playbackRate: 1.5, volume: 1, style: {}, setPointerCapture() {}, releasePointerCapture() {} });
  const engine = { track: { duration: 100 }, scrubbing: false, kick() {}, seek(t) { video.currentTime = t; }, scrollToActive() {} };
  let taps = 0;
  setupVideoGestures({ video, engine, toggle() {}, singleTap() { taps++; }, feedback() {}, setVolume() {},
    toPoint: (event) => ({ x: event.clientX, y: event.clientY, width: 500, height: 300 }) });
  const fire = (type, x = 250, y = 50) => video.dispatchEvent(Object.assign(new Event(type),
    { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y }));
  for (const cancel of [() => fire('pointerup'), () => fire('pointercancel'), () => win.dispatchEvent(new Event('pagehide'))]) {
    fire('pointerdown'); t.mock.timers.tick(451);
    assert.equal(video.playbackRate, 2);
    cancel(); assert.equal(video.playbackRate, 1.5);
    t.mock.timers.tick(400); assert.equal(taps, 0);
  }
  fire('pointerdown'); t.mock.timers.tick(451);
  video.paused = true; fire('pause');
  assert.equal(video.playbackRate, 1.5);
  fire('pointerup');
  fire('pointerdown'); fire('pointermove', 350);
  assert.equal(engine.scrubbing, true);
  fire('pointercancel');
  assert.equal(engine.scrubbing, false);
  assert.equal(video.currentTime, 10, 'cancelled swipe does not seek');
});
