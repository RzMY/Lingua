/**
 * 首页 —— 音频库 + 导入 + 通用设置.
 *
 * 两个视图 (首页 / 设置) 都在同一个文档里, 切换只改 `[hidden]`, 不重新加载页面;
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
  PROMPT_META, DEFAULT_PROMPTS, resetPrompt, DEFAULTS, LANG_DEFAULTS,
} from './config.js';
import { initSettings, settings, setSetting } from './settings.js';
import { openFontSheet } from './font-settings.js';
import { featureKeys, featureText, mergeCatalog, sourceLangs, sourceName, sourceSpec } from './langs.js';
import { ApiError, baseLabel, health } from './api.js';
import { createTrack, listTracks, patchTrack, removeTrack } from './library.js';
import { openBackupExport, openBackupImport, openMissingFiles, openFileRepair } from './backup-ui.js';
import { probe, LLMError } from './llm.js';
import { openSheet, closeSheet, openConfirm, openMenu } from './sheet.js';
import {
  sectionTitle, group, switchRow, segRow, navRow, actionRow, infoRow,
  inputField, inputRow, textField, buttonBar, button,
} from './rows.js';
import { stats, clearAll, wipeTrack, isDegraded, usage } from './store.js';
import { el, icon, toast, fmtTime, fmtSize, dayKey, debounce } from './util.js';

const $ = (id) => document.getElementById(id);

const dom = {
  list: $('trackList'),
  blank: $('homeBlank'),
  finder: $('finder'),
  q: $('q'),
  set: $('setBody'),
  file: $('fileAudio'),
};

const VIEWS = ['viewHome', 'viewSet'];

let tracks = [];
let pending = [];        // 正在写入库的文件 (还没有 track 记录)
let listErr = '';
let query = '';

/* ------------------------------------------------------------------ 列表 */

const STATUS = {
  new: ['is-warn', '待导入字幕'],
  failed: ['is-bad', '分析失败'],
};

/** 卡片左下角那一行: 时长 + 语言/句数, 或者一枚状态徽章. */
function metaOf(t) {
  const meta = el('div', 'card-meta');
  meta.append(el('span', 'dur', fmtTime(t.duration || 0)));
  const hit = t.audio?.missing ? ['is-warn', '待补充音频']
    : t.transcript?.missing ? ['is-warn', '待补充字幕'] : STATUS[t.status];
  if (hit) {
    meta.append(el('span', 'badge ' + hit[0], hit[1]));
    return meta;
  }
  const bits = [sourceName(t.lang)];
  if (t.sentences) bits.push(t.sentences + ' 句');
  if (t.hasWordTiming) bits.push('逐词');
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
  panel.append(icon('i-wave', 'ic card-wm'));
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
  const card = el('div', 'card');
  const { panel, top } = panelOf('i-wave', metaOf(t), el('div', 'card-t', t.title || t.id));

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
    box.append(ic, el('b', null, '读不到音频库'), el('p', null, listErr));
    box.append(buttonBar(button('重试', { main: true, glyph: 'i-refresh', onPick: refresh })));
  } else if (query) {
    const ic = el('span', 'blank-ic');
    ic.append(icon('i-search'));
    box.append(ic, el('b', null, '没有匹配的音频'), el('p', null, `换个词试试, 当前搜索: “${query}”`));
  } else {
    const ic = el('span', 'blank-ic');
    ic.append(icon('i-wave'));
    box.append(ic, el('b', null, '还没有音频'));
    box.append(buttonBar(button('导入音频', { main: true, glyph: 'i-plus', onPick: pick })));
  }
  box.hidden = false;
}

function render() {
  const list = dom.list;
  const key = query.trim().toLowerCase();
  const rows = key
    ? tracks.filter((t) => ((t.title || '') + ' ' + t.id).toLowerCase().includes(key))
    : tracks;

  list.textContent = '';
  //  存储不可用时 (隐私模式 / file:// 打开) 一切都只在内存里, 刷新就丢 —— 这事
  //  必须说在最显眼的地方, 不然用户会以为导入的音频丢了。
  if (isDegraded()) {
    list.append(el('div', 'warn',
      '浏览器存储不可用 (可能是隐私模式, 或用 file:// 打开的): 导入的音频与分析结果'
      + '只在本次会话里有效, 刷新就会丢。'));
  }
  for (const u of pending) list.append(pendingCardOf(u));

  let day = '';
  for (const t of rows) {
    const d = dayKey(t.createdAt || t.updatedAt || '');
    if (d && d !== day) { day = d; list.append(el('div', 'day', d)); }
    list.append(cardOf(t));
  }

  if (!rows.length && !pending.length) paintBlank();
  else dom.blank.hidden = true;
}

async function refresh() {
  try {
    tracks = await listTracks();
    listErr = '';
  } catch (err) {
    tracks = [];
    listErr = (err && err.message) || '读取失败';
  }
  render();
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
    group(segRow('源语言', '字幕使用的语言', () => lang, (v) => { lang = v; },
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
  openSheet('导入音频', body);
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
      u.err = (err && err.message) || '写入失败';
      render();
      toast('导入失败: ' + u.err + ' (浏览器存储可能已满)');
    }
  }
}

