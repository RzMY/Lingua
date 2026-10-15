/** Horizontal subtitle swipes coexist with vertical scrolling and long-press explanation. */
export function setupSubtitleGestures(viewport, { onSwipe, onMove = () => {}, rotated = () => false } = {}) {
  let press = null, suppressUntil = 0;
  const point = (e) => rotated() ? [e.clientY, -e.clientX] : [e.clientX, e.clientY];
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.isPrimary === false) { press = null; return; }
    const art = e.target.closest('.s');
    if (!art) return;
    const [x, y] = point(e);
    press = { id: e.pointerId, i: +art.dataset.i, x, y, swiped: false };
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!press || press.id !== e.pointerId) return;
    const [x, y] = point(e), dx = x - press.x, dy = y - press.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) onMove();
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { press = null; return; }
    if (dx < -48 && -dx > Math.abs(dy) * 1.5) {
      press.swiped = true;
      viewport.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }
  });
  viewport.addEventListener('pointerup', (e) => {
    if (!press || press.id !== e.pointerId) return;
    const current = press;
    press = null;
    if (!current.swiped) return;
    suppressUntil = performance.now() + 500;
    onSwipe(current.i);
  });
  viewport.addEventListener('pointercancel', () => { press = null; });
  viewport.addEventListener('click', (e) => {
    if (performance.now() >= suppressUntil) return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
}
