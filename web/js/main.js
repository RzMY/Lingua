/**
 * 播放页装配 —— 取记录 → (没分析过就先送去分析) → 建阅读区 → 接上翻译/词卡/讲解.
 *
 * 这里只做「一次性」的事: 查询节点、装配对象、绑定事件。与播放进度有关的每帧
 * 工作全部在 engine.js 的那一个 rAF 循环里, 所以本文件没有任何定时器,
 * 也不监听 timeupdate。
 *
 * 数据全部来自浏览器: 音频 Blob、track.json、翻译缓存都在 IndexedDB 里 (library.js),
 * 只有「把字幕变成 track.json」这一步会去问分析后端 (`POST /api/analyze`)。所以
 * 除了那一次请求, 整个播放页离线可用。
 *
 * 三条大模型线在这儿汇合:
 *
 * * **翻译**: `trackCfg.tr` 打开后才创建请求; 译文到达 → `Reader.setTranslation`
 *   → `VirtualList.invalidate` 只重量受影响的几行。
 * * **词卡**: 点词先 seek, 再按开关弹卡片。
 * * **讲解**: 工具条的「讲解」开 2/3 屏对话框; 长按句子仍是本地逐词拆解。
 */

import { $, debounce, el, fmtTime, isIOS, rafOnce, toast } from './util.js';
import { Track } from './track.js';
import { Metrics } from './metrics.js';
import { Reader } from './reader.js';
import { VirtualList } from './virtual.js';
import { Engine } from './engine.js';
import { setupPlayer } from './player.js';
import { mediaKind } from './media.js';
import { setupVideo } from './video-player.js';
import { setupAudioPip } from './audio-pip.js';
import { NativeAudio } from './native-audio.js';
import { NativeVideo } from './native-video.js';
import { initSettings, setSetting, settings } from './settings.js';
import { initTrackCfg, trackCfg } from './trackcfg.js';
import { config, loadConfig } from './config.js';
import { nativeApp, nativeReady } from './native.js';
import { sourceLangs } from './langs.js';
import { createExplain, openSpeedSheet, openTrackSheet } from './ui.js';
import { closeSheet, sheetOpen } from './sheet.js';
import { analyze, ApiError } from './api.js';
import { audioBlob, audioUrl, getTrack, patchTrack, saveAnalysis, setDuration, setPosition, trackData,
  transcriptBlob, savePreparedTranscript, SUB_EXT, SUB_RE } from './library.js';
import { plainTrack } from './subtitles.js';
import { openFileRepair } from './backup-ui.js';
import { createTranslator } from './translate.js';
import { closeWordCard, isCardOpen, openWordCard } from './card.js';
import { chatOpen, closeChat, openChat } from './chat.js';
import { button, buttonBar, group, segRow, switchRow } from './rows.js';

const FOLLOW_ALIGN = 0.30;
const LONG_PRESS = 460;                        // ms: 长按打开逐词拆解
const REPEAT_LABEL = ['重复', '单句', '全部'];
const HOT_BACK = 2;                            // 视口上方也顺手补几句译文
const HOT_AHEAD = 8;
const SWEEP_DELAY = 1600;                      // ms: 视口翻完再后台补全篇

const dom = {
  app: $('app'), videoStage: $('videoStage'),
  topbar: document.querySelector('.topbar'),
  scroller: $('scroller'), viewport: $('viewport'), readerState: $('readerState'),
  setup: $('setup'),
  trackTitle: $('trackTitle'), btnBack: $('btnBack'), btnDisplay: $('btnDisplay'),
  btnFiles: $('btnFiles'),
  explainPanel: $('explainPanel'), explainSub: $('explainSub'), explainBody: $('explainBody'),
  btnExplainClose: $('btnExplainClose'),
  player: $('player'), seek: $('seek'), seekFill: $('seekFill'), seekThumb: $('seekThumb'),
  timeNow: $('timeNow'), timeTotal: $('timeTotal'),
  btnPin: $('btnPin'), btnExplain: $('btnExplain'), btnRepeat: $('btnRepeat'),
  btnSpeed: $('btnSpeed'), speedText: $('speedText'),
  btnPlay: $('btnPlay'), playText: $('playText'),
  btnShadow: $('btnShadow'), hint: $('hint'),
};

