/**
 * 源语言目录 —— 前端这一侧的语言清单.
 *
 * 后端 `pipeline/langs/registry.py` 是唯一权威, 但设置页在还没连上后端时也得能用,
 * 所以这里内置一份同样的清单; `/api/health` 回来后用 `mergeCatalog()` 覆盖并持久化,
 * 于是后端新加的语言会自动出现在设置里, 前端不用改代码。
 *
 * 每条语言最要紧的是 `layers`: 单词卡片上那两行可选文字 (上层注音 / 下层转写) 各叫
 * 什么、有没有。播放页优先用 `track.json` 自带的 `lang` 块 (那是这条音频建库时的
 * 真实情况), 这里的清单只服务「还没有音频」的场合。
 */

const KEY = 'linguatrack.langs.v1';

/** 与 pipeline/langs/registry.py 保持一致. */
export const DEFAULT_LANGS = [
  {
    code: 'ja', name: '日语', nameEn: 'Japanese', native: '日本語',
    script: 'kanji-kana', engine: 'mecab', spaceDelimited: false,
    layers: { read: '假名', roman: '罗马音' }, layerOrder: ['read', 'roman'],
    features: ['read', 'roman', 'tr', 'pos', 'card'],
  },
  {
    code: 'en', name: '英语', nameEn: 'English', native: 'English',
    script: 'latin', engine: 'spacy', spaceDelimited: true,
    layers: { read: '音标', roman: '原形' }, layerOrder: ['read', 'roman'],
    features: ['read', 'roman', 'tr', 'pos', 'card'],
  },
  {
    code: 'es', name: '西班牙语', nameEn: 'Spanish', native: 'Español',
    script: 'latin', engine: 'spacy', spaceDelimited: true,
    layers: { read: '音标', roman: '原形' }, layerOrder: ['read', 'roman'],
    features: ['read', 'roman', 'tr', 'pos', 'card'],
  },
  {
    code: 'fr', name: '法语', nameEn: 'French', native: 'Français',
    script: 'latin', engine: 'spacy', spaceDelimited: true,
    layers: { read: '音标', roman: '原形' }, layerOrder: ['read', 'roman'],
    features: ['read', 'roman', 'tr', 'pos', 'card'],
  },
  {
    code: 'de', name: '德语', nameEn: 'German', native: 'Deutsch',
    script: 'latin', engine: 'spacy', spaceDelimited: true,
    layers: { read: '音标', roman: '原形' }, layerOrder: ['read', 'roman'],
    features: ['read', 'roman', 'tr', 'pos', 'card'],
  },
  {
    code: 'ko', name: '韩语', nameEn: 'Korean', native: '한국어',
    script: 'hangul', engine: 'spacy', spaceDelimited: true,
    layers: { read: '发音', roman: '罗马字' }, layerOrder: ['read', 'roman'],
    features: ['read', 'roman', 'tr', 'pos', 'card'],
  },
];

/** 某个开关的界面文案; 注音/转写两层的标题跟着这门语言自己的层名走.
 *  (日语「假名 / 罗马音」, 韩语「发音 / 罗马字」, 英法德西「音标 / 原形」)
 *  @param {object} layers 这门语言的 `layers` (来自 track.json 或语言目录)
 *  @returns {[string, string]} `[标题, 副标题]` */
export function featureText(layers, key) {
  const label = (layers && layers[key]) || '';
  switch (key) {
    case 'tr': return ['翻译', '显示译文'];
    case 'read': return [label || '注音', '显示' + (label || '注音')];
    case 'roman': return [label || '转写', '显示' + (label || '转写')];
    case 'pos': return ['词性标注', '按词性着色'];
    case 'card': return ['点词释义', '点击单词查看'];
    default: return [key, ''];
  }
}

let cache = null;

function read() {
  if (cache) return cache;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* 用默认 */ }
  cache = Array.isArray(saved) && saved.length && saved.every((l) => l && l.code)
    ? saved : DEFAULT_LANGS;
  return cache;
}

/** 当前生效的源语言清单. */
export const sourceLangs = () => read();

/** 找一门语言; 认不出来时返回一个「够用」的占位, 免得调用方到处判空. */
export function sourceSpec(code) {
  const key = String(code || '').toLowerCase();
  const hit = read().find((l) => l.code.toLowerCase() === key);
  if (hit) return hit;
  return {
    code: key || 'und', name: key || '未知语言', nameEn: key, native: key,
    script: 'latin', engine: '', spaceDelimited: true,
    layers: {}, layerOrder: [], features: ['tr', 'pos', 'card'],
  };
}

export const sourceName = (code) => sourceSpec(code).name;

export const hasSource = (code) =>
  read().some((l) => l.code.toLowerCase() === String(code || '').toLowerCase());

/** 把 /api/health 返回的语言清单存下来 (只在结构合法时). */
export function mergeCatalog(list) {
  if (!Array.isArray(list) || !list.length) return read();
  const clean = list
    .filter((l) => l && typeof l.code === 'string' && l.code)
    .map((l) => ({
      code: l.code,
      name: l.name || l.code,
      nameEn: l.nameEn || l.code,
      native: l.native || l.name || l.code,
      script: l.script || 'latin',
      engine: l.engine || '',
      spaceDelimited: l.spaceDelimited !== false,
      layers: (l.layers && typeof l.layers === 'object') ? l.layers : {},
      layerOrder: Array.isArray(l.layerOrder) ? l.layerOrder : Object.keys(l.layers || {}),
      features: Array.isArray(l.features) ? l.features : ['tr', 'pos', 'card'],
      ready: l.ready !== false,
      detail: l.detail || '',
    }));
  if (!clean.length) return read();
  cache = clean;
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { /* 隐私模式 */ }
  return cache;
}

/** 某个层在这门语言里叫什么; 不支持该层就返回空串. */
export const layerLabel = (spec, key) => (spec && spec.layers && spec.layers[key]) || '';

/** 这门语言支持的开关键 (按界面顺序). */
export function featureKeys(spec) {
  const order = (spec && spec.layerOrder) || [];
  return ['tr', ...order.filter((k) => k === 'read' || k === 'roman'), 'pos', 'card'];
}
