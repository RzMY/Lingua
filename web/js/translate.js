/**
 * 前端批量翻译 —— 只有打开翻译开关并指定语言后才会调大模型.
 *
 * 三条设计约束:
 *
 * * **可见优先** —— 先翻当前视口那几句 (hot 队列), 再在后台慢慢补完 (cold 队列);
 *   用户永远不用等整篇翻完。两个队列都**从焦点句往后**出队 (见 `takeBatch`),
 *   所以听到哪儿就先翻哪儿之后的, 焦点前面的句子留到最后绕回来补。
 * * **一次不重算** —— 命中 IndexedDB 就直接用; key 带 trackId + 译文语言 + 原文
 *   散列, 换语言是另一份缓存, 换音频互不影响。
 * * **一批一次重排** —— 译文到达会改变句子高度, 所以结果攒到一帧里统一交给
 *   播放页, 只触发一次虚拟列表重算。
 */

import { config, fill, langVars } from './config.js';
import { chatJSON, LLMError } from './llm.js';
import { get as cacheGet, getMany, put as cachePut } from './store.js';
import { hash53 } from './util.js';

const keyOf = (trackId, lang, text) => `${trackId}|${lang}|${hash53(text)}`;

/** 从模型返回的 JSON 里挑出 1..n 的译文, 容忍数组/嵌套/带引号的键. */
function pick(data, n) {
  let body = data;
  if (body && !Array.isArray(body) && typeof body === 'object') {
    for (const k of ['translations', 'result', 'data', 'items']) {
      if (Array.isArray(body[k]) || (body[k] && typeof body[k] === 'object')) { body = body[k]; break; }
    }
  }
  if (Array.isArray(body)) {
    const bag = {};
    body.forEach((v, i) => { bag[String(i + 1)] = v; });
    body = bag;
  }
  const out = new Map();
  if (!body || typeof body !== 'object') return out;
  for (const [rawKey, rawVal] of Object.entries(body)) {
    let value = rawVal;
    if (value && typeof value === 'object') value = value.text || value.translation || '';
    const idx = parseInt(String(rawKey).replace(/\D/g, ''), 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > n) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    out.set(idx - 1, value.trim());
  }
  return out;
}

/**
 * @param {object} track   Track 实例 (要 id / sentences)
 * @param {object} hooks   { onApply(Map<i,text>), onProgress(done,total), onError(msg) }
 */
