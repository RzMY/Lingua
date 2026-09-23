/**
 * 单词释义卡片 —— 点词后实时调大模型, 结合上下文给出详细含义.
 *
 * 两段式渲染: 分词器已经算好的东西 (注音/转写/词性/原形/活用/构成) 立刻显示,
 * 不等网络; 大模型那部分 (语境释义 + 说明 + 相关形式) 后到, 占位骨架先撑住高度,
 * 免得卡片弹出后再跳一次。
 *
 * 缓存键带 trackId + 译文语言 + 句序 + 词序 + 原文散列: 同一个词在不同句子里
 * 讲法不同, 所以按位置缓存; 换音频天然隔离。
 */

import { config, fill, langVars, llmReady } from './config.js';
import { chatJSON, once } from './llm.js';
import { errorMessage } from './errors.js';
import { get as cacheGet, put as cachePut } from './store.js';
import { el, copyText, hash53, icon, toast } from './util.js';

let host = null;
let scrim = null;
let ctl = null;
let returnFocus = null;
// 同 sheet.js: `.is-open` 下一帧才加, 状态另用变量记
let openFlag = false;

function ensureHost() {
  if (host) return;
  scrim = el('div', 'wc-scrim');
  scrim.addEventListener('click', closeWordCard);
  host = el('div', 'wcard');
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-labelledby', 'wordCardTitle');
  host.setAttribute('aria-hidden', 'true');
  host.inert = true;
  host.tabIndex = -1;
  document.body.append(scrim, host);
  host.addEventListener('keydown', (event) => {
    if (!openFlag) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); closeWordCard();
    } else if (event.key === 'Tab') {
      const buttons = [...host.querySelectorAll('button:not(:disabled)')];
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement);
      const next = current < 0 ? (event.shiftKey ? buttons.length - 1 : 0)
        : (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  });
}

export const isCardOpen = () => openFlag;

export function closeWordCard() {
  if (!openFlag) return;
  openFlag = false;
  if (ctl) { ctl.abort(); ctl = null; }
  if (host.contains(document.activeElement)) {
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    else document.activeElement.blur();
  }
  host.inert = true;
  host.setAttribute('aria-hidden', 'true');
  host.classList.remove('is-open');
  scrim.classList.remove('is-open');
}

const keyOf = (trackId, lang, i, j, word, text) =>
  `${trackId}|${lang}|${i}|${j}|${hash53(word + '' + text)}`;

/** 骨架屏: 三条灰块, 纯装饰. */
function skeleton() {
  const box = el('div', 'wc-sk');
  box.append(el('i', 'sk sk-1'), el('i', 'sk sk-2'), el('i', 'sk sk-3'));
  return box;
}

function askLLM(track, s, w, i, j, lang, signal) {
  const vars = langVars(lang, track.lang);
  const before = track.sentences.slice(Math.max(0, i - config.ctxBefore), i)
    .map((x) => x.text).filter(Boolean);
  const after = track.sentences.slice(i + 1, i + 1 + config.ctxAfter)
    .map((x) => x.text).filter(Boolean);
  const context = (before.length || after.length)
    ? `上下文:\n${[...before, `>>> ${s.text}`, ...after].join('\n')}\n`
    : '';
  const user = fill(config.prompts.wordUser, {
    ...vars,
    word: w.text,
    reading: w.read || w.roman || w.lemma || w.text,
    pos: track.posLabel(w.pos),
    sentence: s.text,
    context,
  });
  return chatJSON({
    messages: [
      { role: 'system', content: fill(config.prompts.word, vars) },
      { role: 'user', content: user },
    ],
    signal,
    maxTokens: config.maxTokens,
  });
}

/**
 * 打开卡片.
 * @param {object} o `{track, i, j, lang}`; i 句序, j 词序
 */
