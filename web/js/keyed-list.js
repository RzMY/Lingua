/** Keep unchanged cards (and their focus) through metadata refreshes and searches. */
export function createKeyedList(root) {
  let cache = new Map();
  const render = (entries) => {
    const next = new Map();
    for (const { key, value, create, update } of entries) {
      const previous = cache.get(key);
      const signature = JSON.stringify(value);
      let node = previous?.node;
      if (!previous) node = create();
      else if (previous.signature !== signature) {
        if (update) update(node);
        else node = create();
      }
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
  // A caller that updates a live node in place can acknowledge its new data without
  // replacing that node (and its editing host) on the next unchanged refresh.
  render.updateValue = (key, value) => {
    const entry = cache.get(key);
    if (entry) entry.signature = JSON.stringify(value);
  };
  return render;
}
