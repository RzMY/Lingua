import assert from 'node:assert/strict';
import { test } from 'node:test';

test('rapid transitions cancel previous effects and reduced motion cancels running entrances', async () => {
  const media = { matches: false, addEventListener(_event, callback) { this.change = callback; } };
  globalThis.matchMedia = () => media;
  try {
    const { enterView } = await import('../web/js/motion.js?test');
    const effects = [];
    const node = { animate(frames) {
      const effect = { frames, cancelled: false, cancel() { this.cancelled = true; this.oncancel?.(); } };
      effects.push(effect); return effect;
    } };
    enterView(node);
    enterView(node, 'back');
    assert.equal(effects[0].cancelled, true);
    assert.equal(effects[1].cancelled, false);
    media.matches = true;
    media.change();
    assert.equal(effects[1].cancelled, true);
    enterView(node);
    assert.equal(effects.length, 2);
    media.matches = false;
    enterView(node, 'fade');
    assert.ok(effects[2].frames.every((frame) => !('transform' in frame)), 'preserve immersive player positioning');
    effects[2].onfinish();
    enterView(node, 'fade');
    assert.equal(effects[2].cancelled, false, 'finished effects have been released');
    enterView(null);
    enterView({}); // Older WebViews still navigate without animations.
  } finally { delete globalThis.matchMedia; }
});
