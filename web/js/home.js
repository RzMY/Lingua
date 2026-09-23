/**
 * 首页 —— 音频库 + 导入 + 通用设置.
 *
 * 首页 / 实验性工作台 / 设置在同一个文档里, 切换只改 `[hidden]`, 不重新加载页面;
 * 播放页是另一个文档 (`player.html?track=<id>`), 这样阅读器那套 rAF 循环、虚拟列表、
 * 字体探针都不用为首页付代价。
 *
 * 「导入」是纯本地动作: 音频 Blob 直接写进 IndexedDB, 不上传任何服务器, 所以没有上传
 * 进度这回事。字幕留到播放页再选 —— 那一步才会用上分析后端。
 *
 * 设置页把「每种语言的默认开关」收进**一个**「语言设置」入口, 里面按后端报上来的语言
 * 清单逐个列; 语言是后端加的, 这里不写死。
 */

import {
  config, loadConfig, setConfig, setLangConfig, langDefaults, langName, TARGET_LANGS,
  PROMPT_META, DEFAULT_PROMPTS, resetPrompt, DEFAULTS, LANG_DEFAULTS, onConfigChange,
} from './config.js';
import { initSettings, settings, setSetting } from './settings.js';
import { featureKeys, featureText, mergeCatalog, sourceLangs, sourceName, sourceSpec } from './langs.js';
import { baseLabel, health } from './api.js';
import { createTrack, listTracks, patchTrack, removeTrack } from './library.js';
import { MEDIA_ACCEPT, isMediaFile, mediaKind } from './media.js';
import { probe } from './llm.js';
import { errorMessage } from './errors.js';
import { openSheet, closeSheet, openConfirm, openMenu } from './sheet.js';
import {
  sectionTitle, group, switchRow, segRow, navRow, actionRow, infoRow,
  inputField, inputRow, textField, buttonBar, button,
} from './rows.js';
import { stats, clearAll, wipeTrack, isDegraded, usage } from './store.js';
import { el, icon, toast, fmtTime, fmtSize, dayKey, debounce } from './util.js';
import { enterView } from './motion.js';
import { createKeyedList } from './keyed-list.js';
import { nativeApp, nativeReady } from './native.js';

const $ = (id) => document.getElementById(id);

// Optional editors and media processing stay out of the initial module graph.
const lazyAction = (load, name) => (...args) => load().then((module) => module[name](...args))
  .catch((err) => toast(errorMessage(err, '功能加载失败，请刷新页面后重试')));
const openFontSheet = lazyAction(() => import('./font-settings.js'), 'openFontSheet');
const openVideoSheet = lazyAction(() => import('./video-settings.js'), 'openVideoSheet');
const openCaptionSheet = lazyAction(() => import('./video-settings.js'), 'openCaptionSheet');
const openBackupExport = lazyAction(() => import('./backup-ui.js'), 'openBackupExport');
const openBackupImport = lazyAction(() => import('./backup-ui.js'), 'openBackupImport');
const openMissingFiles = lazyAction(() => import('./backup-ui.js'), 'openMissingFiles');
const openFileRepair = lazyAction(() => import('./backup-ui.js'), 'openFileRepair');

const dom = {
  list: $('trackList'),
  blank: $('homeBlank'),
  finder: $('finder'),
  q: $('q'),
  set: $('setBody'),
  file: $('fileAudio'),
};

const VIEWS = ['viewHome', 'viewWorkbench', 'viewSet'];
dom.file.accept = MEDIA_ACCEPT;
let workbench;
let workbenchLoading = null;
let currentView = 'viewHome';
const experimentsEnabled = () => config.experimental === 1;

function syncExperiments() {
  $('navWorkbench').hidden = !experimentsEnabled();
  if (!experimentsEnabled()) {
    workbench?.dispose();
    workbench = null;
    if (currentView === 'viewWorkbench') go('viewHome');
  }
}

let tracks = [];
let pending = [];        // 正在写入库的文件 (还没有 track 记录)
let listErr = '';
let query = '';
let missingFilesRow = null;
const paintList = createKeyedList(dom.list);
const missingCountLabel = () => {
  const count = tracks.filter((track) => track.audio?.missing || track.transcript?.missing).length;
  return count ? count + ' 条待补充' : '';
};

