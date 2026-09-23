/**
 * 设置类界面的行控件 —— 开关 / 分段 / 步进 / 跳转 / 输入 / 文本域.
 *
 * 都做成"取值-写值"两个回调的形式, 这样同一套控件既能绑全局设置, 也能绑
 * 某条音频的配置, 不用为两处各写一遍。
 */

import { el, icon } from './util.js';

/** 分组标题 (设置页里那几个橄榄绿小标题). */
export const sectionTitle = (text) => el('h3', 'sec-t', text);

/** 把若干行装进一张圆角卡片. */
export function group(...rows) {
  const card = el('div', 'rows');
  card.append(...rows.filter(Boolean));
  return card;
}

function labelBox(label, hint) {
  const box = el('div', 'row-label');
  box.append(el('b', null, label));
  if (hint) box.append(el('span', null, hint));
  return box;
}

/** 开关行; get() -> 0|1, set(next). */
export function switchRow(label, hint, get, set) {
  const row = el('div', 'row');
  const sw = el('button', 'switch');
  sw.type = 'button';
  sw.setAttribute('aria-label', label);
  sw.setAttribute('aria-pressed', get() ? 'true' : 'false');
  sw.addEventListener('click', () => {
    const next = get() ? 0 : 1;
    sw.setAttribute('aria-pressed', next ? 'true' : 'false');
    set(next);
  });
  row.append(labelBox(label, hint), sw);
  row.refresh = () => sw.setAttribute('aria-pressed', get() ? 'true' : 'false');
  return row;
}

/** 分段选择行; options = [[value, text], …] */
export function segRow(label, hint, get, set, options, { wrap = false } = {}) {
  const row = el('div', 'row');
  const segs = el('div', 'segs');
  segs.setAttribute('role', 'group');
  segs.setAttribute('aria-label', label);
  if (wrap) segs.style.flexWrap = 'wrap';
  const buttons = options.map(([value, text]) => {
    const b = el('button', 'seg', text);
    b.type = 'button';
    b.dataset.value = String(value);
    b.setAttribute('aria-pressed', get() === value ? 'true' : 'false');
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      set(value);
    });
    return b;
  });
  segs.append(...buttons);
  row.append(labelBox(label, hint), segs);
  row.refresh = () => buttons.forEach((b) =>
    b.setAttribute('aria-pressed', b.dataset.value === String(get()) ? 'true' : 'false'));
  if (wrap) row.classList.add('row-wrap');
  return row;
}

/**
 * 步进行: 数值输入 + 加减按钮, 到边界就把按钮置灰.
 *
 * @param {Function} get 取当前值 (数字)
 * @param {Function} set 写回新值
 * @param {object} o `{min, max, step, unit}`
 */
export function stepRow(label, hint, get, set, { min = 0, max = 100, step = 1, unit = '' } = {}) {
  const row = el('div', 'row');
  const box = el('div', 'stepper');
  const val = el('input', 'step-v');
  val.type = 'number';
  val.inputMode = 'decimal';
  val.min = String(min);
  val.max = String(max);
  val.step = String(step);
  val.setAttribute('aria-label', label + (unit ? ' (' + unit + ')' : ''));
  val.addEventListener('change', () => {
    const next = val.valueAsNumber;
    if (Number.isFinite(next)) set(Math.min(max, Math.max(min, Math.round(next / step) * step)));
    row.refresh();
  });
  val.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') val.blur();
  });

  const mk = (glyph, delta, aria) => {
    const b = el('button', 'step-b');
    b.type = 'button';
    b.setAttribute('aria-label', aria);
    b.title = aria;
    b.append(icon(glyph, 'ic ic-sm'));
    b.addEventListener('click', () => {
      // Touch browsers may leave the number field focused when a button is tapped.
      if (document.activeElement === val) val.blur();
      const cur = Number(get()) || 0;
      const next = Math.min(max, Math.max(min, Math.round((cur + delta) / step) * step));
      if (next === cur) return;
      set(next);
      row.refresh();
    });
    return b;
  };

  const minus = mk('i-minus', -step, '减小' + label);
  const plus = mk('i-plus', step, '增大' + label);
  box.append(minus, val);
  if (unit) box.append(el('span', 'step-unit', unit));
  box.append(plus);

  const refreshLimits = (cur) => {
    minus.disabled = cur <= min;
    plus.disabled = cur >= max;
  };
  val.addEventListener('input', () => {
    const next = val.valueAsNumber;
    refreshLimits(Number.isFinite(next) ? next : Number(get()) || 0);
  });
  row.refresh = () => {
    const cur = Number(get()) || 0;
    val.value = String(cur);
    refreshLimits(cur);
  };
  row.refresh();
  row.append(labelBox(label, hint), box);
  return row;
}

