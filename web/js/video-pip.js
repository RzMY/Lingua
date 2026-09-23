/**
 * 小窗播放 (Picture-in-Picture) —— 视频和字幕一起进小窗。
 *
 * 两条路径, 按「系统原生程度」排序, 上一条不成立或被系统拒绝就落到下一条:
 *
 * 1. Document PiP (Chrome/Edge 116+): 把 `<video>` 搬进系统小窗的独立文档, 画面和字幕
 *    都由我们排版 —— 原文 + 译文, 跟随视频设置里的位置、宽度、透明度、模糊, 以及当前
 *    亮/暗主题和字号。
 * 2. 经典视频 PiP (Safari/iOS、旧内核): 系统只渲染 `<video>`, 页面 DOM 进不去, 所以把
 *    整条时间轴合成一条原生字幕轨 (每句一条 cue, 原文换行接译文), 进小窗时打开、退出
 *    时关掉 —— 系统于是自己把字幕画在画面上。
 * 原生 Android 容器另外支持 Activity PiP；iOS 容器显式开启 WKWebView PiP。
 * 未配置能力的 WebClip / WebView 如果两个接口都没有, 那就只能用系统播放控件里的入口或换浏览器,
 * 页面没有任何办法凭空唤起系统浮窗, 所以这种情况明确提示用户, 不自造一个假小窗顶替。
 *
 * 两条路径共用 `pipLines()` 决定「这一句显示什么」, 所以小窗里的字幕和播放页正在朗读的
 * 那一句永远是同一句; 没有它, 两条路径会对同一份数据各写一遍取值逻辑, 迟早对不上。
 */

import { trackCfg } from './trackcfg.js';
import { locate, toast } from './util.js';
import { nativeApp } from './native.js';

/**  折叠空白: 小窗只有一行位置, 换行和连续空格都不该撑高盒子.
    中日韩文本里换进来的换行不该变成一个空格 (「每天/都练习」中间不该有缝), 所以
    CJK 相邻的那个空格再抹一次。用捕获组而不是后行断言, 老 Safari 解析不了后者。 */
const squash = (value) => String(value ?? '')
  .replace(/\s+/gu, ' ')
  .replace(/([\u3400-\u9fff\u3040-\u30ff\uff01-\uff60]) ([\u3400-\u9fff\u3040-\u30ff\uff01-\uff60])/gu, '$1$2')
  .trim();

/** 一句字幕的两行: 原文 + (可选的) 译文. */
export function pipLines(sentence, showTr = true) {
  if (!sentence) return { text: '', translation: '' };
  const words = Array.isArray(sentence.words) ? sentence.words : [];
  const raw = squash(sentence.text) || words.map((word) => word.text).join(' ');
  return { text: squash(raw), translation: showTr ? squash(sentence.translation) : '' };
}

/**
 * 整条时间轴 → 原生字幕 cue 列表.
 *
 * 经典 PiP 只能画系统字幕, 所以每句预先合成一条 cue (原文换行接译文); 时长为 0 的句子
 * 会被撑到最短可显示长度, 否则那条 cue 永远不出现。
 */
export function pipCues(track, showTr = true) {
  const out = [];
  const count = track ? track.S : 0;
  for (let i = 0; i < count; i++) {
    const { text, translation } = pipLines(track.sentences[i], showTr);
    if (!text) continue;
    const start = track.sStart[i];
    out.push({ start, end: Math.max(track.sEnd[i], start + 0.4), text: translation ? `${text}\n${translation}` : text });
  }
  return out;
}

