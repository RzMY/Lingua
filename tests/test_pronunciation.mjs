import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { normalizePronunciation } from '../web/js/pronunciation-config.js';
import { wordAudioRange, clipAudioRange, selectSpeechVoice } from '../web/js/pronunciation.js';

const { outputFiles } = await build({ stdin: { contents: `
  export * from './web/js/pronunciation.js';
  export * from './web/js/settings.js';
  export * from './web/js/trackcfg.js';
  export * from './web/js/card.js';
  export * from './web/js/pronunciation-settings.js';
  export * from './web/js/voice-packs.js';
  export * from './web/js/voice-pack-catalog.js';
  export { writeBatch } from './web/js/store.js';
  export { closeSheet } from './web/js/sheet.js';`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'PronunciationTest' });
const track = { id: 'lesson', lang: 'en', audioUrl: 'blob:lesson', duration: 10,
  posLabel: () => '名词', sentences: [{ text: 'Hello world', start: 0, end: 10, wordTiming: true,
    words: [{ text: 'Hello', pos: 'noun', read: 'həˈləʊ', start: 1, end: 1.5 }] }] };
const sentence = track.sentences[0], word = sentence.words[0];
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, speech = true) {
  const dom = new JSDOM('<button id="opener">Open</button>', {
    url: 'https://localhost', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, media = [], utterances = [], revoked = [], timers = new Map();
  let timerID = 0, cancels = 0;
  t.after(() => w.close());
  w.console.warn = () => {};
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.setTimeout = (fn, delay) => { timers.set(++timerID, { fn, delay }); return timerID; };
  w.clearTimeout = (id) => timers.delete(id);
  w.URL.createObjectURL = () => 'blob:owned';
  w.URL.revokeObjectURL = (url) => revoked.push(url);
  const create = w.document.createElement.bind(w.document);
  w.document.createElement = (tag) => {
    const node = create(tag);
    if (tag === 'audio') media.push(node);
    return node;
  };
  Object.defineProperties(w.HTMLMediaElement.prototype, {
    duration: { configurable: true, get() { return this._duration ?? 10; } },
    paused: { configurable: true, get() { return this._paused !== false; } },
  });
  w.HTMLMediaElement.prototype.load = function () { this.playbackRate = this.defaultPlaybackRate; };
  w.HTMLMediaElement.prototype.pause = function () {
    this._paused = true; this.dispatchEvent(new w.Event('pause'));
  };
  w.HTMLMediaElement.prototype.play = function () {
    this._paused = false; this.dispatchEvent(new w.Event('playing')); return Promise.resolve();
  };
  const voices = [{ name: 'English US', lang: 'en-US', voiceURI: 'us' },
    { name: 'English UK', lang: 'en-GB', voiceURI: 'uk' }, { name: '日本語', lang: 'ja-JP', voiceURI: 'ja' }];
  if (speech) {
    w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    w.speechSynthesis = new w.EventTarget();
    w.speechSynthesis.getVoices = () => voices;
    w.speechSynthesis.speak = (utterance) => utterances.push(utterance);
    w.speechSynthesis.cancel = () => { cancels++; };
  }
  w.eval(outputFiles[0].text);
  const api = w.PronunciationTest;
  api.initSettings();
  api.initTrackCfg(track.id, track.lang);
  const events = [];
  const session = api.createPronunciation({ track, sentence, word, onState: (event) => events.push(event) });
  t.after(() => { session.dispose(); api.closeWordCard(); api.closeSheet(); });
  const fire = (target, type) => target.dispatchEvent(new w.Event(type));
  return { w, api, media, utterances, revoked, timers, voices, events, session, fire, get cancels() { return cancels; } };
}

async function packageHarness(t, native = false) {
  const h = harness(t), contexts = [], workers = [];
  h.w.TextDecoder = TextDecoder;
  h.w.structuredClone = structuredClone;
  h.w.fetch = async () => ({ ok: true, text: async () => '' });
  Object.defineProperty(h.w.crypto, 'subtle', { value: webcrypto.subtle });
  h.w.Worker = class {
    constructor(url) { this.url = url; workers.push(this); }
    postMessage(data) { this.data = data; }
    terminate() { this.terminated = true; }
  };
  h.w.AudioContext = class {
    constructor() { this.state = 'suspended'; contexts.push(this); }
    resume() { this.resumed = true; this.state = 'running'; return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createBuffer(_channels, length, rate) {
      return { length, rate, copyToChannel: (samples) => { this.samples = samples; } };
    }
    createBufferSource() {
      const node = { connect() {}, disconnect() {}, start() { node.started = true; }, stop() { node.stopped = true; } };
      this.node = node; return node;
    }
  };
  const id = h.api.VOICE_PACKS[0].id;
  await h.api.writeBatch({ voicePacks: [
    { key: id, value: { model: new ArrayBuffer(2), config: new TextEncoder().encode('{}').buffer, revision: h.api.VOICE_REVISION } },
    { key: h.api.VOICE_RUNTIME_KEY, value: { onnx: new ArrayBuffer(2), data: new ArrayBuffer(2), phonemizer: new ArrayBuffer(2) } },
  ], voicePackMeta: [{ key: id, value: { id, revision: h.api.VOICE_REVISION } }] });
  await h.api.refreshVoicePacks();
  const prefs = { onlineVoices: true, voices: { en: h.api.packKey(id) } };
  if (native) {
    const calls = [], cancelled = [], pending = new Map();
    h.w.LinguaNative = { platform: 'ios', speechPCM: true, speechAudio: {
      playPCM: (call) => { calls.push(call); return new Promise((resolve, reject) => pending.set(call.id, { resolve, reject })); },
      cancel: async ({ id }) => { cancelled.push(id); pending.get(id)?.reject(Object.assign(Error('cancelled'), { code: 'SPEECH_CANCELLED' })); },
    }, speechVoices: [] };
    Object.assign(h, { calls, cancelled, pending });
  }
  return { ...h, contexts, workers, prefs,
    render(worker = workers.at(-1)) {
      worker.onmessage({ data: { sampleRate: 16000, samples: h.w.Float32Array.from({ length: 1600 }, (_, i) => .1 * Math.sin(i * 2 * Math.PI * 1000 / 16000)) } });
    } };
}

test('package speech resumes Web Audio in the click, uses actual PCM target and never calls system TTS', async (t) => {
  const h = await packageHarness(t);
  const playing = h.session.play('standard', h.prefs);
  assert.equal(h.contexts[0].resumed, true, 'resume must precede model IO');
  await flush(); h.render(); await playing;
  assert.equal(h.contexts[0].node.started, true); assert.equal(h.events.at(-1).state, 'playing');
  assert.equal(h.workers[0].terminated, true); assert.equal(h.utterances.length, 0);
  assert.equal(h.cancels, 0); assert.equal(h.media.length, 0);
  h.contexts[0].node.onended();
  assert.equal(h.contexts[0].closed, true); assert.equal(h.session.active, '');
  h.api.setSetting('ttsCalibration', .1);
  await h.session.play('standard', h.prefs);
  assert.equal(h.workers.length, 1, 'completed PCM is reused, synthesis is not repeated');
  assert.ok(h.contexts[1].samples.every((n, i) => Math.abs(n - h.contexts[0].samples[i] * .2) < .000001), 'cached raw PCM uses live calibration');
});

test('package cancellation kills inference, ignores late PCM and switching to system speech keeps that request alive', async (t) => {
  const h = await packageHarness(t);
  const playing = h.session.play('standard', h.prefs); await flush();
  h.session.stop(); await playing;
  assert.equal(h.workers[0].terminated, true); assert.equal(h.contexts[0].closed, true);
  h.render(h.workers[0]); assert.equal(h.contexts[0].node, undefined);
  const old = h.session.play('standard', h.prefs); await flush();
  await h.session.play('standard', { voices: { en: 'us' } }); await old;
  h.render(h.workers[1]);
  assert.equal(h.utterances.length, 1); assert.equal(h.contexts[1].node, undefined);
  assert.equal(h.session.active, 'standard');
});

test('native package PCM uses its own capability and cancel id, without Web Audio or system synthesis', async (t) => {
  const h = await packageHarness(t, true);
  const playing = h.session.play('standard', h.prefs); await flush(); h.render(); await flush();
  const call = h.calls[0];
  assert.equal(call.sampleRate, 16000); assert.ok(call.pcm.length > 0);
  assert.equal(call.targetLufs, -18.13189);
  assert.equal(h.contexts.length, 0); assert.equal(h.utterances.length, 0);
  h.w.dispatchEvent(new h.w.CustomEvent('native-speech-state', { detail: { id: call.id, state: 'playing' } }));
  assert.equal(h.events.at(-1).state, 'playing');
  h.fire(h.w, 'pagehide'); await playing;
  assert.deepEqual(h.cancelled, [call.id]); assert.equal(h.session.active, '');
});

test('downloaded and missing pack choices survive settings refresh without switching automatic voices', async (t) => {
  const h = await packageHarness(t);
  h.api.setPronunciation(h.prefs); h.api.openPronunciationSheet();
  h.w.document.querySelector('[data-voice-language="en"]').click(); await flush();
  const selected = h.w.document.querySelector('[role=radio][aria-checked=true]');
  assert.match(selected.textContent, /Lessac/);
  assert.equal(h.api.settings.pronunciation.voices.en, h.prefs.voices.en);
  await h.api.removeVoicePack(h.api.VOICE_PACKS[0].id);
  assert.equal(h.api.settings.pronunciation.voices.en, h.prefs.voices.en);
  assert.match(h.w.document.querySelector('.sheet-body').textContent, /已删除/);
});

test('online voices default off and hide installed packs, download controls and calibration explanations', async (t) => {
  const h = await packageHarness(t);
  const body = () => h.w.document.querySelector('.sheet-body');
  const toggle = () => h.w.document.querySelector('[aria-label="在线音色"]');
  h.api.setPronunciation({ voices: h.prefs.voices }); h.api.openPronunciationSheet();
  assert.equal(toggle().getAttribute('aria-pressed'), 'false');
  assert.doesNotMatch(body().textContent, /Lessac|语音包|未下载/);
  h.w.document.querySelector('[data-voice-language=en]').click(); await flush();
  assert.equal(body().querySelector('.voice-pack-downloads'), null);
  assert.doesNotMatch(body().textContent, /语音包|下载|模型|Hugging Face|镜像|Lessac/);
  assert.equal(body().querySelectorAll('[role=radio]').length, 3, 'local system choices remain');
  assert.match(body().querySelector('[aria-checked=true]').textContent, /自动选择/);
  assert.equal(h.api.settings.pronunciation.voices.en, h.prefs.voices.en);
  await h.session.play('standard', h.api.settings.pronunciation);
  assert.equal(h.utterances.at(-1).voice.voiceURI, 'us');
  assert.equal(h.contexts.length, 0); assert.equal(h.workers.length, 0);
  h.api.closeSheet();
  [...body().querySelectorAll('button')].find((b) => b.textContent.includes('音量校准')).click();
  assert.doesNotMatch(body().textContent, /语音包|模型|媒体音频通道/);
  h.api.closeSheet(); toggle().click(); h.api.initSettings();
  assert.equal(h.api.settings.pronunciation.onlineVoices, true);
  assert.match(body().querySelector('[data-voice-language=en]').textContent, /Lessac/);
  h.w.document.querySelector('[data-voice-language=en]').click(); await flush();
  assert.ok(body().querySelector('.voice-pack-downloads'));
  assert.match(body().textContent, /Hugging Face|镜像/);
  assert.match(body().querySelector('[aria-checked=true]').textContent, /Lessac/);
  h.api.closeSheet(); toggle().click();
  h.w.document.querySelector('[data-voice-language=ja]').click(); await flush();
  assert.doesNotMatch(body().textContent, /Supertonic|OpenRAIL|语音包|模型|下载/);
  assert.equal(h.api.installedVoicePack(h.api.VOICE_PACKS[0].id), true);
  assert.equal(h.api.settings.pronunciation.voices.en, h.prefs.voices.en);
});

test('online voice switch stays with its audio and restore defaults turns it off', (t) => {
  const h = harness(t);
  h.api.openPronunciationSheet({ track });
  const toggle = () => h.w.document.querySelector('[aria-label="在线音色"]');
  toggle().click(); h.api.initTrackCfg(track.id, track.lang);
  assert.equal(h.api.trackCfg.pronunciation.onlineVoices, true);
  assert.equal(h.api.settings.pronunciation.onlineVoices, false);
  h.api.initTrackCfg('other', 'en');
  assert.equal(h.api.trackCfg.pronunciation.onlineVoices, false);
  h.api.initTrackCfg(track.id, track.lang);
  h.w.document.querySelector('[data-voice-language=en]').click();
  assert.ok(h.w.document.querySelector('.voice-pack-downloads'));
  h.api.closeSheet();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent === '恢复默认').click();
  assert.equal(toggle().getAttribute('aria-pressed'), 'false');
  h.api.initTrackCfg(track.id, track.lang);
  assert.equal(h.api.trackCfg.pronunciation.onlineVoices, false);
  h.w.document.querySelector('[data-voice-language=en]').click();
  assert.equal(h.w.document.querySelector('.voice-pack-downloads'), null);
});

test('hidden system network selections remain saved, use local speech and return after enabling', async (t) => {
  const h = harness(t), online = { name: 'Online Voice', lang: 'en-US', voiceURI: 'us', localService: false };
  h.voices.unshift(online);
  const key = h.api.speechVoiceKey(online);
  h.api.setPronunciation({ voices: { en: key } });
  h.api.openPronunciationSheet();
  assert.doesNotMatch(h.w.document.querySelector('[data-voice-language=en]').textContent, /Online Voice/);
  h.w.document.querySelector('[data-voice-language=en]').click();
  assert.equal(h.w.document.querySelectorAll('[role=radio]').length, 3);
  assert.match(h.w.document.querySelector('[aria-checked=true]').textContent, /自动选择/);
  assert.equal(h.api.settings.pronunciation.voices.en, key);
  await h.session.play('standard', h.api.settings.pronunciation);
  assert.notEqual(h.utterances.at(-1).voice, online);
  h.api.closeSheet(); h.w.document.querySelector('[aria-label="在线音色"]').click();
  h.w.document.querySelector('[data-voice-language=en]').click();
  assert.match(h.w.document.querySelector('[aria-checked=true]').textContent, /Online Voice/);
  await h.session.play('standard', h.api.settings.pronunciation);
  assert.equal(h.utterances.at(-1).voice, online);
  h.api.closeSheet(); h.w.document.querySelector('[aria-label="在线音色"]').click();
  h.voices.splice(1);
  await h.session.play('standard', h.api.settings.pronunciation);
  assert.match(h.events.at(-1).message, /暂无可用本机音色/);
  assert.equal(h.utterances.length, 2, 'system default must not silently use a known network voice');
});

test('clip range requires word timing and clamps padding to media boundaries', () => {
  assert.equal(wordAudioRange({ wordTiming: false }, word, 10), null);
  for (const invalid of [{}, { start: 1, end: 1 }, { start: -1, end: 2 }, { start: 12, end: 13 }, { start: 1, end: NaN }]) {
    assert.equal(wordAudioRange(sentence, invalid, 10), null);
  }
  assert.deepEqual(wordAudioRange(sentence, { start: 0, end: 10 }, 10), { start: 0, end: 10 });
  assert.deepEqual(wordAudioRange(sentence, word, 10), { start: .96, end: 1.58 });
});

test('preferences bound corrupt input and match saved voices only within the source language', () => {
  const prefs = normalizePronunciation({ source: 'bad', autoPlay: 'false', before: 9999, volume: 2,
    pitch: null, speechRate: '0.71', audioRate: {}, voices: { EN_us: 'us', '__proto__': 'bad', ja: [] } });
  assert.equal(prefs.source, 'audio'); assert.equal(prefs.autoPlay, false);
  assert.equal(prefs.onlineVoices, false, 'older settings do not opt into online voices');
  for (const value of [true, 1]) assert.equal(normalizePronunciation({ onlineVoices: value }).onlineVoices, true);
  for (const value of [false, 0, null, 'true', 'false', {}, []]) assert.equal(normalizePronunciation({ onlineVoices: value }).onlineVoices, false);
  assert.equal(prefs.volumeBalance, true, 'older and corrupt settings default to enabled');
  for (const value of [false, 0]) assert.equal(normalizePronunciation({ volumeBalance: value }).volumeBalance, false);
  for (const value of [true, 1, null, 'false', {}]) assert.equal(normalizePronunciation({ volumeBalance: value }).volumeBalance, true);
  for (const key of ['before', 'after', 'volume', 'pitch', 'speechRate', 'audioRate']) assert.equal(key in prefs, false);
  assert.deepEqual(prefs.voices, { 'en-us': 'us' });
  const voices = [{ lang: 'en-US', voiceURI: 'us' }, { lang: 'en-GB', voiceURI: 'uk' }, { lang: 'ja', voiceURI: 'ja' }];
  assert.equal(selectSpeechVoice('en', 'uk', voices), voices[1]);
  assert.equal(selectSpeechVoice('en_GB', 'missing', voices), voices[1]);
  assert.equal(selectSpeechVoice('en', 'ja', voices), voices[0]);
  assert.equal(selectSpeechVoice('ko', '', voices), null);
});

test('sentence clips use their explicit range and stop at the end without word timing', async (t) => {
  for (const range of [null, {}, { start: -1, end: 2 }, { start: 4, end: 4 }, { start: 2, end: NaN }]) {
    assert.equal(clipAudioRange(range, 10), null);
  }
  assert.deepEqual(clipAudioRange({ start: 8, end: 12 }, 10), { start: 8, end: 10 });
  const h = harness(t);
  const session = h.api.createPronunciation({ track, word: { text: 'Keep going.' }, audioRange: { start: 5, end: 8 } });
  t.after(() => session.dispose());
  await session.play('audio');
  const audio = h.media[0]; h.fire(audio, 'loadedmetadata'); h.fire(audio, 'seeked');
  assert.equal(audio.currentTime, 5);
  audio.currentTime = 7.9; h.fire(audio, 'timeupdate'); assert.equal(session.active, 'audio');
  audio.currentTime = 8; h.fire(audio, 'timeupdate'); assert.equal(session.active, '');
  assert.equal(audio.isConnected, false);
  await session.play('standard');
  assert.equal(h.utterances[0].text, 'Keep going.');
  session.dispose(); assert.equal(h.cancels, 1);
});

test('audio starts in the click stack, seeks independently and releases at the end', async (t) => {
  const h = harness(t);
  await h.session.play('audio', { audioRate: .75, volume: .4, before: 100, after: 200 });
  const audio = h.media[0];
  assert.equal(audio.src, 'blob:lesson');
  assert.equal(audio.paused, false, 'play is requested before async metadata');
  h.fire(audio, 'loadedmetadata');
  h.fire(audio, 'seeked');
  assert.equal(audio.currentTime, .96); assert.equal(audio.playbackRate, 1); assert.equal(audio.volume, 1);
  assert.equal(h.events.at(-1).state, 'playing');
  audio.currentTime = 1.2; h.fire(audio, 'timeupdate');
  assert.equal(h.session.active, 'audio');
  audio.currentTime = 1.7; h.fire(audio, 'timeupdate');
  assert.equal(h.session.active, ''); assert.equal(audio.paused, true);
  assert.equal(audio.getAttribute('src'), null); assert.equal(h.timers.size, 0);
});

test('stopping before metadata or switching sources cancels all late playback', async (t) => {
  const h = harness(t);
  await h.session.play('audio');
  const audio = h.media[0];
  await h.session.play('standard', { speechRate: .8, pitch: 1.2, volume: .3, voices: { en: 'uk' } });
  h.fire(audio, 'loadedmetadata');
  assert.equal(audio.paused, true);
  const utterance = h.utterances[0];
  assert.equal(utterance.text, 'Hello', 'speak the surface word, never its IPA');
  assert.equal(utterance.lang, 'en-GB'); assert.equal(utterance.voice.voiceURI, 'uk');
  assert.equal(utterance.rate, 1); assert.equal(utterance.pitch, 1); assert.equal(utterance.volume, .5);
  const lateStart = utterance.onstart;
  h.session.stop(); lateStart();
  assert.equal(h.events.at(-1).state, 'idle'); assert.equal(h.cancels, 1); assert.equal(h.timers.size, 0);
});

test('native Blob loading cannot outlive a card and owned URLs are revoked', async (t) => {
  const h = harness(t);
  let resolve;
  const blob = new Promise((done) => { resolve = done; });
  const session = h.api.createPronunciation({ track, sentence, word, getAudioBlob: () => blob });
  const pending = session.play('audio'); session.stop();
  resolve(new h.w.Blob(['test'])); await pending;
  assert.equal(h.media.length, 0); assert.equal(h.revoked.length, 0);
  await session.play('audio');
  assert.equal(h.media.length, 1); assert.match(h.media[0].src, /^blob:owned/);
  session.dispose(); assert.deepEqual(h.revoked, ['blob:owned']);
});

test('a preloaded native Blob starts playback synchronously in the user gesture', async (t) => {
  const h = harness(t);
  const session = h.api.createPronunciation({ track, sentence, word, getAudioBlob: () => new h.w.Blob(['test']) });
  const pending = session.play('audio');
  assert.equal(h.media.length, 1);
  assert.equal(h.media[0].paused, false);
  assert.equal(h.media[0].isConnected, true);
  session.dispose();
  assert.equal(h.media[0].isConnected, false);
  await pending;
});

test('blocked playback, early media end and page departure leave no active playback', async (t) => {
  const h = harness(t);
  const play = h.w.HTMLMediaElement.prototype.play;
  h.w.HTMLMediaElement.prototype.play = () => Promise.reject(Object.assign(Error(), { name: 'NotAllowedError' }));
  await h.session.play('audio');
  h.fire(h.media[0], 'loadedmetadata'); await flush();
  assert.equal(h.events.at(-1).state, 'error'); assert.match(h.events.at(-1).message, /点击/);
  h.w.HTMLMediaElement.prototype.play = play;
  await h.session.play('audio'); h.fire(h.media[1], 'loadedmetadata'); h.fire(h.media[1], 'ended');
  assert.equal(h.session.active, '');
  await h.session.play('standard'); h.fire(h.w, 'pagehide');
  assert.equal(h.session.active, ''); assert.equal(h.timers.size, 0);
});

test('stalled clips time out and reject word timestamps beyond the actual file', async (t) => {
  const h = harness(t);
  await h.session.play('audio');
  h.fire(h.media[0], 'loadedmetadata'); h.fire(h.media[0], 'waiting');
  const watchdog = [...h.timers.values()].find((timer) => timer.delay === 15000);
  assert.ok(watchdog); watchdog.fn();
  assert.equal(h.events.at(-1).state, 'error'); assert.match(h.events.at(-1).message, /超时/);
  assert.equal(h.media[0].paused, true);
  await h.session.play('audio');
  h.media[1]._duration = .99;
  h.fire(h.media[1], 'loadedmetadata');
  assert.equal(h.events.at(-1).state, 'error'); assert.match(h.events.at(-1).message, /超出/);
});

test('word card can pronounce before definitions load and cancels speech when closed', async (t) => {
  const h = harness(t);
  h.api.setTrackPronunciation({ source: 'standard', autoPlay: true });
  const loading = h.api.openWordCard({ track, i: 0, j: 0, lang: 'zh-CN' });
  assert.equal(h.utterances.length, 1, 'autoplay begins within the opening user gesture');
  const button = h.w.document.querySelector('[aria-label="播放标准发音"]');
  assert.equal(button.disabled, false); button.click();
  assert.equal(h.utterances.length, 2); assert.equal(h.cancels, 1);
  h.api.closeWordCard(); await loading;
  assert.equal(h.cancels, 2); assert.equal(h.api.isCardOpen(), false);
});

test('unavailable sources show useful reasons without breaking definitions', async (t) => {
  const h = harness(t, false);
  const missing = { ...track, audioUrl: '', sentences: [{ ...sentence, wordTiming: false }] };
  await h.api.openWordCard({ track: missing, i: 0, j: 0, lang: 'zh-CN' });
  const buttons = h.w.document.querySelectorAll('.wc-sound-source');
  assert.equal(buttons[0].disabled, true); assert.match(buttons[0].title, /补充/);
  assert.equal(buttons[1].disabled, true); assert.match(buttons[1].title, /不支持/);
  assert.equal(h.w.document.getElementById('wordCardTitle').textContent, 'Hello');
  assert.equal(h.w.document.querySelector('.wc-read').textContent, 'həˈləʊ');
  assert.equal(h.w.document.querySelector('[aria-label="停止发音"]'), null);
});

test('settings survive reload, voice lists update asynchronously, reset and detach on close', (t) => {
  const h = harness(t);
  h.api.setPronunciation({ source: 'standard', speechRate: .8, voices: { en: 'uk' } });
  h.api.initSettings();
  assert.equal(h.api.settings.pronunciation.source, 'standard');
  assert.equal(h.api.settings.pronunciation.speechRate, undefined);
  h.voices.length = 0;
  h.api.openPronunciationSheet();
  const row = h.w.document.querySelector('[data-voice-language="en"]');
  assert.match(row.textContent, /自动/);
  assert.equal(h.w.document.querySelectorAll('select, input, .field-hint').length, 0);
  row.click();
  assert.match(h.w.document.querySelector('.voice-empty').textContent, /暂无/);
  h.voices.push({ name: 'British English', lang: 'en-GB', voiceURI: 'uk' });
  h.fire(h.w.speechSynthesis, 'voiceschanged');
  const list = h.w.document.querySelector('.voice-options');
  assert.match(list.textContent, /British English/);
  assert.match(list.querySelector('[aria-checked="true"]').textContent, /British English/);
  list.querySelector('button').click();
  assert.equal(h.api.settings.pronunciation.voices.en, undefined);
  h.api.closeSheet();
  assert.equal(h.w.document.getElementById('sheetTitle').textContent, '发音设置');
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent === '恢复默认').click();
  assert.equal(h.api.settings.pronunciation.source, 'audio');
  h.api.closeSheet(); const options = list.textContent;
  h.voices.length = 0; h.fire(h.w.speechSynthesis, 'voiceschanged');
  assert.equal(list.textContent, options);
});

test('duplicate URIs and identical voice entries remain strictly single selected across refreshes', (t) => {
  const h = harness(t);
  h.voices.splice(0, h.voices.length,
    { name: 'Same', lang: 'en-US', voiceURI: 'shared', localService: true },
    { name: 'Same', lang: 'en-US', voiceURI: 'shared', localService: false },
    { name: 'Same', lang: 'en-US', voiceURI: 'shared', localService: true });
  h.api.setPronunciation({ onlineVoices: true, voices: { en: 'shared' } });
  h.api.openPronunciationSheet(); h.w.document.querySelector('[data-voice-language="en"]').click();
  const radios = () => [...h.w.document.querySelectorAll('[role="radio"]')];
  assert.equal(radios().length, 3, 'one automatic choice plus two distinct voices');
  assert.equal(radios().filter((b) => b.getAttribute('aria-checked') === 'true').length, 1);
  radios()[2].click();
  const saved = h.api.settings.pronunciation.voices.en;
  assert.ok(saved.startsWith('voice:'));
  assert.equal(h.api.speechVoiceKey(h.utterances.at(-1).voice), saved);
  assert.equal(radios().filter((b) => b.getAttribute('aria-checked') === 'true').length, 1);
  h.voices.reverse(); h.fire(h.w.speechSynthesis, 'voiceschanged');
  assert.equal(radios().filter((b) => b.getAttribute('aria-checked') === 'true').length, 1);
  assert.equal(h.api.settings.pronunciation.voices.en, saved);
  h.api.initSettings();
  assert.equal(h.api.settings.pronunciation.voices.en, saved);
});

test('voice selection previews the chosen language, replay does not change selection and close cancels', (t) => {
  const h = harness(t);
  h.api.openPronunciationSheet(); h.w.document.querySelector('[data-voice-language="en"]').click();
  const radios = [...h.w.document.querySelectorAll('[role="radio"]')];
  radios[1].click();
  assert.match(h.utterances.at(-1).text, /Hello/);
  const selected = h.api.settings.pronunciation.voices.en;
  h.w.document.querySelectorAll('.voice-listen')[2].click();
  assert.equal(h.utterances.length, 2);
  assert.equal(h.cancels, 1);
  assert.equal(h.api.settings.pronunciation.voices.en, selected, 'replay previews without selecting');
  const voice = h.utterances.at(-1).voice;
  assert.notEqual(h.api.speechVoiceKey(voice), selected);
  h.api.closeSheet(); assert.equal(h.cancels, 2);
  h.w.document.querySelector('[data-voice-language="ja"]').click();
  h.w.document.querySelectorAll('[role="radio"]')[1].click();
  assert.match(h.utterances.at(-1).text, /こんにちは/);
  assert.equal(h.utterances.at(-1).lang, 'ja-JP');
  h.w.dispatchEvent(new h.w.Event('pagehide'));
  assert.equal(h.cancels, 3);
});

test('late load pause and pre-seek clock events cannot stop a clip before positioning', async (t) => {
  const h = harness(t);
  const playing = h.session.play('audio');
  assert.equal(h.media.length, 1);
  const audio = h.media[0];
  assert.equal(audio.paused, false);
  audio.currentTime = 9; h.fire(audio, 'timeupdate');
  assert.equal(h.session.active, 'audio');
  h.fire(audio, 'loadedmetadata'); h.fire(audio, 'pause'); h.fire(audio, 'seeked');
  assert.equal(h.session.active, 'audio'); assert.equal(h.events.at(-1).state, 'playing');
  await playing;
});

test('balanced speech reads the current cached level synchronously and bypasses it when disabled', async (t) => {
  const h = harness(t);
  let volume = .24;
  const session = h.api.createPronunciation({ track: { ...track, pronunciationLoudness: { volume: () => volume } }, word });
  t.after(() => session.dispose());
  const pending = session.play('standard');
  assert.equal(h.utterances.at(-1).volume, .12, 'calibrated speech remains in the user gesture');
  await pending;
  volume = 0;
  await session.play('standard');
  assert.equal(h.utterances.at(-1).volume, 0);
  await session.play('standard', { volumeBalance: false });
  assert.equal(h.utterances.at(-1).volume, 1);
});

test('volume balance persists, resets to enabled and applies to voice previews', (t) => {
  const h = harness(t);
  const currentTrack = { ...track, pronunciationLoudness: { volume: () => .3 } };
  h.api.openPronunciationSheet({ track: currentTrack });
  const toggle = () => h.w.document.querySelector('[aria-label="音量均衡"]');
  assert.equal(toggle().getAttribute('aria-pressed'), 'true');
  toggle().click(); h.api.initTrackCfg(track.id, track.lang);
  assert.equal(h.api.trackCfg.pronunciation.volumeBalance, false);
  assert.equal(h.api.settings.pronunciation.volumeBalance, true);
  h.w.document.querySelector('[data-voice-language="en"]').click();
  h.w.document.querySelector('.voice-listen').click();
  assert.equal(h.utterances.at(-1).volume, 1);
  h.api.closeSheet();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent === '恢复默认').click();
  assert.equal(toggle().getAttribute('aria-pressed'), 'true');
  h.api.initTrackCfg(track.id, track.lang);
  assert.equal(h.api.trackCfg.pronunciation.volumeBalance, true);
  h.w.document.querySelector('[data-voice-language="en"]').click();
  h.w.document.querySelector('.voice-listen').click();
  assert.equal(h.utterances.at(-1).volume, .15);
});

