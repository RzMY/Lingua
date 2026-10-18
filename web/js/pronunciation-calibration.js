import { el, icon } from './util.js';
import { button, buttonBar, stepRow } from './rows.js';
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
  const preview = el('section', 'calibration-preview');
  const panel = el('div', 'calibration-preview-in');
  const heading = el('div', 'calibration-heading');
  const mark = el('span', 'calibration-mark');
  mark.setAttribute('aria-hidden', 'true');
  mark.append(icon('i-speaker'));
  heading.append(mark, el('h3', null, '对照试听'));
  const sample = el('p', 'calibration-sample', CALIBRATION_TEXT);
  sample.lang = 'en';
  panel.append(heading, sample, el('p', 'calibration-guide', '交替试听，将标准发音调到与参考音频一样响。'));
  preview.append(panel);
  const status = el('p', 'calibration-status');
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
  const audition = buttonBar(reference, speech);
  audition.classList.add('calibration-audition');
  panel.append(audition);
  body.append(preview, status);
  const level = stepRow('标准发音音量', '', () => Math.round(settings.ttsCalibration * 100), (value) => {
    session.stop();
    setSetting('ttsCalibration', value / 100);
  }, { min: 10, max: 100, step: 5, unit: '%' });
  const voicePack = settings.pronunciation.onlineVoices && !!packId(settings.pronunciation.voices.en);
  const controls = el('section', 'calibration-level');
  controls.append(level);
  body.append(controls);
  const app = nativeApp();
  if (!voicePack && ['ios', 'android'].includes(app?.platform) && !app.speechLoudness) {
    const packageType = app.platform === 'android' ? 'APK' : 'IPA';
    body.append(el('p', 'calibration-notice', `音量匹配需安装新版 ${packageType}。`));
  }
  const actions = buttonBar(
    button('停止试听', { onPick: () => session.stop() }),
    button('恢复默认', { onPick: () => {
      session.stop(); setSetting('ttsCalibration', TTS_CALIBRATION_DEFAULT); level.refresh();
    } }),
  );
  actions.classList.add('calibration-actions');
  body.append(actions);
  openSheet('音量校准', body, { onBack, onClose: () => session.dispose() });
}