// The engine's historic `audio` name refers to the one active HTMLMediaElement.
let audio = $('audio');
const metrics = new Metrics($('probe'));
let track = null, reader = null, vlist = null;
let player = null;
let translator = null, sweepTimer = 0;
let record = null;                 // 当前音频的库记录 (library.js)
let objUrl = '';                   // 当前 <audio> 用的 blob URL, 换曲要 revoke
let videoReady = false;
let videoPlayer = null;
let audioPip = null;

function syncVideoLayout() {
  const visible = videoReady && dom.setup.hidden;
  dom.app.classList.toggle('has-video', visible);
  dom.videoStage.hidden = !visible;
  videoPlayer?.syncLayout();
  syncFollowAlign();
}

function syncFollowAlign() {
  // Compact overlays leave more room below the active sentence for its extra layers.
  engine.followAlign = dom.app.classList.contains('has-video')
    && dom.app.classList.contains('is-immersive') ? 0.08 : FOLLOW_ALIGN;
  if (vlist) {
    const single = dom.app.classList.contains('is-immersive');
    if (vlist.followSingle !== single) {
      vlist.followSingle = single;
      vlist.update(true);
    }
  }
}

const engine = new Engine({ audio, reader: null, vlist: null, scroller: dom.scroller, dom });
const explain = createExplain({
  explainPanel: dom.explainPanel, explainSub: dom.explainSub, explainBody: dom.explainBody,
}, (i, j) => seekWord(i, j));

// ---------------------------------------------------------------- 空态 / 提示

function showState(title, hint) {
  const box = dom.readerState;
  box.textContent = '';
  box.append(el('b', null, title));
  if (hint) box.append(el('span', null, hint));
  box.hidden = false;
}

function clearState() {
  dom.readerState.hidden = true;
  dom.readerState.textContent = '';
}

// ---------------------------------------------------------------- 送去分析

/**
 * 还没分析过的音频先停在这一屏: 选字幕 → 选源语言 → 交给分析后端 → 落库 → 进阅读区.
 *
 * 分析后端是无状态的: 它不认识这条音频, 也不保存任何东西 —— 请求带上字幕原文和几个
 * 参数, 换回一份 track.json, 由浏览器负责存。
 */
