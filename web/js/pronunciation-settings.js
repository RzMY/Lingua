import { el, icon } from './util.js';
import { group, sectionTitle, segRow, switchRow, navRow, buttonBar, button } from './rows.js';
import { openSheet } from './sheet.js';
import { settings, setPronunciation, setSetting } from './settings.js';
import { trackCfg, setTrackPronunciation } from './trackcfg.js';
import { normalizePronunciation, speechLanguage, TTS_CALIBRATION_DEFAULT } from './pronunciation-config.js';
import { languageVoices, speechVoices, availableSpeechVoices, supportsSystemSpeech, speechVoiceKey, storedVoiceURI, createPronunciation } from './pronunciation.js';
import { refreshVoicePacks, supportsVoicePacks, installedVoicePack, downloadVoicePack, removeVoicePack, hasSupertonicModels } from './voice-packs.js';
import { packsForLanguage, packId, findVoicePack, voiceModelCard } from './voice-pack-catalog.js';
import { sourceLangs } from './langs.js';
import { openPronunciationCalibration } from './pronunciation-calibration.js';

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
  const voice = voices.find((voice) => speechVoiceKey(voice) === saved) || voices.find((voice) => voice.voiceURI === storedVoiceURI(saved));
  return availableSpeechVoices(preferences, voice ? [voice] : [])[0];
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
  const balance = switchRow('音量均衡', '', () => get().volumeBalance,
    (value) => set({ volumeBalance: value }));
  const online = switchRow('在线音色', '', () => get().onlineVoices,
    (value) => { set({ onlineVoices: value }); refresh(); });
  const calibration = !track ? navRow('音量校准', '', {
    value: Math.round(settings.ttsCalibration * 100) + '%',
    onPick: () => openPronunciationCalibration({ onBack: back }),
  }) : null;
  body.append(group(source, auto, balance, online, calibration), sectionTitle('标准音色'));
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
    const supported = supportsSystemSpeech() || (get().onlineVoices && supportsVoicePacks());
    for (const { row, code } of rows) {
      const voice = savedVoice(code, languageVoices(code, voices), get());
      const selectedPack = get().onlineVoices && findVoicePack(packId(get().voices[code]));
      row.setValue(selectedPack ? `${selectedPack.name}${installedVoicePack(selectedPack.id) ? ' · 语音包' : ' · 未下载'}`
        : !supported ? '暂不可用' : voice ? voiceName(voice) : '自动');
      row.disabled = !supported;
    }
  };
  body.append(group(...rows.map(({ row }) => row)), buttonBar(button(track ? '恢复全局设置' : '恢复默认', { onPick: () => {
    if (!track) {
      setSetting('ttsCalibration', TTS_CALIBRATION_DEFAULT);
      calibration.setValue(Math.round(settings.ttsCalibration * 100) + '%');
    }
    set(normalizePronunciation(track ? settings.pronunciation : undefined));
    source.refresh(); auto.refresh(); balance.refresh(); online.refresh(); refresh();
  } })));
  openSheet(track ? '发音设置 · 当前音频' : '发音设置', body, { onBack,
    onClose: () => {
      globalThis.speechSynthesis?.removeEventListener?.('voiceschanged', refresh);
      window.removeEventListener('voice-packs-changed', refresh);
    } });
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged', refresh);
  window.addEventListener('voice-packs-changed', refresh);
  void refreshVoicePacks().catch(() => {});
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
  const downloads = el('div', 'voice-pack-downloads');
  const downloadJobs = new Map();
  let closed = false, downloadSource = 'official';
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
    const allVoices = languageVoices(code);
    const voices = availableSpeechVoices(get(), allVoices);
    const selected = savedVoice(code, allVoices, get());
    const savedKey = get().voices[code] || '';
    const selectedKey = selected ? speechVoiceKey(selected) : get().onlineVoices && packId(savedKey) ? savedKey : '';
    voices.sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name) || speechVoiceKey(a).localeCompare(speechVoiceKey(b)));
    if (selected && get().voices[code] !== selectedKey) {
      set({ voices: { ...get().voices, [code]: selectedKey } });
    }
    preview.stop();
    choices.length = 0; list.replaceChildren();
    add('自动选择', '', '', !selectedKey);
    choices[0].button.disabled = choices[0].listen.disabled = !supportsSystemSpeech();
    for (const voice of voices) {
      const sameNames = voices.filter((v) => voiceName(v) === voiceName(voice) && v.lang === voice.lang);
      const suffix = sameNames.length > 1 ? ` · ${voice.localService === false ? '在线' : '本机'} ${sameNames.indexOf(voice) + 1}` : '';
      add(voiceName(voice), voiceRegion(voice.lang) + (voice.provider === 'pack' ? ' · 已下载语音包' : suffix), speechVoiceKey(voice), speechVoiceKey(voice) === selectedKey);
      if (voice.provider === 'pack' && !supportsVoicePacks()) {
        choices.at(-1).button.disabled = choices.at(-1).listen.disabled = true;
      }
    }
    if (!voices.length) list.append(el('p', 'voice-empty', '暂无可用音色'));
    if (get().onlineVoices && packId(savedKey) && !selected) list.append(el('p', 'voice-empty', '已选语音包尚未下载或已删除，请在下方重新下载，或选择其他音色。'));
    if (focused) choices.find(({ value }) => value === focused.value)?.[wasListen ? 'listen' : 'button'].focus({ preventScroll: true });
    renderDownloads();
  };
  const report = (message) => { status.textContent = message; status.hidden = !message; };
  const renderDownloads = () => {
    downloads.replaceChildren();
    if (!get().onlineVoices) { downloads.remove(); return; }
    body.append(downloads);
    downloads.replaceChildren(sectionTitle('下载语音包'));
    const packs = packsForLanguage(code);
    if (!packs.length) {
      downloads.append(el('p', 'voice-empty', '此语言暂未提供可下载语音包，请使用系统音色。')); return;
    }
    downloads.append(segRow('下载源', '', () => downloadSource, (value) => { downloadSource = value; }, [['official', 'Hugging Face'], ['mirror', '镜像']]));
    const supertonic = packs.some((item) => item.engine === 'supertonic');
    downloads.append(el('p', 'voice-sample', supertonic
      ? '下载后可离线发音。日语、韩语共用约 138 MB 模型，首次另需约 10 MB 运行文件；每个音色约 0.3 MB。'
      : '下载后可离线发音。每个音色约 60 MB，首次另需约 27 MB 共用运行文件。'));
    if (supertonic) downloads.append(el('p', 'voice-sample', 'Supertonic 模型采用 OpenRAIL-M，包含用途限制。下载并使用即表示遵守模型许可；标准发音由模型合成。'));
    for (const item of packs) {
      const row = el('div', 'voice-pack-row'); row.dataset.voicePack = item.id;
      const label = el('div', 'voice-option-label');
      label.append(el('b', null, `${item.name} · ${voiceRegion(item.lang)}`));
      const link = el('a', 'voice-pack-license', `${item.license} · 模型说明`);
      link.href = voiceModelCard(item); link.target = '_blank'; link.rel = 'noopener noreferrer'; label.append(link);
      if (item.licenseURL) {
        const license = el('a', 'voice-pack-license', '模型许可'); license.href = item.licenseURL;
        license.target = '_blank'; license.rel = 'noopener noreferrer'; label.append(license);
      }
      const present = installedVoicePack(item.id), job = downloadJobs.get(item.id);
      const action = button(job ? '取消' : present ? '删除' : item.engine === 'supertonic' ? '同意并下载' : '下载', { onPick: async () => {
        if (job) { job.controller.abort(); return; }
        preview.stop();
        if (present) {
          action.disabled = true;
          try { await removeVoicePack(item.id); if (!closed) report('语音包已删除；其他音频的选择保留，使用时可重新下载。'); }
          catch (error) { if (!closed) { report(error.message); action.disabled = false; } }
          return;
        }
        const current = { controller: new AbortController(), progress: '' };
        downloadJobs.set(item.id, current); renderDownloads(); report('');
        try {
          await downloadVoicePack(item.id, { source: downloadSource, signal: current.controller.signal,
            onProgress: ({ loaded, total }) => {
              current.progress = `下载中 ${Math.floor(loaded / total * 100)}%`;
              const progress = downloads.querySelector(`[data-voice-pack="${item.id}"] .voice-pack-progress`);
              if (progress) progress.textContent = current.progress;
            } });
          if (!closed) report('下载完成，可在上方选择并试听语音包。');
        } catch (error) { if (!closed) report(current.controller.signal.aborted ? '下载已取消' : error.message); }
        finally {
          downloadJobs.delete(item.id);
          if (!closed) {
            const message = status.textContent;
            refresh(); report(message);
          }
        }
      } });
      action.setAttribute('aria-label', `${job ? '取消下载' : present ? '删除语音包' : '下载语音包'} ${item.name}`);
      action.disabled = !supportsVoicePacks();
      if (downloadJobs.size && !job) action.disabled = true;
      const size = item.engine === 'supertonic' ? (hasSupertonicModels() ? '0.3 MB' : '首次约 148 MB') : '60 MB';
      const progress = el('span', 'voice-pack-progress', job?.progress || (present ? '已下载' : size));
      progress.setAttribute('role', 'status'); label.append(progress);
      row.append(label, action); downloads.append(row);
    }
    if (!supportsVoicePacks()) downloads.append(el('p', 'voice-empty', '当前环境不支持本地语音包，请使用系统音色。'));
  };
  body.append(sample, list, status, downloads);
  openSheet(lang.name + '音色', body, { cls: 'sheet-tall', onBack,
    onClose: () => {
      globalThis.speechSynthesis?.removeEventListener?.('voiceschanged', refresh);
      window.removeEventListener('voice-packs-changed', refresh);
      window.removeEventListener('pagehide', cancelDownloads);
      window.removeEventListener('native-app-state', nativeHidden);
      document.removeEventListener('visibilitychange', hidden);
      closed = true; cancelDownloads();
      preview.dispose();
    } });
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged', refresh);
  const cancelDownloads = () => { for (const job of downloadJobs.values()) job.controller.abort(); };
  const hidden = () => { if (document.hidden) cancelDownloads(); };
  const nativeHidden = ({ detail }) => { if (detail?.active === false) cancelDownloads(); };
  window.addEventListener('voice-packs-changed', refresh);
  window.addEventListener('pagehide', cancelDownloads);
  window.addEventListener('native-app-state', nativeHidden);
  document.addEventListener('visibilitychange', hidden);
  void refreshVoicePacks().catch((error) => { if (!closed && get().onlineVoices) report(error.message); });
  refresh();
}
