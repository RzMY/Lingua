import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const { outputFiles } = await build({
  stdin: { contents: `export { openSubtitleEditor } from './web/js/subtitle-edit-ui.js';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'SubtitleEditTest',
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, defaults = {}, onSave = () => {}) {
  const dom = new JSDOM('', { url: 'https://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  t.after(() => w.close());
  w.eval(outputFiles[0].text);
  w.SubtitleEditTest.openSubtitleEditor({ text: 'Hello.', translation: '你好', hasAnalysis: true,
    reanalyze: false, retranslate: false, ...defaults }, { onSave });
  const doc = w.document;
  const [source, translation] = doc.querySelectorAll('.subtitle-editor textarea');
  const analysis = doc.querySelector('[aria-label="重新分析"]');
  const retranslate = doc.querySelector('[aria-label="重新翻译"]');
  const save = doc.querySelector('.sheet-foot .btn-main');
  const input = (node, text) => { node.value = text; node.dispatchEvent(new w.Event('input', { bubbles: true })); };
  return { doc, source, translation, analysis, retranslate, save, input };
}

test('both switches start unchecked without small-print hints', (t) => {
  const h = harness(t);
  for (const button of [h.analysis, h.retranslate]) {
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(button.disabled, false);
    assert.equal(button.closest('.row').querySelector('.row-label span'), null);
  }
});

for (const manuallyOn of [true, false]) {
  test(`source edits lock reanalysis on an analyzed sentence with manual choice ${manuallyOn}`, async (t) => {
    const saved = [];
    const h = harness(t, {}, (values) => saved.push({ ...values }));
    assert.equal(h.analysis.disabled, false);
    if (manuallyOn) h.analysis.click();
    h.input(h.source, 'Corrected text.');
    assert.equal(h.analysis.getAttribute('aria-pressed'), 'true');
    assert.equal(h.analysis.disabled, true);
    assert.equal(h.analysis.closest('.row').querySelector('.row-label span'), null);
    h.analysis.click();
    assert.equal(h.analysis.getAttribute('aria-pressed'), 'true');
    assert.equal(h.retranslate.disabled, false);
    h.save.click();
    await flush();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].reanalyze, true);
    assert.equal(saved[0].retranslate, true);
  });
}

test('restoring the source unlocks reanalysis and restores the previous choice', (t) => {
  const h = harness(t);
  h.input(h.source, 'Corrected text.');
  h.input(h.source, '  Hello.  ');
  assert.equal(h.analysis.disabled, false);
  assert.equal(h.analysis.getAttribute('aria-pressed'), 'false');
  assert.equal(h.retranslate.getAttribute('aria-pressed'), 'false');
  h.analysis.click();
  h.input(h.source, 'Another correction.');
  h.input(h.source, 'Hello.');
  assert.equal(h.analysis.disabled, false);
  assert.equal(h.analysis.getAttribute('aria-pressed'), 'true');
});

test('translation-only edits do not force reanalysis', async (t) => {
  let saved;
  const h = harness(t, {}, (values) => { saved = { ...values }; });
  h.retranslate.click();
  h.input(h.translation, '新译文');
  assert.equal(h.analysis.disabled, false);
  assert.equal(h.analysis.getAttribute('aria-pressed'), 'false');
  h.save.click();
  await flush();
  assert.equal(saved.reanalyze, false);
  assert.equal(saved.retranslate, false);
  assert.equal(saved.translation, '新译文');
});

test('unanalyzed tracks keep reanalysis optional after source edits', async (t) => {
  let saved;
  const h = harness(t, { hasAnalysis: false, reanalyze: false }, (values) => { saved = { ...values }; });
  h.input(h.source, 'Corrected text.');
  assert.equal(h.analysis.disabled, false);
  assert.equal(h.analysis.getAttribute('aria-pressed'), 'false');
  h.analysis.click(); h.analysis.click();
  assert.equal(h.retranslate.getAttribute('aria-pressed'), 'true');
  h.retranslate.click();
  h.save.click();
  await flush();
  assert.equal(saved.reanalyze, false);
  assert.equal(saved.retranslate, false);
});

for (const order of ['source-first', 'translation-first']) {
  test(`${order}: manual translation changes keep retranslation off, including clearing`, async (t) => {
    let saved;
    const h = harness(t, {}, (values) => { saved = { ...values }; });
    if (order === 'source-first') {
      h.input(h.source, 'Corrected text.');
      assert.equal(h.retranslate.getAttribute('aria-pressed'), 'true');
    }
    h.input(h.translation, '人工译文');
    if (order === 'translation-first') h.input(h.source, 'Corrected text.');
    assert.equal(h.retranslate.getAttribute('aria-pressed'), 'false');
    h.input(h.source, 'Another correction.');
    assert.equal(h.retranslate.getAttribute('aria-pressed'), 'false');
    h.input(h.translation, '');
    assert.equal(h.retranslate.getAttribute('aria-pressed'), 'false');
    h.save.click();
    await flush();
    assert.equal(saved.retranslate, false);
    assert.equal(saved.translation, '');
  });
}

test('restoring fields recomputes retranslation from the current draft', (t) => {
  const h = harness(t);
  h.input(h.source, 'Corrected text.');
  h.input(h.translation, '新译文');
  assert.equal(h.retranslate.getAttribute('aria-pressed'), 'false');
  h.input(h.translation, '  你好  ');
  assert.equal(h.retranslate.getAttribute('aria-pressed'), 'true');
  h.input(h.source, '  Hello.  ');
  assert.equal(h.retranslate.getAttribute('aria-pressed'), 'false');
  assert.equal(h.analysis.disabled, false);
});

test('retranslation remains manually selectable after automatic changes', async (t) => {
  let saved;
  const h = harness(t, {}, (values) => { saved = { ...values }; });
  h.input(h.source, 'Corrected text.');
  h.retranslate.click();
  assert.equal(h.retranslate.getAttribute('aria-pressed'), 'false');
  h.retranslate.click();
  h.input(h.translation, '新译文');
  assert.equal(h.retranslate.getAttribute('aria-pressed'), 'false');
  assert.equal(h.retranslate.disabled, false);
  h.retranslate.click();
  h.save.click();
  await flush();
  assert.equal(saved.retranslate, true);
});

test('failed saves preserve the forced switch and the edited draft for retry', async (t) => {
  let attempts = 0;
  const h = harness(t, {}, () => { attempts++; throw new Error('分析服务不可用'); });
  h.input(h.source, 'Corrected text.');
  for (let i = 0; i < 2; i++) {
    h.save.click();
    await flush();
    assert.equal(h.source.value, 'Corrected text.');
    assert.equal(h.analysis.disabled, true);
    assert.equal(h.analysis.getAttribute('aria-pressed'), 'true');
    assert.equal(h.save.disabled, false);
    assert.match(h.doc.querySelector('[role="status"]').textContent, /分析服务不可用/);
  }
  assert.equal(attempts, 2);
});
