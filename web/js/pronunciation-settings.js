import { el, icon } from './util.js';
import { group, sectionTitle, segRow, switchRow, navRow, buttonBar, button } from './rows.js';
import { openSheet } from './sheet.js';
import { settings, setPronunciation } from './settings.js';
import { trackCfg, setTrackPronunciation } from './trackcfg.js';
import { normalizePronunciation, speechLanguage } from './pronunciation-config.js';
import { languageVoices, speechVoices, supportsSpeech, speechVoiceKey, createPronunciation } from './pronunciation.js';
import { sourceLangs } from './langs.js';

function voiceName(voice) {
  return voice.name.replace(/^Microsoft\s+/i, '').replace(/\s*(?:Online \(Natural\)|Desktop)\s*/gi, ' ').trim();
}

function voiceRegion(code) {
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(code); }
  catch { return code; }
}

const VOICE_SAMPLES = {
  en: 'Hello! It is a lovely day.', ja: 'こんにちは。今日はいい天気ですね。',
  ko: '안녕하세요. 오늘은 날씨가 좋아요.', fr: 'Bonjour ! Il fait beau aujourd’hui.',
  de: 'Hallo! Heute ist ein schöner Tag.', es: '¡Hola! Hoy hace un día precioso.',
};

function savedVoice(code, voices, preferences) {
  const saved = preferences.voices[code];
  // 旧版本只保存 voiceURI; 有多个匹配时迁移到唯一的第一个候选。
  return voices.find((voice) => speechVoiceKey(voice) === saved) || voices.find((voice) => voice.voiceURI === saved);
}

/** 语言列表只显示当前选择, 点入后用单选列表选择声音。 */
export function openPronunciationSheet({ track, onBack } = {}) {
  const get = () => track ? trackCfg.pronunciation : settings.pronunciation;
  const set = track ? setTrackPronunciation : setPronunciation;
  const body = el('div', 'pronunciation-settings');
  const back = () => openPronunciationSheet({ track, onBack });
  const source = segRow('默认发音来源', '', () => get().source,
    (value) => set({ source: value }), [['audio', '音频'], ['standard', '标准']]);
  const auto = switchRow('打开词卡自动发音', '', () => get().autoPlay,
    (value) => set({ autoPlay: value }));
  const balance = switchRow('音量均衡', '根据当前音频的平均响度调整标准发音音量', () => get().volumeBalance,
    (value) => set({ volumeBalance: value }));
  body.append(group(source, auto, balance), sectionTitle('标准音色'));
  const languages = [...sourceLangs()];
  if (track && !languages.some((lang) => lang.code === track.lang)) {
    languages.push({ code: track.lang, name: track.langName || track.lang });
  }
  const rows = languages.map((lang) => {
    const code = speechLanguage(lang.code);
    const row = navRow(lang.name, '', { onPick: () => openVoiceSheet(lang, back, track, get, set) });
    row.dataset.voiceLanguage = code;
    return { row, code };
  });
  const refresh = () => {
    const voices = speechVoices();
    for (const { row, code } of rows) {
      const voice = savedVoice(code, languageVoices(code, voices), get());
      row.setValue(!supportsSpeech() ? '暂不可用' : voice ? voiceName(voice) : '自动');
      row.disabled = !supportsSpeech();
    }
  };
  body.append(group(...rows.map(({ row }) => row)), buttonBar(button('恢复默认', { onPick: () => {
    set(normalizePronunciation()); source.refresh(); auto.refresh(); balance.refresh(); refresh();
  } })));
  openSheet(track ? '发音设置 · 当前音频' : '发音设置', body, { onBack,
    onClose: () => globalThis.speechSynthesis?.removeEventListener?.('voiceschanged', refresh) });
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged', refresh);
  refresh();
}

