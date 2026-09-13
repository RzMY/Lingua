import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepRow } from '../web/js/rows.js';

function fixture(t, initial = 25) {
  const doc = { activeElement: null };
  class Node extends EventTarget {
    children = [];
    value = '';
    disabled = false;
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {}
    get valueAsNumber() { return this.value.trim() ? Number(this.value) : NaN; }
    blur() {
      if (doc.activeElement !== this) return;
      doc.activeElement = null;
      this.dispatchEvent(new Event('change'));
    }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  }
  doc.createElement = doc.createElementNS = () => new Node();
  globalThis.document = doc;
  t.after(() => { delete globalThis.document; });
  let value = initial;
  const row = stepRow('Font size', '', () => value, (next) => { value = next; },
    { min: 8, max: 64, step: 0.5, unit: 'px' });
  const [minus, input, , plus] = row.children[1].children;
  return {
    input, minus, plus, get: () => value,
    type(next) {
      doc.activeElement = input;
      input.value = next;
      input.dispatchEvent(new Event('input'));
    },
  };
}

test('typing a new size re-enables a step button disabled by the saved boundary', (t) => {
  for (const [initial, direction, expected] of [[8, 'minus', 47.5], [64, 'plus', 48.5]]) {
    const form = fixture(t, initial);
    assert.equal(form[direction].disabled, true);
    form.type('48');
    assert.equal(form.get(), initial);
    assert.equal(form[direction].disabled, false);
    form[direction].click();
    assert.equal(form.get(), expected);
    assert.equal(form.input.value, String(expected));
  }
});

test('a step commits and blurs a number field still focused on touch browsers', (t) => {
  const form = fixture(t);
  form.type('36.2');
  form.plus.click();
  assert.equal(form.get(), 36.5);
  assert.equal(form.input.value, '36.5');
  assert.equal(document.activeElement, null);
});

test('manual input followed by repeated steps stays bounded and remains editable', (t) => {
  const form = fixture(t);
  form.type('60');
  for (let i = 0; i < 20; i++) form.plus.click();
  assert.equal(form.get(), 64);
  assert.equal(form.plus.disabled, true);
  form.type('12');
  for (let i = 0; i < 20; i++) form.minus.click();
  assert.equal(form.get(), 8);
  assert.equal(form.minus.disabled, true);
  form.type('30');
  for (let i = 0; i < 12; i++) form.minus.click();
  for (let i = 0; i < 12; i++) form.plus.click();
  assert.equal(form.get(), 30);
  assert.equal(form.input.value, '30');
});

test('empty or invalid pending input does not block subsequent steps', (t) => {
  const form = fixture(t);
  for (const input of ['', 'invalid']) {
    form.type(input);
    form.plus.click();
    form.minus.click();
    assert.equal(form.get(), 25);
    assert.equal(form.input.value, '25');
  }
});
