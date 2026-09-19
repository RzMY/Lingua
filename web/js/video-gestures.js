/** One pointer gesture at a time; controls and subtitles use their own handlers. */
import { clamp, fmtTime } from './util.js';

export const doubleTapAction = (ratio) => ratio < 0.35 ? 'back' : ratio > 0.65 ? 'forward' : 'toggle';
export const swipeTime = (start, dx, width, duration) =>
  clamp(start + dx / Math.max(1, width) * Math.min(120, duration), 0, duration);

export function setupVideoGestures({ video, engine, toggle, singleTap, feedback, setVolume, toPoint }) {
  let pointer = null, holdTimer = 0, tapTimer = 0, previousTap = null, heldRate = null;
  let brightness = 100;
  const stopHold = () => {
    clearTimeout(holdTimer);
    if (heldRate !== null) { video.playbackRate = heldRate; heldRate = null; feedback(''); }
  };
  const stopTap = () => { clearTimeout(tapTimer); previousTap = null; };
  const cancel = () => {
    stopHold(); stopTap();
    const previous = pointer;
    pointer = null;
    if (previous?.mode === 'seek') { engine.scrubbing = false; engine.kick(); }
    if (previous) {
      try { video.releasePointerCapture(previous.id); } catch { /* already released */ }
    }
    feedback('');
  };
  video.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || !engine.track) { if (pointer) cancel(); return; }
    if (pointer) { cancel(); return; }
    const p = toPoint(event);
    pointer = { id: event.pointerId, ...p, start: video.currentTime, volume: video.volume * 100,
      brightness, mode: '', boosted: false };
    video.setPointerCapture(event.pointerId);
    event.preventDefault();
    holdTimer = setTimeout(() => {
      if (!pointer || pointer.mode || video.paused) return;
      stopTap();
      heldRate = video.playbackRate;
      video.playbackRate = Math.max(2, heldRate);
      pointer.boosted = true;
      feedback(video.playbackRate + '× 快速播放');
    }, 450);
  });
  video.addEventListener('pointermove', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const p = toPoint(event), dx = p.x - pointer.x, dy = p.y - pointer.y;
    if (pointer.boosted) return;
    if (!pointer.mode && Math.max(Math.abs(dx), Math.abs(dy)) > 10) {
      clearTimeout(holdTimer); stopTap();
      pointer.mode = Math.abs(dx) >= Math.abs(dy) ? 'seek' : pointer.x < pointer.width / 2 ? 'brightness' : 'volume';
    }
    if (pointer.mode === 'seek') {
      const duration = Number.isFinite(video.duration) ? video.duration : engine.track.duration;
      if (!(duration > 0)) return;
      engine.scrubbing = true;
      engine.scrubTime = swipeTime(pointer.start, dx, pointer.width, duration);
      engine.kick();
      feedback('进度 ' + fmtTime(engine.scrubTime));
    } else if (pointer.mode === 'brightness') {
      brightness = clamp(pointer.brightness - dy / pointer.height * 150, 20, 150);
      video.style.filter = `brightness(${brightness / 100})`;
      feedback('亮度 ' + Math.round(brightness) + '%');
    } else if (pointer.mode === 'volume') {
      const volume = clamp(pointer.volume - dy / pointer.height * 150, 0, 100);
      const changed = setVolume(volume);
      feedback(changed ? '音量 ' + Math.round(video.volume * 100) + '%' : '请使用设备音量键');
    }
    event.preventDefault();
  });
  video.addEventListener('pointerup', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const finished = pointer;
    pointer = null;
    stopHold();
    try { video.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (finished.mode === 'seek') {
      engine.scrubbing = false;
      engine.seek(engine.scrubTime);
      engine.scrollToActive();
    }
    if (finished.mode || finished.boosted) { feedback('', 500); return; }
    const action = doubleTapAction(finished.x / finished.width), now = performance.now();
    if (previousTap && now - previousTap.at < 300 && previousTap.action === action) {
      stopTap();
      if (action === 'toggle') { toggle(); feedback(video.paused ? '已暂停' : '继续播放', 700); }
      else {
        engine.seek(video.currentTime + (action === 'back' ? -10 : 10));
        engine.scrollToActive();
        feedback(action === 'back' ? '快退 10 秒' : '快进 10 秒', 700);
      }
    } else {
      stopTap();
      previousTap = { at: now, action };
      tapTimer = setTimeout(() => { previousTap = null; singleTap(); }, 300);
    }
  });
  video.addEventListener('pointercancel', cancel);
  video.addEventListener('lostpointercapture', () => { if (pointer) cancel(); });
  video.addEventListener('contextmenu', (event) => event.preventDefault());
  video.addEventListener('dblclick', (event) => event.preventDefault());
  video.addEventListener('pause', stopHold);
  video.addEventListener('ended', cancel);
  window.addEventListener('blur', cancel);
  window.addEventListener('pagehide', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  return { cancel };
}