test('global calibration compares exclusive sample/TTS playback, saves and cleans up on return', async (t) => {
  const h = harness(t);
  const find = (label) => h.w.document.querySelector(`[aria-label="${label}"]`);
  h.api.openPronunciationSheet({ track });
  assert.equal([...h.w.document.querySelectorAll('button')].some((b) => b.textContent.includes('音量校准')), false);
  h.api.closeSheet();
  h.api.setPronunciation({ voices: { en: 'uk' }, volumeBalance: false });
  const prefs = JSON.stringify(h.api.trackCfg.pronunciation);
  h.api.openPronunciationSheet();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent.includes('音量校准')).click();
  assert.equal(h.w.document.getElementById('sheetTitle').textContent, '音量校准');
  find('播放参考音频').click();
  const reference = h.media.at(-1);
  assert.match(reference.src, /assets\/pronunciation-calibration.wav$/);
  assert.equal(reference.volume, 1); assert.equal(reference.paused, false);
  h.fire(reference, 'loadedmetadata'); h.fire(reference, 'seeked');
  assert.equal(reference.currentTime, 0);
  find('试听标准发音').click();
  assert.equal(reference.paused, true); assert.equal(reference.isConnected, false);
  assert.equal(h.utterances.at(-1).text, 'Hello! It is a lovely day.');
  assert.equal(h.utterances.at(-1).voice.voiceURI, 'uk');
  assert.equal(h.utterances.at(-1).volume, .5, 'calibration previews work while balance defaults off');
  find('减小标准发音音量').click();
  assert.equal(h.api.settings.ttsCalibration, .45);
  assert.equal(h.cancels, 1, 'editing stops old speech so replay uses the new gain');
  h.api.initSettings();
  find('试听标准发音').click();
  assert.equal(h.utterances.at(-1).volume, .45);
  find('播放参考音频').click();
  assert.equal(h.cancels, 2);
  assert.equal(h.media.at(-1).volume, 1, 'calibration never attenuates the fixed reference');
  h.api.closeSheet();
  assert.equal(h.media.at(-1).isConnected, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.w.document.getElementById('sheetTitle').textContent, '发音设置');
  assert.equal(JSON.stringify(h.api.trackCfg.pronunciation), prefs);
});

