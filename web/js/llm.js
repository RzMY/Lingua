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
import { errorMessage } from './errors.js';

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
const msgOf = (err) => errorMessage(err, '模型请求失败，请重试');

function responseError(status) {
  const messages = {
    400: '模型请求参数不受支持，请检查模型、JSON 模式和调用参数',
    401: '模型身份验证失败，请在「设置 → 大模型」检查 API Key',
    403: '模型接口拒绝访问，请检查模型使用权限',
    404: '模型或接口不存在，请在「设置 → 大模型」检查地址和模型名',
    408: '模型请求超时，请稍后重试',
    413: '模型请求内容过长，请减少每批句数或上下文句数',
    422: '模型请求参数无效，请检查调用参数',
    429: '模型请求受限，请检查可用额度或稍后重试',
  };
  return new LLMError(messages[status] || `模型服务暂时不可用（HTTP ${status}），请稍后重试`, status);
}

async function responseJSON(resp) {
  try { return await resp.json(); }
  catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new LLMError('模型返回格式异常，请检查接口配置后重试', 422);
  }
}

function requireContent(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new LLMError('模型未返回内容，请重试或更换模型', 422);
  }
  return text;
}

function ensureReady() {
  if (!String(config.baseUrl).trim()) throw new LLMError('请在「设置 → 大模型」填写接口地址');
  if (!String(config.model).trim()) throw new LLMError('请在「设置 → 大模型」填写模型名');
}

/** 把外部 signal 和超时并成一个 signal. */
function linkAbort(outer, ms) {
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = ms > 0 ? setTimeout(() => { timedOut = true; ctl.abort(); }, ms) : 0;
  return {
    signal: ctl.signal,
    get timedOut() { return timedOut; },
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
    throw new LLMError(hintFor(endpoint));
  }
}

/** 按页面与模型地址的协议差异, 给一句具体的排查建议. */
function hintFor(endpoint) {
  let url = null;
  try { url = new URL(endpoint); } catch { return '模型接口地址无效，请在「设置 → 大模型」检查地址'; }
  if (globalThis.location?.protocol === 'https:' && url.protocol === 'http:') {
    return '当前页面无法访问 HTTP 模型接口，请使用 HTTPS 接口地址';
  }
  return '无法连接模型接口，请检查网络、接口地址及服务的跨域访问（CORS）设置';
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
        attempt--;
        continue;
      }
      if (!resp.ok) throw responseError(resp.status);
      const data = await responseJSON(resp);
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
        throw new LLMError('模型输出达到上限，请在「设置 → 调用参数」提高输出上限', 422);
      }
      return requireContent(text);
    } catch (err) {
      if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
      last = link.timedOut ? new LLMError('模型请求超时，请重试或在「设置 → 调用参数」延长超时') : err;
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
    throw new LLMError('模型返回的数据格式无效，请重试或更换支持 JSON 输出的模型');
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
    if (!resp.ok) throw responseError(resp.status);
    const ctype = resp.headers.get('content-type') || '';
    // 有的网关会忽略 stream:true, 直接回整包 JSON
    if (!resp.body || !ctype.includes('text/event-stream')) {
      const data = await responseJSON(resp);
      out = requireContent(data ? contentOf(data) : '');
      if (onDelta) onDelta(out, out);
      return out;
    }
    out = await pump(resp.body.getReader(), onDelta);
    return requireContent(out);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    if (link.timedOut) throw new LLMError('讲解请求超时，请重试或在「设置 → 调用参数」延长超时');
    throw err instanceof LLMError ? err : new LLMError(msgOf(err));
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
    buf += done ? dec.decode() : dec.decode(value, { stream: true });
    if (done && buf && !buf.endsWith('\n')) buf += '\n';
    let cut;
    while ((cut = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, cut).trim();
      buf = buf.slice(cut + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk = null;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk?.error) throw new LLMError('讲解生成中断，请重试');
      const choice = chunk?.choices?.[0];
      const piece = (choice && ((choice.delta && choice.delta.content) ||
        (choice.message && choice.message.content))) || '';
      if (typeof piece !== 'string' || !piece) continue;
      out += piece;
      if (onDelta) onDelta(piece, out);
    }
    if (done) break;
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
  return text.trim().slice(0, 120);
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
