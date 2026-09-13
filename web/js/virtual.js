/**
 * 变高虚拟列表.
 *
 * 只把「视口 ± overscan」范围内的句子挂到 DOM 上, 其余交还给 Reader 的 LRU 缓存。
 * 高度先由 Metrics 精确预测 (见 metrics.js), 挂载后再实测一次校正;
 * 校正会连带修正 scrollTop, 所以滚动条和内容不会跳。
 */

import { locateOffset } from './util.js';

export class VirtualList {
  constructor(scroller, viewport, reader, metrics) {
    this.scroller = scroller;
    this.viewport = viewport;
    this.reader = reader;
    this.metrics = metrics;
    this.overscan = 700;
    this.gap = 4;
    this.padTop = 8;
    this.padBottom = 0;
    this.count = 0;
    this.h = new Float64Array(0);
    this.off = new Float64Array(1);
    this.measured = new Uint8Array(0);
    this.total = 0;
    this._vh = -1;
    this._first = 0;
    this._last = -1;
    this._drop = [];
  }

  reset(count) {
    this.count = count;
    this.h = new Float64Array(count);
    this.off = new Float64Array(count + 1);
    this.measured = new Uint8Array(count);
    this._first = 0;
    this._last = -1;
    this.computeAll();
  }

  /** 用 Metrics 重算全部预测高度 (字号/宽度/显示层变化后调用). */
  computeAll() {
    const { metrics, reader } = this;
    const sentences = reader.track.sentences;
    const showTr = document.documentElement.dataset.tr !== '0';
    for (let i = 0; i < this.count; i++) {
      this.h[i] = metrics.sentenceHeight(sentences[i], showTr);
      this.measured[i] = 0;
    }
    this.rebuild(0);
  }

  rebuild(from) {
    const { off, h, count, gap } = this;
    let acc = from > 0 ? off[from] : this.padTop;
    for (let i = from; i < count; i++) { off[i] = acc; acc += h[i] + gap; }
    off[count] = acc;
    this.total = acc;
    this.viewport.style.height = (acc + this.padBottom) + 'px';
  }

  offsetOf(i) { return this.off[Math.max(0, Math.min(i, this.count))]; }

  /** 让第 i 句停在视口 align 位置 (0=顶部, .5=居中). */
  scrollTargetFor(i, align) {
    const vh = this.scroller.clientHeight;
    const y = this.off[i] - (vh - this.h[i]) * align;
    const max = Math.max(0, this.total + this.padBottom - vh);
    return Math.max(0, Math.min(y, max));
  }

  indexAt(scrollTop) {
    return locateOffset(this.off, this.count, scrollTop);
  }

  /**
   * 同步一次可见窗口. 严格分成「写 -> 读 -> 写」三段, 避免布局抖动.
   * @param {boolean} force 忽略窗口未变化的快速返回
   */
  update(force) {
    const sc = this.scroller;
    const vh = sc.clientHeight;
    if (vh !== this._vh) {
      this._vh = vh;
      this.padBottom = Math.round(vh * 0.5);
      this.viewport.style.height = (this.total + this.padBottom) + 'px';
      force = true;
    }
    if (!this.count) return;

    const st = sc.scrollTop;
    const { off, count, overscan } = this;
    let first = locateOffset(off, count, st - overscan);
    let last = locateOffset(off, count, st + vh + overscan);
    if (!force && first === this._first && last === this._last) return;
    this._first = first;
    this._last = last;

    // 1) 回收窗口外的节点
    const drop = this._drop;
    drop.length = 0;
    for (const i of this.reader.els.keys()) if (i < first || i > last) drop.push(i);
    for (let k = 0; k < drop.length; k++) this.reader.unmount(drop[k]);

    // 2) 挂载并定位 (纯写)
    let newFrom = -1, newTo = -1;
    for (let i = first; i <= last; i++) {
      const fresh = !this.reader.els.has(i);
      this.reader.mount(i, off[i]);
      if (fresh && !this.measured[i]) {
        if (newFrom < 0) newFrom = i;
        newTo = i;
      }
    }

    // 3) 实测校正 (纯读)
    if (newFrom < 0) return;
    let dirty = -1;
    for (let i = newFrom; i <= newTo; i++) {
      const el = this.reader.els.get(i);
      if (!el || this.measured[i]) continue;
      const real = el.getBoundingClientRect().height;
      this.measured[i] = 1;
      if (Math.abs(real - this.h[i]) > 0.6) {
        this.h[i] = real;
        if (dirty < 0 || i < dirty) dirty = i;
      }
    }
    if (dirty < 0) return;

    // 4) 偏移表失效: 以视口顶部条目为锚点重排, 保证画面不跳
    const anchor = locateOffset(off, count, st);
    const delta = st - off[anchor];
    this.rebuild(dirty);
    if (anchor >= dirty) {
      const fixed = Math.max(0, off[anchor] + delta);
      if (Math.abs(fixed - sc.scrollTop) > 0.5) sc.scrollTop = fixed;
    }
    this.reposition();
  }