/* ------------------------------------------------------------------ 列表 */

const STATUS = {
  new: ['', '未导入字幕'],
  subtitles: ['', '字幕未分析'],
  failed: ['is-bad', '分析失败'],
};

/** 卡片左下角那一行: 时长 + 语言/句数, 或者一枚状态徽章. */
function metaOf(t) {
  const meta = el('div', 'card-meta');
  meta.append(el('span', 'dur', fmtTime(t.duration || 0)));
  const hit = t.audio?.missing ? ['is-warn', '待补充媒体']
    : t.transcript?.missing ? ['is-warn', '待补充字幕'] : STATUS[t.status];
  if (hit) {
    meta.append(el('span', 'badge ' + hit[0], hit[1]));
    return meta;
  }
  const bits = [sourceName(t.lang)];
  if (t.sentences) bits.push(t.sentences + ' 句');
  if (t.hasWordTiming) bits.push('逐词');
  if (mediaKind(t.audio) === 'video') bits.push('视频');
  meta.append(el('span', 'badge', bits.join(' · ')));
  return meta;
}

/** 左上角的圆形头像. */
function art(glyph) {
  const box = el('div', 'art');
  box.append(icon(glyph));
  return box;
}

/** 奶白面板: 右侧一枚淡水印 + 顶部头像/操作 + 底部时长与标题. */
function panelOf(glyph, meta, title) {
  const panel = el('div', 'card-in');
  panel.append(icon(glyph, 'ic card-wm'));
  const top = el('div', 'card-top');
  top.append(art(glyph));
  const body = el('div', 'card-b');
  body.append(meta, title);
  panel.append(top, body);
  return { panel, top };
}

const openTrack = (id) => { location.href = 'player.html?track=' + encodeURIComponent(id); };
const openSetup = (id) => {
  location.href = 'player.html?track=' + encodeURIComponent(id) + '&setup=1';
};

function cardOf(t) {
  const video = mediaKind(t.audio) === 'video';
  const card = el('div', video ? 'card card-video' : 'card');
  const { panel, top } = panelOf(video ? 'i-video' : 'i-wave', metaOf(t), el('div', 'card-t', t.title || t.id));

  const more = el('button', 'card-a');
  more.type = 'button';
  more.setAttribute('aria-label', '更多操作');
  more.append(icon('i-dots'));
  more.addEventListener('click', () => cardMenu(more, t));
  top.append(more);

  const hit = el('button', 'card-hit');
  hit.type = 'button';
  hit.setAttribute('aria-label', (t.title || t.id) + ' · 打开');
  hit.addEventListener('click', () => openTrack(t.id));
  card.append(panel, hit);
  return card;
}

/** 正在写进库的文件: 音频不走网络, 所以只有「写入中」这一个瞬时状态. */
function pendingCardOf(u) {
  const card = el('div', 'card');
  const meta = el('div', 'card-meta');
  meta.append(el('span', 'dur', fmtSize(u.size)));
  meta.append(el('span', 'badge ' + (u.err ? 'is-bad' : 'is-run'), u.err ? '导入失败' : '导入中…'));
  const { panel } = panelOf('i-upload', meta, el('div', 'card-t', u.name));
  if (u.err) panel.append(el('div', 'card-err', u.err));
  card.append(panel);
  return card;
}

/** 空状态 / 出错状态; 两者都给一个能马上点的出口. */
function paintBlank() {
  const box = dom.blank;
  box.textContent = '';
  if (listErr) {
    const ic = el('span', 'blank-ic');
    ic.append(icon('i-info'));
    box.append(ic, el('b', null, '媒体库加载失败'), el('p', null, listErr));
    box.append(buttonBar(button('重试', { main: true, glyph: 'i-refresh', onPick: refresh })));
  } else if (query) {
    const ic = el('span', 'blank-ic');
    ic.append(icon('i-search'));
    box.append(ic, el('b', null, '未找到匹配的媒体'));
  } else {
    const ic = el('span', 'blank-ic');
    ic.append(icon('i-wave'));
    box.append(ic, el('b', null, '暂无音频或视频'));
    box.append(buttonBar(button('导入音频或视频', { main: true, glyph: 'i-plus', onPick: pick })));
  }
  box.hidden = false;
}

