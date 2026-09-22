/** Keep unchanged cards (and their focus) through metadata refreshes and searches. */
export function createKeyedList(root) {
  let cache = new Map();
  return (entries) => {
    const next = new Map();
    for (const { key, value, create } of entries) {
      const previous = cache.get(key);
      const signature = JSON.stringify(value);
      const node = previous?.signature === signature ? previous.node : create();
      next.set(key, { signature, node });
    }
    const keep = new Set(Array.from(next.values(), ({ node }) => node));
    for (const child of Array.from(root.childNodes)) if (!keep.has(child)) child.remove();
    let cursor = root.firstChild;
    for (const { node } of next.values()) {
      if (node === cursor) cursor = cursor.nextSibling;
      else if (root.moveBefore && node.parentNode === root) root.moveBefore(node, cursor);
      else {
        const focused = root.ownerDocument.activeElement;
        const restoreFocus = node.contains(focused);
        root.insertBefore(node, cursor);
        if (restoreFocus) focused.focus({ preventScroll: true });
      }
    }
    cache = next;
  };
}