function showSetup() {
  audio.pause();
  clearState();
  dom.player.hidden = true;
  const title = record.title || record.id;
  dom.trackTitle.textContent = title;
  document.title = title + ' · Lingua';

  const box = dom.setup;
  box.textContent = '';
  box.hidden = false;

  const head = el('div', 'setup-h');
  syncVideoLayout();
  head.append(el('b', null, '导入字幕'));
  head.append(el('span', null,
    '可选：只导入字幕即可显示原文；分析后可使用分词、注音等学习功能。'));
  box.append(head);

  const flags = { estimate: false, split: true, merge: true };
  let lang = record.lang || config.importLang || 'ja';
  const analysisOptions = el('details', 'setup-options');
  analysisOptions.append(el('summary', null, '分析选项（可选）'), group(
    segRow('源语言', '决定用哪套分词器与注音层', () => lang, (v) => { lang = v; },
      sourceLangs().map((l) => [l.code, l.name]), { wrap: true }),
    switchRow('自动拆句', '一段字幕里有多句时按标点切开',
      () => (flags.split ? 1 : 0), (v) => { flags.split = !!v; }),
    switchRow('合并分词', '把被拆开的缩写与连字符词合回一个词',
      () => (flags.merge ? 1 : 0), (v) => { flags.merge = !!v; }),
    switchRow('估算词级时间戳', '字幕只有句级时间时, 按字数摊给每个词',
      () => (flags.estimate ? 1 : 0), (v) => { flags.estimate = !!v; }),
  ));
  box.append(analysisOptions);

  const input = el('input');
  input.type = 'file';
  //  iOS 上按扩展名过滤会把 .srt / .vtt 一起灰掉 (见 util.isIOS), 只能不给 accept,
  //  让用户在 Files 里随便挑, 再由下面的后缀校验兜住。
  if (!isIOS()) input.accept = SUB_EXT.map((e) => '.' + e).join(',');
  input.hidden = true;
  const name = el('div', 'setup-file', '还没选择文件');
  const bar = el('div', 'setup-bar');
  bar.append(el('i'));
  bar.hidden = true;
  const log = el('pre', 'setup-log');
  log.hidden = true;

  const go = button('开始分析', { main: true, glyph: 'i-check', onPick: () => start() });
  go.disabled = true;
  const only = button('只导入字幕', { glyph: 'i-doc', onPick: () => start(false) });
  only.disabled = true;
  const choose = button('选择文件', { glyph: 'i-doc', onPick: () => input.click() });
  const back = button(record.transcript ? '返回播放' : '跳过，直接播放',
    { glyph: 'i-play', onPick: () => openTrack() });
  const bottom = buttonBar(choose, only, go, back);
  box.append(input, name, bottom, bar, log);

  let file = null;
  transcriptBlob(record.id).then((saved) => {
    if (!saved || file || !name.isConnected || box.hidden) return;
    file = new File([saved], record.transcript?.name || 'transcript.json', { type: saved.type });
    name.textContent = file.name;
    go.disabled = false;
    only.disabled = false;
  });
  input.addEventListener('change', () => {
    const picked = (input.files || [])[0] || null;
    // 没给 accept 的那条路 (iOS) 靠这里挡住选错的文件, 后缀集合与后端一致
    if (picked && !SUB_RE.test(picked.name)) {
      input.value = '';
      toast('只认 ' + SUB_EXT.join(' / ') + ' 文件');
      return;
    }
    file = picked;
    name.textContent = file ? file.name : '还没选择文件';
    go.disabled = !file;
    only.disabled = !file;
  });

  const write = (text) => {
    log.hidden = false;
    log.textContent += text + '\n';
    log.scrollTop = log.scrollHeight;
  };

  async function start(withAnalysis = true) {
    if (!file) return;
    go.disabled = true;
    choose.disabled = true;
    only.disabled = true;
    back.disabled = true;
    bar.hidden = false;
    bar.classList.add('is-busy');
    log.textContent = '';
    write('· 正在' + (withAnalysis ? '分析 ' : '导入 ') + file.name + ' …');
    try {
      if (!withAnalysis) {
        record = await savePreparedTranscript(record.id, file, lang);
        updateFileState();
        await openTrack();
        return;
      }
      const dur = record.duration || (Number.isFinite(audio.duration) ? audio.duration : 0);
      const resp = await analyze(file, {
        lang,
        id: record.id,
        title: record.title,
        duration: dur,
        split: flags.split,
        merge: flags.merge,
        estimate: flags.estimate,
      });
      for (const line of resp.log || []) write(line);
      if (!resp.track || !Array.isArray(resp.track.sentences)) throw new Error('后端没有返回分析结果');
      record = await saveAnalysis(record.id, resp.track, { transcriptName: file.name, transcriptFile: file });
      updateFileState();
      write('✓ 分析完成, 正在载入…');
      await openTrack();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err && err.message) || '分析失败';
      write('! ' + msg);
      // 之前已经分析过的就别把状态打回失败, 用户还能「先看现有内容」
      if (!['ready', 'subtitles'].includes(record.status)) {
        record = (await patchTrack(record.id, { status: 'failed', error: msg })) || record;
      }
      go.disabled = false;
      choose.disabled = false;
      only.disabled = false;
      back.disabled = false;
    } finally {
      bar.classList.remove('is-busy');
    }
  }
}

// ---------------------------------------------------------------- 载入曲目

/** 原始音视频 Blob 直接挂到当前媒体元素, 共用字幕时间轴. */
async function attachAudio(id) {
  if (audio.nativeAudio) {
    const blob = await audioBlob(id);
    if (blob) {
      dom.btnPlay.disabled = true;
      showState('正在准备音频…', '首次打开时将音频传入本地播放器');
      await audio.attach(blob, record);
      audio.playbackRate = settings.rate || 1;
      objUrl = audio.src;
      clearState();
    } else {
      await audio.release(); objUrl = '';
      record = { ...record, audio: { ...record.audio, missing: true } };
    }
    updateFileState(); return;
  }
  const next = await audioUrl(id);
  if (objUrl) URL.revokeObjectURL(objUrl);
  objUrl = next;
  if (!next) {
    record = { ...record, audio: { ...record.audio, missing: true } };
    audio.removeAttribute('src');
    audio.load();
    videoReady = false;
    syncVideoLayout();
    updateFileState();
    return;
  }
  audio.src = next;
  audio.preservesPitch = true;
  audio.playbackRate = settings.rate || 1;
  updateFileState();
}

