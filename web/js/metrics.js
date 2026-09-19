/**
 * 排版度量: 用 Canvas `measureText` 预测句子高度.
 *
 * 虚拟滚动最难的部分是「还没渲染的条目有多高」。这里不猜, 而是:
 *  1. 从一个隐藏探针节点读出真实的字体/间距/网格行高 (全部来自 CSS 变量);
 *  2. 用 Canvas 量出每个单词三层文字的最大宽度;
 *  3. 按 flex-wrap 的规则模拟一遍折行, 得到精确的行数。
 *
 * 结果通常与真实渲染完全一致, 因此滚动条长度和跳转位置都是稳的;
 * 万一有偏差, 虚拟列表挂载时的实测会再校正一次。
 */

import { layoutHeight } from './util.js';

const PROBE_HTML =
  '<div class="s"><div class="s-words"><span class="w">' +
  '<span class="w-read">あ</span><span class="w-text">あ</span>' +
  '<i class="w-bar"><i class="w-fill"></i></i><span class="w-roman">a</span>' +
  '</span></div><p class="s-tr">あ</p></div>';

const px = (v) => parseFloat(v) || 0;

function fontOf(cs) {
  return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
}

export class Metrics {
  constructor(probe) {
    this.probe = probe;
    this.probe.innerHTML = PROBE_HTML;
    const ctx = document.createElement('canvas').getContext('2d');
    this.ctx = ctx;
    this.width = 0;
    this.cache = new Map(); // 单词层文字 -> 宽度
    this.sync(0);
  }

  /** 重新读取样式 (主题/字号/显示层变化后调用). 返回 true 表示度量有变化. */
  sync(contentWidth) {
    const p = this.probe;
    const s = p.firstElementChild;
    const words = s.firstElementChild;
    const chip = words.firstElementChild;
    const readEl = chip.children[0], textEl = chip.children[1], romanEl = chip.children[3];
    const csS = getComputedStyle(s);
    const csW = getComputedStyle(words);
    const csC = getComputedStyle(chip);
    const csTr = getComputedStyle(s.lastElementChild);
    const csA = getComputedStyle(readEl);
    const csB = getComputedStyle(textEl);
    const csR = getComputedStyle(romanEl);

    const chipH = layoutHeight(chip);
    const sig = [
      chipH, csW.columnGap, csW.rowGap, csS.padding, csC.padding,
      csA.font, csB.font, csR.font, csA.display, csR.display,
      csTr.font, csTr.lineHeight, csTr.marginTop, contentWidth,
    ].join('|');
    const changed = sig !== this._sig;
    this._sig = sig;
    if (changed) this.cache.clear();

    this.width = contentWidth;
    this.chipH = chipH;
    this.colGap = px(csW.columnGap);
    this.rowGap = px(csW.rowGap);
    this.padX = px(csS.paddingLeft) + px(csS.paddingRight);
    this.padY = px(csS.paddingTop) + px(csS.paddingBottom);
    this.chipPad = px(csC.paddingLeft) + px(csC.paddingRight);
    this.trH = px(csTr.lineHeight) || px(csTr.fontSize) * 1.5;
    this.trTop = px(csTr.marginTop);

    // key 是单词对象上的字段名, 三层对所有语言通用; tag 只是缓存前缀, 用来区分
    // 「同样的文字用不同字体量」(日语的假名层和原文层经常一模一样, 字号却不同)
    this.layers = [
      { key: 'read', tag: 'a', font: fontOf(csA), ls: px(csA.letterSpacing), on: csA.display !== 'none' },
      { key: 'text', tag: 'b', font: fontOf(csB), ls: px(csB.letterSpacing), on: true },
      { key: 'roman', tag: 'c', font: fontOf(csR), ls: px(csR.letterSpacing), on: csR.display !== 'none' },
    ];
    this.trLayer = { tag: 't', font: fontOf(csTr), ls: px(csTr.letterSpacing) };
    this.avail = Math.max(40, contentWidth - this.padX);
    return changed;
  }

  _measure(text, layer) {
    if (!text) return 0;
    const key = layer.tag + text;
    let v = this.cache.get(key);
    if (v === undefined) {
      this.ctx.font = layer.font;
      v = this.ctx.measureText(text).width + text.length * layer.ls;
      this.cache.set(key, v);
    }
    return v;
  }

  chipWidth(word) {
    let max = 0;
    for (const layer of this.layers) {
      if (!layer.on) continue;
      const text = word[layer.key];
      if (!text) continue;
      const w = this._measure(text, layer);
      if (w > max) max = w;
    }
    return Math.min(this.avail, max + this.chipPad);
  }

  /** 超宽文字层单独缩小, 与 Reader 写入的字号比例共用同一套宽度测量. */
  layerScale(word, layer) {
    if (!layer.on) return 1;
    const width = this._measure(word[layer.key], layer);
    const limit = Math.max(1, this.avail - this.chipPad - 0.5);
    return width > limit ? Math.floor(limit / width * 10000) / 10000 : 1;
  }

  /** 模拟 flex-wrap, 返回句子占的行数. */
  lineCount(words) {
    const { avail, colGap } = this;
    let lines = 1, x = 0;
    for (let i = 0; i < words.length; i++) {
      const w = this.chipWidth(words[i]);
      if (x === 0) { x = w; continue; }
      if (x + colGap + w > avail + 0.5) { lines++; x = w; }
      else x += colGap + w;
    }
    return lines;
  }

  sentenceHeight(sentence, showTr) {
    const lines = this.lineCount(sentence.words);
    let h = this.padY + lines * this.chipH + (lines - 1) * this.rowGap;
    if (showTr && sentence.translation) {
      const w = this._measure(sentence.translation, this.trLayer);
      h += this.trTop + Math.max(1, Math.ceil((w - 0.5) / this.avail)) * this.trH;
    }
    return Math.round(h);
  }
}
