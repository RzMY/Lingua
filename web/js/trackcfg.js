/**
 * 按音频记的显示配置 —— 播放页右上角那个「当前音频」面板.
 *
 * 每条音频一把 localStorage key (`linguatrack.track.<id>`), 于是翻译开关、目标语言、
 * 注音层不会互相污染, 删掉音频时一起清掉。缺项回落到设置页里**这门源语言**的默认值
 * (`config.langs[code]`), 所以「日语默认开假名、英语默认关音标」这种习惯能各自记住。
 *
 * 两个显示层是通用的, 不再叫 kana/rom:
 *
 * * `read`  —— 上层注音 (日语=假名, 英法德西=音标, 韩语=标准发音);
 * * `roman` —— 下层转写 (日语=罗马音, 韩语=罗马字, 拉丁语族=原形)。
 *
 * 支持哪几层由**这条音频自己的** `track.json` (`lang.features`) 说了算, 而不是当前的
 * 语言目录 —— 后端加了一层之后, 之前建的音频里没有那一层的数据, 不该冒出一个点不亮的
 * 开关 (重新分析一次才会有)。不支持的层会被强制关掉并且存不进去。
 *
 * 四个开关最终写到 `<html>` 的 data-* 上, 由 CSS 决定显隐; JS 侧只有
 * `metrics`/`virtual` 会读 `data-tr` 等来算高度。另外还写两个只读的样式钩子:
 * `data-lang` (选字体) 与 `data-space` (分词语言的词间距要更宽)。
 */

import { config, langDefaults } from './config.js';
import { sourceSpec } from './langs.js';
import { FONT_DEFAULTS, fontSizes, normFontSize, normalizeFonts, setFontContext } from './settings.js';
import { normalizeVideo } from './video-config.js';

const PREFIX = 'linguatrack.track.';

/** 会持久化的键 (其余字段来自 track.json, 每次打开重新取). */
const SAVED = ['tr', 'read', 'roman', 'pos', 'card'];

/** 改这些键会影响句子高度, 播放页要重排虚拟列表. */
const LAYOUT = new Set(['tr', 'read', 'roman']);

/** 当前生效的配置; 播放页只会有一条音频, 所以放模块级. */
export const trackCfg = {
  id: '',
  srcLang: '',      // 这条音频的源语言 (来自 track.json)
  script: 'latin',
  space: 0,         // 源语言是否用空格分词
  tr: 0,            // 译文 + 是否允许调 LLM 翻译
  read: 1,
  roman: 1,
  pos: 1,
  card: 1,          // 点词是否弹释义卡片
  lang: 'zh-CN',    // 译文语言
  fonts: {},       // 只保存这条音频明确调整过的字号
  video: normalizeVideo(),
};

const bit = (v, fallback) => (v === undefined || v === null ? fallback : (v ? 1 : 0));

/** 这条音频支持的开关集合; 空数组表示「没说」, 那就都当支持. */
let supported = new Set(SAVED);

export const cfgSupports = (key) => supported.has(key);

/**
 * 某条音频的初始配置 = 源语言默认值 + 本地存档.
 * @param {string} id
 * @param {string} srcLang 源语言代码
 */
export function readTrackCfg(id, srcLang = '') {
  const out = { ...langDefaults(srcLang), id, lang: config.targetLang || 'zh-CN', fonts: {}, video: normalizeVideo() };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFIX + id) || 'null');
    if (saved && typeof saved === 'object') {
      for (const k of SAVED) if (saved[k] !== undefined) out[k] = bit(saved[k], out[k]);
      if (typeof saved.lang === 'string' && saved.lang) out.lang = saved.lang;
      out.fonts = normalizeFonts(saved.fonts);
      out.video = normalizeVideo(saved.video);
    }
  } catch { /* 坏了就用默认 */ }
  return out;
}

let onChange = () => {};
let fontEdit = null;

