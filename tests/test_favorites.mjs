import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeIndexedDB } from './idb_fake.mjs';
import { Track } from '../web/js/track.js';

const fake = createFakeIndexedDB();
fake.version = 4;
for (const name of ['tr', 'word', 'chat', 'kv', 'tracks', 'audio', 'audioChunks', 'data', 'transcripts']) fake.data.set(name, new Map());
fake.data.get('tracks').set('legacy', { v: { id: 'legacy', title: '旧媒体' }, track: 'legacy' });
globalThis.indexedDB = fake;
globalThis.IDBKeyRange = { bound: (lo, hi) => ({ includes: (key) => key >= lo && key <= hi }) };
globalThis.localStorage = { length: 0, getItem: () => null };
const store = await import('../web/js/store.js');
const fav = await import('../web/js/favorites.js');
const learning = await import('../web/js/favorite-learning.js');
const backup = await import('../web/js/backup.js');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

function track(id) {
  return Track.fromData({ id, title: 'Morning lesson', lang: { code: 'en' },
    sentences: [{ text: 'Keep going.', start: 1, end: 4, wordTiming: true,
      words: [{ text: 'Keep', read: 'kiːp', pos: 'verb', start: 1, end: 2 }, { text: 'going', pos: 'verb', start: 2, end: 4 }] },
    { text: 'Keep going.', start: 5, end: 8, words: [{ text: 'Keep', pos: 'verb' }] }] });
}
const draft = (id, extra = {}) => fav.favoriteDraft({ track: track(id), i: 0, j: 0, lang: 'zh-CN', ...extra });

test('v4 upgrades add favorites without changing existing media records', async () => {
  assert.equal(fake.data.has('favorites'), false);
  assert.deepEqual(await fav.listFavorites(), []);
  assert.equal(fake.version, 6);
  assert.equal((await store.get('tracks', 'legacy')).title, '旧媒体');
  await store.del('tracks', 'legacy');
});

test('concurrent duplicate saves preserve notes and mastery; different source occurrences remain distinct', async () => {
  const f = draft('dedup');
  await Promise.all([fav.saveFavorite(f), fav.saveFavorite(f)]);
  await Promise.all([fav.editFavorite(f.id, { note: 'Keep at it!' }), fav.editFavorite(f.id, { mastered: true })]);
  await fav.saveFavorite(draft('dedup', { meaning: { gloss: '保持', note: '继续做某事' } }));
  const saved = await fav.getFavorite(f.id);
  assert.equal(saved.createdAt, f.createdAt);
  assert.equal(saved.note, 'Keep at it!'); assert.equal(saved.mastered, true); assert.equal(saved.gloss, '保持');
  await fav.saveFavorite(draft('dedup', { i: 1 }));
  await fav.saveFavorite(draft('dedup', { j: -1 }));
  assert.equal((await fav.listFavorites()).filter((f) => f.track === 'dedup').length, 3);
});

test('late word meaning fills an existing favorite but never resurrects a removed one', async () => {
  const f = draft('meaning'); await fav.saveFavorite(f);
  await fav.editFavorite(f.id, { note: 'my note', mastered: true });
  const enriched = draft('meaning', { meaning: { gloss: '坚持', note: '用于鼓励' } });
  await fav.enrichFavorite(enriched);
  assert.equal((await fav.getFavorite(f.id)).gloss, '坚持');
  assert.equal((await fav.getFavorite(f.id)).note, 'my note');
  await fav.removeFavorite(f.id); await fav.enrichFavorite(enriched);
  assert.equal(await fav.getFavorite(f.id), undefined);
  await assert.rejects(fav.editFavorite(f.id, { note: 'late edit' }), /已被移除/);
});

