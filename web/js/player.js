/** 播放控制: audio 元素、进度条拖拽、快捷键、播放进度续播. */

import { clamp, fmtTime, toast } from './util.js';

const SAVE_EVERY = 5000;   // ms: 播放中最多每 5 秒写一次进度
const RESUME_GAP = 3;      // s: 距开头 / 结尾这么近就不值得续播

/**
 * 上次停下的位置是否值得续播; 返回 0 表示从头开始.
 *
 * 开头 3 秒内没什么可续的, 结尾 3 秒内其实已经听完了 —— 这两种都从头放,
 * 免得一打开就停在最后半句话上。
 */
export function resumeAt(position, duration) {
  const at = Number(position);
  if (!Number.isFinite(at) || at <= RESUME_GAP) return 0;
  const dur = Number(duration);
  if (Number.isFinite(dur) && dur > 0 && at >= dur - RESUME_GAP) return 0;
  return at;
}

/**
 * 播放进度落库 —— 播放中每 5 秒一次, 暂停 / 听完 / 切后台 / 离开页面时各补一次.
 *
 * `timeupdate` 在这里只当粗粒度的时间源: 它不驱动渲染 (渲染仍然只有 engine.js 那一个
 * rAF 循环), 回调里也只有一个比较和偶尔一次写库. 直接关掉标签页最多丢 5 秒。
 */
export function createProgressSaver(audio, save) {
  let id = '', written = -1, lastAt = -Infinity;
  const write = (force) => {
    if (!id) return;
    const seconds = audio.ended ? 0 : Math.max(0, Number(audio.currentTime) || 0);
    const now = performance.now();
    if (!force && now - lastAt < SAVE_EVERY) return;
    if (Math.abs(seconds - written) < 0.5) return;
    written = seconds;
    lastAt = now;
    // 落库失败 (配额满 / 存储降级) 不影响播放: 这次没写成, 下次从更早的位置继续。
    try { Promise.resolve(save(id, seconds)).catch(() => {}); } catch { /* 同步抛错也一样 */ }
  };
  audio.addEventListener('timeupdate', () => write(false));
  audio.addEventListener('pause', () => write(true));
  audio.addEventListener('ended', () => write(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) write(true); });
  window.addEventListener('pagehide', () => write(true));
  return {
    /** 换到某条音频: 记下它的 id, 之后写库都写它. */
    begin(nextId) { id = String(nextId || ''); written = -1; lastAt = -Infinity; },
    write,
  };
}

export function setupPlayer(ctx) {
  const { audio, engine, dom } = ctx;
  const media = setupMediaSession(ctx);
  // 没传写库回调 (某些测试 / 只读场景) 就不记进度, 播放本身不受影响
  const progress = ctx.savePosition ? createProgressSaver(audio, ctx.savePosition) : null;
  let currentId = '';

  audio.addEventListener('play', () => {
    dom.player.classList.add('is-playing');
    dom.btnPlay.setAttribute('aria-label', '暂停');
    dom.playText.textContent = '暂停';
    engine.kick();
  });
  audio.addEventListener('pause', () => {
    dom.player.classList.remove('is-playing');
    dom.btnPlay.setAttribute('aria-label', '播放');
    dom.playText.textContent = '播放';
    engine.kick();
  });
  audio.addEventListener('loadedmetadata', () => {
    const dur = audio.duration;
    if (Number.isFinite(dur)) {
      dom.timeTotal.textContent = fmtTime(dur);
      dom.seek.setAttribute('aria-valuemax', dur.toFixed(1));
    }
    engine.kick();
  });
  audio.addEventListener('ratechange', () => engine.kick());
  audio.addEventListener('seeked', () => engine.kick());
  audio.addEventListener('ended', () => {
    if (engine.repeat === 2) { engine.seek(0); media.play(); }
    else engine.kick();
  });
  audio.addEventListener('error', () => {
    if (!audio.src) return;                 // 还没挂上音频, 不是错误
    toast('音频解码失败: 这个格式浏览器放不了, 换个文件重新导入');
  });

  const toggle = () => {
    if (audio.paused) media.play();
    else media.pause();
  };
  dom.btnPlay.addEventListener('click', toggle);

  setupSeek(ctx);
  setupKeys(ctx, toggle);
  return {
    toggle,
    /**
     * 换到某条音频: 记住它的库 id 以便落库, 并按存档的位置续播.
     * @param {object} t `{id, title, position}` —— position 是上次停下的秒数
     */
    setTrack({ id = '', title = '', position = 0 } = {}) {
      currentId = String(id || '');
      progress?.begin(currentId);
      media.setTrack({ title });
      const at = resumeAt(position, engine.track?.duration || audio.duration || 0);
      if (at <= 0) return;
      // 元数据还没读完时写 currentTime 会被忽略, 等一次 loadedmetadata 再跳
      if (audio.readyState >= 1) engine.seek(at);
      else audio.addEventListener('loadedmetadata', () => {
        if (currentId === id) engine.seek(at);
      }, { once: true });
    },
  };
}

