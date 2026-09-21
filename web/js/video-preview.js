import { el } from './util.js';

/** Scaled landscape scene: text keeps playback px sizes in a logical viewport. */
export function videoPreview(sentence, getConfig) {
  const frame = el('div', 'video-preview');
  frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', '横屏视频字幕示例');
  const scene = el('div', 'video-preview-scene');
  scene.append(el('div', 'video-preview-sun'), el('div', 'video-preview-hill'));
  scene.append(el('span', 'video-preview-label', '横屏播放 · 示例画面'));
  const overlay = el('div', 'video-preview-subs');
  overlay.append(sentence);
  scene.append(overlay);
  frame.append(scene);
  const width = Math.max(640, Math.max(innerWidth, innerHeight));
  const height = width * 9 / 16;
  const panelHeight = Math.max(96, Math.min(132, height * .3));
  overlay.style.height = panelHeight + 'px';
  scene.style.width = width + 'px';
  scene.style.height = height + 'px';
  const fit = () => {
    const scale = frame.clientWidth / width;
    scene.style.transform = `scale(${scale})`;
    frame.style.height = height * scale + 'px';
  };
  const observer = new ResizeObserver(fit);
  observer.observe(frame);
  return { element: frame, update() {
    const cfg = getConfig();
    overlay.hidden = !cfg.subtitles;
    overlay.style.width = cfg.width + '%';
    overlay.style.bottom = `calc(4px + (100% - ${panelHeight + 8}px) * ${cfg.position / 100})`;
    overlay.style.background = `rgb(10 14 9 / ${1 - cfg.transparency / 100})`;
    overlay.style.backdropFilter = overlay.style.webkitBackdropFilter = `blur(${cfg.blur}px)`;
    fit();
  }, dispose() { observer.disconnect(); } };
}

export function captionPreview(text, translation) {
  const frame = el('div', 'caption-preview');
  frame.setAttribute('role', 'region');
  frame.setAttribute('aria-label', '系统字幕画中画示例');
  const header = el('div', 'caption-preview-head');
  header.append(el('span', null, '画中画示例'), el('span', null, '↗'));
  const original = el('div', 'caption-preview-text', text);
  const translated = el('div', 'caption-preview-tr', translation);
  frame.append(header, original, translated);
  return { element: frame, update(size) {
    original.style.fontSize = size + 'px';
    translated.style.fontSize = size * .8 + 'px';
  } };
}