  /** rebuild() 之后把挂着的节点挪到新偏移; 只写 transform. */
  reposition() {
    const off = this.off;
    for (const [i, el] of this.reader.els) {
      if (el._y !== off[i]) {
        el._y = off[i];
        el.style.transform = `translate3d(0,${off[i]}px,0)`;
      }
    }
  }

  /**
   * 少数句子的内容变了 (前端翻译补齐) —— 只重量这几行, 不动其它句子的实测结果.
   *
   * 挂着的节点直接实测 (调用方已经把新文本写进 DOM), 离屏的按 Metrics 重新预测。
   * 偏移表从最小受影响的下标往后重排, 并以视口顶部条目为锚点回填 scrollTop,
   * 所以译文到达时画面不会跳。
   *
   * @param {Iterable<number>} list 受影响的句序
   * @returns {boolean} 偏移表是否真的变了
   */
  invalidate(list) {
    if (!this.count) return false;
    const { metrics, reader, h, measured } = this;
    const sentences = reader.track.sentences;
    const showTr = document.documentElement.dataset.tr !== '0';
    const mounted = [];
    let dirty = -1;
    const bump = (i, next) => {
      if (Math.abs(next - h[i]) <= 0.6) return;
      h[i] = next;
      if (dirty < 0 || i < dirty) dirty = i;
    };

    for (const i of list) {
      if (i < 0 || i >= this.count) continue;
      if (reader.els.has(i)) { mounted.push(i); continue; }
      measured[i] = 0;
      bump(i, metrics.sentenceHeight(sentences[i], showTr));
    }
    for (const i of mounted) {                       // 纯读, 和上面的纯写分开
      const el = reader.els.get(i);
      if (!el) continue;
      measured[i] = 1;
      bump(i, el.getBoundingClientRect().height);
    }
    if (dirty < 0) return false;

    const sc = this.scroller;
    const st = sc.scrollTop;
    const anchor = locateOffset(this.off, this.count, st);
    const delta = st - this.off[anchor];
    this.rebuild(dirty);
    if (anchor >= dirty) {
      const fixed = Math.max(0, this.off[anchor] + delta);
      if (Math.abs(fixed - sc.scrollTop) > 0.5) sc.scrollTop = fixed;
    }
    this.reposition();
    return true;
  }

  /** 字号/宽度变化: 重算全部高度, 并把指定句子保持在原来的视觉位置. */
  remeasure(keepIndex, align) {
    this.reader.clearAll();
    this.computeAll();
    this._first = 0;
    this._last = -1;
    this._vh = -1;
    if (keepIndex >= 0 && keepIndex < this.count) {
      this.update(true);
      this.scroller.scrollTop = this.scrollTargetFor(keepIndex, align);
    }
    this.update(true);
  }
}