test('global calibration affects existing audio immediately and local resets preserve it', async (t) => {
  const h = harness(t);
  const currentTrack = { ...track, pronunciationLoudness: { volume: () => .8 } };
  const session = h.api.createPronunciation({ track: currentTrack, word });
  t.after(() => session.dispose());
  h.api.setTrackPronunciation({ voices: { en: 'uk' } });
  h.api.setSetting('ttsCalibration', .25);
  await session.play('standard', h.api.trackCfg.pronunciation);
  assert.equal(h.utterances.at(-1).volume, .2);
  h.api.openPronunciationSheet({ track: currentTrack });
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent === '恢复默认').click();
  assert.equal(h.api.settings.ttsCalibration, .25);
  h.api.closeSheet(); h.api.openPronunciationSheet();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent === '恢复默认').click();
  await session.play('standard', h.api.trackCfg.pronunciation);
  assert.equal(h.utterances.at(-1).volume, .4);
  assert.equal(h.api.settings.ttsCalibration, .5);
});

test('calibration reset, unsupported speech, blocked reference and page exit remain usable', async (t) => {
  const h = harness(t, false);
  h.api.setSetting('ttsCalibration', .8);
  h.api.openPronunciationSheet();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent.includes('音量校准')).click();
  const reference = h.w.document.querySelector('[aria-label="播放参考音频"]');
  assert.equal(h.w.document.querySelector('[aria-label="试听标准发音"]').disabled, true);
  assert.match(h.w.document.querySelector('[role="status"]').textContent, /不支持/);
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent === '恢复默认').click();
  assert.equal(h.api.settings.ttsCalibration, .5);
  assert.equal(h.w.document.querySelector('input').value, '50');
  const play = h.w.HTMLMediaElement.prototype.play;
  h.w.HTMLMediaElement.prototype.play = () => Promise.reject(Object.assign(Error(), { name: 'NotAllowedError' }));
  reference.click(); await flush();
  assert.match(h.w.document.querySelector('[role="status"]').textContent, /再次点击/);
  h.w.HTMLMediaElement.prototype.play = play;
  reference.click(); h.fire(h.w, 'pagehide');
  assert.equal(h.media.at(-1).isConnected, false);
  assert.equal(h.timers.size, 0);
});


