import { el } from './util.js';
import { openSheet } from './sheet.js';
import { group, infoRow, sectionTitle, segRow, stepRow, button, buttonBar } from './rows.js';
import { config } from './config.js';
import { sourceLangs } from './langs.js';
import {
  applyFontSizes, fontSizes, setLangFontSize, resetLangFontSizes,
  FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP,
} from './settings.js';
import { trackCfg, setTrackFontSize, resetTrackFontSizes, deferTrackFontSizes } from './trackcfg.js';

// All examples describe the same sentence, so the translation preview needs no model request.
const SAMPLES = {
  ja: [
    ['私たち', 'わたしたち', 'watashitachi'], ['は', '', 'wa'],
    ['音楽', 'おんがく', 'ongaku'], ['を', '', 'o'],
    ['聴きました', 'ききました', 'kikimashita'],
  ],
  en: [
    ['We', 'wiː'], ['listened', 'ˈlɪsənd', 'listen'], ['to', 'tuː'], ['music', 'ˈmjuːzɪk'],
  ],
  es: [['Escuchamos', 'eskuˈtʃamos', 'escuchar'], ['música', 'ˈmusika']],
  fr: [
    ['Nous', 'nu'], ['avons', 'avɔ̃', 'avoir'], ['écouté', 'ekute', 'écouter'],
    ['de', 'də'], ['la', 'la'], ['musique', 'myzik'],
  ],
  de: [
    ['Wir', 'viːɐ̯'], ['haben', 'ˈhaːbən'], ['Musik', 'muˈziːk'], ['gehört', 'ɡəˈhøːɐ̯t', 'hören'],
  ],
  ko: [
    ['우리는', '우리는', 'urineun'], ['음악을', '으마글', 'eumageul'],
    ['들었어요', '드러써요', 'deureosseoyo'],
  ],
};
const TRANSLATIONS = {
  'zh-CN': '我们听了音乐', 'zh-TW': '我們聽了音樂',
  en: 'We listened to music', ja: '私たちは音楽を聴きました', ko: '우리는 음악을 들었어요',
};
const SIZE_OPT = { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: FONT_SIZE_STEP, unit: 'px' };

function previewSentence(spec, track, layers) {
  const preview = el('div', 'font-preview');
  preview.dataset.lang = spec.code;
  preview.dataset.space = spec.spaceDelimited === false ? '0' : '1';
  preview.lang = spec.code;
  preview.tabIndex = 0;
  preview.setAttribute('role', 'region');
  preview.setAttribute('aria-label', '字幕例句');
  const words = el('div', 'font-preview-words');
  const sample = SAMPLES[spec.code];
  const sentence = sample ? null : track?.sentences.find((s) => s.words.length);
  const entries = sample || sentence?.words.map((w) => [w.text, w.read, w.roman]) || [[spec.native || spec.name]];
  for (const [text, read, roman] of entries) {
    const word = el('span', 'font-preview-word');
    if (/^[.。!?！？,，]$/.test(text)) word.classList.add('font-preview-punct');
    if (layers.includes('read')) word.append(el('span', 'font-preview-read', read || ''));
    word.append(el('span', 'font-preview-text', text));
    if (layers.includes('roman')) word.append(el('span', 'font-preview-roman', roman || ''));
    words.append(word);
  }
  if (!layers.includes('read')) preview.style.setProperty('--lh-read', '0px');
  if (!layers.includes('roman')) preview.style.setProperty('--lh-roman', '0px');
  preview.append(words);
  if (layers.includes('tr')) {
    const target = track ? trackCfg.lang : config.targetLang;
    const translation = sample ? (TRANSLATIONS[target] || TRANSLATIONS['zh-CN']) : sentence?.translation;
    if (translation) {
      const tr = el('p', 'font-preview-tr', translation);
      tr.lang = target;
      preview.append(tr);
    }
  }
  return preview;
}

