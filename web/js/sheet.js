/**
 * 底部浮层 / 确认框 / 小菜单 —— 首页和播放页共用.
 *
 * 只有一个 `.sheet` 节点被反复复用: 打开/关闭全靠 `transform` + `opacity` 过渡,
 * 不动布局属性; 下拉关闭时直接写 `style.transform`, 不经过 CSS 类。
 */

import { el, icon } from './util.js';

let sheetEl = null;
let scrimEl = null;
let headEl = null;
let titleEl = null;
let actsEl = null;
let bodyEl = null;
let footEl = null;
let closeCb = null;
// 打开状态用变量记, 不看 `.is-open` 类: 那个类是下一帧才加的, 后台标签页里
// rAF 会被节流, 只看类名会让「同一帧内开了又关」的浮层漏掉 onClose.
let openFlag = false;

function ensureSheet() {
  if (sheetEl) return;
  scrimEl = el('div', 'scrim');
  scrimEl.addEventListener('click', closeSheet);

  sheetEl = el('div', 'sheet');
  sheetEl.setAttribute('role', 'dialog');
  sheetEl.setAttribute('aria-modal', 'true');

  const grip = el('div', 'sheet-grip');
  headEl = el('div', 'sheet-head');
  titleEl = el('h2');
  actsEl = el('div', 'sheet-acts');
  const close = el('button', 'tb-btn tb-btn-sm');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭');
  close.append(icon('i-x'));
  close.addEventListener('click', closeSheet);
  actsEl.append(close);
  headEl.append(titleEl, actsEl);

  bodyEl = el('div', 'sheet-body');
  footEl = el('div', 'sheet-foot');
  footEl.hidden = true;

  sheetEl.append(grip, headEl, bodyEl, footEl);
  document.body.append(scrimEl, sheetEl);
  dragToClose(grip);
  dragToClose(headEl);
}

/**
 * 抓住把手往下拖就能关; 位移只写 transform.
 *
 * 注意必须带上那个 `-50%`: 浮层是 `left:50%` + `translate(-50%, …)` 居中的,
 * 内联 transform 会整条盖掉 CSS 里的值 —— 只写纵向位移的话, 手指一按下去
 * 浮层连着里面的设置卡片就当场右移半个身位, 松手时还会斜着滑出去。
 */
function dragToClose(handle) {
  let id = -1;
  let y0 = 0;
  let dy = 0;
  const pointerY = (event) => document.body.classList.contains('video-rotated') ? -event.clientX : event.clientY;
  handle.addEventListener('pointerdown', (e) => {
    if (id !== -1 || e.target.closest('button')) return;
    id = e.pointerId;
    y0 = pointerY(e);
    dy = 0;
    handle.setPointerCapture(id);
    sheetEl.style.transition = 'none';
  });
  handle.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    dy = Math.max(0, pointerY(e) - y0);
    sheetEl.style.transform = `translate(-50%, ${dy}px)`;
    scrimEl.style.opacity = String(Math.max(0, 1 - dy / 320));
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = -1;
    sheetEl.style.transition = '';
    sheetEl.style.transform = '';
    scrimEl.style.opacity = '';
    if (dy > 96) closeSheet();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/**
 * @param {string} title
 * @param {Node} body
 * @param {object|Function} [opts] `{onClose, footer, cls, actions:[Node]}`; 传函数等价于 onClose
 */
export function openSheet(title, body, opts = {}) {
  ensureSheet();
  const o = typeof opts === 'function' ? { onClose: opts } : (opts || {});
  closeSheet();
  sheetEl.className = 'sheet' + (o.cls ? ' ' + o.cls : '');
  titleEl.textContent = title;
  bodyEl.textContent = '';
  if (body) bodyEl.append(body);
  bodyEl.scrollTop = 0;

  // 头部额外按钮 (如讲解的「…」) 插在关闭按钮前面
  while (actsEl.children.length > 1) actsEl.firstChild.remove();
  for (const node of o.actions || []) actsEl.insertBefore(node, actsEl.lastChild);

  footEl.textContent = '';
  footEl.hidden = !o.footer;
  if (o.footer) footEl.append(o.footer);

  closeCb = o.onClose || null;
  openFlag = true;
  document.documentElement.classList.add('sheet-open');
  requestAnimationFrame(() => {
    // 这一帧到达前又被关掉了 (同一帧内开又关) 就别再补 `.is-open`,
    // 否则浮层会自己弹回来, 而 openFlag 已经是 false, 点遮罩也关不掉。
    if (!openFlag) return;
    scrimEl.classList.add('is-open');
    sheetEl.classList.add('is-open');
  });
  return { sheet: sheetEl, body: bodyEl, foot: footEl };
}

export function closeSheet() {
  if (!sheetEl || !openFlag) return;
  openFlag = false;
  document.documentElement.classList.remove('sheet-open');
  sheetEl.classList.remove('is-open');
  scrimEl.classList.remove('is-open');
  if (closeCb) {
    const cb = closeCb;
    closeCb = null;
    cb();
  }
}

export const sheetOpen = () => openFlag;
export const sheetBody = () => bodyEl;

/** 确认框; resolve(true) 表示点了主按钮. */
export function openConfirm(title, text, { ok = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const body = el('div', 'confirm');
    body.append(el('p', 'confirm-t', text));
    const bar = el('div', 'confirm-acts');
    const cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { done(false); closeSheet(); });
    const okBtn = el('button', 'btn btn-main' + (danger ? ' btn-danger' : ''), ok);
    okBtn.type = 'button';
    okBtn.addEventListener('click', () => { done(true); closeSheet(); });
    bar.append(cancel, okBtn);
    body.append(bar);
    openSheet(title, body, { onClose: () => done(false) });
  });
}

/** 贴着某个按钮弹出的小菜单. items: `{label, icon, danger, onPick}` */
export function openMenu(anchor, items) {
  const scrim = el('div', 'menu-scrim');
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  const shut = () => { scrim.remove(); menu.remove(); };
  scrim.addEventListener('click', shut);
  for (const it of items) {
    if (!it) continue;
    const btn = el('button', 'menu-i' + (it.danger ? ' is-danger' : ''));
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    if (it.icon) btn.append(icon(it.icon, 'ic ic-sm'));
    btn.append(el('span', null, it.label));
    btn.addEventListener('click', () => { shut(); it.onPick(); });
    menu.append(btn);
  }
  document.body.append(scrim, menu);
  let box = anchor.getBoundingClientRect();
  const rotated = document.body.classList.contains('video-rotated');
  const viewWidth = rotated ? innerHeight : innerWidth;
  const viewHeight = rotated ? innerWidth : innerHeight;
  if (rotated) box = { right: box.bottom, top: innerWidth - box.right, bottom: innerWidth - box.left };
  const w = menu.offsetWidth;
  const left = Math.min(Math.max(8, box.right - w), viewWidth - w - 8);
  const below = box.bottom + 6;
  const fits = below + menu.offsetHeight < viewHeight - 8;
  menu.style.left = left + 'px';
  menu.style.top = (fits ? below : Math.max(8, box.top - menu.offsetHeight - 6)) + 'px';
  requestAnimationFrame(() => menu.classList.add('is-open'));
  return shut;
}