test('player preferences and word-card source stay with their audio across switching and reload', async (t) => {
  const h = harness(t);
  const globalBefore = JSON.stringify(h.api.settings.pronunciation);
  h.api.openPronunciationSheet({ track });
  const buttons = () => [...h.w.document.querySelectorAll('button')];
  buttons().find((b) => b.textContent === '标准').click();
  h.w.document.querySelector('[aria-label="打开词卡自动发音"]').click();
  h.w.document.querySelector('[data-voice-language="en"]').click();
  h.w.document.querySelectorAll('[role="radio"]')[2].click();
  const voice = h.api.trackCfg.pronunciation.voices.en;
  h.api.closeSheet(); h.api.closeSheet();
  assert.equal(JSON.stringify(h.api.settings.pronunciation), globalBefore);
  h.api.initSettings(); h.api.initTrackCfg(track.id, track.lang);
  const count = h.utterances.length;
  await h.api.openWordCard({ track, i: 0, j: 0, lang: 'zh-CN' });
  assert.equal(h.utterances.length, count + 1);
  assert.equal(h.api.speechVoiceKey(h.utterances.at(-1).voice), voice);
  h.w.document.querySelector('.wc-sound-source').click();
  assert.equal(h.api.trackCfg.pronunciation.source, 'audio');
  h.api.closeWordCard();
  assert.equal(JSON.stringify(h.api.settings.pronunciation), globalBefore);
  assert.equal(h.w.localStorage.getItem('linguatrack.settings.v1'), null);

  const other = { ...track, id: 'other' };
  h.api.initTrackCfg(other.id, other.lang);
  assert.equal(h.api.trackCfg.pronunciation.autoPlay, false);
  assert.equal(h.api.trackCfg.pronunciation.voices.en, undefined);
  await h.api.openWordCard({ track: other, i: 0, j: 0, lang: 'zh-CN' });
  assert.equal(h.utterances.length, count + 1, 'second audio does not inherit autoplay');
  h.api.closeWordCard();
  h.api.initTrackCfg(track.id, track.lang);
  assert.equal(h.api.trackCfg.pronunciation.source, 'audio');
  assert.equal(h.api.trackCfg.pronunciation.autoPlay, true);
  assert.equal(h.api.trackCfg.pronunciation.voices.en, voice);
});

