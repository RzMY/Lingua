/**
 * 全局显示设置 (每语言字号 / 主题 / 倍速) —— 存 localStorage, 通过 `<html>` 上的
 * `data-theme` 与各层的 `--fs-*` 驱动 CSS.
 *
 * 注意分工: 注音/转写/译文/词性这四层是**按音频**记的 (见 `trackcfg.js`),
 * 单音频字号覆盖也由 trackcfg.js 持有, 这里只负责合并字号并应用到 CSS。
 */

import { normalizeVideo, videoOverrides } from './video-config.js';

const KEY = 'linguatrack.settings.v1';

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 64;
export const FONT_SIZE_STEP = 0.5;
export const FONT_DEFAULTS = { textSize: 25, readSize: 12, romanSize: 11.5, trSize: 16.5 };
const FONT_CSS = {
  textSize: '--fs-text', readSize: '--fs-read', romanSize: '--fs-roman', trSize: '--fs-tr',
};

// 兼容旧三档与百分比存档, 辅助层沿用原来的六成缩放幅度.
const LEGACY_SIZE = { s: 88, m: 100, l: 120 };

const DEFAULTS = {
  // 旧全局字号保留为未设置语言的回退值。
  ...FONT_DEFAULTS,
  theme: 'auto',  // auto | light | dark
  rate: 1,
  track: '',      // 上次打开的曲目
};

/** px 字号: 有限数值、半像素精度, 空值或非法值保留回退值. */
export function normFontSize(v, fallback) {
  if ((typeof v !== 'number' && typeof v !== 'string') || String(v).trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n / FONT_SIZE_STEP) * FONT_SIZE_STEP));
}

function legacyFonts(size) {
  const n = typeof size === 'string' && Object.hasOwn(LEGACY_SIZE, size) ? LEGACY_SIZE[size] : Number(size);
  const valid = (typeof size === 'number' || (typeof size === 'string' && size.trim())) && Number.isFinite(n);
  const scale = valid ? Math.min(160, Math.max(72, Math.round(n))) / 100 : 1;
  return Object.fromEntries(Object.entries(FONT_DEFAULTS).map(([key, value]) => [key,
    normFontSize(value * (key === 'textSize' ? scale : 1 + (scale - 1) * .6), value),
  ]));
}

export const settings = { ...DEFAULTS, fonts: {}, video: normalizeVideo() };

let onChange = () => {};
let media = null;
let fontContext = { code: '', overrides: {} };
const languageCode = (code) => {
  const key = String(code || '').trim().toLowerCase();
  return /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(key) ? key : '';
};

/** 只保留有效的字号覆盖; 缺项继续继承上一级。 */
export function normalizeFonts(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const key of Object.keys(FONT_DEFAULTS)) {
    const size = normFontSize(value[key], undefined);
    if (size !== undefined) out[key] = size;
  }
  return out;
}

export function fontSizes(code = '', overrides = {}) {
  const defaults = Object.fromEntries(Object.keys(FONT_DEFAULTS).map((key) => [key, settings[key]]));
  return { ...defaults, ...settings.fonts[languageCode(code)], ...normalizeFonts(overrides) };
}

export function applyFontSizes(sizes, target = document.documentElement) {
  for (const [key, css] of Object.entries(FONT_CSS)) target.style.setProperty(css, sizes[key] + 'px');
}

/** 当前播放音频的字号作用域; 主题与倍速更新不能覆盖它。 */
export function setFontContext(code = '', overrides = {}) {
  fontContext = { code: languageCode(code), overrides };
  applyFontSizes(fontSizes(fontContext.code, overrides));
}

export function initSettings(handler) {
  onChange = handler || onChange;
  Object.assign(settings, DEFAULTS, { fonts: {}, video: normalizeVideo() });
  fontContext = { code: '', overrides: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      settings.video = normalizeVideo(saved.video);
      Object.assign(settings, legacyFonts(saved.size));
      for (const k of Object.keys(DEFAULTS)) {
        if (saved[k] === undefined) continue;
        settings[k] = Object.hasOwn(FONT_DEFAULTS, k) ? normFontSize(saved[k], settings[k]) : saved[k];
      }
      if (saved.fonts && typeof saved.fonts === 'object' && !Array.isArray(saved.fonts)) {
        for (const [code, sizes] of Object.entries(saved.fonts)) {
          const key = languageCode(code);
          if (key) settings.fonts[key] = normalizeFonts(sizes);
        }
      }
    }
  } catch { /* 忽略损坏的存档 */ }
  if (!media) {
    media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });
  }
  applyAll();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* 隐私模式 */ }
}

export function setGlobalVideo(fields) {
  settings.video = normalizeVideo({ ...settings.video, ...videoOverrides(fields) });
  save();
  onChange('video', settings.video, false);
}

export function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && media?.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = dark ? '#15170f' : '#f2f2ea';
}

export function applyAll() {
  applyFontSizes(fontSizes(fontContext.code, fontContext.overrides));
  applyTheme();
}

function saveLanguageFonts(code, next) {
  const previous = fontSizes(fontContext.code, fontContext.overrides);
  settings.fonts[code] = next;
  save();
  applyAll();
  const current = fontSizes(fontContext.code, fontContext.overrides);
  onChange('fonts', { code, ...next }, Object.keys(FONT_DEFAULTS).some((key) => previous[key] !== current[key]));
}

export function setLangFontSize(code, key, value) {
  code = languageCode(code);
  if (!code || !Object.hasOwn(FONT_DEFAULTS, key)) return;
  const current = fontSizes(code)[key];
  const next = normFontSize(value, current);
  if (next === current) return;
  saveLanguageFonts(code, { ...settings.fonts[code], [key]: next });
}

export function resetLangFontSizes(code) {
  code = languageCode(code);
  if (code) saveLanguageFonts(code, { ...FONT_DEFAULTS });
}

/** 修改一项设置; `layout` 表示会影响排版高度, 需要重排虚拟列表. */
export function setSetting(key, value) {
  if (!Object.hasOwn(DEFAULTS, key)) return;
  const layout = Object.hasOwn(FONT_DEFAULTS, key);
  const next = layout ? normFontSize(value, settings[key]) : value;
  if (settings[key] === next) return;
  settings[key] = next;
  save();
  applyAll();
  onChange(key, next, layout);
}