/**
 * 共用二级菜单; 播放页传入固定的语言与每条音频的写值器.
 *
 * 头部只留「关闭」那一枚 X: 二级菜单不需要第二个能离开本页的图标按钮
 * (以前那枚返回箭头在设置页里做的就是同一件事, 两个按钮挨在一起只会让人犹豫).
 */
export function openFontSheet({ track = null, onClose } = {}) {
  const list = sourceLangs();
  let code = list.find((spec) => spec.code === config.importLang)?.code || list[0].code;
  const body = el('div', 'font-pane');
  const content = el('div');
  let fitPreview = () => {};
  let fitFrame = 0;
  let finishFonts = () => {};
  const scheduleFit = () => {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => { fitFrame = 0; fitPreview(); });
  };
  if (track) {
    code = track.lang;
    body.append(infoRow('源语言', track.langName));
  } else {
    const languages = segRow('语言', '', () => code, (value) => { code = value; paint(); },
      list.map((spec) => [spec.code, spec.name]));
    languages.classList.add('font-languages', 'row-wrap');
    languages.querySelector('.segs').setAttribute('aria-label', '字幕字号语言');
    body.append(languages);
  }
  body.append(content);

  function paint() {
    const spec = track ? {
      code: track.lang, name: track.langName, spaceDelimited: track.space,
      layers: track.layers, layerOrder: track.layerOrder, features: track.features,
    } : list.find((item) => item.code === code);
    const supports = (key) => !spec.features?.length || spec.features.includes(key);
    const layers = ['text', ...(spec.layerOrder || []).filter((key) =>
      ['read', 'roman'].includes(key) && supports(key)), ...(supports('tr') ? ['tr'] : [])];
    const preview = previewSentence(spec, track, layers);
    const get = () => fontSizes(code, track ? trackCfg.fonts : {});
    fitPreview = () => {
      if (!preview.isConnected) return;
      // Transforms leave the measured grid widths unchanged, so fitting cannot reflow itself.
      const fitted = [];
      for (const word of preview.querySelectorAll('.font-preview-word')) {
        const style = getComputedStyle(word);
        const available = Math.max(0, word.clientWidth - parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) - 0.5);
        for (const span of word.children) {
          const width = span.scrollWidth;
          fitted.push([span, width > available && available > 0 ? available / width : 1]);
        }
      }
      for (const [span, scale] of fitted) span.style.transform = scale < 1 ? `scale(${scale})` : '';
    };
    const updatePreview = () => { applyFontSizes(get(), preview); scheduleFit(); };
    const rows = layers.map((layer) => {
      const label = layer === 'text' ? '原文' : layer === 'tr' ? '译文'
        : spec.layers?.[layer] || (layer === 'read' ? '注音' : '转写');
      const key = layer + 'Size';
      return stepRow(label + '字号', '', () => get()[key], (value) => {
        if (track) setTrackFontSize(key, value);
        else setLangFontSize(code, key, value);
        updatePreview();
      }, SIZE_OPT);
    });
    const reset = button(track ? '恢复语言默认字号' : '恢复默认字号', {
      glyph: 'i-refresh', onPick: () => {
        if (track) resetTrackFontSizes();
        else resetLangFontSizes(code);
        rows.forEach((row) => row.refresh());
        updatePreview();
      },
    });
    content.replaceChildren(sectionTitle('例句'), preview, group(...rows), buttonBar(reset));
    updatePreview();
  }

  paint();
  let previousWidth = 0;
  const observer = new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === previousWidth) return;
    previousWidth = entry.contentRect.width;
    scheduleFit();
  });
  openSheet(track ? '字幕字号 · 当前音频' : '字幕字号', body, {
    cls: 'sheet-tall', onClose: () => {
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      fitFrame = 0;
      finishFonts();
      onClose?.();
    },
  });
  if (track) finishFonts = deferTrackFontSizes();
  observer.observe(body);
  scheduleFit();
}