function render() {
  const entries = [];
  const key = query.trim().toLowerCase();
  const rows = key
    ? tracks.filter((t) => ((t.title || '') + ' ' + t.id).toLowerCase().includes(key))
    : tracks;

  //  存储不可用时 (隐私模式 / file:// 打开) 一切都只在内存里, 刷新就丢 —— 这事
  //  必须说在最显眼的地方, 不然用户会以为导入的音频丢了。
  if (isDegraded()) {
    entries.push({ key: 'warning', value: '', create: () => el('div', 'warn',
      '本地存储不可用，刷新页面后将丢失本次数据。请使用普通浏览模式。') });
  }
  pending.forEach((u, i) => entries.push({ key: 'pending:' + i, value: u, create: () => pendingCardOf(u) }));

  let day = '';
  for (const t of rows) {
    const d = dayKey(t.createdAt || t.updatedAt || '');
    if (d && d !== day) {
      day = d;
      entries.push({ key: 'day:' + t.id, value: d, create: () => el('div', 'day', d) });
    }
    entries.push({ key: 'track:' + t.id, value: [t, sourceName(t.lang)], create: () => cardOf(t) });
  }
  paintList(entries);

  if (!rows.length && !pending.length) paintBlank();
  else dom.blank.hidden = true;
}

async function refresh() {
  try {
    tracks = await listTracks();
    listErr = '';
  } catch (err) {
    tracks = [];
    listErr = errorMessage(err, '无法读取本地数据，请重试');
  }
  render();
  missingFilesRow?.setValue(missingCountLabel());
}

/* ------------------------------------------------------------------ 导入 */

const pick = () => dom.file.click();

/**
 * 导入前先确认源语言.
 *
 * 语言决定用哪套分词器与注音层, 是分析时必须明说的参数 —— 猜错的代价 (整篇注音、
 * 词性全错) 比多问一次大得多, 所以宁可在这里挡一下。
 */
function importSheet(files) {
  let lang = config.importLang || 'ja';
  const body = el('div', 'pane');
  const total = files.reduce((n, f) => n + (f.size || 0), 0);
  const note = el('div', 'pane-note',
    files.length === 1 ? `${files[0].name} · ${fmtSize(total)}`
      : `${files.length} 个文件 · 共 ${fmtSize(total)}`);
  body.append(
    note,
    group(segRow('源语言', '', () => lang, (v) => { lang = v; },
      sourceLangs().map((l) => [l.code, l.name]), { wrap: true })),
    buttonBar(
      button('导入', {
        main: true, glyph: 'i-check',
        onPick: () => {
          closeSheet();
          setConfig({ importLang: lang });
          runImport(files, lang);
        },
      }),
      button('取消', { onPick: closeSheet }),
    ),
  );
  openSheet('导入音频或视频', body);
}

/** 顺序写库: 一个大文件写 IndexedDB 也要点时间, 串行能让列表状态好读. */
async function runImport(files, lang) {
  for (const file of files) {
    const u = { name: file.name, size: file.size || 0, err: '' };
    pending.push(u);
    render();
    try {
      await createTrack(file, { title: file.name.replace(/\.[^.]+$/, ''), lang });
      pending = pending.filter((x) => x !== u);
      await refresh();
    } catch (err) {
      u.err = errorMessage(err, '无法保存文件，请重试');
      render();
      toast('导入失败：' + u.err);
    }
  }
}

dom.file.addEventListener('change', () => {
  const picked = [...(dom.file.files || [])];
  const files = picked.filter(isMediaFile);
  if (files.length !== picked.length) toast('已跳过不支持的文件，请选择音频或视频');
  dom.file.value = '';
  if (files.length) importSheet(files);
});
$('btnAdd').addEventListener('click', pick);

/* ------------------------------------------------------------------ 单条操作 */