test('track voice migration and reset never modify global defaults or another audio', (t) => {
  const h = harness(t);
  h.api.setPronunciation({ source: 'standard', autoPlay: true, volumeBalance: false, voices: { en: 'uk' } });
  const globalBefore = h.w.localStorage.getItem('linguatrack.settings.v1');
  h.api.initTrackCfg('other', 'en');
  h.api.setTrackPronunciation({ voices: { en: 'us' } });
  const otherBefore = h.w.localStorage.getItem('linguatrack.track.other');
  h.api.initTrackCfg(track.id, track.lang);
  h.api.openPronunciationSheet({ track });
  h.w.document.querySelector('[data-voice-language="en"]').click();
  assert.ok(h.api.trackCfg.pronunciation.voices.en.startsWith('voice:'));
  assert.equal(h.api.settings.pronunciation.voices.en, 'uk');
  h.api.closeSheet();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent === '恢复默认').click();
  assert.equal(JSON.stringify(h.api.trackCfg.pronunciation), JSON.stringify(normalizePronunciation()));
  h.api.initTrackCfg(track.id, track.lang);
  assert.equal(h.api.trackCfg.pronunciation.source, 'audio');
  assert.equal(h.api.trackCfg.pronunciation.autoPlay, false);
  assert.equal(h.api.trackCfg.pronunciation.voices.en, undefined);
  assert.equal(h.w.localStorage.getItem('linguatrack.settings.v1'), globalBefore);
  assert.equal(h.w.localStorage.getItem('linguatrack.track.other'), otherBefore);
});

