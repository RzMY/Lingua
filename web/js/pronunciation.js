/** 词卡的独立片段播放器与浏览器 TTS。不会 seek 主播放器或写入学习进度。 */
import { normalizePronunciation, speechLanguage } from './pronunciation-config.js';
import { settings } from './settings.js';
import { isIOS, randomId } from './util.js';
import { nativeApp } from './native.js';
import { speechLoudnessTarget } from './pronunciation-loudness.js';

// WebKit cancellation reaches the platform synthesizer asynchronously. Share
// the recovery window across cards/previews, which all use the same synthesizer.
const speechRestartAt = new WeakMap();
const IOS_SPEECH_RESTART_MS = 150;

export function wordAudioRange(sentence, word, duration) {
  if (!sentence?.wordTiming || word?.pos === 'punct' ||
      !Number.isFinite(word?.start) || !Number.isFinite(word?.end) || word.start < 0 || word.end <= word.start) return null;
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  if (word.start >= limit) return null;
  const start = Math.max(0, word.start - .04);
  const end = Math.min(limit, word.end + .08);
  return end > start ? { start, end } : null;
}

/** 句子收藏的显式片段范围, 不伪造词级时间戳。 */
export function clipAudioRange(range, duration) {
  if (!Number.isFinite(range?.start) || !Number.isFinite(range?.end) || range.start < 0 || range.end <= range.start) return null;
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const end = Math.min(range.end, limit);
  return end > range.start ? { start: range.start, end } : null;
}

export function speechVoices(synth = globalThis.speechSynthesis) {
  if (nativeApp()?.speechAudio) return nativeApp().speechVoices || [];
  try { return synth?.getVoices() || []; } catch { return []; }
}

export function storedVoiceURI(key) {
  if (typeof key !== 'string' || !key.startsWith('voice:')) return key;
  try { const identity = JSON.parse(key.slice(6)); return Array.isArray(identity) ? identity[0] : key; }
  catch { return key; }
}

/** voiceURI 并非所有平台上都唯一; 保存完整身份, 不用显示名称或数组下标匹配。 */
export function speechVoiceKey(voice) {
  return 'voice:' + JSON.stringify([voice.voiceURI || '', speechLanguage(voice.lang), voice.name || '', !!voice.localService]);
}

export function languageVoices(lang, voices = speechVoices()) {
  const base = speechLanguage(lang).split('-')[0];
  const unique = new Map();
  for (const voice of voices) {
    if (speechLanguage(voice.lang).split('-')[0] !== base) continue;
    const key = speechVoiceKey(voice);
    if (!unique.has(key)) unique.set(key, voice);
  }
  return [...unique.values()];
}

export function selectSpeechVoice(lang, uri, voices = speechVoices()) {
  const matches = languageVoices(lang, voices);
  return matches.find((voice) => speechVoiceKey(voice) === uri) ||
    matches.find((voice) => voice.voiceURI === storedVoiceURI(uri)) ||
    matches.find((voice) => speechLanguage(voice.lang) === speechLanguage(lang)) ||
    matches.find((voice) => voice.default) || matches[0] || null;
}

export function supportsSpeech() {
  return !!nativeApp()?.speechAudio || (!!globalThis.speechSynthesis && typeof globalThis.SpeechSynthesisUtterance === 'function');
}