test('saving waits for commit and rejected writes and deletes leave durable content intact', async () => {
  const f = draft('commit'); await fav.saveFavorite(f);
  fake.holdCommit = (tx) => tx.names.includes('favorites');
  let completed = false;
  const saving = fav.editFavorite(f.id, { note: 'unsaved' });
  const rejected = assert.rejects(saving, /quota/);
  saving.then(() => { completed = true; }, () => {});
  await flush(); assert.equal(completed, false);
  const tx = fake.stalledCommits.pop(); assert.ok(tx);
  tx.abortWith(new Error('quota')); fake.holdCommit = null;
  await rejected;
  assert.equal((await fav.getFavorite(f.id)).note, '');
  fake.holdCommit = (tx) => tx.names.includes('favorites');
  const deleting = assert.rejects(fav.removeFavorite(f.id), /quota/);
  await flush(); fake.stalledCommits.pop().abortWith(new Error('quota')); fake.holdCommit = null;
  await deleting; assert.ok(await fav.getFavorite(f.id));
});

test('removing source media and clearing model caches preserve favorite snapshots', async () => {
  const f = draft('independent'); await fav.saveFavorite(f);
  await store.put('tracks', f.track, { id: f.track }, f.track);
  await store.put('word', f.track + '|meaning', { gloss: 'cached' }, f.track);
  await store.clearAll(); await store.wipeTrackAll(f.track);
  assert.equal(await store.get('tracks', f.track), undefined);
  assert.equal((await fav.getFavorite(f.id)).context, 'Keep going.');
});

test('search combines context, reading, notes and source with type, language and mastery filters', () => {
  const a = { ...draft('search'), note: '鼓励', mastered: true, createdAt: 10 };
  const b = { ...draft('search', { j: -1 }), createdAt: 20 };
  assert.deepEqual(fav.filterFavorites([a, b], { query: 'KEEP 鼓励', kind: 'word', status: 'mastered', lang: 'en' }), [a]);
  assert.deepEqual(fav.filterFavorites([a, b], { status: 'pending' }), [b]);
  assert.deepEqual(fav.filterFavorites([a, b], { query: 'kiːp' }), [a]);
  assert.deepEqual(fav.filterFavorites([a, b]), [b, a]);
});

test('source navigation rematches reanalysed sentences and preserves seeks close to the beginning', () => {
  const f = draft('position');
  assert.deepEqual(fav.favoritePosition(f, track('position')), { sentence: 0, time: 1 });
  const shifted = track('position'); shifted.sentences.unshift({ text: 'Intro.', start: 0, words: [] });
  assert.deepEqual(fav.favoritePosition(f, shifted), { sentence: 1, time: 1 });
  assert.equal(fav.favoritePosition(f, { sentences: [] }), null);
  assert.ok(fav.favoriteSourceURL(f).includes(encodeURIComponent(f.id)));
});

test('learning snapshots retain cached forms, breakdown and explanations after source deletion', async () => {
  const t = track('learning');
  t.sentences[0].words[1].lemma = 'go';
  t.sentences[0].words[1].conj = '现在分词';
  await store.put('data', t.id, t.raw, t.id);
  const word = fav.favoriteDraft({ track: t, i: 0, j: 0, lang: 'zh-CN' });
  await store.put('word', learning.favoriteWordKey(t.id, 'zh-CN', 0, 0, word.text, word.context),
    { gloss: '坚持', forms: [{ text: 'keep going', gloss: '继续前进' }], note: '用于鼓励' }, t.id);
  await store.put('chat', `${t.id}|0`, { text: 'Keep going.', msgs: [
    { role: 'user', content: '解释 Keep going.' }, { role: 'assistant', content: '**祈使句**：省略主语。' },
    { role: 'user', content: 'going 是什么形式？' }, { role: 'assistant', content: '现在分词。' },
  ] }, t.id);
  const sentence = fav.favoriteDraft({ track: t, i: 0, lang: 'zh-CN' });
  await fav.saveFavorite(word); await fav.saveFavorite(sentence);
  await store.wipeTrackAll(t.id);
  const savedWord = (await learning.readFavoriteContent(await fav.getFavorite(word.id))).favorite;
  assert.deepEqual(savedWord.learning.forms, [{ text: 'keep going', gloss: '继续前进' }]);
  assert.equal(savedWord.learning.explanations[1].question, 'going 是什么形式？');
  const savedSentence = await fav.getFavorite(sentence.id);
  assert.equal(savedSentence.learning.words[1].lemma, 'go');
  assert.equal(savedSentence.learning.words[1].conj, '现在分词');
  assert.equal(savedSentence.learning.explanations.length, 2);
  await fav.editFavorite(word.id, { note: '我的笔记', mastered: true });
  await fav.enrichFavorite({ ...savedWord, learning: { forms: [{ text: 'keep at it', gloss: '坚持' }] } });
  const enriched = await fav.getFavorite(word.id);
  assert.equal(enriched.note, '我的笔记'); assert.equal(enriched.mastered, true);
  assert.equal(enriched.learning.explanations.length, 2);
});

