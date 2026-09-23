/**
 * 句子讲解对话框 —— 从下方弹出约 2/3 屏, 流式讲解当前句, 并能继续追问.
 *
 * 要点:
 *
 * * **流式渲染**: SSE 每来一段就重解析一次 markdown, 但用 rAF 节流, 一帧最多画一次。
 * * **跟手滚动**: 只有用户本来就贴着底部时才自动跟到底; 手动往上翻就不再抢滚动条。
 * * **按句缓存**: `chat` store 里 key = `trackId|句序`, 复位/换音频互不影响,
 *   重开同一句直接看到上次的对话, 不再烧 token。
 */

import { config, fill, langVars, llmReady } from './config.js';
import { chatStream } from './llm.js';
import { errorMessage } from './errors.js';
import { mdInto } from './md.js';
import { get as cacheGet, put as cachePut, del as cacheDel } from './store.js';
import { openSheet, closeSheet, openMenu } from './sheet.js';
import { el, copyText, icon, toast } from './util.js';

const keyOf = (trackId, i) => `${trackId}|${i}`;

let ctl = null;          // 当前在飞的流式请求
let live = null;         // 当前会话状态

export const chatOpen = () => !!live;

export function closeChat() {
  if (!live) return;
  closeSheet();          // onClose 里会清理
}

/** 上下文块: 前后各若干句原文, 当前句用 >>> 标出来. */
function contextOf(track, i) {
  const before = track.sentences.slice(Math.max(0, i - config.ctxBefore), i)
    .map((s) => s.text).filter(Boolean);
  const after = track.sentences.slice(i + 1, i + 1 + config.ctxAfter)
    .map((s) => s.text).filter(Boolean);
  if (!before.length && !after.length) return '';
  return `上下文 (仅供理解, 不要逐句翻译):\n${[...before, `>>> ${track.sentences[i].text}`, ...after].join('\n')}\n\n`;
}

/** 用户气泡: 右对齐, 纯文本. */
function userBubble(text) {
  const row = el('div', 'bub-row is-me');
  row.append(el('div', 'bub bub-me', text));
  return row;
}

/** 助手气泡: markdown + 底部动作条 (复制 / 重新生成). */
function botBubble(onCopy, onRetry) {
  const row = el('div', 'bub-row');
  const bub = el('div', 'bub bub-bot');
  const body = el('div', 'bub-md');
  const acts = el('div', 'bub-acts');
  const copy = el('button', 'bub-a');
  copy.type = 'button';
  copy.setAttribute('aria-label', '复制');
  copy.append(icon('i-copy', 'ic ic-sm'));
  copy.addEventListener('click', onCopy);
  const retry = el('button', 'bub-a');
  retry.type = 'button';
  retry.setAttribute('aria-label', '重新生成');
  retry.append(icon('i-refresh', 'ic ic-sm'));
  retry.addEventListener('click', onRetry);
  acts.append(copy, retry);
  acts.hidden = true;
  bub.append(body, acts);
  row.append(bub);
  row.body = body;
  row.acts = acts;
  return row;
}

/** 三点等待动画. */
function typing() {
  const row = el('div', 'bub-row');
  const bub = el('div', 'bub bub-bot is-wait');
  bub.append(el('i', 'dot'), el('i', 'dot'), el('i', 'dot'));
  row.append(bub);
  return row;
}

/**
 * 打开讲解对话框.
 * @param {object} o `{track, i, lang, onClose}`
 */
