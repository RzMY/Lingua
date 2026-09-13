/**
 * 全局配置 —— 分析后端地址 + 大模型接入参数 + 每种语言的默认开关 + 所有提示词.
 *
 * 配置保存在 `localStorage`: 访问令牌只发给分析后端, 模型 Key 只发给模型端点。
 *
 * 提示词全部外露成模板, 用 `{{var}}` 占位; 语言相关的部分 (源语言名、注音层叫什么)
 * 也是变量, 于是同一套提示词能服务所有语言, 用户在设置页里还能整段重写。
 */

import { sourceSpec } from './langs.js';

const KEY = 'linguatrack.config.v1';

/** 译文语言 (目标语言). */
export const TARGET_LANGS = [
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
];

export const langName = (code) =>
  (TARGET_LANGS.find((l) => l.code.toLowerCase() === String(code || '').toLowerCase()) || {}).name
  || code;

/** 每种源语言的默认开关 (新音频照它初始化, 之后每条音频各自记). */
export const LANG_DEFAULTS = { tr: 0, read: 1, roman: 1, pos: 1, card: 1 };

/** 提示词默认值; 每条都在设置页里可编辑. */
export const DEFAULT_PROMPTS = {
  translate:
    '你是资深的{{src}}影视字幕译者, 服务于语言学习 App。\n' +
    '翻译要求:\n' +
    '1. 译成自然、口语化的{{dst}}, 保留说话者的语气和亲近感, 不要生硬直译。\n' +
    '2. 结合上下文补全{{src}}里省略的主语和指代, 但不要添加原文没有的信息。\n' +
    '3. 每句独立成行, 不合并、不拆分、不加编号、不加引号、不做解释。\n' +
    '4. 语气词/感叹词按语用功能意译 (日语 ね -> 呢/呀, 英语 well -> 那个…), 不要音译。\n' +
    '5. 原文若是 ASR 误识别导致的无意义片段, 就按最接近的合理说法翻译。\n' +
    '只输出 JSON 对象, 形如 {"1": "译文", "2": "译文"}, 键为编号字符串。',

  translateUser:
    '{{before}}【待翻译 共{{n}}句】\n{{numbered}}\n{{after}}\n' +
    '请把上面 {{n}} 句{{src}}译成{{dst}}, 返回 JSON: {"1": "…", …, "{{n}}": "…"}',

  word:
    '你是{{src}}教师, 为{{dst}}母语的学习者讲解词汇。只输出 JSON, 不要 markdown, 不要多余解释。\n' +
    '字段:\n' +
    '- gloss: 该词在**这句话**里的{{dst}}含义, 6 字以内, 不要标点。\n' +
    '- reading: {{read}}; 与词形相同、或这门语言不需要注音就留空。\n' +
    '- roman: {{roman}}; 没有就留空。\n' +
    '- pos: 词性, 用{{dst}}, 2-3 字, 如 名词 / 动词 / 副词 / 介词。\n' +
    '- note: 2-4 句{{dst}}说明: 它在本句里起什么作用、为什么用这个形式 (时态/变位/敬体)、' +
    '有无固定搭配或语气色彩。就事论事, 不要复述整句译文, 不要罗列词典义项。\n' +
    '- forms: 最多 3 个相关形式或搭配, 每项 `{"text": "…", "gloss": "…"}`; 没有就给 []。',

  wordUser:
    '句子: {{sentence}}\n' +
    '目标词: {{word}}（读音/原形 {{reading}}, 分析器判定词性 {{pos}}）\n' +
    '{{context}}' +
    '请按 JSON 输出对「{{word}}」的讲解。',

  explain:
    '你是耐心的{{src}}老师, 用{{dst}}给学习者讲解台词。用 markdown 输出, 结构固定为三个二级标题:\n' +
    '## 翻译\n自然流畅的{{dst}}整句翻译, 一行。\n' +
    '## 词汇\n本句值得记的词, 每条一行 `1. **原文** [{{read}} / {{roman}}] – {{dst}}释义`, 最多 6 条。\n' +
    '## 语法解析\n2-4 条要点, 编号列出, 讲变位、助词或介词、句型、省略成分、语气。\n' +
    '要求: 只讲这一句, 结合上下文但不要跑题; 不要寒暄, 不要提问, 不要复述任务。',

  explainUser:
    '{{context}}请讲解这一句: {{sentence}}',
};

export const PROMPT_META = [
  { key: 'translate', title: '翻译 · 系统提示词', vars: 'src dst' },
  { key: 'translateUser', title: '翻译 · 请求模板', vars: 'src dst n numbered before after' },
  { key: 'word', title: '单词卡片 · 系统提示词', vars: 'src dst read roman' },
  { key: 'wordUser', title: '单词卡片 · 请求模板', vars: 'src dst word reading pos sentence context' },
  { key: 'explain', title: '讲解 · 系统提示词', vars: 'src dst read roman' },
  { key: 'explainUser', title: '讲解 · 首轮请求', vars: 'src dst sentence context' },
];