function openVoiceSheet(lang, onBack, track, get, set) {
  const code = speechLanguage(lang.code);
  const body = el('div');
  const sampleText = VOICE_SAMPLES[code.split('-')[0]] ||
    (track?.lang === lang.code && track.sentences?.find((s) => s.text)?.text) || lang.native || lang.name;
  const sample = el('p', 'voice-sample', sampleText);
  sample.lang = code;
  const list = el('div', 'voice-options');
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', lang.name + '音色');
  const status = el('p', 'voice-empty');
  status.setAttribute('role', 'status'); status.hidden = true;
  const choices = [];
  let previewKey = '';
  const preview = createPronunciation({ track: { ...track, lang: code }, word: { text: sampleText },
    onState: ({ state, message }) => {
      for (const choice of choices) {
        const active = choice.value === previewKey && (state === 'loading' || state === 'playing');
        choice.listen.classList.toggle('is-playing', active);
        choice.listen.setAttribute('aria-busy', String(active));
      }
      status.textContent = message || ''; status.hidden = !message;
    } });
  const audition = (value) => {
    previewKey = value;
    void preview.play('standard', { ...get(), voices: { [code]: value } });
  };
  const choose = (choice) => {
    set({ voices: { ...get().voices, [code]: choice.value } });
    for (const item of choices) {
      const selected = item === choice;
      item.button.setAttribute('aria-checked', String(selected));
      item.button.tabIndex = selected ? 0 : -1;
      item.row.classList.toggle('is-selected', selected);
    }
    audition(choice.value);
  };
  const add = (name, detail, value, selected) => {
    const row = el('div', 'voice-option' + (selected ? ' is-selected' : ''));
    const button = el('button', 'voice-option-select');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
    const label = el('span', 'voice-option-label');
    label.append(el('b', null, name));
    if (detail) label.append(el('span', null, detail));
    const check = el('span', 'voice-option-check', '✓');
    check.setAttribute('aria-hidden', 'true');
    button.append(label, check);
    const listen = el('button', 'voice-listen');
    listen.type = 'button';
    listen.setAttribute('aria-label', '试听' + name + (detail ? ' · ' + detail : ''));
    listen.title = '试听'; listen.append(icon('i-speaker', 'ic ic-sm'));
    const choice = { row, button, listen, value };
    button.addEventListener('click', () => choose(choice));
    button.addEventListener('keydown', (event) => {
      const at = choices.indexOf(choice), n = choices.length;
      const next = { ArrowDown: (at + 1) % n, ArrowRight: (at + 1) % n,
        ArrowUp: (at + n - 1) % n, ArrowLeft: (at + n - 1) % n, Home: 0, End: n - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault(); choices[next].button.focus(); choose(choices[next]);
    });
    listen.addEventListener('click', () => audition(value));
    choices.push(choice); row.append(button, listen); list.append(row);
  };
  const refresh = () => {
    const focused = choices.find(({ button, listen }) => button === document.activeElement || listen === document.activeElement);
    const wasListen = focused?.listen === document.activeElement;
    const voices = languageVoices(code);
    const selected = savedVoice(code, voices, get());
    const selectedKey = selected ? speechVoiceKey(selected) : '';
    voices.sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name) || speechVoiceKey(a).localeCompare(speechVoiceKey(b)));
    if (selected && get().voices[code] !== selectedKey) {
      set({ voices: { ...get().voices, [code]: selectedKey } });
    }
    preview.stop();
    choices.length = 0; list.replaceChildren();
    add('自动选择', '', '', !selected);
    for (const voice of voices) {
      const sameNames = voices.filter((v) => voiceName(v) === voiceName(voice) && v.lang === voice.lang);
      const suffix = sameNames.length > 1 ? ` · ${voice.localService ? '本机' : '在线'} ${sameNames.indexOf(voice) + 1}` : '';
      add(voiceName(voice), voiceRegion(voice.lang) + suffix, speechVoiceKey(voice), speechVoiceKey(voice) === selectedKey);
    }
    if (!voices.length) list.append(el('p', 'voice-empty', '暂无可用音色'));
    if (focused) choices.find(({ value }) => value === focused.value)?.[wasListen ? 'listen' : 'button'].focus({ preventScroll: true });
  };
  body.append(sample, list, status);
  openSheet(lang.name + '音色', body, { cls: 'sheet-tall', onBack,
    onClose: () => {
      globalThis.speechSynthesis?.removeEventListener?.('voiceschanged', refresh);
      preview.dispose();
    } });
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged', refresh);
  refresh();
}
