import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { BACKUP_FORMAT, BACKUP_VERSION, BACKUP_STORES, GLOBAL_KEYS,
  exportBackup, parseBackup, prepareImport, applyLocalData, importBackup } from '../web/js/backup.js';
import { STORES, snapshot, writeBatch, put, get, del } from '../web/js/store.js';
import { matchFiles, missingFiles, removeTrack, saveAnalysis } from '../web/js/library.js';

const empty = () => Object.fromEntries(BACKUP_STORES.map((name) => [name, []]));
const row = (key, value, track = key.split('|')[0]) => ({ key, value, track, at: 1234 });

function fixture(id = 'lesson') {
  const stores = empty();
  stores.tracks.push(row(id, { id, title: 'Lesson', lang: 'en', status: 'ready',
    audio: { name: 'lesson.wav' }, transcript: { name: 'lesson.srt' },
    duration: 1, createdAt: '2026-09-08T00:00:00.000Z' }));
  stores.data.push(row(id, { schemaVersion: 2, id, title: 'Lesson',
    lang: { code: 'en', layers: { read: 'IPA' }, features: ['read', 'tr', 'pos', 'card'] },
    audio: { duration: 1 }, sentences: [{ i: 0, start: 0, end: 1, text: 'Hello.', wordTiming: true,
      words: [{ text: 'Hello', pos: 'interj', read: 'hello', start: 0, end: 1 }] }] }));
  stores.tr.push(row(id + '|zh-CN|hash', 'Translation'));
  stores.word.push(row(id + '|zh-CN|0|0|hash', { gloss: 'Greeting', forms: [] }));
  stores.chat.push(row(id + '|0', { msgs: [{ role: 'user', content: 'Explain' },
    { role: 'assistant', content: '## Explanation\nHello' }], at: 123 }));
  stores.kv.push(row(id + '|progress', { done: [0], total: 1 }));
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: '2026-09-08T00:00:00.000Z',
    includesCredentials: true, stores, localStorage: {
      [GLOBAL_KEYS[0]]: JSON.stringify({ apiKey: 'model-secret', apiToken: 'backend-secret', asrApiKey: 'asr-secret',
        model: 'test-model', prompts: { explain: 'Custom prompt {{src}}' }, langs: { en: { read: 0 } } }),
      [GLOBAL_KEYS[1]]: JSON.stringify({ size: 120, theme: 'dark', rate: 1.5, track: id }),
      [GLOBAL_KEYS[2]]: JSON.stringify([{ code: 'en', layers: { read: 'IPA' } }]),
      ['linguatrack.track.' + id]: JSON.stringify({ tr: 1, read: 0, lang: 'zh-CN' }),
    } };
}

function storage() {
  const bag = new Map();
  return { get length() { return bag.size; }, key: (i) => [...bag.keys()][i] ?? null,
    getItem: (k) => bag.get(k) ?? null, setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k), clear: () => bag.clear() };
}

beforeEach(async () => {
  globalThis.localStorage = storage();
  const all = await snapshot(STORES);
  for (const [name, rows] of Object.entries(all)) for (const r of rows) await del(name, r.key);
});

async function seed(backup) {
  await writeBatch(backup.stores);
  for (const [key, value] of Object.entries(backup.localStorage)) localStorage.setItem(key, value);
}

test('export includes every data store and saved configuration, but only source filenames', async () => {
  const original = fixture();
  original.stores.tracks[0].value.audio = { name: 'C:\\audio\\lesson.wav', size: 500, type: 'audio/wav' };
  original.stores.tracks[0].value.transcript = { name: '/subtitles/lesson.srt', at: 'yesterday' };
  original.stores.data[0].value.audio.src = 'blob:private-resource';
  await seed(original);
  await put('audio', 'lesson', new Blob(['AUDIO_SECRET']), 'lesson');
  await put('transcripts', 'lesson', new Blob(['SUBTITLE_SECRET']), 'lesson');
  localStorage.setItem('other-app.secret', 'unrelated');
  const backup = parseBackup(JSON.stringify(await exportBackup()));
  assert.deepEqual(backup.stores.tracks[0].value.audio, { name: 'lesson.wav' });
  assert.deepEqual(backup.stores.tracks[0].value.transcript, { name: 'lesson.srt' });
  assert.deepEqual(backup.stores.data[0].value.audio, { duration: 1 });
  assert.deepEqual(backup.localStorage, original.localStorage);
  for (const name of ['tr', 'word', 'chat', 'kv']) {
    assert.deepEqual(backup.stores[name][0].value, original.stores[name][0].value);
  }
  const text = JSON.stringify(backup);
  for (const excluded of ['AUDIO_SECRET', 'SUBTITLE_SECRET', 'private-resource', 'other-app']) {
    assert.ok(!text.includes(excluded));
  }
  assert.equal((await get('data', 'lesson')).audio.src, 'blob:private-resource');
});