export function setupVideoPip({ video, stage, app, engine, releaseLandscape, onLayout, onStateChange, beforeOpen, ownsActivity }) {
  const activityPip = nativeApp()?.activityPip;
  let activityActive = false;
  const activityStyle = document.createElement('style');
  activityStyle.textContent = `html.native-activity-pip body{padding:0!important}html.native-activity-pip #videoStage{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;max-height:none!important;z-index:99999!important;border-radius:0!important}html.native-activity-pip #videoStage video{width:100%!important;height:100%!important;object-fit:contain!important}html.native-activity-pip #videoStage button,html.native-activity-pip #videoStage .video-status{display:none!important}`;
  if (activityPip) document.head.append(activityStyle);
  window.addEventListener('native-pip', ({ detail }) => {
    if (ownsActivity?.()) return;
    activityActive = detail.active;
    app.classList.toggle('is-pip', activityActive);
    if (activityActive) fillCues();
    cuesOn(activityActive);
    document.documentElement.classList.toggle('native-activity-pip', activityActive);
    onStateChange?.(); onLayout?.();
  });
  /*  只认「真的能调用」的接口: 有些宿主会把 documentPictureInPicture 暴露成残缺对象,
      按存在性判断会走进死路, 然后被 catch 掉、误报成「不支持小窗」。               */
  const documentPip = () => (typeof window.documentPictureInPicture?.requestWindow === 'function'
    ? window.documentPictureInPicture : null);
  const classicKind = () => {
    if (document.pictureInPictureEnabled !== false && typeof video.requestPictureInPicture === 'function') return 'standard';
    if (typeof video.webkitSetPresentationMode === 'function'
      && (!video.webkitSupportsPresentationMode
        || video.webkitSupportsPresentationMode('picture-in-picture'))) return 'webkit';
    return '';
  };
  const trOn = () => document.documentElement.dataset.tr !== '0';

  let pipWin = null;        // Document PiP 的系统小窗
  let pipStage = null;      // 小窗里的画面容器
  let pipSubs = null;       // 小窗里的字幕层
  let pipText = null;
  let pipTr = null;
  let cueTrack = null;      // 经典 PiP 的合成字幕轨
  let cueList = [];         // 自己记着加过哪些 cue: mode=disabled 时 track.cues 是 null
  let observer = null;
  let lastPaint = '';
  let skinCss = null;       //  小窗样式只在第一次打开时取一次

  const classicOn = () => video === document.pictureInPictureElement
    || video.webkitPresentationMode === 'picture-in-picture';
  const isActive = () => activityActive || !!pipWin || classicOn();

  /**  小窗的样式表在主页面里取好再内联写进小窗: 小窗是独立文档, 外链在请求被拦截的
       环境里会一直挂着不生效 (DevTools/扩展/自动化都会), 内联则永远算得出样式。     */
  const pipCss = async () => {
    if (skinCss !== null) return skinCss;
    try {
      const response = await fetch(new URL('css/video-pip.css', document.baseURI));
      skinCss = response.ok ? await response.text() : '';
    } catch { skinCss = ''; }
    return skinCss;
  };

  /** 当前该显示的句子: 没开始播放时先给第一句, 免得小窗空着. */
  const sentence = () => {
    const track = engine && engine.track;
    if (!track || !track.S) return null;
    const i = Math.max(0, locate(track.sStart, track.S, video.currentTime + 0.004, -1));
    return track.sentences[i] || null;
  };

  /** 主题、字体、字号都从播放页算好的值搬过来, 免得小窗另起一套观感. */
  const syncSkin = () => {
    if (!pipWin) return;
    const root = pipWin.document.documentElement;
    for (const key of ['theme', 'lang', 'space']) {
      const value = document.documentElement.dataset[key];
      if (value === undefined) root.removeAttribute('data-' + key);
      else root.setAttribute('data-' + key, value);
    }
    const computed = getComputedStyle(document.documentElement);
    for (const [from, to] of [['--fs-text', '--pip-fs-text'], ['--fs-tr', '--pip-fs-tr'],
      ['--font-text', '--pip-font-text']]) {
      root.style.setProperty(to, computed.getPropertyValue(from).trim());
    }
  };

  const paint = (force) => {
    if (!pipSubs) return;
    const cfg = trackCfg.video;
    const { text, translation } = pipLines(sentence(), trOn());
    const signature = [text, translation, cfg.subtitles, cfg.position, cfg.width, cfg.transparency,
      cfg.blur, cfg.fit, document.documentElement.dataset.theme].join('|');
    if (!force && signature === lastPaint) return;
    lastPaint = signature;
    pipSubs.hidden = !cfg.subtitles;
    pipText.textContent = text;
    pipTr.textContent = translation;
    pipTr.hidden = !translation;
    pipSubs.style.setProperty('--pip-bottom', (2 + cfg.position * 0.7).toFixed(2) + '%');
    pipSubs.style.setProperty('--pip-width', cfg.width + '%');
    pipSubs.style.setProperty('--pip-alpha', ((100 - cfg.transparency) / 100).toFixed(2));
    pipSubs.style.setProperty('--pip-blur', cfg.blur + 'px');
    pipStage.style.setProperty('--pip-fit', cfg.fit);
  };

  /** 小窗里的画面 + 字幕层: 视频搬进来之后再叠一层字幕. */
  const buildSubs = (doc, container) => {
    pipSubs = doc.createElement('div');
    pipSubs.className = 'pip-subs';
    pipText = doc.createElement('p');
    pipText.className = 'pip-text';
    pipTr = doc.createElement('p');
    pipTr.className = 'pip-tr';
    pipSubs.append(pipText, pipTr);
    container.append(pipSubs);
  };

  // ------------------------------------------------------------ 经典 PiP 的字幕轨

  const cuesOn = (on) => {
    if (!cueTrack) return;
    try { cueTrack.mode = on && trackCfg.video.subtitles ? 'showing' : 'disabled'; } catch { /* 浏览器不认就退回无字幕 */ }
  };

  function fillCues() {
    if (!cueTrack) {
      cueTrack = video.addTextTrack('subtitles', 'Lingua', 'zh');
      cueTrack.mode = 'disabled';
    }
    const Cue = window.VTTCue || window.WebKitVTTCue;
    /*  按规范, mode 为 disabled 时 `TextTrack.cues` 直接是 null —— 只靠它清理会漏,
        于是每次重填都多出一整套 cue。自己拿数组记着, 与 mode 无关。 */
    for (const cue of cueList) {
      try { cueTrack.removeCue(cue); } catch { /* 已经不在轨上 */ }
    }
    cueList = [];
    if (!Cue) return;
    for (const cue of pipCues(engine && engine.track, trOn())) {
      const item = new Cue(cue.start, cue.end, cue.text);
      cueTrack.addCue(item);
      cueList.push(item);
    }
    cuesOn(isActive());
  }

  // ------------------------------------------------------------ Document PiP

  const unmountDocument = () => {
    if (!pipWin) return;
    const win = pipWin;
    pipWin = null;
    pipSubs = pipText = pipTr = pipStage = null;
    lastPaint = '';
    observer?.disconnect();
    observer = null;
    if (video.parentNode !== stage) stage.insertBefore(video, stage.firstChild);
    app.classList.remove('is-pip');
    onStateChange?.();
    onLayout?.();
    try { win.close(); } catch { /* 用户已经自己关掉了 */ }
  };

  function mountDocument(win, css) {
    const doc = win.document;
    if (css) {
      const style = doc.createElement('style');
      style.textContent = css;
      doc.head.appendChild(style);
    } else {   // 取不到就退回外链, 至少 base.css 的变量还在
      for (const href of ['css/base.css', 'css/video-pip.css']) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL(href, document.baseURI).href;
        doc.head.appendChild(link);
      }
    }
    pipStage = doc.createElement('div');
    pipStage.className = 'pip-stage';
    buildSubs(doc, pipStage);
    pipStage.insertBefore(video, pipStage.firstChild);
    doc.body.append(pipStage);
    win.addEventListener('pagehide', unmountDocument);
    observer = new MutationObserver(() => { syncSkin(); paint(true); });
    observer.observe(document.documentElement, { attributes: true,
      attributeFilter: ['data-theme', 'data-lang', 'data-space', 'data-tr'] });
    syncSkin();
    paint(true);
  }

  async function openDocument() {
    // 小窗请求必须留在用户手势里, 所以先要窗口, 再退出横屏。
    const win = await documentPip().requestWindow({ width: 480, height: 270, disallowReturnToOpener: false });
    pipWin = win;
    mountDocument(win, await pipCss());
    app.classList.add('is-pip');
    onStateChange?.();
    await releaseLandscape?.();
  }

  // ------------------------------------------------------------ 经典视频 PiP

  async function openClassic() {
    fillCues();
    if (classicKind() === 'standard') await video.requestPictureInPicture();
    else video.webkitSetPresentationMode('picture-in-picture');
    cuesOn(true);
    app.classList.add('is-pip');
    onStateChange?.();
    await releaseLandscape?.();
  }

  async function close() {
    if (activityActive) { toast('点击系统小窗的展开按钮返回应用'); return false; }
    if (pipWin) { unmountDocument(); return true; }
    if (video === document.pictureInPictureElement && document.exitPictureInPicture) {
      try { await document.exitPictureInPicture(); } catch { /* 已经退出 */ }
    } else if (video.webkitPresentationMode === 'picture-in-picture') {
      try { video.webkitSetPresentationMode('inline'); } catch { /* 已经退出 */ }
    }
    syncClassic();
    return !isActive();
  }

  /** 经典 PiP 的系统状态 → 页面状态 (字幕轨开合、占位提示、按钮态). */
  function syncClassic() {
    const on = classicOn();
    if (on) fillCues();   // iOS 用户上滑回桌面会自动进 PiP, 字幕轨得这时才建
    cuesOn(on);
    app.classList.toggle('is-pip', on || !!pipWin);
    if (on) void releaseLandscape?.();
    onStateChange?.();
  }

  /**  原生路径挨个试: 残缺的接口会让位给下一条, 两个都没有就老实告诉用户。 */
  async function open() {
    if (video.error) { toast('视频加载失败，请重新加载后再试小窗'); return; }
    // Safari 在首帧就绪前可能报告不支持 PiP；标准接口也会拒绝未就绪的视频。
    // 保留下一次真实点击的用户激活，不在 loadeddata 回调里自动申请系统窗口。
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      toast('视频正在加载，请稍后再试小窗'); return;
    }
    const failures = [];
    if (activityPip) {
      try {
        await releaseLandscape?.();
        fillCues();
        await activityPip.enterPip({ width: video.videoWidth || 16, height: video.videoHeight || 9 });
        return;
      } catch (error) { failures.push(error); }
    }
    if (documentPip()) {
      try { await openDocument(); return; } catch (error) { failures.push(error); }
    }
    if (classicKind()) {
      try { await openClassic(); return; } catch (error) { failures.push(error); }
    }
    if (failures.length) console.warn('[pip] 原生小窗没有打开', failures);
    toast(failures.length ? '无法开启画中画，请检查系统权限后重试' : '当前环境不支持画中画');
  }

  async function toggle() {
    try {
      if (isActive()) await close();
      else if (!beforeOpen || await beforeOpen()) await open();
    } catch (error) {
      console.warn('[pip]', error);
      toast('画中画启动失败，请重试');
    }
    onStateChange?.();
  }

  /** 译文到货、设置变化、主题切换后重画小窗内容. */
  function refresh() {
    lastPaint = '';
    if (pipWin) { syncSkin(); paint(true); }
    else if (classicOn() || activityActive) fillCues();
  }

  // 小窗开着的时候页面多半在后台, rAF 会被节流; 媒体事件不受影响, 所以用它们驱动重画。
  for (const event of ['timeupdate', 'seeked', 'play', 'pause', 'loadedmetadata', 'ratechange']) {
    video.addEventListener(event, () => paint(false));
  }
  video.addEventListener('leavepictureinpicture', syncClassic);
  video.addEventListener('enterpictureinpicture', syncClassic);
  video.addEventListener('webkitpresentationmodechanged', syncClassic);
  window.addEventListener('pagehide', () => { if (pipWin) unmountDocument(); });

  return { toggle, close, refresh, paint: () => paint(true), isActive,
    supported: () => !!(activityPip || documentPip() || classicKind()) };
}
