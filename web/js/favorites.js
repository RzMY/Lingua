/** 独立收藏数据层。保留语境快照, 不依赖源文件或模型缓存的生命周期。 */
import { get, values, mutateRecord, updateRecord } from './store.js';
import { hash53 } from './util.js';
import { learningSnapshot, validateLearning, mergeFavoriteContent, readFavoriteContent, favoriteLocation } from './favorite-learning.js';

const clean = (v, max = 12000) => typeof v === 'string' ? v.trim().slice(0, max) : '';
export const favoriteId = (f) => `${f.track}|fav|${f.kind}|${f.sentence}|${f.word}|${hash53(f.text + '\u0001' + f.context)}`;

export function favoriteDraft({ track, i, j = -1, lang = '', meaning = {} }) {
  const sentence = track.sentences[i], word = j >= 0 ? sentence?.words[j] : null;
  if (!sentence || (j >= 0 && (!word || word.pos === 'punct'))) throw new Error('这段内容无法收藏');
  const f = {
    track: track.id, title: clean(track.title, 1000), lang: track.lang,
    kind: word ? 'word' : 'sentence', sentence: i, word: j,
    text: clean(word ? word.text : sentence.text), context: clean(sentence.text),
    start: Math.max(0, word?.start ?? sentence.start ?? 0),
    end: Math.max(0, word?.end ?? sentence.end ?? 0),
    reading: clean(word?.read || meaning.reading, 1000), roman: clean(word?.roman, 1000),
    lemma: clean(word?.lemma, 1000), pos: word ? clean(track.posLabel(word.pos), 100) : '',
    gloss: clean(meaning.gloss), explanation: clean(meaning.note),
    translation: clean(sentence.translation), targetLang: lang,
    note: '', mastered: false, createdAt: Date.now(), updatedAt: Date.now(),
    learning: learningSnapshot(sentence, word, meaning, (pos) => track.posLabel(pos)),
  };
  f.id = favoriteId(f);
  validateFavorite(f);
  return f;
}

/** 备份与写入共用校验, 所有展示字段只接受纯文本。 */
export function validateFavorite(f) {
  const bad = () => { throw new Error('收藏数据格式错误'); };
  if (!f || typeof f !== 'object' || !['word', 'sentence'].includes(f.kind)
    || !/^[\w-]{1,128}$/.test(f.track) || typeof f.lang !== 'string' || !f.lang
    || !Number.isInteger(f.sentence) || f.sentence < 0 || !Number.isInteger(f.word)
    || (f.kind === 'word' ? f.word < 0 : f.word !== -1) || typeof f.mastered !== 'boolean') bad();
  for (const key of ['title', 'text', 'context', 'reading', 'roman', 'lemma', 'pos', 'gloss',
    'explanation', 'translation', 'targetLang', 'note']) {
    if (typeof f[key] !== 'string' || f[key].length > 12000) bad();
  }
  if (!f.text.trim() || f.note.length > 4000) bad();
  for (const key of ['start', 'end', 'createdAt', 'updatedAt']) {
    if (!Number.isFinite(f[key]) || f[key] < 0) bad();
  }
  if (f.end < f.start || f.id !== favoriteId(f)) bad();
  validateLearning(f.learning);
  return f;
}

function changed() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('favoriteschange'));
}
export const getFavorite = (id) => get('favorites', id, { strict: true });
export const listFavorites = () => values('favorites', { strict: true });

export async function saveFavorite(draft) {
  validateFavorite(draft);
  draft = (await readFavoriteContent(draft)).favorite;
  validateFavorite(draft);
  const saved = await mutateRecord('favorites', draft.id, (old) => {
    if (!old) return draft;
    // 再次收藏保留笔记、掌握状态和首次收藏时间, 仅补全最新可用的学习内容。
    return { ...mergeFavoriteContent(old, draft), title: draft.title, updatedAt: Date.now() };
  });
  changed();
  return saved;
}

export async function enrichFavorite(draft) {
  validateFavorite(draft);
  const saved = await updateRecord('favorites', draft.id, (old) => ({ ...mergeFavoriteContent(old, draft), updatedAt: Date.now() }));
  if (saved) changed();
}

export async function editFavorite(id, patch) {
  const saved = await updateRecord('favorites', id, (old) => {
    const next = { ...old, updatedAt: Date.now() };
    if (Object.hasOwn(patch, 'note')) next.note = clean(patch.note, 4000);
    if (Object.hasOwn(patch, 'mastered')) next.mastered = !!patch.mastered;
    return next;
  });
  if (!saved) throw new Error('这条收藏已被移除');
  changed();
  return saved;
}

export async function removeFavorite(id) {
  await mutateRecord('favorites', id, () => null);
  changed();
}

export function filterFavorites(items, { query = '', kind = '', lang = '', status = '', sort = 'new' } = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((f) => (!kind || f.kind === kind) && (!lang || f.lang === lang)
    && (!status || f.mastered === (status === 'mastered'))
    && terms.every((term) => [f.text, f.context, f.reading, f.roman, f.lemma, f.gloss,
      f.translation, f.note, f.title].join('\n').toLocaleLowerCase().includes(term)))
    .sort((a, b) => sort === 'text' ? a.text.localeCompare(b.text)
      : sort === 'old' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
}

export const favoriteSourceURL = (f) => `player.html?track=${encodeURIComponent(f.track)}&favorite=${encodeURIComponent(f.id)}`;

/** 字幕重分析后重新按原文匹配, 避免旧句序定位到不相关内容。 */
export function favoritePosition(f, track) {
  const match = favoriteLocation(f, track);
  if (!match) return null;
  let time = match.s.start;
  if (f.kind === 'word' && match.s.wordTiming) {
    time = match.w?.start ?? time;
  }
  return { sentence: match.i, time };
}