function updateFileState() {
  dom.btnFiles.hidden = !record || (!record.audio?.missing && !record.transcript?.missing);
  dom.btnPlay.disabled = !objUrl;
  dom.btnPlay.title = objUrl ? '' : '请先补充音频或视频文件';
}

function repairFiles() {
  if (!record) return;
  openFileRepair([record], {
    onUpdate: async (updated) => {
      record = updated;
      if (!!videoPlayer !== (mediaKind(record.audio) === 'video')) {
        // A replacement may change media kind. Rebind all listeners on a fresh page.
        location.reload();
        return;
      }
      if (!objUrl && !record.audio?.missing) await attachAudio(record.id);
      if (track) track.audioUrl = objUrl;
      updateFileState();
    },
    onClose: () => { if (!dom.setup.hidden) showSetup(); },
  });
}

/**
 * 按 id 从浏览器库里取记录 —— 这一步没有任何网络请求.
 * @param {string} id
 * @param {boolean} forceSetup 从首页菜单点「重新分析」进来的
 */
async function load(id, forceSetup) {
  showState('正在载入…', id);
  record = await getTrack(id);
  if (!record) {
    dom.player.hidden = true;
    showState('找不到这条媒体', '它可能已经被删掉了; 回首页重新导入一次');
    return false;
  }
  const isVideo = mediaKind(record.audio) === 'video';
  audio = isVideo ? $('video') : $('audio');
  if (audio === $('audio') && nativeApp()?.audioPlayer) audio = new NativeAudio(nativeApp().audioPlayer);
  if (isVideo && nativeApp()?.nativeVideoAudio) audio = new NativeVideo(nativeApp().audioPlayer, $('video'));
  engine.audio = audio;
  player = setupPlayer({ audio, engine, dom, savePosition: setPosition });
  if (isVideo) {
    videoPlayer = setupVideo({ app: dom.app, video: $('video'), media: audio, engine, toggle: () => player.toggle(),
      onLayout: () => relayout(false), overlayOpen: () => sheetOpen() || chatOpen() || isCardOpen(),
      openSettings: openDisplay });
    dom.btnDisplay.setAttribute('aria-label', '视频设置');
    dom.btnDisplay.querySelector('use').setAttribute('href', '#i-tune');
    audioPip = videoPlayer.audioPip;
  } else {
    const button = $('btnAudioPip');
    audioPip = setupAudioPip({ media: audio, engine, app: dom.app,
      onStateChange: () => {
        button.hidden = !audioPip.supported();
        button.setAttribute('aria-busy', String(audioPip.isBusy()));
        button.setAttribute('aria-pressed', String(audioPip.isActive()));
        button.setAttribute('aria-label', audioPip.isActive() ? '关闭字幕画中画' : '字幕画中画');
      } });
    button.hidden = !audioPip.supported();
    button.addEventListener('click', () => audioPip.toggle());
  }
  wireTools();
  (isVideo ? $('video') : audio).addEventListener('loadedmetadata', () => {
    videoReady = isVideo && $('video').videoWidth > 0 && $('video').videoHeight > 0;
    syncVideoLayout();
  });
  // 显示层开关要在算高度之前写进 <html>, 免得首帧闪一下; 语言先用记录里的,
  // track.json 载入后再按它自述的 features 精修一次 (见 apply)
  initTrackCfg(record.id, record.lang, null, onTrackCfg);
  videoPlayer?.apply();
  await attachAudio(record.id);
  if (forceSetup) {
    if (record.status === 'failed' && record.error) toast('上次分析失败: ' + record.error);
    showSetup();
    return false;
  }
  return openTrack();
}

