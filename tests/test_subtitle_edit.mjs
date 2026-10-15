import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { Track } from '../web/js/track.js';
import { plainTrack } from '../web/js/subtitles.js';
import { prepareSubtitleEdit, saveSubtitleEdit, subtitleEditDefaults } from '../web/js/subtitle-edit.js';
import { createTranslator, translationKey, cachedTranslation } from '../web/js/translate.js';
import { getTrack, trackData, transcriptBlob } from '../web/js/library.js';
import { put } from '../web/js/store.js';
import { config } from '../web/js/config.js';

const lesson = (id = 'edit') => Track.fromData({ id, title: 'Lesson', schemaVersion: 2,
  lang: { code: 'en', features: ['tr', 'read', 'roman', 'pos', 'card'], layers: { read: 'IPA' } },
  hasWordTiming: true, audio: { duration: 12 }, sentences: [
    { i: 0, text: 'Hello.', start: 1, end: 4, wordTiming: true,
      words: [{ text: 'Hello', pos: 'noun', start: 1, end: 4, read: 'old' }] },
    { i: 1, text: 'Bye.', start: 6, end: 10, wordTiming: true,
      words: [{ text: 'Bye', pos: 'noun', start: 6, end: 10 }] },
  ] });
const values = (extra = {}) => ({ text: 'Corrected text.', translation: '修正译文', lang: 'zh-CN',
  reanalyze: false, retranslate: false, ...extra });
const reply = (text) => Response.json({ choices: [{ message: { content: JSON.stringify({ 1: text }) } }] });
const flush = () => new Promise((r) => setImmediate(r));
beforeEach(() => Object.assign(config, { baseUrl: 'https://model.example', model: 'test', apiKey: '',
  jsonMode: 1, timeout: 10, concurrency: 1 }));

test('edit defaults use per-sentence analysis and the selected translation language, even when hidden', async () => {
  const track = lesson('defaults');
  assert.deepEqual(await subtitleEditDefaults(track, 0, 'zh-CN'),
    { text: 'Hello.', translation: '', reanalyze: true, retranslate: false });
  await put('tr', translationKey(track.id, 'zh-CN', 'Hello.'), '你好', track.id);
  assert.equal((await subtitleEditDefaults(track, 0, 'zh-CN')).retranslate, true);
  track.sentences[0].translation = '你好'; track.sentences[0].translationLang = 'zh-CN';
  assert.equal((await subtitleEditDefaults(track, 0, 'fr')).retranslate, false);
  track.sentences[0].analyzed = false;
  assert.equal((await subtitleEditDefaults(track, 0, 'zh-CN')).reanalyze, false);
  const plain = Track.fromData(plainTrack({ id: 'plain', lang: 'en' }, [{ text: 'Hello.', start: 0, end: 2 }]));
  assert.equal((await subtitleEditDefaults(plain, 0, 'zh-CN')).reanalyze, false);
});

test('offline source editing persists only the changed sentence, translation and reusable timing source', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No network allowed'); });
  const track = lesson('persist');
  await put('tracks', track.id, { id: track.id, title: 'Lesson', position: 7, audio: { name: 'a.mp3' } });
  const snapshot = structuredClone(track.raw);
  const prepared = await prepareSubtitleEdit(track, 0, values());
  assert.deepEqual(track.raw, snapshot, 'preparation must not mutate the live track');
  assert.equal(prepared.data.sentences[0].wordTiming, false);
  assert.equal(prepared.data.sentences[0].analyzed, false);
  assert.equal(prepared.data.sentences[0].words.map((w) => w.text).join(''), 'Corrected text.');
  assert.equal(prepared.data.sentences[0].words.some((w) => w.read || w.start), false);
  await saveSubtitleEdit(track, prepared);
  const data = await trackData(track.id);
  assert.equal(data.sentences[0].translations['zh-CN'], '修正译文');
  assert.deepEqual(data.sentences[1].words, snapshot.sentences[1].words);
  assert.equal((await getTrack(track.id)).position, 7);
  assert.equal(await cachedTranslation(track.id, 'zh-CN', 'Corrected text.'), '修正译文');
  const source = JSON.parse(await (await transcriptBlob(track.id)).text());
  assert.deepEqual(source.segments[0], { text: 'Corrected text.', start: 1, end: 4 });
  assert.deepEqual(source.segments[1].words, [{ text: 'Bye', start: 6, end: 10 }]);
  const reopened = Track.fromData(data);
  assert.equal(reopened.N, 1);
  assert.equal((await subtitleEditDefaults(reopened, 0, 'zh-CN')).reanalyze, false);
});

test('translation-only edits preserve analysis and the original subtitle file', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No network allowed'); });
  const track = lesson('translation-only');
  track.sentences[1].translation = 'Au revoir';
  track.sentences[1].translationLang = 'fr';
  await put('tracks', track.id, { id: track.id, transcript: { name: 'original.vtt' } });
  await put('transcripts', track.id, new Blob(['original']));
  const prepared = await prepareSubtitleEdit(track, 0, values({ text: 'Hello.', translation: '' }));
  await saveSubtitleEdit(track, prepared);
  assert.deepEqual(prepared.data.sentences[0].words, track.sentences[0].words);
  assert.equal((await getTrack(track.id)).transcript.name, 'original.vtt');
  assert.equal(await (await transcriptBlob(track.id)).text(), 'original');
  assert.equal((await subtitleEditDefaults(Track.fromData(prepared.data), 0, 'zh-CN')).retranslate, false);
  assert.equal(prepared.data.sentences[1].translations.fr, 'Au revoir');
});

