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

import { $, debounce, el, fmtTime, fmtSize, icon, isIOS, rafOnce, toast } from './util.js';
import { enterView } from './motion.js';
import { Track } from './track.js';
import { Metrics } from './metrics.js';
import { Reader } from './reader.js';
import { VirtualList } from './virtual.js';
import { Engine } from './engine.js';
import { setupPlayer } from './player.js';
import { mediaKind } from './media.js';
import { setupVideo } from './video-player.js';
import { setupAudioPip } from './audio-pip.js';
import { initSettings, setSetting, settings } from './settings.js';
import { initTrackCfg, trackCfg } from './trackcfg.js';
import { config, loadConfig } from './config.js';
import { nativeApp, nativeReady } from './native.js';
import { sourceLangs } from './langs.js';
import { createExplain, openSpeedSheet, openTrackSheet } from './ui.js';
import { closeSheet, sheetOpen } from './sheet.js';
import { analyze } from './api.js';
import { errorMessage } from './errors.js';
import { audioBlob, audioUrl, getTrack, patchTrack, saveAnalysis, setDuration, setPosition, trackData,
  transcriptBlob, savePreparedTranscript, SUB_EXT, SUB_RE } from './library.js';
import { plainTrack } from './subtitles.js';
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
  engine.setSuspended(true);
  engine.noteUserScroll();
  explain.close();
  closeWordCard();
  closeChat();
  clearState();
  dom.viewport.hidden = true;
  dom.player.hidden = true;
  const title = record.title || record.id;
  dom.trackTitle.textContent = title;
  document.title = title + ' · Lingua';

  const box = dom.setup;
  box.textContent = '';
  box.hidden = false;
  box.removeAttribute('aria-busy');

  const head = el('div', 'setup-h');
  syncVideoLayout();
  const emblem = el('span', 'setup-emblem');
  emblem.append(icon('i-doc'));
  const intro = el('div');
  intro.append(el('h1', null, '导入字幕'));
  head.append(emblem, intro);
  box.append(head);

  const fields = el('fieldset', 'setup-fields');
  const card = el('div', 'setup-card');
  const label = el('div', 'setup-section');
  label.append(el('span', 'setup-step', '01'), el('h2', null, '选择字幕'));
  card.append(label);
  fields.append(card);
  box.append(fields);

  const flags = { estimate: false, split: true, merge: true };
  let lang = record.lang || config.importLang || 'ja';
  const analysisOptions = el('details', 'setup-options');
  const summary = el('summary');
  const summaryCopy = el('span');
  summaryCopy.append(el('b', null, '分析选项'));
  summary.append(icon('i-tune', 'ic ic-sm'), summaryCopy, icon('i-chev-d', 'ic ic-sm setup-chevron'));
  analysisOptions.append(summary, group(
    switchRow('自动拆句', '按标点拆分字幕',
      () => (flags.split ? 1 : 0), (v) => { flags.split = !!v; }),
    switchRow('合并分词', '合并缩写与连字符词',
      () => (flags.merge ? 1 : 0), (v) => { flags.merge = !!v; }),
    switchRow('估算词级时间戳', '按字数分配时间，可能与实际发音不同步',
      () => (flags.estimate ? 1 : 0), (v) => { flags.estimate = !!v; }),
  ));

  const input = el('input');
  input.type = 'file';
  //  iOS 上按扩展名过滤会把 .srt / .vtt 一起灰掉 (见 util.isIOS), 只能不给 accept,
  //  让用户在 Files 里随便挑, 再由下面的后缀校验兜住。
  if (!isIOS()) input.accept = SUB_EXT.map((e) => '.' + e).join(',');
  input.hidden = true;
  input.setAttribute('aria-label', '选择字幕文件');
  const name = el('b', 'setup-file', '选择或拖入字幕文件');
  const fileHint = el('span', 'setup-file-hint', '支持 SRT、VTT、WebVTT、JSON');
  const fileCopy = el('span', 'setup-file-copy');
  fileCopy.append(name, fileHint);
  const fileIcon = el('span', 'setup-file-icon');
  fileIcon.append(icon('i-doc'));
  const choose = el('button', 'setup-pick');
  choose.type = 'button';
  choose.setAttribute('aria-label', '选择字幕文件');
  choose.append(fileIcon, fileCopy, icon('i-plus', 'ic ic-sm'));
  choose.addEventListener('click', () => input.click());
  card.append(input, choose);

  const languageCard = el('div', 'setup-card');
  const languageLabel = el('div', 'setup-section');
  languageLabel.append(el('span', 'setup-step', '02'), el('h2', null, '设置字幕语言'));
  languageCard.append(languageLabel, group(
    segRow('源语言', '', () => lang, (v) => { lang = v; },
      sourceLangs().map((l) => [l.code, l.name]), { wrap: true })), analysisOptions);
  fields.append(languageCard);

  const bar = el('div', 'setup-bar');
  bar.append(el('i'));
  bar.hidden = true;
  const log = el('pre', 'setup-log');
  log.hidden = true;
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');

  const go = button('开始分析', { main: true, glyph: 'i-check', onPick: () => start() });
  go.disabled = true;
  const only = button('只导入字幕', { glyph: 'i-doc', onPick: () => start(false) });
  only.disabled = true;
  const back = button('返回播放',
    { glyph: 'i-play', onPick: () => openTrack() });
  back.classList.add('setup-back');
  const bottom = buttonBar(only, go);
  bottom.classList.add('setup-actions');
  fields.append(bottom);
  box.append(bar, log, back);
  dom.scroller.scrollTop = 0;
  enterView(box);

  let file = null, busy = false;
  function selectFile(picked, saved = false) {
    if (!picked || busy) return;
    if (!SUB_RE.test(picked.name)) {
      toast('请选择 SRT、VTT、WebVTT 或 JSON 字幕文件');
      return;
    }
    file = picked;
    name.textContent = file.name;
    fileHint.textContent = `${fmtSize(file.size)}${saved ? ' · 已保存' : ''}`;
    choose.classList.add('has-file');
    choose.setAttribute('aria-label', '更换字幕文件：' + file.name);
    choose.lastElementChild.querySelector('use').setAttribute('href', '#i-check');
    go.disabled = false;
    only.disabled = false;
  }
  transcriptBlob(record.id).then((saved) => {
    if (!saved || file || !name.isConnected || box.hidden) return;
    selectFile(new File([saved], record.transcript?.name || 'transcript.json', { type: saved.type }), true);
  }).catch(() => { if (name.isConnected) toast('已保存的字幕读取失败，请重新选择文件'); });
  input.addEventListener('change', () => {
    const picked = (input.files || [])[0] || null;
    // 没给 accept 的那条路 (iOS) 靠这里挡住选错的文件, 后缀集合与后端一致
    selectFile(picked);
    input.value = '';
  });
  card.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!busy) choose.classList.add('is-dragging');
  });
  card.addEventListener('dragleave', (event) => {
    if (!card.contains(event.relatedTarget)) choose.classList.remove('is-dragging');
  });
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    choose.classList.remove('is-dragging');
    const files = event.dataTransfer?.files;
    if (files?.length > 1) { toast('一次请选择一个字幕文件'); return; }
    selectFile(files?.[0]);
  });

  const write = (text) => {
    log.hidden = false;
    log.textContent += text + '\n';
    log.scrollTop = log.scrollHeight;
  };

  async function start(withAnalysis = true) {
    if (!file || busy) return;
    busy = true;
    fields.disabled = true;
    box.setAttribute('aria-busy', 'true');
    go.disabled = true;
    choose.disabled = true;
    only.disabled = true;
    back.disabled = true;
    bar.hidden = false;
    bar.classList.add('is-busy');
    log.textContent = '';
    write(withAnalysis ? '正在分析字幕…' : '正在导入字幕…');
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
      if (!resp.track || !Array.isArray(resp.track.sentences)) throw new Error('未收到字幕分析结果，请重试');
      record = await saveAnalysis(record.id, resp.track, { transcriptName: file.name, transcriptFile: file });
      updateFileState();
      write('分析完成，正在加载…');
      await openTrack();
    } catch (err) {
      const msg = errorMessage(err, withAnalysis ? '字幕分析失败，请重试' : '字幕导入失败，请重试');
      write(msg);
      // 之前已经分析过的就别把状态打回失败, 用户还能「先看现有内容」
      if (!['ready', 'subtitles'].includes(record.status)) {
        try { record = (await patchTrack(record.id, { status: 'failed', error: msg })) || record; }
        catch (saveError) { toast(errorMessage(saveError, '无法保存分析状态，请重试')); }
      }
    } finally {
      go.disabled = false;
      choose.disabled = false;
      only.disabled = false;
      back.disabled = false;
      busy = false;
      fields.disabled = false;
      box.removeAttribute('aria-busy');
      bar.classList.remove('is-busy');
      bar.hidden = true;
    }
  }
}

