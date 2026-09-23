import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  stdin: { contents: `
    export { openTrackSheet } from './web/js/ui.js';
    export { openSheet, closeSheet, sheetOpen } from './web/js/sheet.js';
    export { initTrackCfg, trackCfg } from './web/js/trackcfg.js';
    export { createTranslator } from './web/js/translate.js';
    export { videoPreview } from './web/js/video-preview.js';
    export { put } from './web/js/store.js';
    export { hash53 } from './web/js/util.js';
    export { Track } from './web/js/track.js';`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'SettingsTest',
});

function harness(t) {
  const dom = new JSDOM('<button id="opener">Settings</button>', {
    url: 'https://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.eval(outputFiles[0].text);
  const api = w.SettingsTest;
  const track = api.Track.fromData({ id: 'lesson', language: 'en', sentences: [
    { text: 'First sentence.', start: 0, end: 1 },
    { text: 'Second sentence.', start: 1, end: 2 },
  ] });
  const changes = [];
  api.initTrackCfg(track.id, track.lang, track.features, (...args) => changes.push(args));
  const row = (label) => [...w.document.querySelectorAll('.sheet .row')]
    .find((node) => node.querySelector('b')?.textContent === label);
  const close = () => w.document.querySelector('.sheet-head [aria-label="关闭"]').click();
  const frame = () => new Promise((resolve) => w.requestAnimationFrame(resolve));
  return { w, api, track, changes, row, close, frame };
}

for (const video of [false, true]) test(`${video ? 'video' : 'audio'} submenus return to settings and retain edits`, async (t) => {
  const h = harness(t);
  const title = video ? '视频设置' : '音频配置';
  const opener = h.w.document.getElementById('opener');
  opener.focus();
  h.api.openTrackSheet(h.track, { video });
  await h.frame();
  for (const label of ['字幕字号', '系统字幕字号', ...(video ? ['视频字幕布局'] : [])]) {
    h.row(label).click();
    const input = h.w.document.querySelector('.sheet input');
    input.value = label === '字幕字号' ? '30' : '28';
    input.dispatchEvent(new h.w.Event('change'));
    if (label === '字幕字号') {
      assert.equal(h.changes.length, 0, 'font relayout stays deferred inside the editor');
      h.w.document.querySelector('.sheet').dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(h.changes.filter(([key]) => key === 'fonts').length, 1);
    } else if (label === '系统字幕字号') h.w.document.querySelector('.scrim').click();
    else h.close();
    await h.frame();
    assert.equal(h.api.sheetOpen(), true);
    assert.equal(h.w.document.getElementById('sheetTitle').textContent, title);
    assert.ok(h.row(label));
  }
  assert.match(h.row('系统字幕字号').textContent, /28 px/);
  h.close();
  assert.equal(h.api.sheetOpen(), false);
  assert.equal(h.w.document.activeElement, opener);
});

test('replacing a submenu cleans it up without reopening its parent', (t) => {
  const h = harness(t), events = [];
  h.api.openSheet('Child', h.w.document.createElement('div'), {
    onClose: () => events.push('cleanup'), onBack: () => events.push('back'),
  });
  h.api.openSheet('Other', h.w.document.createElement('div'));
  assert.deepEqual(events, ['cleanup']);
  h.api.closeSheet();
  assert.deepEqual(events, ['cleanup']);
});

test('video preview defers resize writes and cancels them when the submenu closes', async (t) => {
  const h = harness(t);
  let notify, disconnected = false;
  h.w.ResizeObserver = class {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  const preview = h.api.videoPreview(h.w.document.createElement('div'), () => h.api.trackCfg.video);
  Object.defineProperty(preview.element, 'clientWidth', { value: 320 });
  notify(); notify();
  assert.equal(preview.element.style.height, '', 'observer callbacks must not resize their observed frame');
  await h.frame();
  assert.equal(preview.element.style.height, '180px');
  preview.element.style.height = '';
  notify();
  preview.dispose();
  await h.frame();
  assert.equal(disconnected, true);
  assert.equal(preview.element.style.height, '', 'closed previews must not apply queued layout writes');
});

test('first-open progress follows async cached translations, language resets and submenu returns', async (t) => {
  const h = harness(t), translator = h.api.createTranslator(h.track);
  translator.setEnabled(true, 'zh-CN');
  const write = (i, lang = 'zh-CN') => h.api.put('tr',
    `${h.track.id}|${lang}|${h.api.hash53(h.track.sentences[i].text)}`, `Translation ${i}`, h.track.id);
  const show = () => h.api.openTrackSheet(h.track, { translator });
  show();
  const firstProgress = h.row('翻译进度');
  assert.match(firstProgress.textContent, /0 \/ 2 句/);
  await write(0);
  translator.want(0, 0);
  await h.frame();
  assert.equal(h.row('翻译进度'), firstProgress, 'update the row without rebuilding settings');
  assert.match(firstProgress.textContent, /1 \/ 2 句/);

  h.row('系统字幕字号').click();
  await write(1);
  translator.want(1, 1);
  await h.frame();
  assert.match(firstProgress.textContent, /1 \/ 2 句/, 'detached settings unsubscribe');
  h.close();
  assert.match(h.row('翻译进度').textContent, /2 \/ 2 句/);

  translator.setEnabled(true, 'en');
  assert.match(h.row('翻译进度').textContent, /0 \/ 2 句/);
  await write(0, 'en');
  translator.want(0, 0);
  await h.frame();
  assert.match(h.row('翻译进度').textContent, /1 \/ 2 句/);
  const lastProgress = h.row('翻译进度');
  h.close();
  translator.setEnabled(false, 'ja');
  assert.match(lastProgress.textContent, /1 \/ 2 句/, 'closed settings unsubscribe');
  translator.stop();
});
