/**
 * 阅读区 DOM: 句子/单词节点的构建、复用与高亮状态写入.
 *
 * 高亮全部走 `className` 与 `style.transform` 的直接写入 —— 没有虚拟 DOM,
 * 没有响应式代理, 每次状态切换只碰真正变化的那几个节点。
 *
 * 每个单词是一个「三层 chip」: 上层 `w-read` (注音)、中层 `w-text` (原文)、
 * 下层 `w-roman` (转写/原形), 加一条扫光进度条。三层对任何语言都是同一套结构,
 * 具体哪层有内容由 `track.json` 的单词字段决定 —— 没有就留空。
 *
 * **留空的层仍然占着它那一行的高度**: 四行的高度是固定长度 (见 reader.css 的 `.w`),
 * 与内容无关。所以同一视觉行里所有原文都落在同一条线上, 哪个词有注音、哪个词没有都
 * 不影响; 整层关掉才把那一行压成 0 (`html[data-read="0"]`), 而那是全局一致的。
 * 千万别改成「空了就不占高度」—— 字幕会因为个别词有注音而上下参差。
 */

const CACHE_MAX = 200;

const CHIP_TPL = (() => {
  const t = document.createElement('template');
  t.innerHTML =
    '<span class="w"><span class="w-read"></span><span class="w-text"></span>' +
    '<i class="w-bar"><i class="w-fill"></i></i><span class="w-roman"></span></span>';
  return t.content.firstElementChild;
})();

export class Reader {
  constructor(viewport, track, metrics) {
    this.viewport = viewport;
    this.track = track;
    this.metrics = metrics;
    this.els = new Map();    // 已挂载: 句号 -> 元素
    this.cache = new Map();  // LRU 离屏缓存, 回滚时秒级复用
    this.activeS = -1;
    this.activeW = -1;
    this.curFill = null;
    this._lastP = -1;
  }

  // ------------------------------------------------------------ 构建

  _create(i) {
    const s = this.track.sentences[i];
    const art = document.createElement('article');
    art.className = s.wordTiming ? 's' : 's no-wt';
    art.dataset.i = i;

    const wrap = document.createElement('div');
    wrap.className = 's-words';
    const chips = new Array(s.words.length);
    for (let j = 0; j < s.words.length; j++) {
      const w = s.words[j];
      const chip = CHIP_TPL.cloneNode(true);
      const base = 'w p-' + (w.pos || 'other');
      chip.className = base;
      chip._cls = base;
      chip.dataset.j = j;
      if (w.read) chip.children[0].textContent = w.read;
      chip.children[1].textContent = w.text;
      if (w.roman) chip.children[3].textContent = w.roman;
      chip._fill = chip.children[2].firstElementChild;
      chips[j] = chip;
      wrap.appendChild(chip);
    }
    art.appendChild(wrap);

    const tr = document.createElement('p');
    tr.className = 's-tr';
    if (s.translation) tr.textContent = s.translation;
    art.appendChild(tr);

    art._chips = chips;
    return art;
  }

  // ------------------------------------------------------------ 挂载 / 回收

  mount(i, y) {
    let el = this.els.get(i);
    if (!el) {
      el = this.cache.get(i);
      if (el) this.cache.delete(i);
      else el = this._create(i);
      el._st = undefined;
      el._y = NaN;
      this.els.set(i, el);
      this._apply(el, i);
      for (let j = 0; j < el._chips.length; j++) {
        for (const layer of this.metrics.layers) {
          el._chips[j].style.setProperty('--fit-' + layer.key,
            this.metrics.layerScale(this.track.sentences[i].words[j], layer));
        }
      }
      this.viewport.appendChild(el);
      if (i === this.activeS) { this.curFill = el._fillEl || null; this._lastP = -1; }
    }
    if (el._y !== y) {
      el._y = y;
      el.style.transform = `translate3d(0,${y}px,0)`;
    }
    return el;
  }

  unmount(i) {
    const el = this.els.get(i);
    if (!el) return;
    this.els.delete(i);
    el.remove();
    if (el._fillEl) { el._fillEl.style.transform = ''; el._fillEl = null; }
    el._st = undefined;
    this.cache.delete(i);
    this.cache.set(i, el);
    if (this.cache.size > CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value);
    }
    if (i === this.activeS) { this.curFill = null; this._lastP = -1; }
  }

  clearAll() {
    for (const i of [...this.els.keys()]) this.unmount(i);
  }

  /**
   * 写入后到的译文 (前端翻译是异步补齐的).
   *
   * 句子高度会因此变化, 所以调用方紧接着要让虚拟列表重量这几行;
   * 已经回收进 LRU 缓存的节点也一起改, 免得滚回去看到旧内容。
   */
  setTranslation(i, text) {
    const s = this.track.sentences[i];
    if (!s) return false;
    s.translation = text;
    const el = this.els.get(i) || this.cache.get(i);
    if (el) el.lastElementChild.textContent = text;
    return true;
  }

  // ------------------------------------------------------------ 高亮状态

  /** 把当前 (activeS, activeW) 写进某个句子节点; 无变化时立即返回. */
  _apply(el, i) {
    const isActive = i === this.activeS;
    const want = isActive ? this.activeW : -2;
    if (el._st === want) return;
    el._st = want;

    el.classList.toggle('is-active', isActive);
    if (el._fillEl) { el._fillEl.style.transform = ''; el._fillEl = null; }

    const chips = el._chips;
    if (!isActive) {
      if (el._touched) {
        for (let j = 0; j < chips.length; j++) chips[j].className = chips[j]._cls;
        el._touched = false;
      }
      return;
    }
    el._touched = true;
    const aw = this.activeW;
    for (let j = 0; j < chips.length; j++) {
      const chip = chips[j];
      const cls = j === aw ? chip._cls + ' is-cur' : j < aw ? chip._cls + ' is-done' : chip._cls;
      if (chip.className !== cls) chip.className = cls;
    }
    if (aw >= 0 && aw < chips.length) el._fillEl = chips[aw]._fill;
  }

  /** 由渲染循环调用: 切换当前句 / 当前词. */
  setActive(sIdx, wIdx) {
    if (sIdx === this.activeS && wIdx === this.activeW) return;
    const prevS = this.activeS;
    this.activeS = sIdx;
    this.activeW = wIdx;
    if (prevS !== sIdx) {
      const prevEl = this.els.get(prevS);
      if (prevEl) this._apply(prevEl, prevS);
    }
    const el = this.els.get(sIdx);
    if (el) this._apply(el, sIdx);
    this.curFill = el ? el._fillEl || null : null;
    this._lastP = -1;
  }

  /** 当前词内部的扫过进度 (0..1). 唯一的逐帧写入. */
  setProgress(p) {
    const fill = this.curFill;
    if (!fill) return;
    const q = p < 0 ? 0 : p > 1 ? 1 : Math.round(p * 400) / 400;
    if (q === this._lastP) return;
    this._lastP = q;
    fill.style.transform = q ? `scaleX(${q})` : 'scaleX(0)';
  }
}
