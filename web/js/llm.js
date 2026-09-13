/**
 * 浏览器端 LLM 客户端 (OpenAI 兼容 `/chat/completions`).
 *
 * 翻译、词卡、讲解全部由浏览器**直连**模型接口 —— 分析后端不参与, 也就没有任何
 * 中转: API Key 只存在 localStorage 与内存里, 不会经过第三方。这一层要自己处理:
 *
 * * **两种模式** —— 词卡/翻译走非流式 + `response_format=json_object` (服务端不支持
 *   就自动降级); 讲解走 SSE 流式, 边下边渲染。
 * * **超时与重试** —— 非流式请求指数退避重试, 流式只连一次 (半路断了就地展示)。
 * * **同请求合并** —— `once(key, fn)` 让同一个 key 的并发调用共用一个 Promise,
 *   避免重复烧 token。
 *
 * 直连的代价是模型服务必须允许浏览器跨源访问 (CORS)。被拦住时浏览器只会给一个
 * 不带细节的 `TypeError`, 所以 `send()` 会把它翻译成一句能照着做的提示。
 */

import { config, endpointOf, setConfig } from './config.js';

const FENCE = /^\s*```(?:json)?\s*|\s*```\s*$/gi;
const CAP_MAX = 8192;                    // 自动加倍 max_tokens 的天花板

export class LLMError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const choiceOf = (data) => (data && data.choices && data.choices[0]) || null;
const contentOf = (data) => {
  const choice = choiceOf(data);
  const msg = choice && choice.message;
  return (msg && msg.content) || '';
};
const msgOf = (err) => (err && err.message) || '请求失败';

function ensureReady() {
  if (!String(config.baseUrl).trim()) throw new LLMError('还没配置大模型地址: 设置 → 大模型');
  if (!String(config.model).trim()) throw new LLMError('还没配置模型名: 设置 → 大模型');
}

/** 把外部 signal 和超时并成一个 signal. */
function linkAbort(outer, ms) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = ms > 0 ? setTimeout(() => ctl.abort(), ms) : 0;
  return {
    signal: ctl.signal,
    clear() {
      if (timer) clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 直连模型接口; 返回原始 Response, 状态码交给调用方判断.
 *
 * 浏览器把 CORS 拒绝、混合内容拦截、DNS 失败一律报成同一个不带细节的 `TypeError`,
 * 所以这里按地址本身能看出来的线索, 拼一句能照着做的提示。
 */
async function send(body, signal) {
  ensureReady();
  const endpoint = endpointOf();
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = 'Bearer ' + String(config.apiKey).trim();
  try {
    return await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new LLMError(`连不上模型接口: ${msgOf(err)}${hintFor(endpoint)}`);
  }
}

/** 按页面与模型地址的协议差异, 给一句具体的排查建议. */
function hintFor(endpoint) {
  let url = null;
  try { url = new URL(endpoint); } catch { return ' (地址填错了?)'; }
  if (location.protocol === 'https:' && url.protocol === 'http:') {
    return ' —— 本页是 https, 浏览器会拦掉 http 的模型地址 (混合内容);'
      + ' 请给模型服务配 https, 或改用 http 打开本站';
  }
  return ' —— 浏览器直连模型接口需要对方允许跨源 (CORS);'
    + ' 请在模型服务/网关上放开本页的来源 ' + location.origin;
}

/**
 * 非流式请求, 返回 message.content.
 *
 * `json:true` 时带上 `response_format`; 服务端回 400 就当场把全局开关关掉重发
 * (和 Python 侧同一套降级逻辑)。
 */
export async function chat({
  messages, json = false, temperature, maxTokens = 0, signal, retries = 2,
} = {}) {
  const body = {
    model: String(config.model).trim(),
    messages,
    temperature: temperature === undefined ? config.temperature : temperature,
    stream: false,
  };
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (json && config.jsonMode) body.response_format = { type: 'json_object' };

  let last = null;
  let grew = false;                      // 只自动加倍一次, 免得越试越贵
  for (let attempt = 0; attempt <= retries; attempt++) {
    const link = linkAbort(signal, Math.max(10, config.timeout) * 1000);
    try {
      const resp = await send(body, link.signal);
      if (resp.status === 400 && body.response_format) {
        delete body.response_format;
        setConfig({ jsonMode: 0 });
        continue;
      }
      if (!resp.ok) {
        const text = (await resp.text().catch(() => '')).slice(0, 300);
        throw new LLMError(`模型接口 ${resp.status}: ${text || '无响应体'}`, resp.status);
      }
      const data = await resp.json();
      const text = contentOf(data);
      const choice = choiceOf(data);
      // 推理型模型会先写 reasoning_content; 上限太小就只剩思考、正文为空。
      // max_tokens 只是封顶不是预付, 所以先就地翻倍再试一次 (不计入 retries);
      // 还是空的就用 422 抛出, 让下面的 4xx 分支放弃重试 —— 再试只会一样被截断。
      if (!text && choice && choice.finish_reason === 'length') {
        if (body.max_tokens && !grew && body.max_tokens < CAP_MAX) {
          grew = true;
          body.max_tokens = Math.min(CAP_MAX, body.max_tokens * 2);
          attempt--;
          continue;
        }
        throw new LLMError('输出被 max_tokens 截断, 额度全花在思考上了: 把「单条最多输出」调大些', 422);
      }
      return text;
    } catch (err) {
      if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
      last = err;
      // 4xx 基本是配置/额度问题, 重试没意义
      if (err instanceof LLMError && err.status >= 400 && err.status < 500) break;
      if (attempt < retries) await sleep(600 * 2 ** attempt);
    } finally {
      link.clear();
    }
  }
  throw last instanceof LLMError ? last : new LLMError(msgOf(last));
}

/** 容错解析: 去掉 ```json 围栏, 再退一步抓第一个 {...}. */
export function parseLoose(text) {
  const body = String(text || '').trim().replace(FENCE, '');
  try { return JSON.parse(body); } catch { /* 继续找 */ }
  const match = body.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* 放弃 */ }
  }
  return null;
}

