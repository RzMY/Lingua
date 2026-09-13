import { audioBlob } from './library.js';
import { createPlaybackLog } from './playback-log.js';
import { copyText, isIOS } from './util.js';

const audio = document.getElementById('audio');
const field = document.getElementById('report');
const source = document.getElementById('source');
const status = document.getElementById('status');
const mode = document.getElementById('mode');
const pageUrl = new URL(location.href);
const sampleMode = ['http', 'blob'].includes(pageUrl.searchParams.get('sample'))
  ? pageUrl.searchParams.get('sample') : '';
const sampleUrl = new URL('../assets/audio-probe.wav', import.meta.url);
const log = createPlaybackLog(audio, { ios: isIOS(),
  standalone: navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches,
  controls: 'native-audio-element' });
let url = '', selection = 0;
let timer = 0, samples = 0, lastTime = null, progress = 0;

const update = () => {
  field.value = log.report();
  return field.value;
};
const stopSampling = () => { clearTimeout(timer); timer = 0; };
const sample = () => {
  timer = 0;
  log.record('resume:sample');
  const playable = !audio.paused && !audio.seeking && audio.readyState >= 2;
  progress = playable && lastTime !== null && audio.currentTime > lastTime + 0.01
    ? progress + 1 : 0;
  lastTime = playable ? audio.currentTime : null;
  if (progress >= 2) log.record('play:progress');
  else if (++samples < 5) timer = setTimeout(sample, 500);
  else log.record('resume:stalled');
};

// The comparison page never registers MediaSession actions or changes AudioSession.
for (const event of ['loadstart', 'loadedmetadata', 'durationchange', 'canplay', 'play',
  'playing', 'pause', 'ended', 'waiting', 'seeking', 'seeked', 'ratechange', 'error']) {
  audio.addEventListener(event, () => {
    if (event === 'play') {
      stopSampling();
      samples = progress = 0;
      lastTime = null;
      log.record('action:play:native');
      timer = setTimeout(sample, 500);
    }
    if (event === 'seeking' || event === 'seeked') { lastTime = null; progress = 0; }
    if (audio.paused || audio.ended || event === 'error') stopSampling();
    log.record(event, audio.error ? String(audio.error.code) : '');
    if (!document.hidden) update();
  });
}
document.addEventListener('visibilitychange', () => {
  log.record('visibilitychange');
  if (!document.hidden) update();
});
window.addEventListener('pageshow', () => { log.record('pageshow'); update(); });
window.addEventListener('pagehide', (e) => log.record('pagehide:' + e.persisted));
document.getElementById('refresh').addEventListener('click', update);
document.getElementById('copy').addEventListener('click', async () => {
  status.textContent = await copyText(update()) ? '已复制播放记录' : '复制失败，请长按播放记录复制';
});

const attach = (blob, origin) => {
  stopSampling();
  audio.pause();
  const previous = url;
  url = URL.createObjectURL(blob);
  audio.src = url;
  if (previous) URL.revokeObjectURL(previous);
  log.setSourceInfo({ origin, type: blob.type, bytes: blob.size });
  source.textContent = origin === 'library' ? '音频库中的原始文件' : '本地文件';
  update();
};
document.getElementById('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selection++;
  attach(file, 'file');
});

mode.value = sampleMode;
mode.addEventListener('change', () => {
  // A new document gives each transport its own run and native media session.
  if (mode.value) pageUrl.searchParams.set('sample', mode.value);
  else pageUrl.searchParams.delete('sample');
  location.assign(pageUrl.href);
});
document.getElementById('local-source').hidden = !!sampleMode;
const id = pageUrl.searchParams.get('track');
if (id) {
  const back = new URL('player.html', location.href);
  back.searchParams.set('track', id);
  document.getElementById('back').href = back.href;
}
if (sampleMode) {
  source.textContent = '正在读取测试音频';
  try {
    // Check a real GET range response; Accept-Ranges alone does not prove support.
    const probe = await fetch(sampleUrl, { headers: { Range: 'bytes=0-43' }, cache: 'no-store' });
    const range = /^bytes 0-43\/(\d+)$/.exec(probe.headers.get('Content-Range') || '');
    const info = { origin: 'test-' + sampleMode,
      type: (probe.headers.get('Content-Type') || '').split(';')[0].trim(),
      bytes: range ? Number(range[1]) : Number(probe.headers.get('Content-Length') || NaN),
      rangeStatus: probe.status, rangeSupported: probe.status === 206 && !!range };
    await probe.body?.cancel();
    if (!probe.ok) throw new Error('HTTP ' + probe.status);
    if (sampleMode === 'http') {
      audio.src = sampleUrl.href;
    } else {
      const response = await fetch(sampleUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const blob = await response.blob();
      info.bytes = blob.size;
      info.type = blob.type;
      url = URL.createObjectURL(blob);
      audio.src = url;
    }
    log.setSourceInfo(info);
    source.textContent = sampleMode === 'http' ? '测试音频 · HTTP · 90 秒' : '测试音频 · Blob · 90 秒';
    if (!info.rangeSupported) status.textContent = '测试音源的 HTTP Range 校验未通过';
  } catch (err) {
    source.textContent = '测试音频载入失败';
    log.record('source:failed', err?.name || 'Error');
  }
} else if (id) {
  const current = selection;
  source.textContent = '正在读取音频';
  try {
    const blob = await audioBlob(id);
    if (current === selection) {
      if (blob) attach(blob, 'library');
      else source.textContent = '音频库中没有这条音频';
    }
  } catch {
    if (current === selection) source.textContent = '音频读取失败';
  }
}
update();