dom.file.addEventListener('change', () => {
  const files = [...(dom.file.files || [])];
  dom.file.value = '';
  if (files.length) importSheet(files);
});
$('btnAdd').addEventListener('click', pick);

/* ------------------------------------------------------------------ 单条操作 */

function renameSheet(t) {
  let text = t.title || '';
  const field = inputField('标题', {
    value: text, placeholder: '给这条音频起个名字', onInput: (v) => { text = v; },
  });
  const body = el('div', 'pane');
  const save = button('保存', {
    main: true,
    onPick: async () => {
      const title = text.trim();
      if (!title) { toast('标题不能为空'); return; }
      closeSheet();
      await patchTrack(t.id, { title: title.slice(0, 200) });
      await refresh();
      toast('已重命名');
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
      label: t.status === 'ready' ? '重新分析' : '导入字幕', icon: 'i-doc',
      onPick: () => openSetup(t.id),
    },
    {
      label: '清除缓存', icon: 'i-refresh',
      onPick: async () => {
        const n = await wipeTrack(t.id);
        toast(n ? `已清除 ${n} 条缓存` : '没有可清的缓存');
      },
    },
    {
      label: '删除', icon: 'i-trash', danger: true,
      onPick: async () => {
        const ok = await openConfirm('删除音频',
          `将从这台浏览器删除「${t.title || t.id}」的音频、分析结果与全部缓存, 不可撤销。`,
          { ok: '删除', danger: true });
        if (!ok) return;
        await removeTrack(t.id);
        await refresh();
        toast('已删除');
      },
    },
  ]);
}

/* ------------------------------------------------------------------ 视图切换 */