test('fresh restore retains analysis and all LLM outputs and records both missing files', async () => {
  const backup = fixture();
  const plan = prepareImport(backup, empty(), {});
  await writeBatch(plan.batches, { beforeCommit: () => applyLocalData(plan.changes) });
  assert.equal(plan.copies, 0);
  assert.equal((await get('tracks', 'lesson')).status, 'ready');
  assert.equal(missingFiles([await get('tracks', 'lesson')]).length, 2);
  assert.deepEqual((await exportBackup()).stores.data[0].value, backup.stores.data[0].value);
  assert.deepEqual((await exportBackup()).localStorage, backup.localStorage);
});

test('independent subtitle fonts survive backup restore and reject invalid sizes', async () => {
  const backup = fixture();
  const fonts = { textSize: 32, readSize: 18.5, romanSize: 15, trSize: 24 };
  backup.localStorage[GLOBAL_KEYS[1]] = JSON.stringify(fonts);
  await seed(backup);
  const exported = parseBackup(JSON.stringify(await exportBackup()));
  const plan = prepareImport(exported, empty(), {});
  applyLocalData(plan.changes);
  assert.deepEqual(JSON.parse(localStorage.getItem(GLOBAL_KEYS[1])), { ...fonts, track: '' });
  for (const key of Object.keys(fonts)) {
    for (const value of [0, -1, null, '24px', {}, []]) {
      backup.localStorage[GLOBAL_KEYS[1]] = JSON.stringify({ ...fonts, [key]: value });
      assert.throws(() => parseBackup(JSON.stringify(backup)), /\u5b57\u53f7/);
    }
  }
});

test('language and audio font settings survive backups and audio ID remapping', async () => {
  const backup = fixture();
  const language = { fonts: { ja: { textSize: 32 }, en: { readSize: 18.5 } } };
  const audio = { read: 0, lang: 'zh-CN', fonts: { textSize: 40, trSize: 24 } };
  backup.localStorage[GLOBAL_KEYS[1]] = JSON.stringify(language);
  backup.localStorage['linguatrack.track.lesson'] = JSON.stringify(audio);
  await seed(backup);
  const exported = parseBackup(JSON.stringify(await exportBackup()));
  const plan = prepareImport(exported, await snapshot(BACKUP_STORES), backup.localStorage);
  const copyId = plan.batches.tracks[0].key;
  assert.notEqual(copyId, 'lesson');
  applyLocalData(plan.changes);
  assert.deepEqual(JSON.parse(localStorage.getItem('linguatrack.track.' + copyId)), audio);
  assert.deepEqual(JSON.parse(localStorage.getItem(GLOBAL_KEYS[1])).fonts, language.fonts);

  for (const invalid of [null, [], 'large', { textSize: -1 }, { readSize: '24px' }]) {
    backup.localStorage[GLOBAL_KEYS[1]] = JSON.stringify({ fonts: { ja: invalid } });
    assert.throws(() => parseBackup(JSON.stringify(backup)), /字号/);
    backup.localStorage[GLOBAL_KEYS[1]] = JSON.stringify(language);
    backup.localStorage['linguatrack.track.lesson'] = JSON.stringify({ ...audio, fonts: invalid });
    assert.throws(() => parseBackup(JSON.stringify(backup)), /字号/);
    backup.localStorage['linguatrack.track.lesson'] = JSON.stringify(audio);
  }
});