async function openTrack() {
  dom.setup.hidden = true;
  syncVideoLayout();
  dom.setup.textContent = '';
  dom.player.hidden = false;
  showState('正在载入…', record.title || record.id);
  audio.pause();
  let data = await trackData(record.id);
  if (!data || !Array.isArray(data.sentences)) {
    const saved = await transcriptBlob(record.id);
    if (saved) {
      try {
        record = await savePreparedTranscript(record.id,
          new File([saved], record.transcript?.name || 'transcript.json'), record.lang);
        data = await trackData(record.id);
      } catch (err) { toast(err.message); }
    }
    data ||= plainTrack(record);
  }
  apply(Track.fromData(data, objUrl));
  return true;
}

/** 用新曲目重建阅读区: Reader / VirtualList / Translator 都是一曲一份. */
function apply(next) {
  track = next;
  document.documentElement.dataset.subtitleMode = next.raw.subtitleMode || 'analyzed';
  const title = (record && record.title) || next.title;
  dom.trackTitle.textContent = title;
  document.title = title + ' · Lingua';
  setSetting('track', next.id);
  // 这条音频到底支持哪些显示层, 由 track.json 自述的 features 说了算
  initTrackCfg(next.id, next.lang, next.features, onTrackCfg);
  videoPlayer?.apply();

  explain.close();
  closeWordCard();
  closeChat();
  dom.viewport.textContent = '';
  dom.scroller.scrollTop = 0;
  reader = new Reader(dom.viewport, next, metrics);
  vlist = new VirtualList(dom.scroller, dom.viewport, reader, metrics);
  vlist.followSingle = dom.app.classList.contains('is-immersive');
  engine.reader = reader;
  engine.vlist = vlist;
  explain.setTrack(next);

  if (translator) translator.stop();
  translator = createTranslator(next, {
    onApply: applyTranslations,
    onError: (msg) => toast('翻译: ' + msg),
  });

  dom.timeNow.textContent = '0:00';
  dom.timeTotal.textContent = fmtTime(next.duration);
  dom.seek.setAttribute('aria-valuemax', (next.duration || 0).toFixed(1));

  metrics.sync(dom.viewport.clientWidth);
  vlist.reset(next.S);
  vlist.update(true);
  engine.attach(next);
  paintRepeat();
  paintSpeed();
  paintShadow('off', -1, 0);
  //  上次停在哪儿由 library.js 记着: 这里把位置交给 player.js 决定要不要续播
  player.setTrack({ id: next.id, title, position: record?.position });
  if (next.S) clearState();
  else {
    showState('可以直接播放', '字幕为可选项，可在设置中随时导入');
    dom.readerState.append(button('导入字幕（可选）', { onPick: showSetup }));
  }
  dom.btnPin.disabled = !next.S;
  dom.btnExplain.disabled = !next.S || next.raw.subtitleMode === 'plain';
  syncTranslate();
}

// ---------------------------------------------------------------- 翻译

/*  译文是异步补齐的: 一批到达 → 写进 DOM → 只重量这几行 → 让引擎重新算滚动位置.
    translate.js 已经把结果攒到一帧一批, 这里不再节流。                      */

function applyTranslations(batch) {
  if (!reader) return;
  const list = [];
  for (const [i, text] of batch) if (reader.setTranslation(i, text)) list.push(i);
  if (list.length) { videoPlayer?.refreshPip?.(); audioPip?.refresh(); }   // 小窗里的译文跟着补齐
  if (!list.length || !vlist) return;
  if (document.documentElement.dataset.tr === '0') return;   // 没显示译文, 高度不变
  vlist.invalidate(list);
  engine.markScrollDirty();
}

/** 视口内优先翻; 滚动与句子切换都会触发, 140ms 合并一次. */
const wantVisible = debounce(() => {
  if (!translator || !vlist || !trackCfg.tr) return;
  const st = dom.scroller.scrollTop;
  const vh = dom.scroller.clientHeight;
  //  焦点句 = 正在朗读的那句 (没在放就是视口第一句): 队列从它往后出队,
  //  于是听到哪儿就先翻哪儿之后的, 而不是每次都从整曲第一句重新排。
  translator.setFocus(curIndex());
  translator.want(vlist.indexAt(st) - HOT_BACK, vlist.indexAt(st + vh) + HOT_AHEAD);
}, 140);