function renameSheet(t) {
  let text = t.title || '';
  const field = inputField('标题', {
    value: text, placeholder: '输入媒体标题', onInput: (v) => { text = v; },
  });
  const body = el('div', 'pane');
  const save = button('保存', {
    main: true,
    onPick: async () => {
      const title = text.trim();
      if (!title) { toast('标题不能为空'); return; }
      save.disabled = true;
      try {
        const updated = await patchTrack(t.id, { title: title.slice(0, 200) });
        if (!updated) throw new Error('媒体不存在，请刷新媒体库');
        closeSheet();
        await refresh();
        toast('已重命名');
      } catch (err) { toast('重命名失败：' + errorMessage(err)); }
      finally { save.disabled = false; }
    },
  });
  body.append(field, buttonBar(save, button('取消', { onPick: closeSheet })));
  openSheet('重命名', body);
  requestAnimationFrame(() => field.input.focus());
}

function cardMenu(anchor, t) {
  openMenu(anchor, [
    { label: '打开', icon: 'i-play', onPick: () => openTrack(t.id) },
    { label: '重命名', icon: 'i-pen', onPick: () => renameSheet(t) },
    (t.audio?.missing || t.transcript?.missing) && {
      label: '补充文件', icon: 'i-upload',
      onPick: () => openFileRepair([t], { onUpdate: refresh, onClose: refresh }),
    },
    {
      label: t.transcript ? '字幕管理' : '导入字幕', icon: 'i-doc',
      onPick: () => openSetup(t.id),
    },
    {
      label: '清空模型缓存', icon: 'i-refresh',
      onPick: async () => {
        try {
          const n = await wipeTrack(t.id);
          toast(n ? `已清空 ${n} 条缓存` : '暂无缓存');
        } catch (err) { toast('清空缓存失败：' + errorMessage(err)); }
      },
    },
    {
      label: '删除', icon: 'i-trash', danger: true,
      onPick: async () => {
        const ok = await openConfirm('删除媒体',
          `将删除「${t.title || t.id}」的本地媒体、字幕、分析结果和缓存。此操作无法撤销。`,
          { ok: '删除', danger: true });
        if (!ok) return;
        try {
          await removeTrack(t.id);
          await refresh();
          toast('已删除');
        } catch (error) { toast('删除失败：' + errorMessage(error)); }
      },
    },
  ]);
}

/* ------------------------------------------------------------------ 视图切换 */

function ensureWorkbench() {
  if (workbench || workbenchLoading) return;
  const root = $('workbenchBody');
  const note = el('div', 'pane-note', '正在加载工作台…');
  note.setAttribute('role', 'status');
  root.replaceChildren(note);
  workbenchLoading = import('./workbench.js').then(({ mountWorkbench }) => {
    if (!experimentsEnabled()) { root.replaceChildren(); return; }
    root.replaceChildren();
    workbench = mountWorkbench(root, { onImport: refresh });
    if (currentView === 'viewWorkbench') enterView(root);
  }).catch(() => {
    root.replaceChildren(el('p', 'pane-note', '工作台加载失败，请重试。'),
      button('重新加载', { onPick: ensureWorkbench }));
  }).finally(() => { workbenchLoading = null; });
}

