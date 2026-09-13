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
 * 分析是同步的 (没有作业轮询): 后端把过程日志随响应一起给回来, 播放页照原样展示。
 */

import { config } from './config.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 规整后端地址: 去掉尾斜杠, 容忍用户把 `/api` 也填进去. */
export function baseOf(raw) {
  const value = raw === undefined ? config.apiBase : raw;
  let base = String(value || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  base = base.replace(/\/api$/i, '');
  return base;
}

export const apiUrl = (path, base) => baseOf(base) + '/api' + path;

/** 给人看的地址描述 (设置页/关于页用). */
export const baseLabel = (raw) => baseOf(raw) || '同源 (本机服务)';

async function json(url, init) {
  const headers = new Headers(init.headers);
  const token = String(config.apiToken || '').trim();
  if (token) headers.set('Authorization', 'Bearer ' + token);
  let resp;
  try {
    resp = await fetch(url, { cache: 'no-store', ...init, headers });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, '连不上分析后端: ' + ((err && err.message) || '网络错误')
      + ' (检查「设置 → 分析后端」, 或用 python -m pipeline serve 启动)');
  }
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (resp.status === 401) {
    throw new ApiError(401, '分析后端鉴权失败: 请在「设置 → 分析后端」填写正确的访问令牌');
  }
  if (!resp.ok) throw new ApiError(resp.status, (data && data.error) || text.slice(0, 300));
  return data || {};
}

/**
 * 后端自检.
 * @returns {Promise<{ok, version, schemaVersion, languages, formats, maxBody}>}
 */
export function health({ base, probe = true, signal } = {}) {
  return json(apiUrl(`/health?probe=${probe ? 1 : 0}`, base), { method: 'GET', signal });
}

/**
 * 分析一份字幕.
 * @param {File|Blob} file 字幕文件 (.json / .srt / .vtt)
 * @param {object} params `{lang, id, title, duration, split, merge, estimate, maxSeconds}`
 * @returns {Promise<{ok, log, track}>}
 */
export function analyze(file, params = {}, { signal, base } = {}) {
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