/** 跳转行: 标题 + 副标题 + 右侧值 + 尖角. */
export function navRow(label, hint, { value = '', onPick, danger = false } = {}) {
  const row = el('button', 'row row-nav' + (danger ? ' is-danger' : ''));
  row.type = 'button';
  row.append(labelBox(label, hint));
  const right = el('div', 'row-right');
  const val = el('span', 'row-v', value);
  right.append(val, icon('i-chev', 'ic ic-sm ic-chev'));
  row.append(right);
  row.setValue = (text) => { val.textContent = text; };
  if (onPick) row.addEventListener('click', onPick);
  return row;
}

/** 纯动作行 (清缓存、恢复默认…). */
export function actionRow(label, hint, { onPick, danger = false } = {}) {
  const row = el('button', 'row row-nav' + (danger ? ' is-danger' : ''));
  row.type = 'button';
  row.append(labelBox(label, hint));
  if (onPick) row.addEventListener('click', onPick);
  return row;
}

/** 只读信息行. */
export function infoRow(label, value) {
  const row = el('div', 'row');
  row.append(labelBox(label, ''), el('span', 'row-v', value));
  row.setValue = (text) => { row.lastElementChild.textContent = text; };
  return row;
}

/**
 * 行内输入: 参数名与输入框同处一行, 输入框紧跟其后.
 *
 * 与 `inputField` 的区别就这一条 —— 后者把标签单独放一行、输入框占满整行.
 * 参数多而每项都短的时候 (句数 / 超时 / 温度), 一张卡片就能列完。
 */
export function inputRow(label, {
  value = '', type = 'text', min = 0, max = 999, step = 1, onInput,
} = {}) {
  const row = el('label', 'row row-inline');
  row.append(labelBox(label, ''));
  const input = el('input', 'row-input');
  input.type = type;
  input.value = value == null ? '' : String(value);
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (type === 'number') {
    input.inputMode = 'decimal';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
  }
  input.addEventListener('input', () => onInput && onInput(input.value));
  row.append(input);
  row.input = input;
  return row;
}

/** 单行输入 (标签在上, 输入框另起一行); `secret` 会加一个显示/隐藏按钮. */
export function inputField(label, {
  value = '', hint = '', placeholder = '', type = 'text', secret = false, onInput,
} = {}) {
  const wrap = el('label', 'field');
  wrap.append(el('b', null, label));
  if (hint) wrap.append(el('span', 'field-hint', hint));
  const box = el('div', 'field-box');
  const input = el('input');
  input.setAttribute('aria-label', label);
  input.type = secret ? 'password' : type;
  input.value = value == null ? '' : String(value);
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.addEventListener('input', () => onInput && onInput(input.value));
  box.append(input);
  if (secret) {
    const eye = el('button', 'field-eye');
    eye.type = 'button';
    eye.setAttribute('aria-label', '显示' + label);
    eye.setAttribute('aria-pressed', 'false');
    eye.append(icon('i-eye', 'ic ic-sm'));
    eye.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      eye.setAttribute('aria-pressed', input.type === 'text' ? 'true' : 'false');
      eye.setAttribute('aria-label', (input.type === 'text' ? '隐藏' : '显示') + label);
    });
    box.append(eye);
  }
  wrap.append(box);
  wrap.input = input;
  return wrap;
}

/** 多行输入 (提示词编辑). */
export function textField(label, { value = '', hint = '', placeholder = '', rows = 10, onInput } = {}) {
  const wrap = el('label', 'field');
  wrap.append(el('b', null, label));
  if (hint) wrap.append(el('span', 'field-hint', hint));
  const ta = el('textarea');
  ta.placeholder = placeholder;
  ta.rows = rows;
  ta.spellcheck = false;
  ta.value = value == null ? '' : String(value);
  ta.addEventListener('input', () => onInput && onInput(ta.value));
  wrap.append(ta);
  wrap.input = ta;
  return wrap;
}

/** 底部按钮条. */
export function buttonBar(...buttons) {
  const bar = el('div', 'field-acts');
  bar.append(...buttons.filter(Boolean));
  return bar;
}

export function button(text, { main = false, danger = false, glyph = '', onPick } = {}) {
  const b = el('button', 'btn' + (main ? ' btn-main' : '') + (danger ? ' btn-danger' : ''));
  b.type = 'button';
  if (glyph) b.append(icon(glyph, 'ic ic-sm'));
  b.append(el('span', null, text));
  if (onPick) b.addEventListener('click', onPick);
  return b;
}