/** 开关/语言变化后重新对齐翻译器状态. */
function syncTranslate() {
  if (!translator) return;
  translator.setEnabled(!!trackCfg.tr, trackCfg.lang);
  if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = 0; }
  if (!trackCfg.tr) return;
  wantVisible();
  sweepTimer = setTimeout(() => { sweepTimer = 0; if (translator) translator.sweep(); }, SWEEP_DELAY);
}

// ---------------------------------------------------------------- 重排

/*  字号/显示层/窗口宽度变化后, 句子高度全都变了: 重新量一遍 CSS,
    重算全部预测高度, 并把当前句留在原来的视觉位置。               */

let pendingForce = false;

const runRelayout = rafOnce(() => {
  const force = pendingForce;
  pendingForce = false;
  if (!track || !vlist) return;
  syncFollowAlign();
  const changed = metrics.sync(dom.viewport.clientWidth);
  if (!changed && !force) { engine.markScrollDirty(); return; }
  const active = reader.activeS;
  const keepActive = active >= 0 && engine.follow;
  vlist.remeasure(keepActive ? active : vlist.indexAt(dom.scroller.scrollTop),
    keepActive ? engine.followAlign : 0);
  if (keepActive) engine.scrollToActive();
  else engine.markScrollDirty();
});

function relayout(force) {
  pendingForce = pendingForce || !!force;
  runRelayout();
}

/** Immersive subtitles are one non-wrapping line; follow the spoken word horizontally. */
const followSubtitleX = rafOnce(() => {
  if (!videoPlayer || !dom.app.classList.contains('is-immersive')) return;
  const word = dom.scroller.querySelector('.s.is-active .w.is-cur');
  if (!word) return;
  const wr = word.getBoundingClientRect();
  const sr = dom.scroller.getBoundingClientRect();
  const pad = 24;
  if (wr.left < sr.left + pad) dom.scroller.scrollLeft -= sr.left + pad - wr.left;
  else if (wr.right > sr.right - pad) dom.scroller.scrollLeft += wr.right - (sr.right - pad);
});

// ---------------------------------------------------------------- 阅读区交互

let stuck = false;
const press = { id: -1, x: 0, y: 0, i: -1, timer: 0 };
let pressFired = false;

function curIndex() {
  if (reader && reader.activeS >= 0) return reader.activeS;
  return vlist ? vlist.indexAt(dom.scroller.scrollTop) : 0;
}

function seekWord(i, j) {
  if (!track) return;
  const s = track.sentences[i];
  const w = s && s.words[j];
  engine.seekSentence(i, s && s.wordTiming && w && w.start != null ? w.start : null);
  engine.kick();
}

/** 点词: 先 seek, 再按开关弹释义卡片. */
function onReaderClick(e) {
  if (!track) return;
  if (pressFired) { pressFired = false; return; }
  const art = e.target.closest('.s');
  if (!art) return;
  const i = +art.dataset.i;
  const chip = e.target.closest('.w');
  if (!chip) { engine.seekSentence(i, null); engine.kick(); return; }
  const j = +chip.dataset.j;
  seekWord(i, j);
  const w = track.sentences[i] && track.sentences[i].words[j];
  if (trackCfg.card && w && w.pos !== 'punct') {
    openWordCard({ track, i, j, lang: trackCfg.lang });
  }
}

function cancelPress() {
  if (press.timer) { clearTimeout(press.timer); press.timer = 0; }
}

function onPressStart(e) {
  const art = e.target.closest('.s');
  if (!art) return;
  cancelPress();
  press.id = e.pointerId;
  press.x = e.clientX;
  press.y = e.clientY;
  press.i = +art.dataset.i;
  press.timer = setTimeout(() => {
    press.timer = 0;
    pressFired = true;
    openExplain(press.i);
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* 忽略 */ } }
  }, LONG_PRESS);
}

function onPressMove(e) {
  if (!press.timer || e.pointerId !== press.id) return;
  if (Math.abs(e.clientX - press.x) > 8 || Math.abs(e.clientY - press.y) > 8) cancelPress();
}

