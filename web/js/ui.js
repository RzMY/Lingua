/**
 * 播放页的浮层 —— 音频配置 / 倍速 / 逐词讲解面板.
 *
 * 显示类开关分两层: 「这条音频」的开关写进 `trackcfg`, 换音频互不影响;
 * 本页的字号也写进 `trackcfg`, 缺项继承语言默认值; 主题写进 `settings`。
 * 两边都通过各自的 onChange 回到 main.js,
 * 由它决定要不要整表重排。
 *
 * 开关清单是**按语言算出来的**: 这条音频支持哪些层 (`track.features` / `track.layers`)
 * 就只列哪些, 标题也用这门语言自己的说法 (日语「假名 / 罗马音」, 韩语「发音 / 罗马字」,
 * 英法德西「音标 / 原形」)。所以后端新增一门语言, 这个面板不用改。
 */

import { el } from './util.js';
import { openSheet } from './sheet.js';
import { group, infoRow, navRow, sectionTitle, segRow, switchRow } from './rows.js';
import { setSetting, settings } from './settings.js';
import { openFontSheet } from './font-settings.js';
import { setTrackCfg, trackCfg } from './trackcfg.js';
import { openVideoSheet, openCaptionSheet } from './video-settings.js';
import { TARGET_LANGS } from './config.js';
import { featureText } from './langs.js';

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const THEMES = [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']];

/** 词性图例: 只加 `p-<tag>` 类, 颜色由 reader.css 里的 --pc 决定. */
function legendCard(track) {
  const legend = el('div', 'legend');
  let n = 0;
  for (const [tag, info] of Object.entries(track.posLegend || {})) {
    if (tag === 'punct') continue;
    legend.append(el('span', 'gw-pos p-' + tag, info.label || tag));
    n++;
  }
  if (!n) return null;
  const row = el('div', 'row row-block');
  const box = el('div', 'row-label');
  box.append(el('b', null, '词性图例'));
  box.append(legend);
  row.append(box);
  return group(row);
}

/**
 * 当前音频的配置入口.
 * @param {object} track
 * @param {object} [o] `{trStats}` —— 翻译进度的读取回调
 */
export function openTrackSheet(track, { trStats, video, onSubtitles } = {}) {
  const body = document.createDocumentFragment();
  if (video) {
    body.append(group(navRow('视频字幕布局', '', { onPick: () => openVideoSheet({ track }) })));
  }
  const langRow = segRow('译文语言', '',
    () => trackCfg.lang, (v) => setTrackCfg('lang', v),
    TARGET_LANGS.map((l) => [l.code, l.name]), { wrap: true });

  // tr 先出现 (紧跟译文语言), 然后是这门语言的注音/转写层, 最后是词性与点词
  const keys = ['tr', ...track.layerOrder, 'pos', 'card'].filter((k) => track.supports(k));
  const rows = [];
  for (const key of keys) {
    const [title, hint] = featureText(track.layers, key);
    rows.push(switchRow(title, video ? '' : hint, () => trackCfg[key], (v) => {
      setTrackCfg(key, v);
      if (key === 'tr') langRow.refresh();
    }));
    if (key === 'tr') rows.push(langRow);
  }

  rows.push(navRow('字幕字号', '', { onPick: () => openFontSheet({ track, video: !!video }) }));
  rows.push(navRow('系统字幕字号', '', { value: trackCfg.video.captionSize + ' px', onPick: () => openCaptionSheet({ track }) }));
  if (onSubtitles) rows.push(navRow('字幕管理', '', { onPick: onSubtitles }));
  body.append(sectionTitle(video ? '当前视频' : '当前音频'), group(...rows));
  body.append(group(infoRow('源语言', track.langName)));

  if (trStats) {
    const st = trStats();
    body.append(group(infoRow('翻译进度', st.total ? `${st.done} / ${st.total} 句` : '—')));
  }

  body.append(
    sectionTitle('全局'),
    group(
      segRow('主题', '', () => settings.theme, (v) => setSetting('theme', v), THEMES),
    ),
  );
  const legend = legendCard(track);
  if (legend) body.append(sectionTitle('图例'), legend);
  openSheet(video ? '视频设置' : '音频配置', body, { cls: 'sheet-tall' });
}

/** 倍速; 选中项由最接近的档位决定 (可能被键盘微调过). */
export function openSpeedSheet(audio, onPick) {
  const near = RATES.reduce((best, r) =>
    (Math.abs(r - audio.playbackRate) < Math.abs(best - audio.playbackRate) ? r : best), 1);
  const body = document.createDocumentFragment();
  body.append(group(segRow('播放速度', '', () => near, (v) => onPick(v),
    RATES.map((r) => [r, (r === 1 ? '1.0' : String(r)) + 'x']), { wrap: true })));
  openSheet('速度', body);
}

/* ---------------------------------------------------------------- 讲解面板 */

/**
 * 当前句的逐词拆解 (长按句子打开). 只在句子变化时重建 DOM, 词变化时只挪一个 class.
 */
export function createExplain(dom, onPick) {
  let track = null, open = false, shown = -1, curRow = null;
  const rows = [];

  function build(sIdx) {
    const s = track.sentences[sIdx];
    rows.length = 0;
    const frag = document.createDocumentFragment();
    s.words.forEach((w, j) => {
      if (w.pos === 'punct') { rows.push(null); return; }
      const row = el('div', 'gw p-' + (w.pos || 'other'));
      const left = el('div', 'gw-l');
      if (w.read) left.append(el('span', 'gw-read', w.read));
      left.append(el('span', 'gw-text', w.text));
      if (w.roman) left.append(document.createTextNode(' '), el('span', 'gw-roman', w.roman));
      const right = el('div', 'gw-r');
      right.append(el('span', 'gw-pos', track.posLabel(w.pos)));
      const bits = [];
      if (w.lemma && w.lemma !== w.text) bits.push('原形 ' + w.lemma);
      if (w.conj) bits.push(w.conj);
      if (w.parts) bits.push(w.parts.map((p) => p.text).join(' + '));
      if (w.posDetail && !bits.length) bits.push(w.posDetail);
      if (bits.length) right.append(el('span', 'gw-meta', bits.join(' · ')));
      row.append(left, right);
      row.addEventListener('click', () => onPick(sIdx, j));
      rows.push(row);
      frag.append(row);
    });
    dom.explainBody.textContent = '';
    dom.explainBody.append(frag);
    dom.explainBody.scrollTop = 0;
    dom.explainSub.textContent = `${sIdx + 1} / ${track.S}`;
    shown = sIdx;
    curRow = null;
  }

  return {
    setTrack(t) { track = t; shown = -1; },
    get isOpen() { return open; },
    toggle(sIdx) { open ? this.close() : this.open(sIdx); return open; },
    open(sIdx) {
      open = true;
      dom.explainPanel.hidden = false;
      if (dom.btnExplain) dom.btnExplain.setAttribute('aria-pressed', 'true');
      if (sIdx >= 0) build(sIdx);
    },
    close() {
      open = false;
      dom.explainPanel.hidden = true;
      if (dom.btnExplain) dom.btnExplain.setAttribute('aria-pressed', 'false');
    },
    /** 由渲染循环的游标回调驱动. */
    cursor(sIdx, wIdx, sentenceChanged) {
      if (!open || sIdx < 0 || !track) return;
      if (sentenceChanged || shown !== sIdx) build(sIdx);
      const next = wIdx >= 0 ? rows[wIdx] : null;
      if (next === curRow) return;
      if (curRow) curRow.classList.remove('is-cur');
      curRow = next;
      if (!curRow) return;
      curRow.classList.add('is-cur');
      const box = dom.explainBody;
      const top = curRow.offsetTop, bottom = top + curRow.offsetHeight;
      if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
        box.scrollTop = top - box.clientHeight * 0.35;
      }
    },
  };
}
