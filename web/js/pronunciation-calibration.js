import { el } from './util.js';
import { button, buttonBar, group, stepRow } from './rows.js';
import { openSheet } from './sheet.js';
import { settings, setSetting } from './settings.js';
import { TTS_CALIBRATION_DEFAULT } from './pronunciation-config.js';
import { createPronunciation, supportsSystemSpeech } from './pronunciation.js';
import { supportsVoicePacks } from './voice-packs.js';
import { nativeApp } from './native.js';
import { packId } from './voice-pack-catalog.js';

// Bundled reference: RMS 0.1 / gated K-weighted loudness -18.13189 LUFS.
export const CALIBRATION_TEXT = 'Hello! It is a lovely day.';
export const CALIBRATION_AUDIO = 'assets/pronunciation-calibration.wav';

export function openPronunciationCalibration({ onBack } = {}) {
  const body = el('div', 'pronunciation-calibration');
  body.append(el('p', 'voice-sample', '先播放参考音频，再试听标准发音。调整到两者听起来差不多响，调整后请重新试听。'));
  const sample = el('p', 'voice-sample', CALIBRATION_TEXT);
  sample.lang = 'en';
  body.append(sample);
  const status = el('p', 'voice-empty');
  status.setAttribute('role', 'status'); status.hidden = true;
  const choices = new Map();
  // The clip player clamps this end to actual metadata; no separate playback path.
  const session = createPronunciation({
    track: { lang: 'en', audioUrl: CALIBRATION_AUDIO },
    sentence: { wordTiming: true }, word: { text: CALIBRATION_TEXT, start: 0, end: 30 },
    onState: ({ state, source, message }) => {
      for (const [key, node] of choices) {
        const active = key === source && (state === 'loading' || state === 'playing');
        node.setAttribute('aria-pressed', String(active));
        node.setAttribute('aria-busy', String(active));
      }
      status.textContent = message || ''; status.hidden = !message;
    },
  });
  const play = (source) => {
    // Calibration can be auditioned even if the global default balance switch is off.
    void session.play(source, { ...settings.pronunciation, volumeBalance: true });
  };
  const reference = button('参考音频', { glyph: 'i-speaker', onPick: () => play('audio') });
  reference.setAttribute('aria-label', '播放参考音频');
  const speech = button('标准发音', { glyph: 'i-speaker', onPick: () => play('standard') });
  speech.setAttribute('aria-label', '试听标准发音');
  choices.set('audio', reference); choices.set('standard', speech);
  for (const node of choices.values()) node.setAttribute('aria-pressed', 'false');
  speech.disabled = !(supportsSystemSpeech() || (settings.pronunciation.onlineVoices && supportsVoicePacks()));
  if (speech.disabled) { status.textContent = '当前浏览器不支持标准发音'; status.hidden = false; }
  body.append(buttonBar(reference, speech), status);
  const level = stepRow('TTS 音量', '', () => Math.round(settings.ttsCalibration * 100), (value) => {
    session.stop();
    setSetting('ttsCalibration', value / 100);
  }, { min: 10, max: 100, step: 5, unit: '%' });
  const voicePack = settings.pronunciation.onlineVoices && !!packId(settings.pronunciation.voices.en);
  const normalized = voicePack || nativeApp()?.speechLoudness === true;
  body.append(group(level), el('p', 'voice-sample', normalized
    ? '默认 50% 为参考响度，数值越小，标准发音越轻。自动保存，对所有开启音量均衡的音频生效。试听使用全局英语音色。'
    : '默认 50%，数值越小，标准发音越轻。自动保存，对所有开启音量均衡的音频生效。试听使用全局英语音色。'));
  if (voicePack) body.append(el('p', 'voice-sample', '当前选择语音包，本地合成后通过媒体音频通道播放，并按实际响度匹配参考音频。'));
  else if (['ios', 'android'].includes(nativeApp()?.platform)) {
    const packageType = nativeApp().platform === 'android' ? 'APK' : 'IPA';
    body.append(el('p', 'voice-sample', nativeApp().speechAudio
      ? (normalized ? '当前使用原生系统发音，按所选音色的实际响度自动匹配参考音频。'
        : `当前使用原生系统发音，安装新版 ${packageType} 后可按实际响度自动匹配参考音频。`)
      : `当前安装包尚未包含原生发音修复，需要重新安装新版 ${packageType}。`));
  }
  body.append(buttonBar(
    button('停止试听', { onPick: () => session.stop() }),
    button('恢复默认', { onPick: () => {
      session.stop(); setSetting('ttsCalibration', TTS_CALIBRATION_DEFAULT); level.refresh();
    } }),
  ));
  openSheet('音量校准', body, { onBack, onClose: () => session.dispose() });
}
