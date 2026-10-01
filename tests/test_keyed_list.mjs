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

test('an acknowledged in-place rename retains the editing host and focus on refresh', () => {
  const { document } = new JSDOM('<main></main>').window;
  const root = document.querySelector('main');
  const render = createKeyedList(root);
  const entry = (title) => ({ key: 'track', value: { title }, create() {
    const node = document.createElement('input'); node.value = title; return node;
  } });
  render([entry('Original')]);
  const node = root.firstChild;
  node.value = 'Saved';
  render.updateValue('track', { title: 'Saved' });
  node.value = 'Next draft';
  node.focus();
  render([entry('Saved')]);
  assert.equal(root.firstChild, node);
  assert.equal(document.activeElement, node);
  assert.equal(node.value, 'Next draft');
  render([entry('External change')]);
  assert.notEqual(root.firstChild, node);
  assert.equal(root.firstChild.value, 'External change');
});

test('changed metadata can update a card without detaching its focused editor or menu anchor', () => {
  const { document } = new JSDOM('<main></main>').window;
  const root = document.querySelector('main');
  const render = createKeyedList(root);
  let created = 0;
  const entry = (duration) => ({ key: 'track', value: { duration }, create() {
    created++;
    const node = document.createElement('article');
    node.append(document.createElement('button'), document.createElement('input'));
    node.dataset.duration = duration;
    return node;
  }, update(node) { node.dataset.duration = duration; } });
  render([entry(0)]);
  const node = root.firstChild, anchor = node.firstChild, editor = node.lastChild;
  editor.value = 'Unsaved draft';
  editor.focus();
  render([entry(90)]);
  assert.equal(created, 1);
  assert.equal(root.firstChild, node);
  assert.equal(root.firstChild.firstChild, anchor);
  assert.equal(document.activeElement, editor);
  assert.equal(editor.value, 'Unsaved draft');
  assert.equal(node.dataset.duration, '90');
});