function wireReader() {
  const sc = dom.scroller;
  sc.addEventListener('scroll', () => {
    engine.onScroll();
    // A queued follow-scroll can arrive just after a paused video press begins.
    // Pointer movement and wheel still cancel an intentional subtitle gesture.
    if (!videoPlayer || !audio.paused) cancelPress();
    wantVisible();
    const on = sc.scrollTop > 2;
    if (on !== stuck) { stuck = on; dom.topbar.classList.toggle('is-stuck', on); }
  }, { passive: true });
  sc.addEventListener('wheel', cancelPress, { passive: true });
  for (const ev of ['wheel', 'touchstart', 'pointerdown']) {
    sc.addEventListener(ev, () => engine.noteUserScroll(), { passive: true });
  }
  new ResizeObserver(() => relayout(false)).observe(sc);
  document.addEventListener('visibilitychange', () => engine.kick());

  dom.viewport.addEventListener('click', onReaderClick);
  dom.viewport.addEventListener('pointerdown', onPressStart);
  dom.viewport.addEventListener('pointermove', onPressMove);
  dom.viewport.addEventListener('pointerup', cancelPress);
  dom.viewport.addEventListener('pointercancel', cancelPress);
  dom.viewport.addEventListener('contextmenu', (event) => { if (videoPlayer) event.preventDefault(); });
}

// ---------------------------------------------------------------- 工具行

/** 长按打开的本地逐词拆解 (不调模型). */
function openExplain(i) {
  if (!track?.S || track.raw.subtitleMode === 'plain') return;
  const at = i >= 0 ? i : curIndex();
  explain.open(at);
  // 引擎只在游标变化时回调, 面板刚打开时得自己补一次当前词.
  if (reader && reader.activeS === at) explain.cursor(at, reader.activeW, false);
  engine.markScrollDirty();
  if (engine.follow) engine.scrollToActive();
}

/** 工具条的「讲解」: 2/3 屏对话框, 流式讲解当前句. */
function toggleChat() {
  if (!track?.S || track.raw.subtitleMode === 'plain') return;
  if (chatOpen()) { closeChat(); return; }
  const i = curIndex();
  dom.btnExplain.setAttribute('aria-pressed', 'true');
  openChat({
    track, i, lang: trackCfg.lang,
    onClose: () => dom.btnExplain.setAttribute('aria-pressed', 'false'),
  });
}

/** Topbar and the immersive toolbar share one settings entry. */
function openDisplay() {
  if (track) openTrackSheet(track, { trStats: () => translator.stats(), video: videoPlayer,
    onSubtitles: () => { closeSheet(); showSetup(); } });
}

function paintRepeat() {
  const mode = engine.repeat;
  dom.btnRepeat.setAttribute('aria-pressed', mode ? 'true' : 'false');
  dom.btnRepeat.querySelector('.tool-t').textContent = REPEAT_LABEL[mode];
  dom.btnRepeat.querySelector('use').setAttribute('href', mode === 1 ? '#i-repeat1' : '#i-repeat');
}

function paintSpeed() {
  const r = audio.playbackRate;
  const one = Math.abs(r - 1) < 0.01;
  dom.speedText.textContent = one ? '速度' : r + 'x';
  dom.btnSpeed.setAttribute('aria-pressed', one ? 'false' : 'true');
}

let hintText = '';

/** 跟读状态机的界面反馈 (按钮已隐藏, 逻辑留着备用). */
function paintShadow(kind, i, until) {
  dom.btnShadow.setAttribute('aria-pressed', kind === 'off' ? 'false' : 'true');
  const total = track ? track.S : 0;
  let text = '';
  if (kind === 'listen') text = `跟读 ${i + 1}/${total} · 先听一遍`;
  else if (kind === 'speak' || kind === 'tick') {
    const left = Math.max(0, Math.ceil((until - performance.now()) / 1000));
    text = `跟读 ${i + 1}/${total} · 该你说了 ${left}s`;
  }
  if (text === hintText) return;
  hintText = text;
  dom.hint.textContent = text;
  const hide = !text;
  if (dom.hint.hidden !== hide) { dom.hint.hidden = hide; engine.markScrollDirty(); }
}