test('analyzing one plain cue enables analysis layers without marking neighboring cues analyzed', async (t) => {
  const track = Track.fromData(plainTrack({ id: 'mixed', lang: 'en' }, [
    { text: 'Hello.', start: 0, end: 3 }, { text: 'Bye.', start: 4, end: 6 },
  ]));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ track: {
    lang: lesson().raw.lang, sentences: [{ text: 'Hello.', wordTiming: false,
      words: [{ text: 'Hello.', read: 'hello', pos: 'noun' }] }],
  } }));
  const prepared = await prepareSubtitleEdit(track, 0, values({ text: 'Hello.', reanalyze: true }));
  const updated = Track.fromData(prepared.data);
  assert.equal(updated.supports('read'), true);
  assert.equal(updated.raw.subtitleMode, 'analyzed');
  assert.equal((await subtitleEditDefaults(updated, 0, 'zh-CN')).reanalyze, true);
  assert.equal((await subtitleEditDefaults(updated, 1, 'zh-CN')).reanalyze, false);
});

test('reanalyze and retranslate request only the edited sentence, bypass old translations and preserve boundaries', async (t) => {
  const track = lesson('regenerate'), requests = [];
  await put('tr', translationKey(track.id, 'zh-CN', 'Corrected text.'), '旧缓存', track.id);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(String(url));
    if (String(url).includes('/api/analyze')) {
      const params = new URL(String(url), 'https://localhost').searchParams;
      assert.equal(params.get('split'), '0'); assert.equal(params.get('estimate'), '0');
      assert.deepEqual(JSON.parse(await init.body.text()).segments,
        [{ start: 1, end: 4, text: 'Corrected text.' }]);
      return Response.json({ track: { lang: track.raw.lang, posLegend: { verb: { label: '动词' } },
        sentences: [{ i: 0, start: 1, end: 4, text: 'Corrected text.', wordTiming: false,
          words: [{ text: 'Corrected', pos: 'verb', read: 'new' }, { text: 'text.', pos: 'noun' }] }] } });
    }
    const prompt = JSON.parse(init.body).messages.at(-1).content;
    assert.match(prompt, /1\. Corrected text\./);
    assert.doesNotMatch(prompt, /2\. Bye/);
    return reply('重新生成的译文');
  });
  const result = await prepareSubtitleEdit(track, 0, values({ reanalyze: true, retranslate: true }));
  assert.equal(requests.length, 2);
  assert.equal(result.translation, '重新生成的译文');
  assert.equal(result.data.sentences[0].analyzed, true);
  assert.equal(result.data.sentences[0].words[0].read, 'new');
  assert.deepEqual(result.data.sentences.map((s) => [s.i, s.start, s.end]), [[0, 1, 4], [1, 6, 10]]);
  assert.equal(await cachedTranslation(track.id, 'zh-CN', 'Corrected text.'), '旧缓存', 'no write before commit');
});

test('validation, failed analysis, failed translation and cancellation leave saved/live content untouched', async (t) => {
  const track = lesson('failed'), snapshot = structuredClone(track.raw);
  await put('tracks', track.id, { id: track.id }); await put('data', track.id, snapshot);
  await assert.rejects(prepareSubtitleEdit(track, 0, values({ text: '  ' })), /不能为空/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ track: { sentences: [] } }));
  await assert.rejects(prepareSubtitleEdit(track, 0, values({ reanalyze: true })), /单句分析/);
  t.mock.method(globalThis, 'fetch', async () => reply(''));
  await assert.rejects(prepareSubtitleEdit(track, 0, values({ retranslate: true })), /未收到本句译文/);
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(prepareSubtitleEdit(track, 0, values(), { signal: ctl.signal }), { name: 'AbortError' });
  assert.deepEqual(track.raw, snapshot); assert.deepEqual(await trackData(track.id), snapshot);
});

test('authored translations and intentional blanks survive reload, cached duplicates and language changes', async (t) => {
  const frames = [], applied = [];
  globalThis.requestAnimationFrame = (cb) => frames.push(cb);
  t.after(() => { delete globalThis.requestAnimationFrame; });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No network allowed'); });
  const track = lesson('authored');
  track.sentences[0].translations = { 'zh-CN': '人工译文', fr: 'Bonjour' };
  track.sentences[1].translations = { 'zh-CN': '', fr: '' };
  const tr = createTranslator(track, { onApply: (batch) => applied.push([...batch]) });
  tr.setEnabled(true, 'zh-CN'); tr.want(0, 1); await flush();
  frames.splice(0).forEach((cb) => cb());
  assert.deepEqual(applied.pop(), [[0, '人工译文'], [1, '']]);
  assert.equal(tr.stats().done, 2);
  tr.setEnabled(true, 'fr'); await tr.sweep(); frames.splice(0).forEach((cb) => cb());
  assert.deepEqual(applied.pop(), [[0, 'Bonjour'], [1, '']]);
  tr.stop();
});

test('stopping an in-flight translator prevents late rendering and cache overwrite after editing', async (t) => {
  const frames = [], applied = [];
  globalThis.requestAnimationFrame = (cb) => frames.push(cb);
  t.after(() => { delete globalThis.requestAnimationFrame; });
  let respond;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { respond = resolve; }));
  const track = lesson('stopped');
  const tr = createTranslator(track, { onApply: (batch) => applied.push(batch) });
  tr.setEnabled(true, 'zh-CN'); tr.want(0, 0);
  for (let i = 0; i < 10 && !respond; i++) await flush();
  assert.ok(respond); tr.stop();
  await put('tr', translationKey(track.id, 'zh-CN', 'Hello.'), '新译文', track.id);
  respond(reply('过期结果')); await flush(); await flush();
  frames.splice(0).forEach((cb) => cb());
  assert.equal(applied.length, 0);
  assert.equal(await cachedTranslation(track.id, 'zh-CN', 'Hello.'), '新译文');
});