/** 系统控制与页面按钮共用同一个 audio, 状态通过媒体事件同步。 */
export function setupMediaSession({ audio, engine }) {
  const ms = navigator.mediaSession;
  let playRequest = 0;

  const sync = () => {
    if (!ms) return;
    try {
      ms.playbackState = !audio.src ? 'none'
        : audio.paused || audio.ended ? 'paused' : 'playing';
    } catch { /* 部分实现没有可写的 playbackState */ }
    try {
      const duration = audio.duration;
      if (Number.isFinite(duration) && duration > 0 && audio.playbackRate > 0) {
        ms.setPositionState({
          duration, playbackRate: audio.playbackRate,
          position: clamp(audio.currentTime || 0, 0, duration),
        });
      } else ms.setPositionState();
    } catch { /* 旧版浏览器没有位置 API */ }
  };

  const play = async () => {
    const request = ++playRequest;
    const source = audio.src;
    try {
      // 直接调用, 保留页面或系统动作的用户激活。
      const pending = audio.play();
      sync();
      await pending;
    } catch (err) {
      if (request !== playRequest || source !== audio.src) return;
      sync();
      if (err?.name !== 'AbortError') toast('播放失败，请再点播放重试');
    }
  };
  const pause = () => {
    playRequest++;
    audio.pause();
    sync();
  };

  for (const event of ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'loadstart',
    'durationchange', 'ratechange', 'seeked', 'emptied', 'error', 'timeupdate']) {
    audio.addEventListener(event, () => {
      if (event === 'pause' || event === 'ended' || event === 'emptied') playRequest++;
      sync();
    });
  }
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pageshow', sync);

  if (ms) {
    const set = (name, fn) => {
      try { ms.setActionHandler(name, fn); }
      catch { /* 不支持的动作不影响页面控制 */ }
    };
    set('play', play);
    set('pause', pause);
    set('previoustrack', () => engine.track && engine.step(-1));
    set('nexttrack', () => engine.track && engine.step(1));
    set('seekbackward', (e) => engine.seek(audio.currentTime - (e.seekOffset ?? 5)));
    set('seekforward', (e) => engine.seek(audio.currentTime + (e.seekOffset ?? 5)));
    set('seekto', (e) => { if (Number.isFinite(e.seekTime)) engine.seek(e.seekTime); });
  }

  return {
    play,
    pause,
    setTrack(track) {
      playRequest++;
      if (!ms) return;
      try {
        if (typeof window.MediaMetadata === 'function') {
          ms.metadata = new window.MediaMetadata({ title: track.title, artist: 'Lingua' });
        }
      } catch { /* 元数据不受支持时仍保留播放控制 */ }
      sync();
    },
  };
}

// ---------------------------------------------------------------- 进度条拖拽

function setupSeek({ audio, engine, dom }) {
  const hit = dom.seek.querySelector('.seek-hit');
  let rect = null, lastSet = 0;

  const measure = () => { rect = hit.getBoundingClientRect(); engine.setRailWidth(rect.width); };
  measure();
  new ResizeObserver(measure).observe(hit);

  const ratioAt = (x) => (rect && rect.width ? clamp((x - rect.left) / rect.width, 0, 1) : 0);
  const dur = () => audio.duration || engine.track?.duration || 0;

  const down = (e) => {
    if (!dur()) return;
    measure();
    dom.seek.classList.add('is-drag');
    dom.seek.setPointerCapture(e.pointerId);
    engine.scrubbing = true;
    engine.scrubTime = ratioAt(e.clientX) * dur();
    engine.noteUserScroll();
    engine.kick();
    e.preventDefault();
  };

  const move = (e) => {
    if (!engine.scrubbing) return;
    engine.scrubTime = ratioAt(e.clientX) * dur();
    const now = performance.now();
    if (now - lastSet > 90) { lastSet = now; audio.currentTime = engine.scrubTime; }
    engine.kick();
  };

  const up = (e) => {
    if (!engine.scrubbing) return;
    engine.scrubbing = false;
    dom.seek.classList.remove('is-drag');
    try { dom.seek.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    engine.seek(engine.scrubTime);
    engine.scrollToActive();
  };

  dom.seek.addEventListener('pointerdown', down);
  dom.seek.addEventListener('pointermove', move);
  dom.seek.addEventListener('pointerup', up);
  dom.seek.addEventListener('pointercancel', up);

  dom.seek.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0;
    if (!d) return;
    e.preventDefault();
    engine.seek(audio.currentTime + d);
  });
}

// ---------------------------------------------------------------- 快捷键

function setupKeys({ engine, dom }, toggle) {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); toggle(); break;
      case 'ArrowLeft': e.preventDefault(); engine.seek(engine.audio.currentTime - 5); break;
      case 'ArrowRight': e.preventDefault(); engine.seek(engine.audio.currentTime + 5); break;
      case 'ArrowUp': e.preventDefault(); engine.step(-1); break;
      case 'ArrowDown': e.preventDefault(); engine.step(1); break;
      case 'f': dom.btnPin.click(); break;
      case 'r': dom.btnRepeat.click(); break;
      case 'Escape': dom.closeOverlays && dom.closeOverlays(); break;
      default: break;
    }
  });
}