export const DEFAULTS = {
  // 分析后端: 空 = 与页面同源 (python -m pipeline serve 的默认情形)
  apiBase: '',
  apiToken: '',
  // 大模型 (浏览器直连)
  baseUrl: '',
  apiKey: '',
  model: 'deepseek-v4-flash',
  targetLang: 'zh-CN',
  temperature: 0.2,
  batchSize: 8,
  concurrency: 2,
  ctxBefore: 3,
  ctxAfter: 2,
  timeout: 120,
  // 推理型模型会先吐一大段 reasoning_content, 上限给小了就只剩思考没有正文。
  // max_tokens 只是封顶不是预付, 所以默认给到 3000。
  maxTokens: 3000,
  jsonMode: 1,              // 服务端不支持 response_format 时自动关掉
  importLang: 'ja',         // 导入音频时预选的源语言
  langs: {},                // code -> {tr, read, roman, pos, card}
  prompts: { ...DEFAULT_PROMPTS },
};

/** @type {typeof DEFAULTS} */
export const config = { ...DEFAULTS, langs: {}, prompts: { ...DEFAULT_PROMPTS } };

const listeners = new Set();

export function onConfigChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const bit = (v, fallback) => (v === undefined || v === null ? fallback : (v ? 1 : 0));

export function loadConfig() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch { /* 坏了就用默认 */ }
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (k === 'prompts' || k === 'langs') continue;
      if (saved[k] !== undefined && saved[k] !== null) config[k] = saved[k];
    }
    const p = saved.prompts;
    if (p && typeof p === 'object') {
      for (const k of Object.keys(DEFAULT_PROMPTS)) {
        if (typeof p[k] === 'string' && p[k].trim()) config.prompts[k] = p[k];
      }
    }
    const langs = saved.langs;
    if (langs && typeof langs === 'object') {
      for (const [code, value] of Object.entries(langs)) {
        if (!code || !value || typeof value !== 'object') continue;
        const bag = {};
        for (const key of Object.keys(LANG_DEFAULTS)) {
          bag[key] = bit(value[key], LANG_DEFAULTS[key]);
        }
        config.langs[code] = bag;
      }
    }
    // 从旧版 (阶段二) 迁移: 那时开关是全局的 def*, 且只有日语
    if (!Object.keys(config.langs).length && saved.defKana !== undefined) {
      config.langs.ja = {
        tr: bit(saved.defTr, 0), read: bit(saved.defKana, 1), roman: bit(saved.defRom, 1),
        pos: bit(saved.defPos, 1), card: bit(saved.defCard, 1),
      };
    }
  }
  return config;
}

/** 某门源语言的默认开关 (缺项回落到内置默认). */
export function langDefaults(code) {
  const saved = config.langs[String(code || '')] || {};
  const out = {};
  for (const key of Object.keys(LANG_DEFAULTS)) out[key] = bit(saved[key], LANG_DEFAULTS[key]);
  return out;
}

/** 改某门语言的默认开关. */
export function setLangConfig(code, patch) {
  const key = String(code || '');
  if (!key) return config;
  const next = { ...langDefaults(key) };
  let changed = false;
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in LANG_DEFAULTS)) continue;
    const value = bit(v, next[k]);
    if (next[k] === value) continue;
    next[k] = value;
    changed = true;
  }
  if (!changed) return config;
  config.langs[key] = next;
  save();
  for (const fn of listeners) fn(config, { langs: { [key]: next } });
  return config;
}

export function setConfig(patch) {
  let changed = false;
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'prompts' || k === 'langs') continue;
    if (!(k in DEFAULTS) || config[k] === v) continue;
    config[k] = v;
    changed = true;
  }
  if (patch && patch.prompts) {
    for (const [k, v] of Object.entries(patch.prompts)) {
      if (!(k in DEFAULT_PROMPTS)) continue;
      const next = typeof v === 'string' && v.trim() ? v : DEFAULT_PROMPTS[k];
      if (config.prompts[k] === next) continue;
      config.prompts[k] = next;
      changed = true;
    }
  }
  if (!changed) return config;
  save();
  for (const fn of listeners) fn(config, patch);
  return config;
}

export function resetPrompt(key) {
  if (key in DEFAULT_PROMPTS) setConfig({ prompts: { [key]: DEFAULT_PROMPTS[key] } });
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
  } catch { /* 隐私模式下写不进去, 本次会话内仍然生效 */ }
}

/** 有地址和模型就算能用; Key 允许为空 (自建网关常常不校验). */
export const llmReady = () => Boolean(config.baseUrl.trim() && config.model.trim());

/** `http://host:3000` -> `http://host:3000/v1/chat/completions` */
export function endpointOf(base = config.baseUrl) {
  let url = String(base || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (/\/chat\/completions$/.test(url)) return url;
  if (!/\/v\d+$/.test(url)) url += '/v1';
  return url + '/chat/completions';
}

/** `{{a}}` -> vars.a; 缺的变量替换成空串, 免得提示词里漏出占位符. */
export function fill(tpl, vars = {}) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_, k) =>
    (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

/**
 * 提示词里到处要用的四个变量.
 *
 * `read` / `roman` 是这门语言两个显示层的名字 (日语「假名 / 罗马音」, 韩语「发音 /
 * 罗马字」, 英法德西「音标 / 原形」), 所以同一套提示词能服务所有语言。认不出的语言
 * 给一个通用说法, 免得模板里出现空洞。
 * @param {string} target 译文语言
 * @param {string} src    源语言代码 (来自这条音频)
 */
export function langVars(target = config.targetLang, src = '') {
  const spec = sourceSpec(src);
  return {
    src: spec.name,
    dst: langName(target),
    read: spec.layers.read || '读音',
    roman: spec.layers.roman || '原形或转写',
  };
}
