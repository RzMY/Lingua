import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  stdin: { contents: `
    export { openTrackSheet } from './web/js/ui.js';
    export { openFontSheet } from './web/js/font-settings.js';
    export { settings, initSettings, setGlobalVideo, setLangFontSize, captionSize, setLangCaptionSize } from './web/js/settings.js';
    export { config, setConfig } from './web/js/config.js';
    export { sourceLangs, mergeCatalog } from './web/js/langs.js';
    export { openSheet, closeSheet, sheetOpen } from './web/js/sheet.js';
    export { initTrackCfg, trackCfg, readTrackCfg, setVideoCfg, setTrackCfg } from './web/js/trackcfg.js';
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
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
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
  assert.equal(h.row('发音设置').closest('.rows').previousElementSibling.textContent, video ? '当前视频' : '当前音频');
  h.row('发音设置').click();
  h.w.document.querySelector('[aria-label="打开词卡自动发音"]').click();
  assert.equal(h.api.trackCfg.pronunciation.autoPlay, true);
  h.close();
  assert.equal(h.w.document.getElementById('sheetTitle').textContent, title);
  h.changes.length = 0;
  assert.equal(h.row('系统字幕字号'), undefined, 'caption settings share the font submenu');
  for (const label of ['字幕字号', ...(video ? ['视频字幕布局'] : [])]) {
    h.row(label).click();
    const input = h.w.document.querySelector('.sheet input');
    input.value = label === '字幕字号' ? '30' : '28';
    input.dispatchEvent(new h.w.Event('change'));
    if (label === '字幕字号') {
      assert.equal(h.changes.length, 0, 'font relayout stays deferred inside the editor');
      const caption = h.row('系统字幕字号').querySelector('input');
      caption.value = '28'; caption.dispatchEvent(new h.w.Event('change'));
      assert.equal(h.api.trackCfg.video.captionSize, 28);
      assert.equal(h.changes.filter(([key]) => key === 'video').length, 1, 'system captions update immediately');
      h.w.document.querySelector('.sheet').dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(h.changes.filter(([key]) => key === 'fonts').length, 1);
    } else h.close();
    await h.frame();
    assert.equal(h.api.sheetOpen(), true);
    assert.equal(h.w.document.getElementById('sheetTitle').textContent, title);
    assert.ok(h.row(label));
  }
  assert.equal(h.row('系统字幕字号'), undefined);
  h.row('字幕字号').click();
  assert.equal(h.row('系统字幕字号').querySelector('input').value, '28');
  h.w.document.querySelector('.scrim').click();
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

test('global font languages refresh both previews and retain independent ordinary and system sizes', (t) => {
  const h = harness(t), api = h.api, doc = h.w.document;
  h.w.localStorage.setItem('linguatrack.settings.v1', JSON.stringify({ video: { captionSize: 26, position: 60 } }));
  api.initSettings();
  api.setConfig({ importLang: 'ja', targetLang: 'zh-TW' });
  api.openFontSheet();
  const change = (label, value) => {
    const input = h.row(label).querySelector('input');
    input.value = String(value); input.dispatchEvent(new h.w.Event('change'));
  };
  const list = api.sourceLangs();
  for (const [index, spec] of list.entries()) {
    doc.querySelector(`.font-languages [data-value="${spec.code}"]`).click();
    assert.equal(doc.querySelector('.font-preview').lang, spec.code);
    assert.equal(doc.querySelector('.caption-preview-text').lang, spec.code);
    assert.equal(doc.querySelector('.caption-preview').dataset.lang, spec.code);
    assert.equal(doc.querySelector('.caption-preview-tr').textContent, '我們聽了音樂');
    assert.equal(doc.querySelector('.caption-preview-tr').lang, 'zh-TW');
    const text = [...doc.querySelectorAll('.font-preview-text')].map((node) => node.textContent)
      .join(spec.spaceDelimited ? ' ' : '');
    assert.equal(doc.querySelector('.caption-preview-text').textContent, text);
    for (const layer of spec.layerOrder) assert.ok(h.row(spec.layers[layer] + '字号'));
    change('原文字号', 30 + index);
    assert.equal(h.row('系统字幕字号').querySelector('input').value, '26', 'unconfigured languages inherit the old shared size');
    change('系统字幕字号', 28 + index);
    assert.equal(doc.querySelector('.caption-preview-text').style.fontSize, `${28 + index}px`);
  }
  for (const [index, spec] of list.entries()) {
    doc.querySelector(`.font-languages [data-value="${spec.code}"]`).click();
    assert.equal(h.row('原文字号').querySelector('input').value, String(30 + index));
    assert.equal(h.row('系统字幕字号').querySelector('input').value, String(28 + index));
  }
  assert.equal(api.config.importLang, 'ja', 'preview language does not change the import language');
  const fonts = JSON.stringify(api.settings.fonts);
  [...doc.querySelectorAll('.btn')].find((node) => node.textContent === '恢复默认系统字号').click();
  assert.equal(api.captionSize('ko'), 20);
  assert.equal(api.captionSize('ja'), 28);
  assert.equal(api.settings.video.captionSize, 26);
  assert.equal(api.settings.video.position, 60);
  assert.equal(JSON.stringify(api.settings.fonts), fonts);
  change('系统字幕字号', 29);
  [...doc.querySelectorAll('.btn')].find((node) => node.textContent === '恢复默认字号').click();
  assert.equal(h.row('原文字号').querySelector('input').value, '25');
  assert.equal(api.settings.fonts.en.textSize, 31);
  assert.equal(api.captionSize('ko'), 29);
  h.close();
  api.initSettings();
  api.openFontSheet();
  assert.equal(h.row('系统字幕字号').querySelector('input').value, '28');
});

test('current-media system preview follows its translation language and resets only the caption override', (t) => {
  const h = harness(t), api = h.api, doc = h.w.document;
  api.setGlobalVideo({ captionSize: 26, position: 60 });
  api.setLangCaptionSize('en', 27);
  api.setLangFontSize('en', 'textSize', 32);
  api.initTrackCfg(h.track.id, h.track.lang, h.track.features);
  api.setVideoCfg({ captionSize: 30, position: 45 });
  for (const [lang, text] of [['en', 'We listened to music'], ['ja', '私たちは音楽を聴きました'],
    ['ko', '우리는 음악을 들었어요'], ['zh-CN', '我们听了音乐'], ['zh-TW', '我們聽了音樂']]) {
    api.setTrackCfg('lang', lang);
    api.openFontSheet({ track: h.track });
    assert.equal(doc.querySelector('.font-languages'), null);
    assert.equal(doc.querySelector('.caption-preview-tr').textContent, text);
    assert.equal(doc.querySelector('.caption-preview-tr').lang, lang);
    assert.equal(h.row('系统字幕字号').querySelector('input').value, '30');
    h.close();
  }
  api.openFontSheet({ track: h.track });
  const input = h.row('原文字号').querySelector('input');
  input.value = '35'; input.dispatchEvent(new h.w.Event('change'));
  [...doc.querySelectorAll('.btn')].find((node) => node.textContent === '恢复语言默认系统字号').click();
  assert.equal(h.row('系统字幕字号').querySelector('input').value, '27');
  assert.equal(doc.querySelector('.caption-preview-text').style.fontSize, '27px');
  const saved = api.readTrackCfg(h.track.id, 'en');
  assert.equal(saved.video.captionSize, 27);
  assert.equal(saved.videoOverrides.captionSize, undefined);
  assert.equal(saved.videoOverrides.position, 45);
  assert.equal(saved.fonts.textSize, 35);
  assert.equal(api.readTrackCfg('other', 'ko').video.captionSize, 26);
});

test('new source languages use actual subtitles and their available layers in both font previews', (t) => {
  const h = harness(t), api = h.api, doc = h.w.document;
  const spec = { code: 'it', name: '意大利语', native: 'Italiano', spaceDelimited: true,
    layers: { roman: '词形' }, layerOrder: ['roman'], features: ['roman'] };
  api.mergeCatalog([spec]);
  api.setConfig({ importLang: 'it' });
  api.openFontSheet();
  assert.equal(doc.querySelector('.caption-preview-text').textContent, 'Italiano');
  assert.equal(doc.querySelector('.caption-preview-tr').hidden, true);
  assert.ok(h.row('词形字号'));
  assert.equal(h.row('译文字号'), undefined);
  const track = { lang: 'it', langName: '意大利语', space: true,
    layers: spec.layers, layerOrder: spec.layerOrder, features: spec.features,
    sentences: [{ words: [{ text: 'Ascoltiamo', roman: 'ascoltare' }, { text: 'musica' }] }] };
  api.initTrackCfg('italian', 'it', spec.features);
  api.openFontSheet({ track });
  assert.equal(doc.querySelector('.caption-preview-text').textContent, 'Ascoltiamo musica');
  assert.equal(doc.querySelector('.caption-preview-tr').hidden, true);
  assert.equal(doc.querySelector('.caption-preview-text').lang, 'it');
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

  h.row('字幕字号').click();
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