function wireTools() {
  dom.btnPin.addEventListener('click', () => {
    if (!track) return;
    const on = dom.btnPin.getAttribute('aria-pressed') !== 'true';
    dom.btnPin.setAttribute('aria-pressed', on ? 'true' : 'false');
    engine.setFollow(on);
    toast(on ? '自动跟随已开' : '自动跟随已关，可自由翻阅');
  });

  dom.btnExplain.addEventListener('click', toggleChat);
  dom.btnExplainClose.addEventListener('click', () => {
    explain.close();
    engine.markScrollDirty();
  });

  dom.btnRepeat.addEventListener('click', () => {
    if (!track) return;
    engine.setRepeat((engine.repeat + 1) % 3);
    paintRepeat();
    toast(['重复已关', '单句循环', '整曲循环'][engine.repeat]);
  });

  dom.btnSpeed.addEventListener('click', () => openSpeedSheet(audio, (rate) => {
    audio.playbackRate = rate;
    setSetting('rate', rate);
    paintSpeed();
    closeSheet();
  }));

  dom.btnDisplay.addEventListener('click', openDisplay);
  audio.addEventListener('ratechange', paintSpeed);

  engine.onCursor = (s, w, changed) => {
    explain.cursor(s, w, changed);
    if (changed) {
      wantVisible();
      if (dom.app.classList.contains('is-immersive')) dom.scroller.scrollLeft = 0;
    }
    followSubtitleX();
  };
  engine.onShadowState = paintShadow;

  //  字幕给的时长只到最后一句结束, 真实时长要等浏览器读完音频头; 回写库里,
  //  首页的列表就能显示准确的时长, 下次再分析也能把它当参数带给后端。
  audio.addEventListener('loadedmetadata', async () => {
    if (!record) return;
    const updated = await setDuration(record.id, audio.duration);
    if (updated) record = updated;
    if (track && Number.isFinite(audio.duration)) {
      track.duration = audio.duration;
      dom.timeTotal.textContent = fmtTime(audio.duration);
      dom.seek.setAttribute('aria-valuemax', audio.duration.toFixed(1));
    }
  });

  dom.closeOverlays = () => {
    if (isCardOpen()) { closeWordCard(); return; }
    if (chatOpen()) { closeChat(); return; }
    if (sheetOpen()) { closeSheet(); return; }
    if (explain.isOpen) { explain.close(); engine.markScrollDirty(); return; }
    if (engine.shadow !== 'off') engine.setShadow(false);
  };
}

/** 全局设置回调; `layout` 表示句子高度会变, 需要整表重排. */
function onSetting(key, value, layout) {
  if (key === 'rate') { audio.playbackRate = value; paintSpeed(); }
  if (layout) relayout(true);
  else engine.kick();
}

/** 本条音频的配置回调. */
function onTrackCfg(key, value, layout) {
  audioPip?.refresh();
  if (key === 'video') { videoPlayer?.apply(); return; }
  if (key === 'tr' || key === 'lang') { syncTranslate(); videoPlayer?.refreshPip?.(); }
  if (layout) relayout(true);
  else engine.kick();
}

// ---------------------------------------------------------------- 启动

async function boot() {
  loadConfig();
  initSettings(onSetting);
  wireReader();
  nativeReady(); // A valid entry point is ready before network or large media reads.
  dom.btnBack.addEventListener('click', () => {
    if (history.length > 1) history.back();
    else location.href = 'index.html';
  });

  const q = new URLSearchParams(location.search);
  const id = q.get('track') || settings.track;
  if (!id) {
    dom.player.hidden = true;
    showState('没有指定媒体', '回首页选择或导入音频、视频');
    return;
  }
  await load(id, q.get('setup') === '1');
  dom.btnFiles.addEventListener('click', repairFiles);
  if (record?.audio?.missing && q.get('setup') !== '1') repairFiles();

  // 本地字体加载完再校一次度量: 字体一换, 所有宽度都要重量.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => relayout(true));
}

// 当前音源跟随文档生命周期, 供页面从 bfcache 恢复后继续使用。
// 换曲由 attachAudio 释放旧 URL, 文档销毁时浏览器会自动释放剩余的 URL。

boot().catch((err) => {
  console.error(err);
  showState('初始化失败', String((err && err.message) || err));
});

// 带 ?debug 时挂一个只读句柄, 方便在控制台里看内部状态 (高度表/游标/翻译进度)
if (new URLSearchParams(location.search).has('debug')) {
  window.LT = {
    engine, metrics, relayout,
    get track() { return track; },
    get reader() { return reader; },
    get vlist() { return vlist; },
    get translator() { return translator; },
  };
}