test('old favorites hydrate at rematched positions without attaching stale sentence explanations', async () => {
  const t = track('learning-rematch'), f = fav.favoriteDraft({ track: t, i: 0, j: 0, lang: 'zh-CN' });
  delete f.learning;
  const shifted = track(t.id); shifted.sentences.unshift({ text: 'Intro.', start: 0, end: 1, words: [] });
  await store.put('data', t.id, shifted.raw, t.id);
  await store.put('word', learning.favoriteWordKey(t.id, 'zh-CN', 1, 0, f.text, f.context),
    { forms: ['keep on'], gloss: '继续' }, t.id);
  await store.put('chat', `${t.id}|1`, { text: 'An unrelated sentence.', msgs: [{ role: 'assistant', content: '错误讲解' }] }, t.id);
  const content = await learning.readFavoriteContent(f);
  assert.equal(content.location.i, 1);
  assert.equal(content.favorite.gloss, '继续');
  assert.deepEqual(content.favorite.learning.forms, [{ text: 'keep on', gloss: '' }]);
  assert.equal(content.favorite.learning.explanations, undefined);
  assert.equal(content.favorite.id, f.id);
  assert.throws(() => fav.validateFavorite({ ...f, learning: { forms: [{ text: {}, gloss: '' }] } }), /收藏学习数据/);
  await store.wipeTrackAll(t.id);
});

test('backups round-trip independent favorites and remap their IDs and source track together', async () => {
  const exported = await backup.exportBackup({ includeCredentials: false });
  const parsed = backup.parseBackup(JSON.stringify(exported));
  assert.ok(parsed.stores.favorites.length > 0);
  assert.equal(parsed.version, 2);
  const current = await store.snapshot(backup.BACKUP_STORES);
  const plan = backup.prepareImport(parsed, current, {});
  const original = parsed.stores.favorites[0], imported = plan.batches.favorites[0];
  assert.notEqual(imported.value.track, original.value.track);
  assert.equal(imported.key, fav.favoriteId(imported.value));
  assert.equal(imported.track, imported.value.track);
  assert.equal(imported.value.note, original.value.note);
  assert.equal(imported.value.mastered, original.value.mastered);
  assert.deepEqual(imported.value.learning, original.value.learning);
  await store.writeBatch(plan.batches, { addOnly: true });
  assert.deepEqual(await fav.getFavorite(imported.key), imported.value);
  const legacy = structuredClone(exported); legacy.version = 1; delete legacy.stores.favorites;
  assert.equal(backup.parseBackup(JSON.stringify(legacy)).version, 1);
  assert.equal(backup.prepareImport(legacy, current, {}).batches.favorites.length, 0);
  const corrupt = structuredClone(exported); corrupt.stores.favorites[0].value.mastered = 'yes';
  assert.throws(() => backup.parseBackup(JSON.stringify(corrupt)), /收藏数据/);
  const wrongKey = structuredClone(exported); wrongKey.stores.favorites[0].key += '-forged';
  assert.throws(() => backup.parseBackup(JSON.stringify(wrongKey)), /收藏关联/);
});