test('conflicting IDs copy all dependent data, including legacy rows without a track index', async () => {
  const backup = fixture();
  backup.stores.tracks[0].track = '';
  backup.stores.data[0].track = '';
  await seed(fixture());
  const plan = prepareImport(backup, await snapshot(BACKUP_STORES), fixture().localStorage);
  assert.equal(plan.mapping.get('lesson'), 'lesson-2');
  assert.equal(plan.copies, 1);
  await writeBatch(plan.batches, { addOnly: true, beforeCommit: () => applyLocalData(plan.changes) });
  assert.equal((await get('tracks', 'lesson')).audio.missing, undefined);
  assert.equal((await get('tracks', 'lesson-2')).audio.missing, true);
  assert.equal((await get('data', 'lesson-2')).id, 'lesson-2');
  for (const name of ['tr', 'word', 'chat', 'kv']) {
    const source = backup.stores[name][0];
    assert.deepEqual(await get(name, 'lesson-2' + source.key.slice(6)), source.value);
  }
  assert.equal(JSON.parse(localStorage.getItem(GLOBAL_KEYS[1])).track, 'lesson-2');
  assert.equal(localStorage.getItem('linguatrack.track.lesson-2'), backup.localStorage['linguatrack.track.lesson']);
  await removeTrack('lesson-2');
  assert.equal(await get('tr', 'lesson-2|zh-CN|hash'), undefined);
  assert.equal(await get('tr', 'lesson|zh-CN|hash'), 'Translation');
});

test('allocated copy IDs do not collide with other incoming IDs or orphan caches', () => {
  const backup = fixture();
  const second = fixture('lesson-2');
  for (const name of BACKUP_STORES) backup.stores[name].push(...second.stores[name]);
  const current = empty();
  current.word.push(row('lesson|orphan', { gloss: 'old' }));
  const plan = prepareImport(backup, current, {});
  assert.equal(plan.mapping.get('lesson'), 'lesson-3');
  assert.equal(plan.mapping.get('lesson-2'), 'lesson-2');
  assert.equal(new Set(plan.batches.tracks.map((r) => r.key)).size, 2);
});

test('credentials can be excluded without erasing destination secrets or mutating source config', async () => {
  await seed(fixture());
  const backup = await exportBackup({ includeCredentials: false });
  assert.ok(!JSON.stringify(backup).includes('model-secret'));
  assert.ok(!JSON.stringify(backup).includes('backend-secret'));
  assert.ok(!JSON.stringify(backup).includes('asr-secret'));
  assert.equal(JSON.parse(localStorage.getItem(GLOBAL_KEYS[0])).apiKey, 'model-secret');
  const plan = prepareImport(backup, empty(), { [GLOBAL_KEYS[0]]: JSON.stringify({ apiKey: 'keep-key', apiToken: 'keep-token', asrApiKey: 'keep-asr-key' }) });
  const cfg = JSON.parse(plan.changes.get(GLOBAL_KEYS[0]));
  assert.equal(cfg.apiKey, 'keep-key');
  assert.equal(cfg.apiToken, 'keep-token');
  assert.equal(cfg.asrApiKey, 'keep-asr-key');
  assert.equal(cfg.model, 'test-model');
});

test('global configuration can be kept while track configuration still follows imported tracks', () => {
  const plan = prepareImport(fixture(), empty(), {}, { restoreConfig: false });
  assert.deepEqual([...plan.changes.keys()], ['linguatrack.track.lesson']);
});

test('backups without saved global overrides restore built-in defaults', () => {
  const backup = fixture();
  for (const key of GLOBAL_KEYS) delete backup.localStorage[key];
  const plan = prepareImport(backup, empty(), fixture().localStorage);
  for (const key of GLOBAL_KEYS) assert.equal(plan.changes.get(key), null);
});

