import { el } from './util.js';
import { openSheet } from './sheet.js';
import { group, sectionTitle, stepRow, switchRow, buttonBar, button } from './rows.js';
import { settings, setGlobalVideo, fontSizes, applyFontSizes } from './settings.js';
import { trackCfg, setVideoCfg, resetVideoCfg } from './trackcfg.js';
import { VIDEO_DEFAULTS } from './video-config.js';
import { previewSentence } from './font-settings.js';
import { videoPreview } from './video-preview.js';
import { sourceSpec } from './langs.js';
import { config } from './config.js';

const LAYOUT_KEYS = ['subtitles', 'position', 'width', 'height', 'transparency', 'blur'];

export function openVideoSheet({ track = null, onBack } = {}) {
  const body = el('div', 'font-pane');
  const get = () => track ? trackCfg.video : settings.video;
  const spec = sourceSpec(track?.lang || config.importLang);
  const layers = ['text', ...(spec.layerOrder || []), 'tr'];
  const sentence = previewSentence(spec, track, layers);
  applyFontSizes(fontSizes(spec.code, track ? trackCfg.fonts : {}), sentence);
  const preview = videoPreview(sentence, get);
  const set = (fields) => {
    if (track) setVideoCfg(fields); else setGlobalVideo(fields);
    preview.update();
  };
  const control = (label, key, min, max, unit = '%', step = 5) => stepRow(label, '',
    () => get()[key], (v) => set({ [key]: v }), { min, max, unit, step });
  const rows = [
    switchRow('显示字幕', '', () => get().subtitles, (subtitles) => set({ subtitles })),
    control('字幕位置', 'position', 0, 100),
    control('字幕窗口宽度', 'width', 50, 100),
    control('字幕背景透明度', 'transparency', 0, 100),
    control('字幕背景模糊', 'blur', 0, 30, 'px', 1),
  ];
  body.append(preview.element,
    sectionTitle('横屏字幕'), group(...rows),
    buttonBar(button(track ? '恢复全局字幕布局' : '恢复默认字幕布局', { onPick: () => {
      if (track) resetVideoCfg(LAYOUT_KEYS);
      else setGlobalVideo(Object.fromEntries(LAYOUT_KEYS.map((key) => [key, VIDEO_DEFAULTS[key]])));
      rows.forEach((row) => row.refresh()); preview.update();
    } })));
  openSheet(track ? '视频布局 · 当前媒体' : '视频设置 · 全局', body,
    { cls: 'sheet-tall', onBack, onClose: () => preview.dispose() });
  preview.update();
}
