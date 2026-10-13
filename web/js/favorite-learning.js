/** 收藏的学习快照与现有缓存。只读取已有内容, 不触发模型请求。 */
import { get } from './store.js';
import { hash53 } from './util.js';
import { Track } from './track.js';

const clean = (value, max = 12000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];
const WORD_FIELDS = ['text', 'reading', 'roman', 'lemma', 'lemmaRoman', 'pos', 'conj', 'parts', 'posDetail'];
const INFO_FIELDS = ['conj', 'parts', 'lemmaRoman', 'posDetail'];

function wordInfo(w, posLabel) {
  return { text: clean(w.text), reading: clean(w.read), roman: clean(w.roman), lemma: clean(w.lemma),
    lemmaRoman: clean(w.lemmaRoman), pos: clean(posLabel(w.pos)), conj: clean(w.conj),
    parts: clean(list(w.parts, 100).map((part) => clean(part.text)).filter(Boolean).join(' + ')),
    posDetail: clean(w.posDetail) };
}

export function learningSnapshot(sentence, word, meaning, posLabel) {
  const info = word ? wordInfo(word, posLabel) : {};
  return {
    ...Object.fromEntries(INFO_FIELDS.map((key) => [key, info[key] || ''])),
    forms: list(meaning?.forms, 20).map((form) => ({
      text: clean(typeof form === 'string' ? form : form?.text), gloss: clean(form?.gloss),
    })).filter((form) => form.text),
    words: word ? [] : list(sentence.words, 300).filter((w) => w.pos !== 'punct').map((w) => wordInfo(w, posLabel)),
    explanations: [],
  };
}

export function mergeLearning(old = {}, fresh = {}) {
  const merged = { ...old };
  for (const key of [...INFO_FIELDS, 'forms', 'words', 'explanations']) {
    if (fresh[key]?.length) merged[key] = fresh[key];
  }
  return merged;
}

export function validateLearning(value) {
  if (value === undefined) return; // 兼容未包含学习快照的旧收藏与备份。
  const bad = () => { throw new Error('收藏学习数据格式错误'); };
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v, keys) => obj(v) && keys.every((key) => typeof v[key] === 'string' && v[key].length <= 12000);
  if (!obj(value)) bad();
  for (const key of INFO_FIELDS) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 12000)) bad();
  for (const [key, max, fields] of [['forms', 20, ['text', 'gloss']], ['words', 300, WORD_FIELDS],
    ['explanations', 12, ['question', 'answer']]]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > max
      || !value[key].every((item) => strings(item, fields)))) bad();
  }
}

export const favoriteWordKey = (track, lang, i, j, word, text) =>
  `${track}|${lang}|${i}|${j}|${hash53(word + '\u0001' + text)}`;

export function favoriteLocation(f, track) {
  const matches = track.sentences.map((s, i) => ({ s, i })).filter(({ s }) => clean(s.text) === f.context);
  matches.sort((a, b) => Math.abs(a.s.start - f.start) - Math.abs(b.s.start - f.start));
  const match = matches.find(({ i }) => i === f.sentence) || matches[0];
  if (!match) return null;
  const words = match.s.words || [];
  const j = f.kind !== 'word' ? -1 : words[f.word]?.text === f.text ? f.word : words.findIndex((w) => w.text === f.text);
  return { ...match, j, w: j >= 0 ? words[j] : null };
}

function explanationSnapshot(chat, text) {
  // 新缓存显式记录原句；旧缓存的首轮用户模板也必须包含当前原句。
  const msgs = Array.isArray(chat?.msgs) ? chat.msgs : [];
  if (chat?.text !== undefined ? chat.text !== text : !msgs[0]?.content?.includes(text)) return [];
  let question = '';
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'user') question = i === 0 ? '' : clean(m.content);
    else if (m.role === 'assistant' && clean(m.content)) out.push({ question, answer: clean(m.content) });
  }
  return out.slice(-12);
}

export function mergeFavoriteContent(old, fresh) {
  const next = { ...old };
  for (const key of ['reading', 'roman', 'lemma', 'pos', 'gloss', 'explanation', 'translation']) {
    if (fresh[key]) next[key] = fresh[key];
  }
  if (fresh.gloss || fresh.translation) next.targetLang = fresh.targetLang;
  if (fresh.learning) next.learning = mergeLearning(old.learning, fresh.learning);
  return next;
}

export async function readFavoriteContent(f) {
  const data = await get('data', f.track);
  const track = data ? Track.fromData(data) : null;
  const location = track ? favoriteLocation(f, track) : null;
  const i = location?.i ?? f.sentence, j = location?.j ?? f.word;
  const [meaning, chat, translation] = await Promise.all([
    f.kind === 'word' && j >= 0 ? get('word', favoriteWordKey(f.track, f.targetLang, i, j, f.text, f.context)) : null,
    location ? get('chat', `${f.track}|${i}`) : null,
    get('tr', `${f.track}|${f.targetLang}|${hash53(f.context)}`),
  ]);
  const s = location?.s || { words: [] }, w = location?.w;
  const learning = learningSnapshot(s, f.kind === 'word' ? (w || {}) : null, meaning || {}, (pos) => track?.posLabel(pos) || pos || '');
  learning.explanations = explanationSnapshot(chat, f.context);
  const fresh = { reading: clean(w?.read || meaning?.reading), roman: clean(w?.roman), lemma: clean(w?.lemma),
    pos: clean(meaning?.pos || (w && track.posLabel(w.pos))), gloss: clean(meaning?.gloss), explanation: clean(meaning?.note),
    translation: clean(translation || s.translation), targetLang: f.targetLang, learning };
  return { favorite: mergeFavoriteContent(f, fresh), track, location };
}