function go(id) {
  for (const v of VIEWS) $(v).hidden = v !== id;
  for (const b of document.querySelectorAll('.nav-i')) {
    const on = b.dataset.go === id;
    b.classList.toggle('is-on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('btnAdd').hidden = id !== 'viewHome';
  if (id === 'viewSet') paintSettings();
  const tag = id === 'viewHome' ? '' : '#set';
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

const THEMES = [['auto', '跟随'], ['light', '浅色'], ['dark', '深色']];

function paintSettings() {
  const box = dom.set;
  box.textContent = '';
  const svc = infoRow('分析后端', '检测中…');
  const ver = infoRow('后端版本', '—');

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
      navRow('目标语言', '', { value: langName(config.targetLang), onPick: langPane }),
      navRow('语言默认值', '',
        { value: sourceLangs().length + ' 种', onPick: langsPane }),
      navRow('字幕字号', '', { onPick: () => openFontSheet() }),
      segRow('主题', '', () => settings.theme, (v) => setSetting('theme', v), THEMES),
    ),
    sectionTitle('数据管理'),
    group(
      navRow('导出数据', '', { onPick: openBackupExport }),
      navRow('导入数据', '', { onPick: openBackupImport }),
      navRow('补充文件', '', {
        value: String(tracks.filter((t) => t.audio?.missing || t.transcript?.missing).length) + ' 条待补充',
        onPick: () => openMissingFiles({ onUpdate: refresh, onClose: () => { refresh(); paintSettings(); } }),
      }),
      navRow('存储明细', '', { value: '查看', onPick: dataPane }),
      actionRow('清理模型缓存', '',
        { danger: true, onPick: wipeAll }),
    ),
    sectionTitle('系统'),
    group(
      svc,
      ver,
      infoRow('存储', isDegraded() ? '仅本次会话' : 'IndexedDB'),
    ),
  );

  //  探活不带 probe: 只要知道通不通, 不用让后端把六个分词器全 import 一遍。
  //  顺手把语言清单存下来, 于是后端新加的语言会自己出现在「语言设置」里。
  health({ probe: false }).then((r) => {
    svc.setValue('已连接 · ' + baseLabel());
    ver.setValue(`${r.version || '?'} · schema ${r.schemaVersion || '?'}`);
    if (r.languages) mergeCatalog(r.languages);
  }, () => svc.setValue('未连接 · ' + baseLabel()));
}

async function wipeAll() {
  const ok = await openConfirm('清空大模型缓存',
    '译文、词卡和讲解缓存会被删除。音频与分析结果不受影响。',
    { ok: '清空', danger: true });
  if (!ok) return;
  await clearAll();
  toast('缓存已清空');
  paintSettings();
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
  note.hidden = true;

  body.append(inputField('后端地址', {
    value: config.apiBase,
    hint: '留空使用当前页面地址',
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
      note.textContent = '正在请求 ' + baseLabel() + ' …';
      test.disabled = true;
      try {
        const r = await health({ probe: true });
        const list = r.languages || [];
        const ready = list.filter((l) => l.ready !== false);
        if (list.length) mergeCatalog(list);
        note.textContent = [
          '连通 ✓ ' + (r.version || ''),
          `语言 ${ready.length}/${list.length} 就绪`,
          '字幕格式 ' + ((r.formats || []).join(' / ') || '—'),
          '单次上限 ' + fmtSize(r.maxBody || 0),
        ].join('  ·  ');
        for (const l of list) {
          if (l.ready === false) {
            note.append(el('div', null, `· ${l.name || l.code}: ${l.detail || '依赖没装好'}`));
          }
        }
      } catch (err) {
        note.textContent = '失败: '
          + (err instanceof ApiError ? err.message : (err && err.message) || '未知错误');
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
  return `${keys.filter((k) => cur[k]).length}/${keys.length}`;
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
    group(segRow('导入时默认', '新音频使用的源语言', () => config.importLang,
      (v) => setConfig({ importLang: v }), list.map((l) => [l.code, l.name]), { wrap: true })),
    sectionTitle('各语言的默认开关'),
    group(...list.map((l) => navRow(l.name,
      [l.native, l.engine, l.ready === false ? '后端未就绪' : ''].filter(Boolean).join(' · '),
      { value: onCountOf(l), onPick: () => langFeaturePane(l.code) }))),
  );
  openSheet('语言设置', body, { cls: 'sheet-tall', onClose: paintSettings });
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
    el('div', 'pane-note', '仅影响之后导入的音频。'),
    group(...rows),
    group(
      infoRow('分词引擎', spec.engine || '—'),
      infoRow('文字', (spec.script || '—') + (spec.spaceDelimited ? ' · 空格分词' : ' · 不分词')),
      spec.ready === false ? infoRow('后端就绪', spec.detail || '依赖没装好') : null,
    ),
    buttonBar(button('恢复默认', {
      glyph: 'i-refresh',
      onPick: () => {
        setLangConfig(code, LANG_DEFAULTS);
        for (const r of rows) r.refresh();
        toast('已恢复默认');
      },
    })),
  );
  openSheet(spec.name + ' · 默认开关', body, { cls: 'sheet-tall', onClose: langsPane });
}

/** 接口地址 / 密钥 / 模型 + 连通性自检. */
function llmPane() {
  const body = el('div', 'pane');
  const state = el('div', 'pane-note');
  state.hidden = true;

  body.append(
    el('div', 'pane-note', '请求由浏览器直接发送，API Key 仅保存在本机。'),
    inputField('接口地址', {
      value: config.baseUrl, placeholder: 'http://10.0.1.3:3000',
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
      state.textContent = '正在请求…';
      test.disabled = true;
      try {
        state.textContent = '连通 ✓  模型回了: ' + (await probe());
      } catch (err) {
        state.textContent = '失败: '
          + (err instanceof LLMError ? err.message : (err && err.message) || '未知错误');
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
  return inputRow(label, {
    value: config[key], type: 'number', min, max, step,
    onInput: (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < min || n > max) return;
      setConfig({ [key]: step < 1 ? n : Math.round(n) });
    },
  });
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
      numField('单条输出上限', 'maxTokens', { min: 256, max: 8192 }),
      numField('请求超时（秒）', 'timeout', { min: 10, max: 600 }),
    ),
    group(switchRow('JSON 模式', '不支持时自动关闭',
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
    el('div', 'pane-note', '`{{src}}` 源语言，`{{dst}}` 目标语言。'),
    group(...rows),
    buttonBar(button('全部恢复默认', {
      glyph: 'i-refresh', danger: true,
      onPick: async () => {
         const ok = await openConfirm('恢复默认提示词', '六段提示词将恢复内置版本。',
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
  body.append(field, vars, buttonBar(
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
    tracks: infoRow('音频记录', '…'),
    audio: infoRow('音频文件', '…'),
    transcripts: infoRow('字幕文件', '…'),
    data: infoRow('分析结果', '…'),
  };
  const used = infoRow('已用空间', '…');
  body.append(
    sectionTitle('大模型缓存'),
    group(rows.tr, rows.word, rows.chat, rows.kv),
    sectionTitle('音频库'),
    group(rows.tracks, rows.audio, rows.transcripts, rows.data, used),
    buttonBar(button('清空大模型缓存', {
      danger: true, glyph: 'i-trash',
      onPick: async () => { await wipeAll(); closeSheet(); },
    })),
  );
  openSheet('存储明细', body, { cls: 'sheet-tall', onClose: paintSettings });
  const s = await stats();
  for (const k of Object.keys(rows)) rows[k].setValue(`${s[k] || 0} 条`);
  const u = await usage();
  used.setValue(u.quota ? `${fmtSize(u.used)} / ${fmtSize(u.quota)}`
    : (u.used ? fmtSize(u.used) : '未知'));
}

/* ------------------------------------------------------------------ 启动 */

function boot() {
  loadConfig();
  initSettings(() => {});
  const hash = (location.hash || '').replace('#', '').toLowerCase();
  const start = hash === 'set' || hash === 'restore' ? 'viewSet' : 'viewHome';
  go(start);
  refresh().then(() => {
    if (start === 'viewSet') paintSettings();
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
}

boot();