function iosHarness(t, ipad = false) {
  const h = harness(t);
  Object.defineProperty(h.w.navigator, 'platform', { value: ipad ? 'MacIntel' : 'iPhone' });
  Object.defineProperty(h.w.navigator, 'userAgent', { value: ipad ? 'Macintosh' : 'iPhone OS 18_7_2' });
  Object.defineProperty(h.w.navigator, 'maxTouchPoints', { value: 5 });
  let now = 0;
  h.w.performance.now = () => now;
  h.settleCancel = () => {
    now += 150;
    for (const [id, timer] of [...h.timers]) {
      if (timer.delay <= 150) { h.timers.delete(id); timer.fn(); }
    }
  };
  return h;
}

test('iOS natural completion keeps calibrated volume for repeated speech without cancelling the finished engine', async (t) => {
  const h = iosHarness(t);
  h.api.setSetting('ttsCalibration', .3);
  const currentTrack = { ...track, pronunciationLoudness: { volume: () => .4 } };
  for (let card = 0; card < 3; card++) {
    const session = h.api.createPronunciation({ track: currentTrack, word });
    for (let replay = 0; replay < 3; replay++) {
      const count = h.utterances.length;
      void session.play('standard');
      assert.equal(h.utterances.length, count + 1, 'finished speech can restart in the tap');
      const utterance = h.utterances.at(-1);
      assert.equal(utterance.volume, .12);
      utterance.onstart(); utterance.onend();
      assert.equal(session.active, '');
      assert.equal(h.cancels, 0, 'end must not send an unnecessary native cancel');
      assert.equal(h.timers.size, 0);
    }
    session.dispose();
    assert.equal(h.cancels, 0, 'disposing a finished card leaves the engine idle');
  }
});