// ---------------------------------------------------------------- 载入曲目

/** 原始音视频 Blob 直接挂到当前媒体元素, 共用字幕时间轴. */
async function attachAudio(id) {
  dom.btnPlay.disabled = true;
  if (audio.nativeAudio) {
    showState('正在加载…');
    const blob = await audioBlob(id);
    if (blob) {
      await audio.attach(blob, record);
      audio.playbackRate = settings.rate || 1;
      objUrl = audio.src;
    } else {
      await audio.release(); objUrl = '';
      record = { ...record, audio: { ...record.audio, missing: true } };
    }
    clearState();
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

async function repairFiles() {
  if (!record) return;
  let openFileRepair;
  try { ({ openFileRepair } = await import('./backup-ui.js')); }
  catch (error) { toast(errorMessage(error, '文件管理加载失败，请重试')); return; }
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
  showState('正在加载…');
  record = await getTrack(id);
  if (!record) {
    dom.player.hidden = true;
    showState('媒体不存在', '请返回首页选择或重新导入');
    return false;
  }
  const isVideo = mediaKind(record.audio) === 'video';
  audio = isVideo ? $('video') : $('audio');
  if (audio === $('audio') && nativeApp()?.audioPlayer) {
    const { NativeAudio } = await import('./native-audio.js');
    audio = new NativeAudio(nativeApp().audioPlayer);
  }
  if (isVideo && nativeApp()?.nativeVideoAudio) {
    const { NativeVideo } = await import('./native-video.js');
    audio = new NativeVideo(nativeApp().audioPlayer, $('video'));
  }
  engine.audio = audio;
  audio.addEventListener('timeupdate', () => engine.backgroundTick());
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
    if (record.status === 'failed' && record.error) toast(errorMessage(record.error, '上次字幕分析失败，请重试'));
    showSetup();
    return false;
  }
  return openTrack();
}

async function openTrack() {
  dom.setup.hidden = true;
  dom.viewport.hidden = false;
  syncVideoLayout();
  dom.setup.textContent = '';
  dom.player.hidden = false;
  showState('正在加载…');
  audio.pause();
  let data = await trackData(record.id);
  if (!data || !Array.isArray(data.sentences)) {
    const saved = await transcriptBlob(record.id);
    if (saved) {
      try {
        record = await savePreparedTranscript(record.id,
          new File([saved], record.transcript?.name || 'transcript.json'), record.lang);
        data = await trackData(record.id);
      } catch (err) { toast(errorMessage(err, '字幕加载失败，请重新导入')); }
    }
    data ||= plainTrack(record);
  }
  apply(Track.fromData(data, objUrl));
  engine.setSuspended(false);
  // Immersive video uses transforms to center these elements; preserve that layout.
  enterView(dom.scroller, 'fade');
  enterView(dom.player, 'fade');
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
    onError: (msg) => toast('翻译失败：' + msg),
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
    showState('');
    dom.readerState.append(button('导入字幕', { main: true, glyph: 'i-doc', onPick: showSetup }));
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
  if (!dom.setup.hidden || !list.length || !vlist) return;
  if (document.documentElement.dataset.tr === '0') return;   // 没显示译文, 高度不变
  vlist.invalidate(list);
  engine.markScrollDirty();
}

/** 视口内优先翻; 滚动与句子切换都会触发, 140ms 合并一次. */
const wantVisible = debounce(() => {
  if (!dom.setup.hidden || !translator || !vlist || !trackCfg.tr) return;
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
  if (engine.presentationHidden) return;
  const force = pendingForce;
  pendingForce = false;
  if (!dom.setup.hidden || !track || !vlist || engine.presentationHidden) return;
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
  if (!videoPlayer || !engine.follow || !dom.app.classList.contains('is-immersive')) return;
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
  for (const ev of ['touchstart', 'pointerdown']) {
    sc.addEventListener(ev, () => engine.noteUserScroll(), { passive: true });
  }
  for (const ev of ['wheel', 'touchmove']) {
    sc.addEventListener(ev, () => engine.noteUserScroll({ unpin: true }), { passive: true });
  }
  sc.addEventListener('pointerdown', (event) => {
    // Scrollbar dragging is manual scrolling too; ordinary subtitle taps retain follow.
    const rect = sc.getBoundingClientRect();
    if (sc.offsetWidth > sc.clientWidth && event.clientX >= rect.left + sc.clientWidth) {
      engine.noteUserScroll({ unpin: true });
    }
  }, { passive: true });
  sc.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea, select, button, [contenteditable]')) return;
    if (['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
      engine.noteUserScroll({ unpin: true });
    }
  });
  new ResizeObserver(() => relayout(false)).observe(sc);
  let activityPip = false, nativeActive = true;
  const syncPresentation = () => {
    engine.setPresentationHidden(document.hidden || !nativeActive || activityPip);
    if (!engine.presentationHidden) relayout(false);
  };
  document.addEventListener('visibilitychange', syncPresentation);
  window.addEventListener('native-app-state', ({ detail }) => { nativeActive = detail.active; syncPresentation(); });
  window.addEventListener('native-pip', ({ detail }) => {
    if (typeof detail.active !== 'boolean') return;
    activityPip = detail.active; syncPresentation();
  });
  syncPresentation();

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
  if (track) openTrackSheet(track, { translator, video: videoPlayer,
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
  if (kind === 'listen') text = `跟读 ${i + 1}/${total} · 播放示范`;
  else if (kind === 'speak' || kind === 'tick') {
    const left = Math.max(0, Math.ceil((until - performance.now()) / 1000));
    text = `跟读 ${i + 1}/${total} · 请跟读，剩余 ${left} 秒`;
  }
  if (text === hintText) return;
  hintText = text;
  dom.hint.textContent = text;
  const hide = !text;
  if (dom.hint.hidden !== hide) { dom.hint.hidden = hide; engine.markScrollDirty(); }
}

function wireTools() {
  engine.onFollowChange = (on) => dom.btnPin.setAttribute('aria-pressed', String(on));
  dom.btnPin.addEventListener('click', () => {
    if (!track) return;
    const on = !engine.follow;
    engine.setFollow(on);
    toast(on ? '已开启字幕跟随' : '已关闭字幕跟随');
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
    toast(['已关闭循环播放', '单句循环', '全部循环'][engine.repeat]);
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
      if (engine.follow && dom.app.classList.contains('is-immersive')) dom.scroller.scrollLeft = 0;
    }
    followSubtitleX();
  };
  engine.onShadowState = paintShadow;

  //  字幕给的时长只到最后一句结束, 真实时长要等浏览器读完音频头; 回写库里,
  //  首页的列表就能显示准确的时长, 下次再分析也能把它当参数带给后端。
  audio.addEventListener('loadedmetadata', async () => {
    if (!record) return;
    try {
      const updated = await setDuration(record.id, audio.duration);
      if (updated) record = updated;
    } catch (error) { console.warn('Media duration was not saved', error); }
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
    showState('未选择媒体', '请返回首页选择或导入音频、视频');
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
  showState('播放器加载失败', errorMessage(err, '请刷新页面后重试'));
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
