/** Single-sentence edits: prepare privately, then commit text, analysis and translation together. */
import { analyze } from './api.js';
import { saveAnalysis } from './library.js';
import { plainSentence } from './subtitles.js';
import { cachedTranslation, translateSentence, translationKey } from './translate.js';

export const sentenceAnalyzed = (track, s) => s.analyzed ?? (track.raw.subtitleMode !== 'plain');

export async function subtitleEditDefaults(track, i, lang) {
  const s = track.sentences[i];
  if (!s) throw new Error('字幕不存在，请重新选择');
  const translation = Object.hasOwn(s.translations || {}, lang) ? s.translations[lang]
    : ((!s.translationLang || s.translationLang === lang) && s.translation)
      || await cachedTranslation(track.id, lang, s.text);
  return { text: s.text, translation, hasAnalysis: sentenceAnalyzed(track, s),
    reanalyze: false, retranslate: false };
}

/** Keep sentence boundaries and genuine word timing in the editable subtitle source. */
export function editedTranscript(data) {
  return new File([JSON.stringify({ language: data.lang.code, segments: data.sentences.map((s) => ({
    start: s.start, end: s.end, text: s.text,
    ...(s.wordTiming ? { words: s.words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
      .map(({ text, start, end }) => ({ text, start, end })) } : {}),
  })) })], 'subtitles.edited.json', { type: 'application/json' });
}

export async function prepareSubtitleEdit(track, i, values, { signal, onStage = () => {} } = {}) {
  const previous = track.sentences[i];
  const text = String(values.text || '').trim();
  if (!previous || !text) throw new Error('字幕原文不能为空');
  const changed = text !== previous.text;
  const reanalyze = !!values.reanalyze || (changed && sentenceAnalyzed(track, previous));
  let sentence = changed ? plainSentence({ ...previous, text }) : { ...previous };
  sentence.analyzed = changed ? false : sentenceAnalyzed(track, previous);
  let analyzed;
  if (reanalyze) {
    onStage('正在重新分析本句…');
    const response = await analyze(editedTranscript({ lang: { code: track.lang }, sentences: [sentence] }), {
      lang: track.lang, id: track.id, title: track.title, duration: track.duration,
      split: false, merge: true, estimate: false,
    }, { signal });
    analyzed = response.track;
    const fresh = analyzed?.sentences?.[0];
    if (analyzed?.sentences?.length !== 1 || !fresh?.words?.length) {
      throw new Error('未收到有效的单句分析结果，请重试');
    }
    sentence = { ...sentence, ...fresh, text, i, start: previous.start, end: previous.end, analyzed: true };
  }
  let translation = String(values.translation || '').trim();
  if (values.retranslate) {
    onStage('正在重新翻译本句…');
    translation = await translateSentence(track, i, text, values.lang, { signal });
  }
  signal?.throwIfAborted();
  // Authored translations belong to the subtitle data, including intentional empty values.
  sentence.translations = { ...(changed ? {} : previous.translations), [values.lang]: translation };
  const data = { ...track.raw, sentences: track.sentences.map((s, at) => {
    const { translation: _live, translationLang: _lang, ...saved } = at === i ? sentence : s;
    // Preserve pre-existing translations with their language when the live view is serialized.
    if (at !== i && _live) saved.translations = {
      [_lang || values.lang]: _live, ...saved.translations,
    };
    return { ...saved, analyzed: at === i ? sentence.analyzed : sentenceAnalyzed(track, s) };
  }) };
  const hasAnalysis = data.sentences.some((s) => s.analyzed);
  data.subtitleMode = hasAnalysis ? 'analyzed' : 'plain';
  if (analyzed && track.raw.subtitleMode === 'plain') data.lang = analyzed.lang;
  // Translation can also be edited/generated for locally imported, unanalyzed subtitles.
  data.lang = { ...data.lang, features: [...new Set([...(data.lang.features || []), 'tr'])] };
  data.posLegend = { ...data.posLegend, ...analyzed?.posLegend };
  data.hasWordTiming = data.sentences.some((s) => s.wordTiming);
  data.stats = { sentences: data.sentences.length,
    words: data.sentences.reduce((n, s) => n + (s.analyzed ? s.words.length : 0), 0) };
  return { data, translation, lang: values.lang, text, sourceChanged: changed || reanalyze };
}

export async function saveSubtitleEdit(track, prepared) {
  const { data, translation, lang, text, sourceChanged } = prepared;
  const transcriptFile = sourceChanged ? editedTranscript(data) : null;
  return saveAnalysis(track.id, data, {
    transcriptFile, transcriptName: transcriptFile?.name,
    translations: [{ key: translationKey(track.id, lang, text), value: translation, track: track.id }],
  });
}