test('iOS and iPadOS rapid replay wait for cancellation and only the latest request is spoken', async (t) => {
  for (const ipad of [false, true]) {
    const h = iosHarness(t, ipad);
    await h.session.play('standard');
    const lateStart = h.utterances[0].onstart, lateEnd = h.utterances[0].onend;
    const lateError = h.utterances[0].onerror;
    for (let tap = 0; tap < 5; tap++) await h.session.play('standard');
    assert.equal(h.utterances.length, 1, 'no speak is submitted in the native cancel window');
    assert.equal(h.cancels, 1, 'pending replays are discarded without cancelling the idle engine');
    lateStart(); lateEnd(); lateError({ error: 'interrupted' });
    assert.equal(h.session.active, 'standard');
    h.api.setSetting('ttsCalibration', .2);
    h.settleCancel();
    assert.equal(h.utterances.length, 2);
    assert.equal(h.utterances[1].volume, .2, 'the submitted replay uses the latest global calibration');
    h.utterances[1].onend();
    assert.equal(h.cancels, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('iOS cancellation recovery crosses cards and pending speech cannot survive page exit', async (t) => {
  const h = iosHarness(t);
  await h.session.play('standard');
  h.session.dispose();
  const next = h.api.createPronunciation({ track, word: { text: 'world' } });
  t.after(() => next.dispose());
  await next.play('standard');
  assert.equal(h.utterances.length, 1);
  const lateReplay = [...h.timers.values()].find((timer) => timer.delay <= 150).fn;
  h.fire(h.w, 'pagehide');
  h.settleCancel(); lateReplay();
  assert.equal(h.utterances.length, 1);
  assert.equal(h.cancels, 1);
  assert.equal(h.timers.size, 0);
  await next.play('standard', { volumeBalance: false });
  assert.equal(h.utterances.at(-1).text, 'world');
  assert.equal(h.utterances.at(-1).volume, 1);
});

test('speech errors finish without another cancel; a delayed speak exception releases its timers', async (t) => {
  const h = iosHarness(t);
  await h.session.play('standard');
  h.utterances[0].onerror({ error: 'synthesis-failed' });
  assert.equal(h.events.at(-1).state, 'error');
  assert.equal(h.cancels, 0); assert.equal(h.timers.size, 0);
  await h.session.play('standard');
  await h.session.play('standard');
  h.w.speechSynthesis.speak = () => { throw Error('engine failed'); };
  h.settleCancel();
  assert.equal(h.events.at(-1).state, 'error');
  assert.equal(h.timers.size, 0);
});

function nativeSpeechHarness(t) {
  const h = iosHarness(t), calls = [], cancelled = [], pending = new Map();
  const voices = [{ voiceURI: 'uk', name: 'Native British English', lang: 'en-GB', localService: true }];
  h.w.LinguaNative = { platform: 'ios', speechVoices: voices, speechAudio: {
    speak: (call) => { calls.push(call); return new Promise((resolve, reject) => pending.set(call.id, { resolve, reject })); },
    cancel: async ({ id }) => { cancelled.push(id); pending.get(id)?.reject(Object.assign(Error('cancelled'), { code: 'SPEECH_CANCELLED' })); },
  } };
  return { ...h, calls, cancelled, pending, voices,
    nativeEvent(id) { h.w.dispatchEvent(new h.w.CustomEvent('native-speech-state', { detail: { id, state: 'playing' } })); } };
}

function playbackSessionHarness(h) {
  let type = 'auto';
  const changes = [], submissions = [];
  Object.defineProperty(h.w.navigator, 'audioSession', { configurable: true, value: {
    get type() { return type; },
    set type(value) { type = value; changes.push(value); },
  } });
  const play = h.w.HTMLMediaElement.prototype.play;
  h.w.HTMLMediaElement.prototype.play = function () {
    submissions.push({ source: 'audio', type, volume: this.volume });
    return play.call(this);
  };
  const speak = h.w.speechSynthesis.speak;
  h.w.speechSynthesis.speak = (utterance) => {
    submissions.push({ source: 'standard', type, volume: utterance.volume });
    speak(utterance);
  };
  return { changes, submissions, get type() { return type; } };
}

test('WebClip calibration keeps one playback category and gain across standard/reference alternation', async (t) => {
  const h = iosHarness(t), route = playbackSessionHarness(h);
  h.api.openPronunciationSheet();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent.includes('音量校准')).click();
  const tap = (label) => h.w.document.querySelector(`[aria-label="${label}"]`).click();
  for (const calibration of [.5, .1, .8]) {
    h.api.setSetting('ttsCalibration', calibration);
    for (const label of ['试听标准发音', '播放参考音频', '试听标准发音']) {
      tap(label);
      if (label === '试听标准发音') {
        assert.equal(h.utterances.at(-1).volume, calibration);
        h.utterances.at(-1).onend();
      } else {
        const audio = h.media.at(-1);
        h.fire(audio, 'loadedmetadata'); h.fire(audio, 'seeked'); h.fire(audio, 'ended');
        assert.equal(audio.isConnected, false);
      }
      assert.equal(route.type, 'playback', 'natural end must not reset the category to auto');
    }
  }
  assert.deepEqual(route.changes, ['playback']);
  assert.ok(route.submissions.every((call) => call.type === 'playback'));
  assert.equal(h.cancels, 0); assert.equal(h.timers.size, 0);
  h.api.closeSheet(); assert.equal(route.type, 'playback');
});

test('WebClip word clips do not change the next standard gain or the main media state', async (t) => {
  const h = iosHarness(t), route = playbackSessionHarness(h);
  const main = { volume: .6, muted: false, currentTime: 4, paused: true, playbackRate: 1.5 };
  const before = { ...main };
  const local = { ...track, pronunciationLoudness: { volume: () => .4 * main.volume } };
  const session = h.api.createPronunciation({ track: local, sentence, word });
  t.after(() => session.dispose());
  h.api.setSetting('ttsCalibration', .25);
  for (let i = 0; i < 3; i++) {
    await session.play('standard');
    assert.equal(h.utterances.at(-1).volume, .06); h.utterances.at(-1).onend();
    await session.play('audio');
    const audio = h.media.at(-1);
    h.fire(audio, 'loadedmetadata'); h.fire(audio, 'seeked'); h.fire(audio, 'ended');
    await session.play('standard');
    assert.equal(h.utterances.at(-1).volume, .06); h.utterances.at(-1).onend();
  }
  assert.deepEqual(main, before);
  assert.deepEqual(route.changes, ['playback']);
  assert.ok(route.submissions.every((call) => call.type === 'playback'));
});

test('iOS source switches set playback before cancel recovery and obsolete taps cannot submit', async (t) => {
  const h = iosHarness(t), route = playbackSessionHarness(h);
  await h.session.play('standard');
  await h.session.play('audio');
  await h.session.play('standard');
  assert.equal(h.utterances.length, 1, 'the interrupted Web Speech engine still needs its recovery window');
  assert.equal(h.media.at(-1).isConnected, false);
  assert.equal(route.type, 'playback');
  // Another output may change the category while cancellation is settling.
  // The delayed submission must prepare it again, not rely on the earlier tap.
  h.w.navigator.audioSession.type = 'ambient';
  h.api.setSetting('ttsCalibration', .2); h.settleCancel();
  assert.equal(h.utterances.length, 2); assert.equal(h.utterances.at(-1).volume, .2);
  assert.equal(route.type, 'playback');
  h.w.dispatchEvent(new h.w.Event('pagehide'));
  h.settleCancel();
  assert.equal(h.session.active, ''); assert.equal(h.timers.size, 0);
  assert.deepEqual(route.changes, ['playback', 'ambient', 'playback']);
});

test('absent, restricted or throwing AudioSession APIs do not block reference or speech playback', async (t) => {
  for (const kind of ['absent', 'getter', 'setter', 'ignored']) {
    const h = iosHarness(t);
    if (kind === 'getter') Object.defineProperty(h.w.navigator, 'audioSession', { get() { throw Error('restricted'); } });
    if (kind === 'setter' || kind === 'ignored') Object.defineProperty(h.w.navigator, 'audioSession', { value: {
      get type() { return 'auto'; }, set type(_) { if (kind === 'setter') throw Error('unsupported'); },
    } });
    await h.session.play('audio');
    const audio = h.media.at(-1); h.fire(audio, 'loadedmetadata'); h.fire(audio, 'seeked'); h.fire(audio, 'ended');
    await h.session.play('standard');
    assert.equal(h.utterances.length, 1); h.utterances[0].onend();
    assert.equal(h.session.active, ''); assert.equal(h.events.some((event) => event.state === 'error'), false);
  }
});

test('native iOS calibration preserves its PCM target before and after WebView reference playback', async (t) => {
  const h = nativeSpeechHarness(t), route = playbackSessionHarness(h);
  h.w.LinguaNative.speechLoudness = true;
  h.api.openPronunciationSheet();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent.includes('音量校准')).click();
  const tap = (label) => h.w.document.querySelector(`[aria-label="${label}"]`).click();
  for (const calibration of [.5, .1, .8]) {
    h.api.setSetting('ttsCalibration', calibration);
    tap('试听标准发音');
    const first = h.calls.at(-1); h.pending.get(first.id).resolve(); await flush();
    tap('播放参考音频');
    const audio = h.media.at(-1); h.fire(audio, 'loadedmetadata'); h.fire(audio, 'seeked'); h.fire(audio, 'ended');
    tap('试听标准发音');
    const second = h.calls.at(-1);
    assert.equal(second.targetLufs, first.targetLufs);
    assert.equal(second.volume, first.volume);
    assert.equal(second.targetLufs, -18.13189 + 20 * Math.log10(calibration / .5));
    h.pending.get(second.id).resolve(); await flush();
  }
  assert.equal(h.utterances.length, 0); assert.equal(h.cancelled.length, 0);
  assert.deepEqual(route.changes, ['playback']);
  h.api.closeSheet(); assert.equal(h.timers.size, 0);
});

test('native iOS word-card standard/clip/standard keeps the lesson target and live calibration', async (t) => {
  const h = nativeSpeechHarness(t), route = playbackSessionHarness(h);
  h.w.LinguaNative.speechLoudness = true;
  const local = { ...track, pronunciationLoudness: {
    volume: () => .4, target: (calibration) => -24 + 20 * Math.log10(calibration / .5),
  } };
  const session = h.api.createPronunciation({ track: local, sentence, word });
  t.after(() => session.dispose());
  for (const calibration of [.5, .1, .8]) {
    h.api.setSetting('ttsCalibration', calibration);
    const firstPlay = session.play('standard'), first = h.calls.at(-1);
    h.pending.get(first.id).resolve(); await firstPlay;
    await session.play('audio');
    const audio = h.media.at(-1); h.fire(audio, 'loadedmetadata'); h.fire(audio, 'seeked'); h.fire(audio, 'ended');
    const secondPlay = session.play('standard'), second = h.calls.at(-1);
    assert.equal(second.targetLufs, first.targetLufs); assert.equal(second.volume, first.volume);
    assert.equal(second.targetLufs, local.pronunciationLoudness.target(calibration));
    h.pending.get(second.id).resolve(); await secondPlay;
  }
  assert.equal(h.utterances.length, 0); assert.equal(h.cancelled.length, 0);
  assert.deepEqual(route.changes, ['playback']);
});

test('installed iOS repeats native PCM speech with live calibration and preserves the saved system voice', async (t) => {
  const h = nativeSpeechHarness(t);
  const oldVoice = h.api.speechVoiceKey({ voiceURI: 'uk', lang: 'en-GB', name: 'Old WebKit name', localService: true });
  for (const gain of [.5, .5, .1, .8]) {
    h.api.setSetting('ttsCalibration', gain);
    const play = h.session.play('standard', { voices: { en: oldVoice } });
    const call = h.calls.at(-1);
    assert.equal(call.voiceURI, 'uk'); assert.equal(call.volume, gain);
    assert.equal(call.text, word.text); assert.equal(call.lang, 'en-GB');
    assert.equal(h.utterances.length, 0, 'native playback never enters Web Speech');
    h.nativeEvent(call.id); assert.equal(h.events.at(-1).state, 'playing');
    h.pending.get(call.id).resolve(); await play;
    assert.equal(h.session.active, ''); assert.equal(h.timers.size, 0);
  }
  assert.equal(new Set(h.calls.map((call) => call.id)).size, 4);
  assert.equal(h.cancelled.length, 0);
  delete h.w.SpeechSynthesisUtterance;
  assert.equal(h.api.supportsSpeech(), true);
});

test('native rapid replay cancels only the previous id; late results and page exit cannot restart it', async (t) => {
  const h = nativeSpeechHarness(t);
  const first = h.session.play('standard'), id1 = h.calls[0].id;
  const next = h.session.play('standard'), id2 = h.calls[1].id;
  assert.deepEqual(h.cancelled, [id1]);
  h.nativeEvent(id1); await first;
  assert.equal(h.session.active, 'standard'); assert.equal(h.events.at(-1).state, 'loading');
  h.nativeEvent(id2); assert.equal(h.events.at(-1).state, 'playing');
  h.fire(h.w, 'pagehide'); await next;
  assert.deepEqual(h.cancelled, [id1, id2]);
  h.nativeEvent(id2);
  assert.equal(h.session.active, ''); assert.equal(h.timers.size, 0);
});

test('native PCM errors never fall back to the broken Web Speech volume path', async (t) => {
  const h = nativeSpeechHarness(t);
  const play = h.session.play('standard', { volumeBalance: false });
  const call = h.calls[0]; assert.equal(call.volume, 1);
  h.pending.get(call.id).reject(Error('音色不可用')); await play;
  assert.equal(h.events.at(-1).message, '音色不可用'); assert.equal(h.utterances.length, 0);
  assert.equal(h.timers.size, 0);
  const stalled = h.session.play('standard');
  const watchdog = [...h.timers.values()].find((timer) => timer.delay === 50000);
  watchdog.fn(); await stalled;
  assert.equal(h.events.at(-1).state, 'error'); assert.equal(h.cancelled.length, 1);
});

test('native calibration and voice previews use system voices and retain the upgrade notice', async (t) => {
  const h = nativeSpeechHarness(t);
  h.api.openPronunciationSheet();
  h.w.document.querySelector('[data-voice-language="en"]').click();
  const radios = [...h.w.document.querySelectorAll('[role="radio"]')];
  assert.equal(radios.length, 2, 'automatic plus the native voice, not the browser catalog');
  radios[1].click();
  assert.equal(h.calls.at(-1).voiceURI, 'uk');
  h.api.closeSheet(); await flush();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent.includes('音量校准')).click();
  assert.match(h.w.document.querySelector('.calibration-notice').textContent, /新版 IPA/);
  h.api.setSetting('ttsCalibration', .1);
  h.w.document.querySelector('[aria-label="试听标准发音"]').click();
  assert.equal(h.calls.at(-1).volume, .1);
  assert.equal(h.utterances.length, 0);
  h.api.closeSheet(); await flush();
  assert.equal(h.cancelled.length, 2);
});

test('iOS normalized speech sends a measured target, preserves mute and bypasses normalization when disabled', async (t) => {
  const h = nativeSpeechHarness(t);
  h.w.LinguaNative.speechLoudness = true;
  const local = { ...track, pronunciationLoudness: { target: (calibration) => -24 + 20 * Math.log10(calibration / .5) } };
  const session = h.api.createPronunciation({ track: local, sentence, word });
  t.after(() => session.dispose());
  for (const calibration of [.5, 1, .1]) {
    h.api.setSetting('ttsCalibration', calibration);
    const play = session.play('standard'), call = h.calls.at(-1);
    assert.equal(call.targetLufs, local.pronunciationLoudness.target(calibration));
    assert.equal(call.muted, false);
    h.pending.get(call.id).resolve(); await play;
  }
  local.pronunciationLoudness.target = () => -Infinity;
  const muted = session.play('standard'), call = h.calls.at(-1);
  assert.equal(call.muted, true); assert.equal(call.targetLufs, -100);
  h.pending.get(call.id).resolve(); await muted;
  const unbalanced = session.play('standard', { volumeBalance: false }), full = h.calls.at(-1);
  assert.equal(full.volume, 1); assert.equal('targetLufs' in full, false);
  h.pending.get(full.id).resolve(); await unbalanced;
});

test('iOS calibration defaults to the measured bundled reference instead of a second 50 percent attenuation', async (t) => {
  const h = nativeSpeechHarness(t); h.w.LinguaNative.speechLoudness = true;
  h.api.openPronunciationSheet();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent.includes('音量校准')).click();
  assert.equal(h.w.document.querySelector('.calibration-notice'), null);
  h.w.document.querySelector('[aria-label="试听标准发音"]').click();
  assert.equal(h.calls.at(-1).targetLufs, -18.13189);
  assert.equal(h.calls.at(-1).muted, false);
  h.api.closeSheet(); await flush();
});

test('Android native calibration and repeat playback use the same loudness target and media speech bridge', async (t) => {
  const h = nativeSpeechHarness(t); h.w.LinguaNative.platform = 'android'; h.w.LinguaNative.speechLoudness = true;
  h.api.openPronunciationSheet();
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent.includes('音量校准')).click();
  assert.equal(h.w.document.querySelector('.calibration-notice'), null);
  for (const calibration of [.5, .1, 1]) {
    h.api.setSetting('ttsCalibration', calibration);
    h.w.document.querySelector('[aria-label="试听标准发音"]').click();
    const call = h.calls.at(-1);
    assert.equal(call.targetLufs, -18.13189 + 20 * Math.log10(calibration / .5));
    h.pending.get(call.id).resolve(); await flush();
  }
  assert.equal(h.utterances.length, 0);
  h.api.closeSheet(); await flush();
  delete h.w.LinguaNative.speechAudio; h.w.LinguaNative.speechLoudness = false;
  [...h.w.document.querySelectorAll('button')].find((b) => b.textContent.includes('音量校准')).click();
  assert.match(h.w.document.querySelector('.pronunciation-calibration').textContent, /新版 APK/);
});
