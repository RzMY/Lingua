/**
 * 渲染引擎 —— 全应用唯一的 requestAnimationFrame 循环.
 *
 * 每帧只做四件事:
 *   1. 读一次 `audio.currentTime`;
 *   2. 用单调指针 (退化时二分) 在 Float32Array 时间轴上定位句/词;
 *   3. 直接写 className / style.transform 更新高亮与进度条;
 *   4. 同步虚拟列表窗口, 并推进自动滚动的缓动.
 *
 * 不使用 timeupdate 事件, 不经过任何响应式状态; 暂停且静止时循环会自行停车。
 */

import { clamp, fmtTime, locate } from './util.js';

const FOLLOW_ALIGN = 0.30;
const USER_SCROLL_HOLD = 2600; // ms: 手动滚动后暂停自动跟随
const SCROLL_TAU = 150;        // ms: 自动滚动的缓动时间常数
const IDLE_GRACE = 500;
const CUE_EPS = 0.004;         // s: 见 _sync —— 补偿媒体元素的采样点对齐

export class Engine {
  constructor(ctx) {
    this.audio = ctx.audio;
    this.reader = ctx.reader;
    this.vlist = ctx.vlist;
    this.scroller = ctx.scroller;
    this.dom = ctx.dom;
    this.track = null;

    this.follow = true;
    this.repeat = 0;          // 0 关 / 1 单句 / 2 全部
    this.loopS = -1;
    this.shadow = 'off';      // off | listen | speak
    this.shadowS = -1;
    this.speakUntil = 0;

    this.scrubbing = false;
    this.scrubTime = 0;

    this._sHint = -1;
    this._wHint = -1;
    this._sec = -1;
    this._pct = -1;
    this._railW = 0;
    this._wrote = 0;
    this._userAt = 0;
    this._target = -1;
    this._needV = true;
    this._lastKick = 0;
    this._raf = 0;
    this._prev = 0;
    this._onFrame = this._frame.bind(this);
  }

  attach(track) {
    this.track = track;
    this._sHint = this._wHint = -1;
    this._sec = -1;
    this._pct = -1;
    this._target = -1;
    this._needV = true;
    this.repeat = 0;
    this.loopS = -1;
    this.shadow = 'off';
    this.kick();
  }

  // ------------------------------------------------------------ 循环控制