/** 一张卡一个会话; stop/dispose 使所有迟到的媒体事件、Blob 读取与 play() 失效。 */
export function createPronunciation({ track, sentence, word, audioRange, getAudioBlob, onState = () => {} }) {
  let serial = 0, disposed = false, cleanup = () => {}, active = '';
  const publish = (state, source = '', message = '') => onState({ state, source, message });
  const rangeFor = (duration) => audioRange ? clipAudioRange(audioRange, duration) : wordAudioRange(sentence, word, duration);
  const stop = () => {
    serial++;
    cleanup(); cleanup = () => {}; active = '';
    publish('idle');
  };
  const availability = () => ({
    audio: !(track.audioUrl || getAudioBlob) ? '请先补充音频或视频文件' :
      !rangeFor(track.duration) ? (audioRange ? '此收藏没有可用的原文时间戳' : '此词没有词级时间戳，请使用「标准」发音') : '',
    standard: supportsSpeech() ? '' : '当前浏览器不支持语音合成，请使用「音频」发音',
  });

  async function play(source, preferences) {
    if (disposed) return;
    stop();
    const token = serial;
    const current = () => !disposed && token === serial;
    const prefs = normalizePronunciation(preferences);
    const finish = (message = '') => {
      if (!current()) return;
      stop();
      if (message) publish('error', source, message);
    };
    const unavailable = availability()[source];
    if (unavailable || !['audio', 'standard'].includes(source)) {
      finish(unavailable || '未知发音来源'); return;
    }
    active = source;
    publish('loading', source);
    try {
      if (source === 'standard') {
        const nativeSpeech = nativeApp()?.speechAudio;
        if (nativeSpeech) {
          const id = randomId(), lang = speechLanguage(track.lang);
          const voice = selectSpeechVoice(lang, prefs.voices[lang]);
          const volume = prefs.volumeBalance
            ? (track.pronunciationLoudness?.volume?.() ?? 1) * settings.ttsCalibration : 1;
          const target = prefs.volumeBalance && nativeApp()?.speechLoudness
            ? (track.pronunciationLoudness?.target?.(settings.ttsCalibration) ?? speechLoudnessTarget(undefined, undefined, settings.ttsCalibration))
            : null;
          let completed = false;
          const state = ({ detail }) => {
            if (current() && detail?.id === id && detail.state === 'playing') publish('playing', source);
          };
          window.addEventListener('native-speech-state', state);
          const timeout = setTimeout(() => finish('原生发音未响应，请重试'), 50000);
          cleanup = () => {
            clearTimeout(timeout); window.removeEventListener('native-speech-state', state);
            if (!completed) void nativeSpeech.cancel({ id }).catch(() => {});
          };
          try {
            await nativeSpeech.speak({ id, text: word.text, lang: voice?.lang || lang, voiceURI: voice?.voiceURI || '', volume,
              ...(target === null ? {} : { targetLufs: Number.isFinite(target) ? target : -100, muted: target === -Infinity }) });
            completed = true; finish();
          } catch (error) {
            completed = true;
            finish(error?.code === 'SPEECH_CANCELLED' ? '' : (error?.message || '原生发音失败，请重试或更换声音'));
          }
          return;
        }
        const synth = globalThis.speechSynthesis;
        const utterance = new globalThis.SpeechSynthesisUtterance(word.text);
        const lang = speechLanguage(track.lang);
        const voice = selectSpeechVoice(lang, prefs.voices[lang]);
        utterance.lang = voice?.lang || lang;
        if (voice) utterance.voice = voice;
        utterance.rate = utterance.pitch = 1;
        let timeout = 0, restartTimer = 0, submitted = false, completed = false;
        utterance.onstart = () => { if (current()) publish('playing', source); };
        utterance.onend = () => {
          if (!current()) return;
          completed = true;
          finish();
        };
        utterance.onerror = (event) => {
          if (!current()) return;
          completed = true;
          finish(event.error === 'not-allowed'
            ? '浏览器阻止了自动发音，请点击「标准」重试' : '标准发音失败，请检查系统语音包或更换声音');
        };
        cleanup = () => {
          clearTimeout(timeout); clearTimeout(restartTimer);
          utterance.onstart = utterance.onend = utterance.onerror = null;
          // Natural end/error already completed the native utterance. Cancelling
          // again needlessly tears down iOS speech/audio state before the next tap.
          if (submitted && !completed) {
            if (isIOS()) speechRestartAt.set(synth, performance.now() + IOS_SPEECH_RESTART_MS);
            synth.cancel();
          }
        };
        const speak = () => {
          if (!current()) return;
          try {
            // Re-read the current calibration/measurement at actual submission,
            // including retries delayed until the preceding native cancel settles.
            utterance.volume = prefs.volumeBalance
              ? (track.pronunciationLoudness?.volume() ?? 1) * settings.ttsCalibration : 1;
            timeout = setTimeout(() => finish('语音合成未响应，请重试或更换声音'), 20000);
            submitted = true;
            synth.speak(utterance);
          }
          catch (error) { finish(error?.message || '标准发音失败，请重试'); }
        };
        const delay = isIOS() ? Math.max(0, (speechRestartAt.get(synth) || 0) - performance.now()) : 0;
        // The first speak remains synchronous in the user gesture. Only an
        // already-started iOS session needs this cancellation recovery delay.
        if (delay) restartTimer = setTimeout(speak, delay);
        else speak();
        return;
      }

      // 原生主播放器的 src 是会话标识, 用已载入的 Blob 建立 WebView 可播放的 URL。
      let url = track.audioUrl, ownedURL = '';
      if (getAudioBlob) {
        const result = getAudioBlob();
        const blob = result?.then ? await result : result;
        if (!current()) return;
        if (!blob) throw Error('请先补充音频或视频文件');
        ownedURL = url = URL.createObjectURL(blob);
      }
      const media = document.createElement('audio');
      media.hidden = true;
      media.setAttribute('playsinline', '');
      document.body.append(media);
      const range = rangeFor(track.duration);
      let stopTimer = 0, loadTimer = 0, ready = false, positioned = false;
      const loading = () => {
        clearTimeout(loadTimer);
        loadTimer = setTimeout(() => finish('音频片段加载超时，请重试'), 15000);
      };
      const listeners = [];
      const listen = (event, fn) => { media.addEventListener(event, fn); listeners.push([event, fn]); };
      cleanup = () => {
        clearTimeout(stopTimer); clearTimeout(loadTimer);
        for (const [event, fn] of listeners) media.removeEventListener(event, fn);
        media.pause(); media.removeAttribute('src'); media.load();
        media.remove();
        if (ownedURL) URL.revokeObjectURL(ownedURL);
      };
      const boundary = () => {
        clearTimeout(stopTimer);
        if (!current() || !positioned || media.seeking || media.paused) return;
        const remaining = range.end - media.currentTime;
        if (remaining <= .005) { finish(); return; }
        // 不增加 rAF 循环。停顿/缓冲后按媒体时钟重算, 不把墙钟当成播放进度。
        stopTimer = setTimeout(boundary, Math.max(10, Math.min(100, remaining / media.playbackRate * 1000)));
      };
      listen('loadedmetadata', () => {
        if (!current() || ready) return;
        const actual = rangeFor(media.duration);
        if (!actual) { finish(audioRange ? '原文时间戳超出音频范围' : '词时间戳超出音频范围'); return; }
        range.end = Math.min(range.end, actual.end);
        ready = true;
        try {
          media.currentTime = range.start;
          if (!media.seeking && Math.abs(media.currentTime - range.start) < .02) positioned = true;
        } catch { finish('无法定位音频片段，请重试'); }
      });
      const playing = () => {
        if (!current() || !positioned || media.seeking || media.paused) return;
        clearTimeout(loadTimer); publish('playing', source); boundary();
      };
      listen('seeked', () => { if (ready) { positioned = true; playing(); } });
      listen('playing', playing);
      listen('timeupdate', boundary);
      listen('waiting', () => {
        clearTimeout(stopTimer);
        if (current()) { loading(); publish('loading', source); }
      });
      listen('ended', () => finish());
      // load() 的异步 pause 事件可能晚于 loadedmetadata, 不能当作片段播放结束。
      listen('pause', () => { if (positioned && media.paused) finish(); });
      listen('error', () => finish('无法播放此音频片段，请尝试「标准」发音'));
      media.preload = 'auto';
      media.defaultPlaybackRate = media.playbackRate = 1;
      media.preservesPitch = true;
      media.volume = 1;
      media.muted = false;
      media.src = url;   // Blob URL 不附带兼容性不一致的媒体片段 fragment。
      loading();
      media.load();
      // 在用户点击的调用栈内 play, 不等 loadedmetadata/seeked 才请求播放权限。
      Promise.resolve(media.play()).catch((error) => finish(error?.name === 'NotAllowedError'
        ? '浏览器阻止了发音，请再次点击「音频」' : '音频片段播放失败，请重试'));
    } catch (error) {
      finish(error?.message || '发音失败，请重试');
    }
  }

  const hidden = () => { if (document.hidden) stop(); };
  const nativeHidden = ({ detail }) => { if (detail?.active === false) stop(); };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', stop);
  window.addEventListener('native-app-state', nativeHidden);
  return {
    play, stop, availability,
    get active() { return active; },
    dispose() {
      disposed = true; stop();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('native-app-state', nativeHidden);
    },
  };
}