export function createTranslator(track, hooks = {}) {
  const sentences = track.sentences || [];
  const total = sentences.length;
  const texts = sentences.map((s) => (s.text || '').trim());

  let lang = 'zh-CN';
  let enabled = false;
  let ctl = new AbortController();
  let focus = 0;                  // 焦点句: 出队从这里往后走

  const hot = new Set();          // 视口内, 优先
  const cold = new Set();         // 后台补完
  const queued = new Set();       // hot ∪ cold, 查重用
  const tries = new Map();        // i -> 失败次数
  const done = new Set();         // 已有译文的句子
  let running = 0;
  let sweeping = false;
  let warned = false;

  let buf = new Map();
  let flushing = false;

  function flushSoon() {
    if (flushing) return;
    flushing = true;
    requestAnimationFrame(() => {
      flushing = false;
      if (!buf.size) return;
      const batch = buf;
      buf = new Map();
      if (hooks.onApply) hooks.onApply(batch);
      if (hooks.onProgress) hooks.onProgress(done.size, total);
    });
  }

  function accept(i, text) {
    if (!text || done.has(i)) return;
    done.add(i);
    buf.set(i, text);
    flushSoon();
  }

  /**
   * 从队列里取一段**连续**的下标: 连续才好带上下文, 也让译文成片出现.
   *
   * 起点取「不早于焦点句的第一个」—— 用户往下读/往下听, 译文就该顺着这个方向长;
   * 焦点之后的都排完了 (`findIndex` 落空) 才回头补前面漏下的。
   */
  function takeBatch() {
    for (const bag of [hot, cold]) {
      if (!bag.size) continue;
      const sorted = [...bag].sort((a, b) => a - b);
      const at = Math.max(0, sorted.findIndex((i) => i >= focus));
      const batch = [sorted[at]];
      for (let k = at + 1; k < sorted.length && batch.length < Math.max(1, config.batchSize); k++) {
        if (sorted[k] !== batch[batch.length - 1] + 1) break;
        batch.push(sorted[k]);
      }
      for (const i of batch) { bag.delete(i); queued.delete(i); }
      return batch;
    }
    return null;
  }

  function requeue(list, hotter) {
    for (const i of list) {
      const n = (tries.get(i) || 0) + 1;
      tries.set(i, n);
      if (n > 2 || done.has(i)) continue;      // 试两次还不行就放过它
      (hotter ? hot : cold).add(i);
      queued.add(i);
    }
  }

  async function runBatch(batch) {
    const lo = batch[0];
    const hi = batch[batch.length - 1];
    const vars = langVars(lang, track.lang);
    const before = texts.slice(Math.max(0, lo - config.ctxBefore), lo).filter(Boolean);
    const after = texts.slice(hi + 1, hi + 1 + config.ctxAfter).filter(Boolean);
    const user = fill(config.prompts.translateUser, {
      ...vars,
      n: batch.length,
      numbered: batch.map((i, k) => `${k + 1}. ${texts[i]}`).join('\n'),
      before: before.length ? `【上文(仅供参考, 不要翻译)】\n${before.join('\n')}\n\n` : '',
      after: after.length ? `\n【下文(仅供参考, 不要翻译)】\n${after.join('\n')}\n` : '',
    });
    const data = await chatJSON({
      messages: [
        { role: 'system', content: fill(config.prompts.translate, vars) },
        { role: 'user', content: user },
      ],
      signal: ctl.signal,
    });
    const got = pick(data, batch.length);
    const missing = [];
    for (let k = 0; k < batch.length; k++) {
      const text = got.get(k);
      if (!text) { missing.push(batch[k]); continue; }
      accept(batch[k], text);
      cachePut('tr', keyOf(track.id, lang, texts[batch[k]]), text, track.id);
    }
    if (missing.length) requeue(missing, false);
  }

  function pumpQueue() {
    while (enabled && running < Math.max(1, config.concurrency)) {
      const batch = takeBatch();
      if (!batch) return;
      running++;
      runBatch(batch)
        .catch((err) => {
          if (err && err.name === 'AbortError') return;
          if (batch.length > 1) {                 // 拆小再试, 常见于单句超长
            requeue(batch.slice(0, Math.ceil(batch.length / 2)), true);
            requeue(batch.slice(Math.ceil(batch.length / 2)), false);
          } else {
            requeue(batch, false);
          }
          if (!warned && hooks.onError) {
            warned = true;
            hooks.onError(err instanceof LLMError ? err.message : (err && err.message) || '翻译失败');
          }
        })
        .finally(() => {
          running--;
          if (enabled) pumpQueue();
        });
    }
  }

  /** 先查缓存 (一次批量读), 剩下的进队列. */
  async function resolve(list, hotter) {
    const need = list.filter((i) => i >= 0 && i < total && texts[i] && !done.has(i) && !queued.has(i));
    if (!need.length) return;
    const keys = need.map((i) => keyOf(track.id, lang, texts[i]));
    const hits = await getMany('tr', [...new Set(keys)]);
    const miss = [];
    need.forEach((i, k) => {
      const text = hits.get(keys[k]);
      if (text) accept(i, text);
      else miss.push(i);
    });
    if (!enabled || !miss.length) return;
    for (const i of miss) {
      if (done.has(i) || queued.has(i)) continue;
      (hotter ? hot : cold).add(i);
      queued.add(i);
    }
    pumpQueue();
  }

  for (let i = 0; i < total; i++) {
    if (sentences[i] && sentences[i].translation) done.add(i);   // 建库时就译好的
  }

  function resetForLang() {
    ctl.abort();
    ctl = new AbortController();
    hot.clear();
    cold.clear();
    queued.clear();
    tries.clear();
    done.clear();
    warned = false;
  }

  async function sweep() {
    if (!enabled || sweeping) return;
    sweeping = true;
    try {
      //  从焦点句开始往后排, 到尾巴再绕回开头: 「正在听的这一段」先进队列, 也先出队.
      const rest = [];
      for (let k = 0; k < total; k++) {
        const i = (focus + k) % total;
        if (texts[i] && !done.has(i) && !queued.has(i)) rest.push(i);
      }
      for (let k = 0; k < rest.length && enabled; k += 240) {
        await resolve(rest.slice(k, k + 240), false);
      }
    } finally {
      sweeping = false;
    }
  }

  return {
    get lang() { return lang; },
    get enabled() { return enabled; },
    stats: () => ({ done: done.size, total }),

    /** 开关 + 目标语言一起设; 关的时候中断所有在飞请求. */
    setEnabled(on, nextLang) {
      if (nextLang && nextLang !== lang) {
        lang = nextLang;
        resetForLang();               // 换语言就是另一份缓存, 全部重来
      }
      if (Boolean(on) === enabled) return;
      enabled = Boolean(on);
      if (!enabled) {
        ctl.abort();
        hot.clear();
        cold.clear();
        queued.clear();
      } else {
        ctl = new AbortController();
        warned = false;
      }
    },

    /** 视口范围内优先补齐 (含少量缓冲). */
    want(lo, hi) {
      if (!enabled) return;
      const list = [];
      for (let i = Math.max(0, lo); i <= Math.min(total - 1, hi); i++) list.push(i);
      resolve(list, true);
    },

    /** 焦点句 (当前朗读句, 没有就是视口第一句): 出队顺序的起点, 见 `takeBatch`. */
    setFocus(i) {
      if (!Number.isFinite(i)) return;
      focus = Math.max(0, Math.min(total - 1, i | 0));
    },

    sweep,

    stop() {
      enabled = false;
      ctl.abort();
      hot.clear();
      cold.clear();
      queued.clear();
    },
  };
}

/** 单句取译文 (讲解卡片里要用, 不进队列). */
export async function cachedTranslation(trackId, lang, text) {
  if (!text) return '';
  return (await cacheGet('tr', keyOf(trackId, lang, text))) || '';
}