export async function openWordCard({ track, i, j, lang }) {
  const s = track.sentences[i];
  const w = s && s.words[j];
  if (!w) return;
  ensureHost();
  if (!host.contains(document.activeElement)) returnFocus = document.activeElement;
  if (ctl) ctl.abort();
  ctl = new AbortController();
  const signal = ctl.signal;

  host.textContent = '';
  const top = el('div', 'wc-top');
  const word = el('div', 'wc-word', w.text);
  word.id = 'wordCardTitle';
  if (w.read && w.read !== w.text) word.append(el('span', 'wc-read', w.read));
  top.append(word);
  if (w.roman) top.append(el('div', 'wc-roman', w.roman));
  host.append(top);

  const gloss = el('h3', 'wc-gloss');
  const note = el('div', 'wc-note');
  const forms = el('div', 'wc-forms');
  host.append(gloss, note, forms);

  const bits = [];
  if (w.lemma && w.lemma !== w.text) bits.push('原形 ' + w.lemma);
  if (w.conj) bits.push(w.conj);
  if (w.parts && w.parts.length > 1) bits.push(w.parts.map((p) => p.text).join(' + '));
  if (w.posDetail && !bits.length) bits.push(w.posDetail);
  if (bits.length) host.append(el('div', 'wc-meta', bits.join(' · ')));

  // 词性小标签落在左下角 (照 img/卡片.PNG), 和操作按钮同一行
  const acts = el('div', 'wc-acts');
  const pos = el('span', 'wc-pos p-' + (w.pos || 'other'), track.posLabel(w.pos));
  const copy = el('button', 'wc-a wc-a-ic');
  copy.type = 'button';
  copy.title = '复制';
  copy.setAttribute('aria-label', '复制');
  copy.append(icon('i-copy', 'ic ic-sm'));
  const again = el('button', 'wc-a wc-a-ic');
  again.type = 'button';
  again.title = '重新生成';
  again.setAttribute('aria-label', '重新生成');
  again.append(icon('i-refresh', 'ic ic-sm'));
  const shut = el('button', 'wc-a wc-a-main', '关闭');
  shut.type = 'button';
  shut.addEventListener('click', closeWordCard);
  acts.append(pos, copy, again, shut);
  host.append(acts);

  openFlag = true;
  host.inert = false;
  host.removeAttribute('aria-hidden');
  requestAnimationFrame(() => {
    if (!openFlag) return;               // 同一帧内开又关: 别把卡片补回来
    scrim.classList.add('is-open');
    host.classList.add('is-open');
    if (!host.contains(document.activeElement)) host.focus({ preventScroll: true });
  });

  const paint = (data) => {
    gloss.textContent = String(data.gloss || '').trim() || '暂无释义';
    note.textContent = '';
    const body = String(data.note || '').trim();
    for (const line of body.split(/\n+/)) if (line) note.append(el('p', null, line));
    forms.textContent = '';
    for (const f of Array.isArray(data.forms) ? data.forms.slice(0, 3) : []) {
      const text = typeof f === 'string' ? f : (f && f.text);
      if (!text) continue;
      const chip = el('span', 'wc-form');
      chip.append(el('b', null, text));
      const tip = typeof f === 'object' && f.gloss;
      if (tip) chip.append(el('i', null, tip));
      forms.append(chip);
    }
    if (data.reading && !w.read) word.append(el('span', 'wc-read', data.reading));
    if (data.pos) pos.textContent = data.pos;
    host.classList.remove('is-load');
    copy.onclick = async () => {
      const ok = await copyText(`${w.text}${data.reading ? `（${data.reading}）` : ''}\n` +
        `${gloss.textContent}\n${body}`);
      toast(ok ? '已复制' : '复制失败');
    };
  };

  const fail = (msg) => {
    host.classList.remove('is-load');
    gloss.textContent = '释义加载失败';
    note.textContent = '';
    note.append(el('p', 'wc-err', msg));
  };

  const cacheKey = keyOf(track.id, lang, i, j, w.text, s.text);

  async function load(force) {
    host.classList.add('is-load');
    gloss.textContent = '';
    note.textContent = '';
    note.append(skeleton());
    forms.textContent = '';
    if (!force) {
      const hit = await cacheGet('word', cacheKey);
      if (hit) { paint(hit); return; }
    }
    if (!llmReady()) {
      fail('请在「设置 → 大模型」配置接口地址和模型名');
      return;
    }
    try {
      const data = await once('w:' + cacheKey, () => askLLM(track, s, w, i, j, lang, signal));
      if (signal.aborted) return;
      paint(data);
      cachePut('word', cacheKey, data, track.id);
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      fail(errorMessage(err, '释义请求失败，请重试'));
    }
  }

  again.addEventListener('click', () => load(true));
  await load(false);
}