export async function openChat({ track, i, lang, onClose }) {
  const s = track.sentences[i];
  if (!s) return;
  const cacheKey = keyOf(track.id, i);

  const log = el('div', 'chat-log');
  const wrap = el('div', 'chat');
  wrap.append(log);

  const foot = el('div', 'chat-foot');
  const bar = el('div', 'chat-in');
  const box = el('textarea');
  box.rows = 1;
  box.placeholder = '输入问题…';
  box.setAttribute('aria-label', '追问内容');
  box.spellcheck = false;
  const send = el('button', 'chat-send');
  send.type = 'button';
  send.setAttribute('aria-label', '发送');
  send.append(icon('i-send'));
  bar.append(box, send);
  foot.append(bar);

  const menuBtn = el('button', 'tb-btn tb-btn-sm');
  menuBtn.type = 'button';
  menuBtn.setAttribute('aria-label', '更多');
  menuBtn.append(icon('i-dots'));

  const state = { msgs: [], busy: false, pinned: true };
  live = state;

  const view = openSheet(`讲解 · 第 ${i + 1} 句`, wrap, {
    cls: 'sheet-chat',
    footer: foot,
    actions: [menuBtn],
    onClose() {
      if (ctl) { ctl.abort(); ctl = null; }
      live = null;
      if (onClose) onClose();
    },
  });
  const scroller = view.body;
  const nearBottom = () =>
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };
  scroller.addEventListener('scroll', () => {
    state.pinned = nearBottom();
  }, { passive: true });

  const save = () => cachePut('chat', cacheKey, { msgs: state.msgs, at: Date.now() }, track.id);

  /** 重画整段对话 (打开时/清空后用; 流式过程走增量). */
  function repaint() {
    log.textContent = '';
    state.msgs.forEach((m, k) => {
      if (m.role === 'user') {
        // 首轮那条是模板拼出来的, 只展示句子本身, 免得把上下文块摊给用户看
        log.append(userBubble(k === 0 ? s.text : m.content));
        return;
      }
      const row = botBubble(
        async () => toast((await copyText(m.content)) ? '已复制' : '复制失败'),
        () => regenerate(k),
      );
      mdInto(row.body, m.content);
      row.acts.hidden = false;
      log.append(row);
    });
    toBottom();
  }

  /** 发一轮; msgs 里已经放好了到目前为止的对话. */
  async function turn() {
    if (state.busy) return;
    state.busy = true;
    send.disabled = true;
    const wait = typing();
    log.append(wait);
    if (state.pinned) toBottom();

    if (!llmReady()) {
      wait.remove();
      const row = botBubble(() => {}, () => {});
      mdInto(row.body, '请在「设置 → 大模型」配置接口地址和模型名');
      log.append(row);
      state.busy = false;
      send.disabled = false;
      return;
    }

    const vars = langVars(lang, track.lang);
    const messages = [
      { role: 'system', content: fill(config.prompts.explain, vars) },
      ...state.msgs,
    ];
    ctl = new AbortController();
    const signal = ctl.signal;
    let row = null;
    let queued = false;
    let full = '';

    const flush = () => {
      queued = false;
      if (!row) return;
      mdInto(row.body, full);
      if (state.pinned) toBottom();
    };

    try {
      full = await chatStream({
        messages,
        signal,
        onDelta: (_piece, text) => {
          full = text;
          if (!row) {
            wait.remove();
            row = botBubble(
              async () => toast((await copyText(full)) ? '已复制' : '复制失败'),
              () => regenerate(state.msgs.length - 1),
            );
            log.append(row);
          }
          if (queued) return;
          queued = true;
          requestAnimationFrame(flush);
        },
      });
      if (signal.aborted) return;
      if (!row) { wait.remove(); row = botBubble(() => {}, () => {}); log.append(row); }
      mdInto(row.body, full || '模型未返回内容，请重试');
      row.acts.hidden = false;
      state.msgs.push({ role: 'assistant', content: full });
      save();
      if (state.pinned) toBottom();
    } catch (err) {
      wait.remove();
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      const msg = errorMessage(err, '模型请求失败，请重试');
      const bad = botBubble(() => {}, () => regenerate(state.msgs.length - 1));
      mdInto(bad.body, '讲解失败：' + msg);
      bad.acts.hidden = false;
      log.append(bad);
      if (state.pinned) toBottom();
    } finally {
      ctl = null;
      state.busy = false;
      send.disabled = false;
    }
  }

  /** 重新生成第 k 条助手回复: 砍掉它及其之后的内容, 再跑一轮. */
  function regenerate(k) {
    if (state.busy) return;
    let cut = k;
    while (cut > 0 && state.msgs[cut] && state.msgs[cut].role !== 'assistant') cut--;
    state.msgs = state.msgs.slice(0, Math.max(1, cut));
    save();
    repaint();
    state.pinned = true;
    turn();
  }

  function submit() {
    const text = box.value.trim();
    if (!text || state.busy) return;
    box.value = '';
    box.style.height = '';
    state.msgs.push({ role: 'user', content: text });
    log.append(userBubble(text));
    state.pinned = true;
    save();
    turn();
  }

  send.addEventListener('click', submit);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  // 单行 pill 输入框, 最多长到 5 行
  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 132) + 'px';
  });

  menuBtn.addEventListener('click', () => openMenu(menuBtn, [
    {
      label: '重新生成', icon: 'i-refresh',
      onPick: () => regenerate(state.msgs.length - 1),
    },
    {
      label: '复制全文', icon: 'i-copy',
      onPick: async () => {
        const text = state.msgs.map((m) => (m.role === 'user' ? '我：' : '') + m.content).join('\n\n');
        toast((await copyText(text)) ? '已复制' : '复制失败');
      },
    },
    {
      label: '清空对话', icon: 'i-trash', danger: true,
      onPick: () => {
        if (ctl) { ctl.abort(); ctl = null; }
        state.msgs = [];
        cacheDel('chat', cacheKey);
        log.textContent = '';
        start();
      },
    },
  ]));

  /** 首轮: 有缓存就直接展示, 否则按模板问一次. */
  async function start() {
    const hit = state.msgs.length ? null : await cacheGet('chat', cacheKey);
    if (hit && Array.isArray(hit.msgs) && hit.msgs.length) {
      state.msgs = hit.msgs;
      repaint();
      return;
    }
    const vars = langVars(lang, track.lang);
    state.msgs = [{
      role: 'user',
      content: fill(config.prompts.explainUser, {
        ...vars, sentence: s.text, context: contextOf(track, i),
      }),
    }];
    log.append(userBubble(s.text));
    state.pinned = true;
    turn();
  }

  await start();
}