  kick() {
    this._lastKick = performance.now();
    if (!this._raf) {
      this._prev = this._lastKick;
      this._raf = requestAnimationFrame(this._onFrame);
    }
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  markScrollDirty() { this._needV = true; this.kick(); }

  noteUserScroll() {
    this._userAt = performance.now();
    this._target = -1;
  }

  setRailWidth(w) { this._railW = w; this._pct = -1; }

  // ------------------------------------------------------------ 主帧

  _frame(now) {
    const dt = Math.min(64, now - this._prev) || 16.7;
    this._prev = now;
    const audio = this.audio;
    const track = this.track;
    if (!track) { this._raf = 0; return; }

    const t = this.scrubbing ? this.scrubTime : audio.currentTime;

    this._sync(t);
    this._paintSeek(t);
    this._autoScroll(dt);
    if (this._needV) { this._needV = false; this.vlist.update(false); }
    if (!this.scrubbing) this._loops(t, now);

    const busy = !audio.paused || this._target >= 0 || this._needV ||
                 this.scrubbing || this.shadow !== 'off' ||
                 now - this._lastKick < IDLE_GRACE;
    this._raf = busy ? requestAnimationFrame(this._onFrame) : 0;
  }

  /** 定位当前句/词并写入高亮. */
  _sync(t) {
    const tr = this.track;
    /*  定位用的时间往前借几毫秒: 把 currentTime 设成某个词的起点时, 媒体元素会
        对齐到采样点, 落点可能比目标早几微秒 (23.92 → 1054872/44100 =
        23.919999999999998), 不补这一点点, 点词后高亮会停在上一个词上。       */
    const tc = t + CUE_EPS;
    const s = locate(tr.sStart, tr.S, tc, this._sHint);
    this._sHint = s;

    let wj = -1, p = 0;
    if (s >= 0 && tr.N) {
      const k = locate(tr.wStart, tr.N, tc, this._wHint);
      if (k >= 0) {
        this._wHint = k;
        if (tr.wSent[k] === s) {
          wj = tr.wIdx[k];
          const a = tr.wStart[k], b = tr.wEnd[k];
          p = b > a ? clamp((t - a) / (b - a), 0, 1) : 1;
        }
      }
    }

    const prevS = this.reader.activeS;
    const prevW = this.reader.activeW;
    this.reader.setActive(s, wj);
    this.reader.setProgress(p);
    if (s !== prevS && s >= 0) {
      this._needV = true;
      if (this.follow && performance.now() - this._userAt > USER_SCROLL_HOLD) this._follow(s);
    }
    if ((s !== prevS || wj !== prevW) && this.onCursor) this.onCursor(s, wj, s !== prevS);
  }

  /** 进度条: 只写 transform; 时间文字每秒更新一次. */
  _paintSeek(t) {
    const dur = this.audio.duration || this.track.duration || 0;
    const dom = this.dom;
    const p = dur > 0 ? clamp(t / dur, 0, 1) : 0;
    const q = Math.round(p * 2000) / 2000;
    if (q !== this._pct) {
      this._pct = q;
      dom.seekFill.style.transform = `scaleX(${q})`;
      /*  圆点的位移必须写在 `translate` 上, 不能写 transform: 按下时 CSS 给它加了
          `scale: 1.3`, 而独立的 translate/scale 属性排在 transform 之前 ——
          位移一旦写进 transform 就会被那个 1.3 一起放大, 圆点当场跑到填充条
          右边 30% 的位置, 拖起来完全不跟手。translate 排在 scale 前面, 不受影响。 */
      dom.seekThumb.style.translate = `${(q * this._railW).toFixed(2)}px`;
      dom.seek.setAttribute('aria-valuenow', t.toFixed(1));
    }
    const sec = t | 0;
    if (sec !== this._sec) {
      this._sec = sec;
      dom.timeNow.textContent = fmtTime(t);
    }
  }

  // ------------------------------------------------------------ 自动跟随

  /** 只在当前句飘出舒适区时才滚, 避免每句都推动画面. */
  _follow(s) {
    const vl = this.vlist;
    const vh = this.scroller.clientHeight;
    const top = vl.offsetOf(s) - this.scroller.scrollTop;
    const bottom = top + vl.h[s];
    if (top >= vh * 0.12 && (bottom <= vh * 0.74 || top <= vh * 0.30)) return;
    this._target = vl.scrollTargetFor(s, FOLLOW_ALIGN);
  }

  scrollToActive() {
    const s = this.reader.activeS;
    if (s < 0) return;
    this._userAt = 0;
    this._target = this.vlist.scrollTargetFor(s, FOLLOW_ALIGN);
    this.kick();
  }

  _autoScroll(dt) {
    if (this._target < 0) return;
    const sc = this.scroller;
    const cur = sc.scrollTop;
    const d = this._target - cur;
    if (Math.abs(d) < 0.75) {
      this._write(this._target);
      this._target = -1;
      return;
    }
    const step = Math.abs(d) > 3000 ? d : d * (1 - Math.exp(-dt / SCROLL_TAU));
    this._write(cur + step);
    this._needV = true;
  }

  _write(y) {
    const max = this.scroller.scrollHeight - this.scroller.clientHeight;
    const v = clamp(y, 0, Math.max(0, max));
    this._wrote = v;
    this.scroller.scrollTop = v;
  }

  /** scroll 事件回调: 判断是自己写的还是用户拖的. */
  onScroll() {
    if (Math.abs(this.scroller.scrollTop - this._wrote) > 2) {
      this._userAt = performance.now();
      this._target = -1;
    }
    this._needV = true;
    this.kick();
  }

  // ------------------------------------------------------------ 循环 / 跟读

  _loops(t, now) {
    const tr = this.track;
    if (this.shadow !== 'off') { this._shadowStep(t, now); return; }
    if (this.repeat === 1 && this.loopS >= 0 && this.loopS < tr.S) {
      if (t >= tr.sEnd[this.loopS] - 0.008 || t < tr.sStart[this.loopS] - 0.2) {
        this.seek(tr.sStart[this.loopS]);
      }
    }
  }

  _shadowStep(t, now) {
    const tr = this.track;
    const i = this.shadowS;
    if (i < 0 || i >= tr.S) { this.setShadow(false); return; }
    if (this.shadow === 'listen') {
      if (t >= tr.sEnd[i] - 0.008) {
        this.audio.pause();
        this.seek(tr.sEnd[i]);
        const dur = Math.max(1.2, tr.sEnd[i] - tr.sStart[i]);
        this.speakUntil = now + dur * 1150 + 350;
        this.shadow = 'speak';
        this.onShadowState && this.onShadowState('speak', i, this.speakUntil);
      }
      return;
    }
    if (now >= this.speakUntil) {
      const next = i + 1;
      if (next >= tr.S) { this.setShadow(false); return; }
      this.shadowS = next;
      this.shadow = 'listen';
      this.seek(tr.sStart[next]);
      this.audio.play().catch(() => {});
      this.onShadowState && this.onShadowState('listen', next, 0);
    } else {
      this.onShadowState && this.onShadowState('tick', i, this.speakUntil);
    }
  }

  // ------------------------------------------------------------ 对外操作

  seek(t) {
    const dur = this.audio.duration || this.track.duration || 0;
    this.audio.currentTime = clamp(t, 0, dur ? dur - 0.01 : t);
    this._sec = -1;
    this.kick();
  }

  /** 点击句子/单词: 定位并把该句设为循环/跟读的锚点. */
  seekSentence(i, t) {
    const tr = this.track;
    if (i < 0 || i >= tr.S) return;
    this.seek(t != null ? t : tr.sStart[i]);
    if (this.repeat === 1) this.loopS = i;
    if (this.shadow !== 'off') { this.shadowS = i; this.shadow = 'listen'; }
    this._userAt = 0;
    this._target = this.vlist.scrollTargetFor(i, FOLLOW_ALIGN);
  }

  setFollow(on) {
    this.follow = on;
    if (on) this.scrollToActive();
  }

  setRepeat(mode) {
    this.repeat = mode;
    this.loopS = mode === 1 ? Math.max(0, this.reader.activeS) : -1;
    if (mode) this.setShadow(false);
    this.kick();
  }

  setShadow(on) {
    if (!on) {
      if (this.shadow === 'off') return;
      this.shadow = 'off';
      this.shadowS = -1;
      this.onShadowState && this.onShadowState('off', -1, 0);
      this.kick();
      return;
    }
    this.repeat = 0;
    this.shadowS = Math.max(0, this.reader.activeS);
    this.shadow = 'listen';
    this.seek(this.track.sStart[this.shadowS]);
    this.audio.play().catch(() => {});
    this.onShadowState && this.onShadowState('listen', this.shadowS, 0);
  }

  /** 上/下一句. */
  step(delta) {
    const s = this.reader.activeS;
    const i = clamp((s < 0 ? 0 : s) + delta, 0, this.track.S - 1);
    this.seekSentence(i);
    this.kick();
  }
}
