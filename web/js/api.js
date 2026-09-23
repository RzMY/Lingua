/**
 * 分析后端客户端 —— 后端只有两个接口, 所以这一层很薄.
 *
 * * `health()`  —— 探活, 并顺手拿到「这台后端支持哪些语言、依赖装好了没」;
 * * `analyze()` —— 把字幕原文当裸 body POST 上去, 拿回 track.json。
 *
 * 地址来自设置页的「分析后端」(`config.apiBase`)。留空就用同源, 也就是
 * `python -m pipeline serve` 同时端出站点和 API 的常见情形; 填了就走跨源,
 * 后端已经放开了 CORS。
 *
 * 分析是同步的 (没有作业轮询): 响应可带诊断日志，播放页只展示进度和面向用户的错误。
 */

import { config } from './config.js';
import { nativeApp } from './native.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message || `分析请求失败（HTTP ${status}），请重试`);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 规整后端地址: 去掉尾斜杠, 容忍用户把 `/api` 也填进去. */
export function baseOf(raw) {
  const value = (raw === undefined ? config.apiBase : raw) || nativeApp()?.target;
  let base = String(value || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  base = base.replace(/\/api$/i, '');
  return base;
}

export const apiUrl = (path, base) => baseOf(base) + '/api' + path;

/** 给人看的地址描述 (设置页/关于页用). */
export const baseLabel = (raw) => baseOf(raw) || (nativeApp() ? '未配置分析后端' : '当前站点');

function responseError(status, data) {
  const detail = typeof data?.error === 'string' ? data.error : '';
  if (status === 400) {
    if (/依赖|词典|模型.*(?:缺|安装|加载)|not installed|No module named|Can't find model/i.test(detail)) {
      return '所选语言的分析组件未就绪，请检查后端配置';
    }
    if (/不支持的语言|未知语言/.test(detail)) return '所选语言不可用，请检查字幕语言或后端配置';
    if (/时间戳|字幕|JSON|SRT|VTT/i.test(detail)) return '字幕格式或时间戳无效，请检查字幕文件';
    return '分析请求无效，请检查字幕文件、源语言和分析选项（HTTP 400）';
  }
  const messages = {
    401: '分析后端身份验证失败，请在「设置 → 分析后端」检查访问令牌',
    403: '分析后端拒绝访问，请检查访问权限',
    404: '分析接口不存在，请在「设置 → 分析后端」检查地址',
    408: '分析请求超时，请稍后重试',
    413: '字幕文件超过服务上限，请缩小文件后重试',
    415: '字幕格式不受支持，请选择 SRT、VTT 或 JSON 文件',
    429: '分析请求过于频繁，请稍后重试',
  };
  return messages[status] || `分析服务暂时不可用（HTTP ${status}），请稍后重试`;
}

async function json(url, init) {
  const headers = new Headers(init.headers);
  const token = String(config.apiToken || '').trim();
  if (token) headers.set('Authorization', 'Bearer ' + token);
  let resp;
  try {
    resp = await fetch(url, { cache: 'no-store', ...init, headers });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, '无法连接分析后端，请检查网络及「设置 → 分析后端」中的地址');
  }
  let text;
  try { text = await resp.text(); }
  catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, '分析连接中断，请重试');
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!resp.ok) throw new ApiError(resp.status, responseError(resp.status, data));
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok === false || data.error) {
    throw new ApiError(resp.status, '分析后端返回格式异常，请检查服务地址后重试');
  }
  return data;
}

/**
 * 后端自检.
 * @returns {Promise<{ok, version, schemaVersion, languages, formats, maxBody}>}
 */
export function health({ base, probe = true, signal } = {}) {
  if (nativeApp() && !baseOf(base)) return Promise.reject(new ApiError(0, '请在「设置 → 分析后端」配置服务地址'));
  return json(apiUrl(`/health?probe=${probe ? 1 : 0}`, base), { method: 'GET', signal });
}

/**
 * 分析一份字幕.
 * @param {File|Blob} file 字幕文件 (.json / .srt / .vtt)
 * @param {object} params `{lang, id, title, duration, split, merge, estimate, maxSeconds}`
 * @returns {Promise<{ok, log, track}>}
 */
export function analyze(file, params = {}, { signal, base } = {}) {
  if (nativeApp() && !baseOf(base)) return Promise.reject(new ApiError(0, '请在「设置 → 分析后端」配置服务地址'));
  const q = new URLSearchParams();
  q.set('name', file.name || 'transcript.json');
  if (params.lang) q.set('lang', params.lang);
  if (params.id) q.set('id', params.id);
  if (params.title) q.set('title', params.title);
  if (params.duration) q.set('duration', String(params.duration));
  for (const key of ['split', 'merge', 'estimate']) {
    if (params[key] !== undefined) q.set(key, params[key] ? '1' : '0');
  }
  if (params.maxSeconds !== undefined) q.set('maxSeconds', String(params.maxSeconds));
  return json(apiUrl(`/analyze?${q}`, base), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: file,
    signal,
  });
}
