import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { normalizePronunciation } from '../web/js/pronunciation-config.js';
import { wordAudioRange, selectSpeechVoice } from '../web/js/pronunciation.js';

const { outputFiles } = await build({ stdin: { contents: `
  export * from './web/js/pronunciation.js';
  export * from './web/js/settings.js';
  export * from './web/js/card.js';
  export * from './web/js/pronunciation-settings.js';
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
  const events = [];
  const session = api.createPronunciation({ track, sentence, word, onState: (event) => events.push(event) });
  t.after(() => { session.dispose(); api.closeWordCard(); api.closeSheet(); });
  const fire = (target, type) => target.dispatchEvent(new w.Event(type));
  return { w, api, media, utterances, revoked, timers, voices, events, session, fire, get cancels() { return cancels; } };
}

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
  for (const key of ['before', 'after', 'volume', 'pitch', 'speechRate', 'audioRate']) assert.equal(key in prefs, false);
  assert.deepEqual(prefs.voices, { 'en-us': 'us' });
  const voices = [{ lang: 'en-US', voiceURI: 'us' }, { lang: 'en-GB', voiceURI: 'uk' }, { lang: 'ja', voiceURI: 'ja' }];
  assert.equal(selectSpeechVoice('en', 'uk', voices), voices[1]);
  assert.equal(selectSpeechVoice('en_GB', 'missing', voices), voices[1]);
  assert.equal(selectSpeechVoice('en', 'ja', voices), voices[0]);
  assert.equal(selectSpeechVoice('ko', '', voices), null);
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
  assert.equal(utterance.rate, 1); assert.equal(utterance.pitch, 1); assert.equal(utterance.volume, 1);
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
  h.api.setPronunciation({ source: 'standard', autoPlay: true });
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
  h.api.setPronunciation({ voices: { en: 'shared' } });
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
