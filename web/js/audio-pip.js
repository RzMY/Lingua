/** Pure-caption PiP is available only through the supported native transparent-view path. */
import { nativeApp } from './native.js';
import { setupNativeCaptionPip } from './native-caption-pip.js';
import { toast } from './util.js';

export function setupAudioPip({ media, engine, app, beforeOpen, releaseLandscape, onStateChange }) {
  const getBridge = () => nativeApp()?.platform === 'ios' ? nativeApp().captionPip : null;
  let nativePip = null, opening = false;
  const supported = () => !!getBridge() || hasSession();
  const isActive = () => !!nativePip?.isActive();
  const hasSession = () => !!nativePip?.hasSession();
  const isBusy = () => !!nativePip?.isBusy();
  const notify = () => {
    app.classList.toggle('is-audio-pip', isActive());
    onStateChange?.();
    if (isActive()) void releaseLandscape?.();
  };
  const bind = () => {
    const bridge = getBridge();
    if (bridge && !nativePip) nativePip = setupNativeCaptionPip({ bridge, media, engine, onStateChange: notify });
  };
  bind();
  window.addEventListener('native-caption-capabilities', () => { bind(); notify(); });
  media.addEventListener('play', () => { void nativeApp()?.refreshCaptionPip?.(); });

  async function toggle() {
    if (!supported() || opening) return;
    if (isActive()) { await nativePip.close(); return; }
    if (media.error) { toast('媒体加载失败，请重新加载后再试字幕小窗'); return; }
    if (media.readyState < 2) { toast('媒体正在加载，请稍后再试字幕小窗'); return; }
    opening = true;
    try {
      if (beforeOpen) {
        const result = beforeOpen();
        if (!(result?.then ? await result : result)) return;
      }
      await nativePip.open();
    } catch (error) { toast(error?.message || '字幕小窗启动失败，请重试'); }
    finally { opening = false; }
  }
  return { toggle, close: () => nativePip?.close() ?? Promise.resolve(true),
    refresh: () => nativePip?.refresh(), isActive, hasSession, isBusy, supported, ownsActivity: () => false };
}
