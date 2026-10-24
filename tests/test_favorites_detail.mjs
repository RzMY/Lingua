import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { createFakeIndexedDB } from './idb_fake.mjs';

const { outputFiles } = await build({
  stdin: { contents: `
    export { openFavoriteDetail } from './web/js/favorites-detail.js';
    export { favoriteDraft, saveFavorite, getFavorite } from './web/js/favorites.js';
    export { openSheet, closeSheet, sheetOpen } from './web/js/sheet.js';
    export { Track } from './web/js/track.js';`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'FavoriteDetailTest',
});
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve)); };

async function harness(t) {
  const dom = new JSDOM('<button id="opener">Open</button>', {
    url: 'https://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, fake = createFakeIndexedDB();
  w.indexedDB = fake;
  w.structuredClone = structuredClone;
  w.console.warn = () => {};
  w.eval(outputFiles[0].text);
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); });
  const api = w.FavoriteDetailTest;
  const track = api.Track.fromData({ id: 'lesson', lang: { code: 'en' },
    sentences: [{ text: 'Keep going.', start: 1, end: 4 }] });
  const f = await api.saveFavorite({ ...api.favoriteDraft({ track, i: 0 }), note: '原笔记' });
  let saves = 0;
  const opener = w.document.querySelector('#opener'); opener.focus();
  const open = (value = f) => api.openFavoriteDetail(value, { onSave: () => { saves++; } });
  open(); await flush();
  const find = (selector) => w.document.querySelector(selector);
  const button = (text) => [...w.document.querySelectorAll('.sheet button')].find((node) => node.textContent === text);
  const close = () => find('.sheet-head [aria-label="关闭"]').click();
  const edit = (value = '新笔记') => {
    const input = find('textarea'); input.value = value;
    input.dispatchEvent(new w.Event('input', { bubbles: true })); return input;
  };
  return { w, fake, api, f, opener, open, find, button, close, edit, get saves() { return saves; } };
}

for (const method of ['button', 'scrim', 'Escape', 'drag', 'api']) {
  test(`unsaved notes prompt on ${method} close and discard preserves stored content`, async (t) => {
    const h = await harness(t); h.edit('新笔记\n<img src=x>');
    if (method === 'button') h.close();
    if (method === 'scrim') h.find('.scrim').click();
    if (method === 'Escape') h.find('.sheet').dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (method === 'api') h.api.closeSheet();
    if (method === 'drag') {
      const grip = h.find('.sheet-grip'); grip.setPointerCapture = () => {};
      for (const [type, y] of [['pointerdown', 0], ['pointermove', 130], ['pointerup', 130]]) {
        const event = new h.w.Event(type, { bubbles: true });
        Object.assign(event, { pointerId: 1, clientY: y }); grip.dispatchEvent(event);
      }
    }
    assert.equal(h.api.sheetOpen(), true);
    assert.equal(h.find('#sheetTitle').textContent, '保存更改？');
    assert.equal(h.find('.confirm-t').textContent, '笔记尚未保存。');
    assert.equal(h.find('.sheet img'), null);
    assert.equal(h.w.document.activeElement, h.button('保存'));
    h.button('放弃更改').click();
    assert.equal(h.api.sheetOpen(), false);
    assert.equal((await h.api.getFavorite(h.f.id)).note, '原笔记');
    assert.equal(h.saves, 0);
    assert.equal(h.w.document.activeElement, h.opener);
  });
}

test('unchanged notes and edits restored to their original text close without a prompt', async (t) => {
  const h = await harness(t); h.close();
  assert.equal(h.api.sheetOpen(), false);
  h.open(); h.edit(); h.edit('原笔记'); h.close();
  assert.equal(h.api.sheetOpen(), false);
});

test('closing the prompt restores the same draft, scroll position and editor focus', async (t) => {
  const h = await harness(t), input = h.edit('草稿\n第二行');
  h.find('.sheet-body').scrollTop = 120;
  h.close(); h.close();
  assert.equal(h.find('#sheetTitle').textContent, '收藏详情');
  assert.equal(h.find('textarea'), input);
  assert.equal(input.value, '草稿\n第二行');
  assert.equal(h.find('.sheet-body').scrollTop, 120);
  assert.equal(h.w.document.activeElement, input);
  h.close(); h.find('.scrim').click();
  assert.equal(h.find('textarea'), input);
  h.close(); h.find('.sheet').dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.find('textarea'), input);
});

for (const prompt of [false, true]) test(`${prompt ? 'prompt' : 'explicit'} save waits for commit and submits once`, async (t) => {
  const h = await harness(t), input = h.edit('');
  if (prompt) h.close();
  h.fake.holdCommit = (tx) => tx.names.includes('favorites');
  const save = h.button(prompt ? '保存' : '保存笔记'); save.click(); save.click();
  await flush();
  assert.equal(h.api.sheetOpen(), true);
  assert.equal(input.disabled, true);
  h.close();
  assert.equal(h.api.sheetOpen(), true);
  assert.equal(h.fake.stalledCommits.length, 1);
  assert.equal(h.saves, 0);
  const tx = h.fake.stalledCommits.pop(); h.fake.holdCommit = null; tx.commit();
  await flush();
  assert.equal(h.api.sheetOpen(), false);
  assert.equal((await h.api.getFavorite(h.f.id)).note, '');
  assert.equal(h.saves, 1);
});

test('failed save keeps the draft and stored note, with a working retry', async (t) => {
  const h = await harness(t); h.edit(); h.close();
  h.fake.holdCommit = (tx) => tx.names.includes('favorites');
  h.button('保存').click(); await flush();
  h.fake.stalledCommits.pop().abortWith(new Error('quota')); h.fake.holdCommit = null;
  await flush();
  assert.equal(h.api.sheetOpen(), true);
  assert.equal(h.find('#sheetTitle').textContent, '收藏详情');
  assert.equal(h.find('textarea').value, '新笔记');
  assert.equal(h.find('textarea').disabled, false);
  assert.equal(h.w.document.activeElement, h.find('textarea'));
  assert.equal((await h.api.getFavorite(h.f.id)).note, '原笔记');
  h.close(); h.button('保存').click(); await flush();
  assert.equal(h.api.sheetOpen(), false);
  assert.equal((await h.api.getFavorite(h.f.id)).note, '新笔记');
  assert.equal(h.saves, 1);
});

test('pagehide cleans up unsaved notes and a late save cannot close another sheet', async (t) => {
  const h = await harness(t); h.edit();
  h.w.dispatchEvent(new h.w.Event('pagehide'));
  assert.equal(h.api.sheetOpen(), false);
  h.open(); h.edit(); h.close();
  h.fake.holdCommit = (tx) => tx.names.includes('favorites');
  h.button('保存').click(); await flush();
  h.api.openSheet('其他面板', h.w.document.createElement('div'));
  const tx = h.fake.stalledCommits.pop(); h.fake.holdCommit = null; tx.commit(); await flush();
  assert.equal(h.api.sheetOpen(), true);
  assert.equal(h.find('#sheetTitle').textContent, '其他面板');
});
