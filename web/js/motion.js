/** Short, interruptible entrances. No animation loop or delayed navigation. */
const active = new Map();
const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

reduced?.addEventListener('change', () => {
  if (reduced.matches) for (const animation of active.values()) animation.cancel();
});

export function enterView(node, direction = 'up') {
  if (!node) return;
  active.get(node)?.cancel();
  if (reduced?.matches || typeof node.animate !== 'function') return;
  const offset = direction === 'up' ? '0, 10px' : direction === 'back' ? '-14px, 0' : '14px, 0';
  const frames = direction === 'fade' ? [{ opacity: 0 }, { opacity: 1 }] : [
    { opacity: 0, transform: `translate(${offset})` },
    { opacity: 1, transform: 'translate(0, 0)' },
  ];
  const animation = node.animate(frames, { duration: 240, easing: 'cubic-bezier(.32, .72, 0, 1)' });
  active.set(node, animation);
  const cleanup = () => { if (active.get(node) === animation) active.delete(node); };
  animation.onfinish = cleanup;
  animation.oncancel = cleanup;
}