function go(id) {
  if (!VIEWS.includes(id) || (id === 'viewWorkbench' && !experimentsEnabled())) id = 'viewHome';
  const previous = currentView;
  currentView = id;
  if (id === 'viewWorkbench') ensureWorkbench();
  for (const v of VIEWS) $(v).hidden = v !== id;
  if (id !== previous) enterView($(id), VIEWS.indexOf(id) < VIEWS.indexOf(previous) ? 'back' : 'forward');
  for (const b of document.querySelectorAll('.nav-i')) {
    const on = b.dataset.go === id;
    b.classList.toggle('is-on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('btnAdd').hidden = id !== 'viewHome';
  if (id === 'viewSet') paintSettings();
  const tag = id === 'viewHome' ? '' : id === 'viewWorkbench' ? '#workbench' : '#set';
  history.replaceState(null, '', location.pathname + location.search + tag);
}

for (const b of document.querySelectorAll('.nav-i')) {
  b.addEventListener('click', () => go(b.dataset.go));
}

/* ------------------------------------------------------------------ 搜索 */

const btnSearch = $('btnSearch');
btnSearch.addEventListener('click', () => {
  const open = dom.finder.hidden;
  dom.finder.hidden = !open;
  btnSearch.setAttribute('aria-pressed', open ? 'true' : 'false');
  if (open) { dom.q.focus(); return; }
  if (query) { query = ''; dom.q.value = ''; render(); }
});

dom.q.addEventListener('input', debounce(() => { query = dom.q.value; render(); }, 120));
$('btnSearchX').addEventListener('click', () => {
  dom.q.value = '';
  query = '';
  render();
  dom.q.focus();
});

/* ------------------------------------------------------------------ 设置视图 */

const THEMES = [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']];

function paintSettings() {
  const box = dom.set;
  const focusLabel = box.contains(document.activeElement)
    ? document.activeElement.querySelector('.row-label b')?.textContent : null;
  box.textContent = '';
  const svc = infoRow('分析后端', '检测中…');
  const ver = infoRow('后端版本', '—');
  missingFilesRow = navRow('补充文件', '', {
    value: missingCountLabel(),
    onPick: () => openMissingFiles({ onUpdate: refresh, onClose: () => { refresh(); paintSettings(); } }),
  });

  box.append(
    sectionTitle('连接与模型'),
    group(
      navRow('分析后端', '', { value: baseLabel(), onPick: apiPane }),
      navRow('大模型', '', { value: config.model || '未配置', onPick: llmPane }),
      navRow('提示词', '', { value: PROMPT_META.length + ' 组', onPick: promptPane }),
      navRow('调用参数', '', { value: `${config.batchSize} × ${config.concurrency}`, onPick: tunePane }),
    ),
    sectionTitle('学习偏好'),
    group(
      navRow('译文语言', '', { value: langName(config.targetLang), onPick: langPane }),
      navRow('语言默认值', '',
        { value: sourceLangs().length + ' 种', onPick: langsPane }),
      navRow('字幕字号', '', { onPick: () => openFontSheet() }),
      navRow('系统字幕字号', '', { onPick: () => openCaptionSheet() }),
      navRow('视频设置', '', { onPick: () => openVideoSheet() }),
      segRow('主题', '', () => settings.theme, (v) => setSetting('theme', v), THEMES),
    ),
    sectionTitle('数据管理'),
    group(
      navRow('导出数据', '', { onPick: openBackupExport }),
      navRow('导入数据', '', { onPick: openBackupImport }),
      missingFilesRow,
      navRow('存储明细', '', { onPick: dataPane }),
      actionRow('清空模型缓存', '',
        { danger: true, onPick: wipeAll }),
    ),
    sectionTitle('系统'),
    group(
      switchRow('实验性功能', '启用音频提取与语音转录工作台',
        () => experimentsEnabled(), (v) => setConfig({ experimental: v })),
      svc,
      ver,
      infoRow('数据存储', isDegraded() ? '仅本次会话' : '本地存储'),
    ),
  );

  if (nativeApp()) box.append(group(
    navRow('检查更新', '', { onPick: () => nativeApp().checkUpdates() }),
    navRow('开发人员选项', '', { onPick: () => nativeApp().settings() }),
  ));
  if (focusLabel) {
    [...box.querySelectorAll('.row-nav')].find((row) => row.querySelector('.row-label b')?.textContent === focusLabel)
      ?.focus({ preventScroll: true });
  }

  //  探活不带 probe: 只要知道通不通, 不用让后端把六个分词器全 import 一遍。
  //  顺手把语言清单存下来, 于是后端新加的语言会自己出现在「语言设置」里。
  health({ probe: false }).then((r) => {
    svc.setValue('已连接');
    ver.setValue(r.version || '未知');
    if (r.languages) mergeCatalog(r.languages);
  }, () => svc.setValue('未连接'));
}

async function wipeAll() {
  const ok = await openConfirm('清空模型缓存',
    '将删除全部译文、词卡和讲解缓存，保留媒体、字幕与分析结果。',
    { ok: '清空', danger: true });
  if (!ok) return false;
  try {
    await clearAll();
    toast('缓存已清空');
    paintSettings();
    return true;
  } catch (err) {
    toast('清空缓存失败：' + errorMessage(err));
    return false;
  }
}

/* ------------------------------------------------------------------ 设置子页 */

/**
 * 分析后端: 地址 + 自检.
 *
 * 留空就用同源 —— `python -m pipeline serve` 同时端出站点和 API 的常见情形。填了就
 * 走跨源, 后端放开了 CORS。「测试连接」带 probe=1, 让后端真的 import 一遍各语言的
 * 分词器, 于是缺哪个模型能当场看出来。
 */
function apiPane() {
  const body = el('div', 'pane');
  const note = el('div', 'pane-note');
  note.setAttribute('role', 'status');
  note.hidden = true;

  body.append(inputField('后端地址', {
    value: config.apiBase,
    hint: nativeApp() ? (nativeApp().target ? '留空使用当前站点的分析服务' : '') : '留空使用当前站点',
    placeholder: 'http://127.0.0.1:8765',
    onInput: (v) => setConfig({ apiBase: v }),
  }));
  body.append(inputField('访问令牌', {
    value: config.apiToken, secret: true,
    onInput: (v) => setConfig({ apiToken: v }),
  }));

  const test = button('测试连接', {
    main: true, glyph: 'i-check',
    onPick: async () => {
      note.hidden = false;
      note.textContent = '正在测试连接…';
      test.disabled = true;
      try {
        const r = await health({ probe: true });
        const list = r.languages || [];
        const ready = list.filter((l) => l.ready !== false);
        if (list.length) mergeCatalog(list);
        note.textContent = [
          '连接成功',
          list.length ? `${ready.length}/${list.length} 种语言可用` : '',
        ].filter(Boolean).join(' · ');
        for (const l of list) {
          if (l.ready === false) {
            note.append(el('div', null, `${l.name || l.code}：分析组件未就绪`));
          }
        }
      } catch (err) {
        note.textContent = errorMessage(err, '连接失败，请检查后端地址后重试');
      } finally {
        test.disabled = false;
      }
    },
  });
  body.append(buttonBar(test), note);
  openSheet('分析后端', body, { cls: 'sheet-tall', onClose: paintSettings });
}

/** 这门语言当前开了几项 (navRow 右侧那个小字). */
function onCountOf(spec) {
  const keys = featureKeys(spec).filter((k) => spec.features.includes(k));
  const cur = langDefaults(spec.code);
  return `${keys.filter((k) => cur[k]).length} 项已开启`;
}

/**
 * 语言设置 —— 所有语言收在这一个入口里, 不在设置主页平铺.
 *
 * 清单来自 `/api/health` (存过一份在 localStorage), 所以后端新增一门语言,
 * 这里自动多一行, 前端不用改代码。
 */
function langsPane() {
  const list = sourceLangs();
  const body = el('div', 'pane');
  body.append(
    group(segRow('默认源语言', '', () => config.importLang,
      (v) => setConfig({ importLang: v }), list.map((l) => [l.code, l.name]), { wrap: true })),
    sectionTitle('显示默认值'),
    group(...list.map((l) => navRow(l.name,
      l.ready === false ? '分析服务未就绪' : '',
      { value: onCountOf(l), onPick: () => langFeaturePane(l.code) }))),
  );
  openSheet('语言默认值', body, { cls: 'sheet-tall', onClose: paintSettings });
}

/** 某门语言的默认开关; 有哪几项由这门语言的 features/layers 决定. */
function langFeaturePane(code) {
  const spec = sourceSpec(code);
  const keys = featureKeys(spec).filter((k) => spec.features.includes(k));
  const body = el('div', 'pane');
  const rows = keys.map((key) => {
    const [title, hint] = featureText(spec.layers, key);
    return switchRow(title, hint,
      () => langDefaults(code)[key], (v) => setLangConfig(code, { [key]: v }));
  });
  body.append(
    el('div', 'pane-note', '未单独设置的媒体使用这些默认值。'),
    group(...rows),
    buttonBar(button('恢复默认', {
      glyph: 'i-refresh',
      onPick: () => {
        setLangConfig(code, LANG_DEFAULTS);
        for (const r of rows) r.refresh();
        toast('已恢复默认');
      },
    })),
  );
  openSheet(spec.name + ' · 显示默认值', body, { cls: 'sheet-tall', onClose: langsPane });
}

/** 接口地址 / 密钥 / 模型 + 连通性自检. */
function llmPane() {
  const body = el('div', 'pane');
  const state = el('div', 'pane-note');
  state.setAttribute('role', 'status');
  state.hidden = true;

  body.append(
    inputField('接口地址', {
      value: config.baseUrl, placeholder: 'https://api.example.com/v1',
      onInput: (v) => setConfig({ baseUrl: v }),
    }),
    inputField('API Key', {
      value: config.apiKey, placeholder: 'sk-…', secret: true,
      onInput: (v) => setConfig({ apiKey: v }),
    }),
    inputField('模型名', {
      value: config.model, placeholder: 'deepseek-v4-flash',
      onInput: (v) => setConfig({ model: v }),
    }),
  );

  const test = button('测试连接', {
    main: true, glyph: 'i-check',
    onPick: async () => {
      state.hidden = false;
      state.textContent = '正在测试连接…';
      test.disabled = true;
      try {
        await probe();
        state.textContent = '连接成功';
      } catch (err) {
        state.textContent = errorMessage(err, '连接失败，请检查模型配置后重试');
      } finally {
        test.disabled = false;
      }
    },
  });
  body.append(buttonBar(test), state);
  openSheet('大模型', body, { cls: 'sheet-tall', onClose: paintSettings });
}

/** 数值输入 (输入框跟在参数名后面): 只在能解析且落在区间内时才写回, 允许中途乱输. */
function numField(label, key, { min = 0, max = 999, step = 1 } = {}) {
  const row = inputRow(label, {
    value: config[key], type: 'number', min, max, step,
    onInput: (raw) => {
      const n = Number(raw);
      if (!raw.trim() || !Number.isFinite(n) || n < min || n > max) return;
      setConfig({ [key]: step < 1 ? n : Math.round(n) });
    },
  });
  row.input.addEventListener('change', () => { row.input.value = String(config[key]); });
  return row;
}

function tunePane() {
  const body = el('div', 'pane');
  body.append(
    group(
      numField('每批句数', 'batchSize', { min: 1, max: 20 }),
      numField('并发请求数', 'concurrency', { min: 1, max: 8 }),
      numField('上文句数', 'ctxBefore', { min: 0, max: 10 }),
      numField('下文句数', 'ctxAfter', { min: 0, max: 10 }),
      numField('温度', 'temperature', { min: 0, max: 1, step: 0.1 }),
      numField('输出上限（Token）', 'maxTokens', { min: 256, max: 8192 }),
      numField('请求超时（秒）', 'timeout', { min: 10, max: 600 }),
    ),
    group(switchRow('JSON 模式', '',
      () => config.jsonMode, (v) => setConfig({ jsonMode: v }))),
    buttonBar(button('恢复默认', {
      glyph: 'i-refresh',
      onPick: () => {
        setConfig({
          batchSize: DEFAULTS.batchSize, concurrency: DEFAULTS.concurrency,
          ctxBefore: DEFAULTS.ctxBefore, ctxAfter: DEFAULTS.ctxAfter,
          temperature: DEFAULTS.temperature, timeout: DEFAULTS.timeout,
          maxTokens: DEFAULTS.maxTokens, jsonMode: DEFAULTS.jsonMode,
        });
        closeSheet();
        tunePane();
      },
    })),
  );
  openSheet('调用参数', body, { cls: 'sheet-tall', onClose: paintSettings });
}

function langPane() {
  const body = el('div', 'pane');
  body.append(group(segRow('译文语言', '',
    () => config.targetLang, (v) => setConfig({ targetLang: v }),
    TARGET_LANGS.map((l) => [l.code, l.name]), { wrap: true })));
  openSheet('译文语言', body, { onClose: paintSettings });
}

function promptPane() {
  const body = el('div', 'pane');
  const rows = PROMPT_META.map((m) => navRow(m.title, '', {
    value: config.prompts[m.key] === DEFAULT_PROMPTS[m.key] ? '默认' : '已修改',
    onPick: () => promptEdit(m),
  }));
  body.append(
    group(...rows),
    buttonBar(button('全部恢复默认', {
      glyph: 'i-refresh', danger: true,
      onPick: async () => {
         const ok = await openConfirm('恢复默认提示词', '将覆盖全部自定义提示词。此操作无法撤销。',
          { ok: '恢复', danger: true });
        if (!ok) return;
        for (const m of PROMPT_META) resetPrompt(m.key);
        toast('已恢复默认');
        promptPane();
      },
    })),
  );
  openSheet('提示词', body, { cls: 'sheet-tall', onClose: paintSettings });
}

function promptEdit(m) {
  let text = config.prompts[m.key];
  const field = textField(m.title, { value: text, rows: 14, onInput: (v) => { text = v; } });
  const vars = el('div', 'vars');
  for (const v of String(m.vars || '').split(/\s+/).filter(Boolean)) {
    vars.append(el('span', null, `{{${v}}}`));
  }
  const body = el('div', 'pane');
  body.append(field, el('p', 'field-hint', '{{src}}：源语言；{{dst}}：译文语言'), vars, buttonBar(
    button('保存', {
      main: true,
      onPick: () => { setConfig({ prompts: { [m.key]: text } }); toast('已保存'); closeSheet(); },
    }),
    button('恢复默认', {
      glyph: 'i-refresh',
      onPick: () => {
        resetPrompt(m.key);
        text = config.prompts[m.key];
        field.input.value = text;
        toast('已恢复默认');
      },
    }),
  ));
  openSheet(m.title, body, { cls: 'sheet-tall', onClose: promptPane });
}

/** 两类数据分开看: 大模型缓存清了只是重烧 token, 音频库是用户的资产. */
async function dataPane() {
  const body = el('div', 'pane');
  const rows = {
    tr: infoRow('译文', '…'),
    word: infoRow('单词卡片', '…'),
    chat: infoRow('句子讲解', '…'),
    kv: infoRow('其他', '…'),
    tracks: infoRow('媒体记录', '…'),
    audio: infoRow('媒体文件', '…'),
    transcripts: infoRow('字幕文件', '…'),
    data: infoRow('分析结果', '…'),
  };
  const used = infoRow('已用空间', '…');
  body.append(
    sectionTitle('模型缓存'),
    group(rows.tr, rows.word, rows.chat, rows.kv),
    sectionTitle('媒体库'),
    group(rows.tracks, rows.audio, rows.transcripts, rows.data, used),
    buttonBar(button('清空模型缓存', {
      danger: true, glyph: 'i-trash',
      onPick: async () => { if (await wipeAll()) closeSheet(); },
    })),
  );
  openSheet('存储明细', body, { cls: 'sheet-tall', onClose: paintSettings });
  try {
    const s = await stats();
    for (const k of Object.keys(rows)) rows[k].setValue(`${s[k] || 0} 条`);
    const u = await usage();
    used.setValue(u.quota ? `${fmtSize(u.used)} / ${fmtSize(u.quota)}`
      : (u.used ? fmtSize(u.used) : '未知'));
  } catch (err) {
    for (const row of Object.values(rows)) row.setValue('读取失败');
    used.setValue('读取失败');
    toast(errorMessage(err, '存储明细加载失败，请重试'));
  }
}

/* ------------------------------------------------------------------ 启动 */

function boot() {
  loadConfig();
  initSettings(() => {});
  syncExperiments();
  onConfigChange((_cfg, patch) => { if ('experimental' in patch) syncExperiments(); });
  const hash = (location.hash || '').replace('#', '').toLowerCase();
  const start = hash === 'set' || hash === 'restore' ? 'viewSet'
    : hash === 'workbench' ? 'viewWorkbench' : 'viewHome';
  go(start);
  refresh().then(() => {
    if (hash === 'restore') {
      openFileRepair(tracks, { imported: true, onUpdate: refresh,
        onClose: () => { refresh(); paintSettings(); } });
    }
  });
  // 从播放页返回时记录可能已经变了 (分析跑完 / 改了名 / 补了时长), 回到前台就刷一次
  addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  addEventListener('pageshow', (e) => { if (e.persisted) refresh(); });
  addEventListener('hashchange', () => go(location.hash === '#workbench' ? 'viewWorkbench'
    : location.hash === '#set' ? 'viewSet' : 'viewHome'));
}

boot();
nativeReady();