/** 字号菜单只更新存档与局部预览, 退出时再统一重排阅读区。 */
export function deferTrackFontSizes() {
  const edit = { id: trackCfg.id, fonts: { ...trackCfg.fonts } };
  fontEdit = edit;
  return () => {
    if (fontEdit !== edit) return;
    fontEdit = null;
    if (trackCfg.id !== edit.id) return;
    const before = fontSizes(trackCfg.srcLang, edit.fonts);
    const after = fontSizes(trackCfg.srcLang, trackCfg.fonts);
    applyTrackCfg();
    if (Object.keys(FONT_DEFAULTS).some((key) => before[key] !== after[key])) {
      onChange('fonts', trackCfg.fonts, true);
    }
  };
}

/**
 * 播放页启动时调一次: 载入 + 应用.
 * @param {string} id
 * @param {string} srcLang  这条音频的源语言 (track.json 里的 `lang.code`)
 * @param {string[]} features 这门语言支持哪些开关 (track.json 里的 `lang.features`)
 * @param {Function} handler `(key, value, needsRelayout) => void`
 */
export function initTrackCfg(id, srcLang = '', features = null, handler = null) {
  fontEdit = null;
  onChange = handler || onChange;
  supported = new Set(Array.isArray(features) && features.length ? features : SAVED);
  const spec = sourceSpec(srcLang);
  Object.assign(trackCfg, readTrackCfg(id, srcLang), {
    srcLang: srcLang || spec.code,
    script: spec.script || 'latin',
    space: spec.spaceDelimited ? 1 : 0,
  });
  // 这门语言没有的层就别亮着 —— 开着也没内容可显示
  for (const key of SAVED) if (!supported.has(key)) trackCfg[key] = 0;
  applyTrackCfg();
  return trackCfg;
}

function save() {
  if (!trackCfg.id) return;
  const out = { lang: trackCfg.lang };
  if (Object.keys(trackCfg.fonts).length) out.fonts = trackCfg.fonts;
  out.video = trackCfg.video;
  for (const k of SAVED) if (supported.has(k)) out[k] = trackCfg[k];
  try {
    localStorage.setItem(PREFIX + trackCfg.id, JSON.stringify(out));
  } catch { /* 隐私模式 */ }
}

export function applyTrackCfg() {
  const d = document.documentElement.dataset;
  d.tr = String(trackCfg.tr);
  d.read = String(trackCfg.read);
  d.roman = String(trackCfg.roman);
  d.pos = String(trackCfg.pos);
  if (trackCfg.srcLang) d.lang = trackCfg.srcLang;
  d.space = String(trackCfg.space);
  setFontContext(trackCfg.srcLang, fontEdit ? fontEdit.fonts : trackCfg.fonts);
}

export function setTrackFontSize(key, value) {
  if (!trackCfg.id || !Object.hasOwn(FONT_DEFAULTS, key)) return;
  if (key !== 'textSize' && !supported.has(key.slice(0, -4))) return;
  const current = fontSizes(trackCfg.srcLang, trackCfg.fonts)[key];
  const next = normFontSize(value, current);
  if (next === current) return;
  trackCfg.fonts = { ...trackCfg.fonts, [key]: next };
  save();
  if (fontEdit) return;
  applyTrackCfg();
  onChange(key, next, true);
}

export function resetTrackFontSizes() {
  if (!Object.keys(trackCfg.fonts).length) return;
  trackCfg.fonts = {};
  save();
  if (fontEdit) return;
  applyTrackCfg();
  onChange('fonts', trackCfg.fonts, true);
}

/** 改一项; 第三个回调参数表示这次改动会影响句子高度. */
export function setTrackCfg(key, value) {
  if (!(key in trackCfg) || trackCfg[key] === value) return;
  if (SAVED.includes(key) && !supported.has(key)) return;
  trackCfg[key] = value;
  save();
  applyTrackCfg();
  onChange(key, value, LAYOUT.has(key));
}

/** Video fields are bounded before persistence; they never modify subtitle font overrides. */
export function setVideoCfg(fields) {
  const next = normalizeVideo({ ...trackCfg.video, ...fields });
  if (JSON.stringify(next) === JSON.stringify(trackCfg.video)) return;
  trackCfg.video = next;
  save();
  onChange('video', next, false);
}

/** 删音频时顺手清掉它的配置. */
export function dropTrackCfg(id) {
  try { localStorage.removeItem(PREFIX + id); } catch { /* 忽略 */ }
}