export async function chatJSON(opts) {
  const text = await chat({ ...opts, json: true });
  const data = parseLoose(text);
  if (!data || typeof data !== 'object') {
    throw new LLMError('模型没有返回可解析的 JSON: ' + String(text || '').slice(0, 80));
  }
  return data;
}

/** 流式请求; 每来一段调用 onDelta(piece, full), 结束返回全文. */
export async function chatStream({ messages, onDelta, temperature, signal } = {}) {
  const body = {
    model: String(config.model).trim(),
    messages,
    temperature: temperature === undefined ? config.temperature : temperature,
    stream: true,
  };
  const link = linkAbort(signal, Math.max(60, config.timeout) * 1000);
  let out = '';
  try {
    const resp = await send(body, link.signal);
    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).slice(0, 300);
      throw new LLMError(`模型接口 ${resp.status}: ${text || '无响应体'}`, resp.status);
    }
    const ctype = resp.headers.get('content-type') || '';
    // 有的网关会忽略 stream:true, 直接回整包 JSON
    if (!resp.body || ctype.includes('application/json')) {
      const data = await resp.json().catch(() => null);
      out = data ? contentOf(data) : '';
      if (out && onDelta) onDelta(out, out);
      return out;
    }
    out = await pump(resp.body.getReader(), onDelta);
    return out;
  } finally {
    link.clear();
  }
}

/** 逐行消费 SSE: `data: {...}` / `data: [DONE]`. */
async function pump(reader, onDelta) {
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, cut).trim();
      buf = buf.slice(cut + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk = null;
      try { chunk = JSON.parse(payload); } catch { continue; }
      const choice = chunk.choices && chunk.choices[0];
      const piece = (choice && ((choice.delta && choice.delta.content) ||
        (choice.message && choice.message.content))) || '';
      if (!piece) continue;
      out += piece;
      if (onDelta) onDelta(piece, out);
    }
  }
  return out;
}

/** 连通性自检, 设置页里的「测试连接」用. */
export async function probe(signal) {
  const text = await chat({
    messages: [
      { role: 'system', content: '只输出 JSON。' },
      { role: 'user', content: '返回 {"ok": true}' },
    ],
    // 512 是给推理型模型留的余量: 32 那种小上限会被思考吃光
    json: true, retries: 0, maxTokens: 512, signal,
  });
  return String(text || '').trim().slice(0, 120) || '(空响应)';
}

/** 同 key 的并发请求共用一个 Promise —— 缓存之外的第二道去重. */
const inflight = new Map();
export function once(key, factory) {
  const hit = inflight.get(key);
  if (hit) return hit;
  const task = (async () => factory())().finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