test('invalid, future, mismatched and malicious archives fail before changing storage', () => {
  const invalid = [
    (b) => { b.version = 99; },
    (b) => { b.stores.data[0].value.schemaVersion = 99; },
    (b) => { b.stores.data = []; },
    (b) => { b.stores.data[0].value.id = 'different'; },
    (b) => { b.stores.data[0].value.sentences[0].words[0].end = 4; },
    (b) => { b.stores.tr.push(b.stores.tr[0]); },
    (b) => { b.stores.audio = []; },
    (b) => { b.stores.tr[0].track = 'another'; },
    (b) => { b.stores.tracks[0].value.audio.content = 'binary'; },
    (b) => { b.localStorage['another-app.config'] = '{}'; },
    (b) => { b.localStorage[GLOBAL_KEYS[0]] = '{"model":{}}'; },
    (b) => { b.localStorage[GLOBAL_KEYS[0]] = '{"langs":{"__proto__":{"tr":1}}}'; },
    (b) => { b.localStorage[GLOBAL_KEYS[2]] = '[{"code": 123}]'; },
    (b) => { b.stores.chat[0].value.msgs[0].content = {}; },
  ];
  for (const mutate of invalid) {
    const backup = fixture();
    mutate(backup);
    assert.throws(() => parseBackup(JSON.stringify(backup)), /备份无效/);
  }
  assert.throws(() => parseBackup('{broken'), /JSON/);
  assert.equal(localStorage.length, 0);
  assert.equal(Object.prototype.tr, undefined);
});

test('configuration quota failure rolls back every modified key and the batch', async () => {
  localStorage.setItem(GLOBAL_KEYS[0], 'old-config');
  localStorage.setItem('another-app.key', 'untouched');
  const set = localStorage.setItem;
  let failed = false;
  localStorage.setItem = (key, value) => {
    if (key === GLOBAL_KEYS[1] && !failed) { failed = true; throw new Error('QuotaExceededError'); }
    set(key, value);
  };
  const plan = prepareImport(fixture(), empty(), {});
  await assert.rejects(writeBatch(plan.batches, { beforeCommit: () => applyLocalData(plan.changes) }), /Quota/);
  assert.equal(await get('tracks', 'lesson'), undefined);
  assert.equal(localStorage.getItem(GLOBAL_KEYS[0]), 'old-config');
  assert.equal(localStorage.getItem(GLOBAL_KEYS[1]), null);
  assert.equal(localStorage.getItem('another-app.key'), 'untouched');
});

test('an insert collision rejects the whole batch and leaves configuration untouched', async () => {
  await put('chat', 'lesson|0', { msgs: [] }, 'lesson');
  const plan = prepareImport(fixture(), empty(), {});
  await assert.rejects(writeBatch(plan.batches, { addOnly: true, beforeCommit: () => applyLocalData(plan.changes) }));
  assert.equal(await get('tracks', 'lesson'), undefined);
  assert.equal(localStorage.length, 0);
});

test('import explicitly refuses transient in-memory storage', async () => {
  await assert.rejects(importBackup(fixture()), /持久存储不可用/);
  assert.equal(await get('tracks', 'lesson'), undefined);
});

test('batch filename matching leaves duplicate and renamed files for explicit selection', () => {
  const record = fixture().stores.tracks[0].value;
  record.audio.missing = true;
  record.transcript.missing = true;
  const wav = new File(['audio'], 'lesson.wav');
  const sub = new File(['subtitle'], 'lesson.srt');
  assert.equal(matchFiles([record], [wav, sub]).matches.length, 2);
  assert.deepEqual(matchFiles([record], [wav, wav]).ambiguous, ['lesson.wav']);
  assert.deepEqual(matchFiles([record, { ...record, id: 'other' }], [wav]).ambiguous, ['lesson.wav']);
  assert.deepEqual(matchFiles([record], [new File(['x'], 'renamed.wav')]).unmatched, ['renamed.wav']);
  record.audio.missing = false;
  assert.equal(matchFiles([record], [wav, sub]).matches.length, 1);
});

test('new analysis persists subtitle bytes and deleting a track removes them without clearing another track', async () => {
  await put('tracks', 'lesson', { id: 'lesson', duration: 1 }, 'lesson');
  await put('transcripts', 'other', new Blob(['keep']), 'other');
  const file = new File(['1\n00:00:00,000 --> 00:00:01,000\nHello.'], 'lesson.srt');
  const record = await saveAnalysis('lesson', fixture().stores.data[0].value, { transcriptName: file.name, transcriptFile: file });
  assert.equal(record.transcript.missing, false);
  assert.equal(await (await get('transcripts', 'lesson')).text(), await file.text());
  await removeTrack('lesson');
  assert.equal(await get('transcripts', 'lesson'), undefined);
  assert.equal(await (await get('transcripts', 'other')).text(), 'keep');
});
