/** Video presentation and gestures. Playback and subtitles share the existing engine clock. */
import { trackCfg, setVideoCfg } from './trackcfg.js';
import { isIOS, toast } from './util.js';
import { setupVideoGestures } from './video-gestures.js';
import { setupVideoPip } from './video-pip.js';

export function setupVideo({ app, video, engine, toggle, onLayout, overlayOpen, openSettings }) {
  const rotate = document.getElementById('btnVideoRotate');
  const toolFit = document.getElementById('btnToolFit');
  const fitText = document.getElementById('fitText');
  const toolCc = document.getElementById('btnToolSubtitles');
  const toolSettings = document.getElementById('btnToolSettings');
  const toolRotate = document.getElementById('btnToolRotate');
  const pipBtn = document.getElementById('btnVideoPip');
  const pipTool = document.getElementById('btnToolPip');
  const pipNote = document.getElementById('videoPipNote');
  const stage = document.getElementById('videoStage');
  const status = document.getElementById('videoStatus');
  const hint = document.getElementById('videoGestureHint');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const landscape = window.matchMedia('(orientation: landscape)');
  let forceLandscape = false, chromeTimer = 0, hintTimer = 0, orientationRequest = 0;
  let layoutSignature = '';
  let gestures, wakeLock = null, themedImmersive = false;
  const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const isImmersive = () => app.classList.contains('is-immersive');
  const hideControls = () => {
    clearTimeout(chromeTimer);
    if (overlayOpen() || engine.scrubbing || app.querySelector('.seek.is-drag')) { scheduleHide(); return; }
    app.classList.remove('controls-visible');
  };
  const scheduleHide = () => {
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(hideControls, isImmersive() ? 6500 : 3200);
  };
  const showControls = () => { app.classList.add('controls-visible'); scheduleHide(); };
  const feedback = (text, timeout = 0) => {
    clearTimeout(hintTimer);
    if (!text && timeout) { hintTimer = setTimeout(() => feedback(''), timeout); return; }
    hint.textContent = text; hint.hidden = !text;
    if (timeout) hintTimer = setTimeout(() => feedback(''), timeout);
  };
  const syncStatusBar = async (immersive) => {
    if (immersive === themedImmersive) return;
    themedImmersive = immersive;
    document.documentElement.classList.toggle('video-immersive', immersive);
    if (immersive) {
      if (themeMeta) themeMeta.content = '#000000';
      try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
    } else {
      if (themeMeta) {
        themeMeta.content = document.documentElement.dataset.theme === 'dark'
          ? '#15170f' : '#f2f2ea';
      }
      try { await wakeLock?.release?.(); } catch { /* already released */ }
      wakeLock = null;
    }
  };
  const syncLayout = () => {
    const active = app.classList.contains('has-video');
    const rotated = active && forceLandscape && !landscape.matches;
    const signature = [active, rotated, innerWidth, innerHeight, isFullscreen()].join('|');
    if (signature !== layoutSignature) { gestures?.cancel(); layoutSignature = signature; }
    document.body.classList.toggle('video-rotated', rotated);
    document.body.style.setProperty('--rotated-width', innerHeight + 'px');
    document.body.style.setProperty('--rotated-height', innerWidth + 'px');
    document.body.style.setProperty('--video-view-w', (rotated ? innerHeight : innerWidth) + 'px');
    document.body.style.setProperty('--video-view-h', (rotated ? innerWidth : innerHeight) + 'px');
    const immersive = active && (landscape.matches || forceLandscape || isFullscreen());
    const changed = immersive !== isImmersive();
    app.classList.toggle('is-immersive', immersive);
    if (changed) app.classList.remove('controls-visible');
    rotate.setAttribute('aria-label', immersive ? '退出横屏' : '横屏播放');
    rotate.setAttribute('aria-pressed', String(immersive));
    syncStatusBar(immersive);
    onLayout();
  };
  async function enterFullscreen() {
    if (isFullscreen()) return;
    if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else if (document.documentElement.webkitRequestFullscreen) document.documentElement.webkitRequestFullscreen();
  }
  async function leaveHorizontal() {
    orientationRequest++;
    forceLandscape = false;
    try { screen.orientation?.unlock?.(); } catch { /* unsupported */ }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    } catch { /* inline layout can still exit */ }
    syncLayout();
    if (landscape.matches) toast('竖起设备即可退出横屏');
  }
  /**  进小窗前松开整页全屏和方向锁: 画面已经交给系统小窗, 播放页不该继续锁在横屏;
       设备本身横着的时候 syncLayout 会自己保持沉浸, 所以这里不弹「竖起设备」的提示。 */
  async function releaseLandscape() {
    forceLandscape = false;
    orientationRequest++;
    try { screen.orientation?.unlock?.(); } catch { /* unsupported */ }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    } catch { /* inline 布局照样能开小窗 */ }
    syncLayout();
  }
  async function horizontal() {
    if (isImmersive()) { await leaveHorizontal(); return; }
    const request = ++orientationRequest;
    forceLandscape = true;
    syncLayout();
    try { await enterFullscreen(); } catch { /* inline landscape remains available */ }
    if (request !== orientationRequest) return;
    try { await screen.orientation?.lock?.('landscape'); } catch { /* CSS rotation fallback */ }
    syncLayout();
  }
  const apply = () => {
    const cfg = trackCfg.video;
    app.dataset.videoSubtitles = String(cfg.subtitles);
    app.style.setProperty('--video-fit', cfg.fit);
    app.style.setProperty('--subtitle-position', cfg.position / 100);
    app.style.setProperty('--subtitle-width', cfg.width + '%');
    app.style.setProperty('--subtitle-background', (100 - cfg.transparency) + '%');
    app.style.setProperty('--subtitle-blur', cfg.blur + 'px');
    //  经典 PiP 的字幕由系统画, 字号只能靠 ::cue 传进去, 所以写成一个可调变量。
    app.style.setProperty('--cue-size', cfg.captionSize + 'px');
    if (!isIOS() && video.volume !== cfg.volume / 100) video.volume = cfg.volume / 100;
    if (video.muted !== !!cfg.muted) video.muted = !!cfg.muted;
    toolCc.setAttribute('aria-pressed', String(!!cfg.subtitles));
    toolCc.setAttribute('aria-label', cfg.subtitles ? '隐藏字幕' : '显示字幕');
    const cover = cfg.fit === 'cover';
    toolFit.setAttribute('aria-label', '画面适配：' + (cover ? '填满裁切' : '完整画面'));
    toolFit.setAttribute('aria-pressed', String(cover));
    fitText.textContent = cover ? '填满' : '完整';
    if (isImmersive() && themeMeta) themeMeta.content = '#000000';
    onLayout();
    pip?.refresh();
  };
  toolCc.addEventListener('click', () => setVideoCfg({ subtitles: trackCfg.video.subtitles ? 0 : 1 }));
  toolSettings.addEventListener('click', () => openSettings());
  toolFit.addEventListener('click', () => setVideoCfg({ fit: trackCfg.video.fit === 'cover' ? 'contain' : 'cover' }));
  toolRotate.addEventListener('click', horizontal);
  rotate.addEventListener('click', horizontal);
  document.addEventListener('fullscreenchange', () => {
    if (!isFullscreen()) { forceLandscape = false; try { screen.orientation?.unlock?.(); } catch { /* unsupported */ } }
    syncLayout();
  });
  document.addEventListener('webkitfullscreenchange', syncLayout);
  landscape.addEventListener('change', async () => {
    if (landscape.matches && !isFullscreen()) {
      try { await enterFullscreen(); } catch { /* iOS/PWA keeps the CSS immersive fallback */ }
    }
    syncLayout();
  });
  window.addEventListener('resize', syncLayout);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlayOpen()) {
      if (forceLandscape) leaveHorizontal();
      else app.classList.remove('controls-visible');
    }
  }, { capture: true }); // Observe dialogs before the shared Escape handler closes them.
  app.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, .seek')) showControls();
  });
  const showStatus = (text) => { status.textContent = text; status.hidden = !text; };
  video.addEventListener('waiting', () => { if (!video.paused) showStatus('正在缓冲…'); });
  for (const event of ['playing', 'canplay', 'seeked', 'pause', 'ended', 'error']) video.addEventListener(event, () => showStatus(''));
  video.addEventListener('play', scheduleHide);
  video.addEventListener('volumechange', () => setVideoCfg({ volume: Math.round(video.volume * 100), muted: video.muted ? 1 : 0 }));
  gestures = setupVideoGestures({ video, engine, toggle, feedback,
    singleTap: () => { if (app.classList.contains('controls-visible')) hideControls(); else showControls(); },
    setVolume: (volume) => {
      if (isIOS()) return false;
      setVideoCfg({ volume: Math.round(volume), muted: volume <= 0 ? 1 : 0 });
      return true;
    },
    toPoint: (event) => {
      const rect = video.getBoundingClientRect();
      return document.body.classList.contains('video-rotated')
        ? { x: event.clientY - rect.top, y: rect.right - event.clientX, width: rect.height, height: rect.width }
        : { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
    },
  });
  //  小窗的最后一步: 视频被搬进系统窗口后, 播放页只剩一块占位提示 (点它收回画面)。
  let pip = null;
  const paintPip = () => {
    const on = pip ? pip.isActive() : false;
    for (const button of [pipBtn, pipTool]) {
      if (!button) continue;
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('aria-label', on ? '关闭小窗' : '小窗播放');
    }
    if (pipNote) pipNote.hidden = !app.classList.contains('is-pip');
  };
  pip = setupVideoPip({ video, stage, app, engine, releaseLandscape,
    onLayout, onStateChange: paintPip });
  pipBtn?.addEventListener('click', () => pip.toggle());
  pipTool?.addEventListener('click', () => pip.toggle());
  pipNote?.addEventListener('click', () => pip.toggle());
  paintPip();
  window.addEventListener('pagehide', () => { clearTimeout(chromeTimer); clearTimeout(hintTimer); });
  window.addEventListener('pagehide', () => { wakeLock?.release?.()?.catch?.(() => {}); wakeLock = null; });
  // Theme changes from the settings sheet must not repaint the iOS status bar light.
  new MutationObserver(() => { if (themedImmersive && themeMeta) themeMeta.content = '#000000'; })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  apply();
  return { apply, syncLayout, showControls, media: video, isFullscreen, isImmersive, pip,
    refreshPip: () => pip.refresh() };
}
