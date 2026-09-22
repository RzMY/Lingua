import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createKeyedList } from '../web/js/keyed-list.js';

test('library refresh keeps unchanged cards and keyboard focus, replacing only edited metadata', () => {
  const { document } = new JSDOM('<main></main>').window;
  const root = document.querySelector('main');
  const render = createKeyedList(root);
  let created = 0;
  const entry = (key, title) => ({ key, value: { title }, create() {
    created++;
    const node = document.createElement('button');
    node.textContent = title;
    return node;
  } });
  render([entry('a', 'First'), entry('b', 'Second')]);
  const [first, second] = root.children;
  second.focus();
  render([entry('a', 'First'), entry('b', 'Second')]);
  assert.equal(created, 2);
  assert.equal(document.activeElement, second);
  render([entry('a', 'Renamed'), entry('b', 'Second')]);
  assert.equal(created, 3);
  assert.equal(first.isConnected, false);
  assert.equal(root.lastChild, second);
  assert.equal(document.activeElement, second);
});

test('search, reordering and deletion produce the requested order without stale cards', () => {
  const { document } = new JSDOM('<main></main>').window;
  const root = document.querySelector('main');
  const render = createKeyedList(root);
  const entries = (keys) => keys.map((key) => ({ key, value: key, create() {
    const node = document.createElement('div'); node.textContent = key; return node;
  } }));
  render(entries(['a', 'b', 'c']));
  const last = root.lastChild;
  render(entries(['c', 'a', 'd']));
  assert.equal(root.textContent, 'cad');
  assert.equal(root.firstChild, last);
  render(entries(['d']));
  assert.equal(root.textContent, 'd');
  render(entries([]));
  assert.equal(root.children.length, 0);
  render(entries(['a', 'b']));
  assert.equal(root.textContent, 'ab');
});
