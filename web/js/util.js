/** 小工具集. */

export const $ = (id) => document.getElementById(id);

/** Logical block size remains the same when the video page is rotated as a fallback. */
export function layoutHeight(node) {
  const rect = node.getBoundingClientRect();
  return document.body.classList.contains('video-rotated') ? rect.width : rect.height;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Local storage identifiers also work on HTTP origins without randomUUID. */
export function randomId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 0:09 / 1:02:33 */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const t = Math.floor(sec);
  const s = t % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 在**单调不减**的 Float32Array 里找最后一个 `arr[i] <= t` 的下标.
 *
 * 先从 `hint` 向前线性走几步 (播放时命中率极高, O(1)), 走不通再退化成二分.
 * 这是整个渲染循环里唯一的查找逻辑, 每帧最多一次。
 */
export function locate(arr, n, t, hint) {
  if (n === 0 || t < arr[0]) return -1;
  if (hint >= 0 && hint < n && arr[hint] <= t) {
    let i = hint;
    for (let k = 0; k < 6 && i + 1 < n && arr[i + 1] <= t; k++) i++;
    if (i + 1 >= n || arr[i + 1] > t) return i;
  }
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 在单调不减的 Float64Array 偏移表里找 `off[i] <= y < off[i+1]`. */
export function locateOffset(off, n, y) {
  let lo = 0, hi = n - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (off[mid] <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer = 0;
export function toast(msg) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = msg;
  node.classList.add('is-on');
  clearTimeout(toastTimer);
  const duration = Math.min(15000, Math.max(1600, String(msg).length * 60));
  toastTimer = setTimeout(() => node.classList.remove('is-on'), duration);
}

/** rAF 节流: 同一帧内多次调用只执行一次. */
export function rafOnce(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...args); });
  };
}

/** 尾延迟节流: 常用于输入框搜索. */
export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * cyrb53 —— 同步的 53 位字符串散列, 只用来做缓存键.
 *
 * 不用 `crypto.subtle.digest` 是因为它是异步的: 命中缓存的路径要保持同步,
 * 否则每次取译文都要多等一个微任务, 还得把整条链路改成 async。
 */
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 1.4 MB / 820 KB */
export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

/** ISO 时间 -> 本地 `2026-8-25`; 解析不了就原样返回. */
export function dayKey(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '未知日期';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 把 SVG 图标塞进按钮; 用 use 引用页面里的 sprite. */
export function icon(name, cls = 'ic') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}

/**
 * 是不是 iOS / iPadOS (含桌面模式的 iPad).
 *
 * 只用来绕开一个 Safari 的老问题: `<input accept>` 里按扩展名给的类型, 系统必须
 * 认识对应的 UTI 才会放行 —— `.json` 有 `public.json`, 而 `.srt` / `.vtt` 拿到的
 * 是动态 UTI, 于是文件选择器里整片灰掉, 根本选不中。
 */
export const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.platform || '')
  || /iP(hone|ad|od)/.test(navigator.userAgent)
  || (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** 复制到剪贴板, 带 execCommand 兜底 (非 https 时 clipboard API 不可用). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* 降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
