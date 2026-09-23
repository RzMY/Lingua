/** Local subtitle decoding only: no tokenizer, linguistic analysis, or network requests. */
import { sourceSpec } from './langs.js';

const textOf = (value) => String(value?.text ?? value?.word ?? value?.value ?? '');
const numberOf = (value, keys) => {
  for (const key of keys) {
    if (value?.[key] !== null && value?.[key] !== '' && value?.[key] !== undefined) return Number(value[key]);
  }
  return NaN;
};
const startOf = (v) => numberOf(v, ['start', 'start_time', 'startTime', 's', 'from']);
const endOf = (v) => numberOf(v, ['end', 'end_time', 'endTime', 'e', 'to']);
const clean = (text) => text.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '')
  .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (s) =>
    ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[s]).trim();

function timestamp(value) {
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  return parts.reduce((n, p) => n * 60 + p, 0);
}

export function parseSubtitles(text, name = '') {
  let rows = [];
  if (/\.json$/i.test(name)) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('字幕 JSON 格式无效，请检查文件内容'); }
    const list = Array.isArray(data) ? data : ['segments', 'sentences', 'chunks', 'result', 'results', 'words']
      .map((key) => data?.[key]).find(Array.isArray);
    if (!list) throw new Error('字幕 JSON 缺少带时间戳的句子或单词');
    rows = list.filter((v) => v && typeof v === 'object').map((v) => ({
      start: startOf(v), end: endOf(v),
      text: clean(textOf(v) || (v.words || []).map(textOf).join(' ')),
    }));
  } else {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[i])) {
        while (i + 1 < lines.length && lines[i + 1].trim()) i++;
        continue;
      }
      const match = lines[i].match(/^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d+)/);
      if (!match) continue;
      const content = [];
      while (i + 1 < lines.length && lines[i + 1].trim()) content.push(lines[++i]);
      rows.push({ start: timestamp(match[1]), end: timestamp(match[2]), text: clean(content.join(' ')) });
    }
  }
  rows = rows.filter((s) => s.text && Number.isFinite(s.start) && Number.isFinite(s.end)
    && s.start >= 0 && s.end > s.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const row of rows) {
    const previous = out.at(-1);
    if (previous && previous.start === row.start) {
      previous.text += '\n' + row.text;
      previous.end = Math.max(previous.end, row.end);
      continue;
    }
    if (previous && previous.end > row.start) previous.end = row.start;
    out.push({ ...row });
  }
  if (!out.length) throw new Error('字幕缺少有效时间戳，请检查 JSON、SRT 或 VTT 文件');
  return out;
}

export function plainTrack(record, rows = []) {
  const spec = sourceSpec(record.lang);
  // These are display fragments, not analyzed words. Preserve spaces and CJK wrapping.
  const sentences = rows.map((s, i) => ({ ...s, i, wordTiming: false,
    words: (s.text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\s]+\s*|\s+/gu) || [])
      .map((text) => ({ text, pos: 'other' })),
  }));
  return { schemaVersion: 2, id: record.id, title: record.title,
    generator: 'lingua-subtitles/1', subtitleMode: 'plain',
    lang: { ...spec, features: ['text'], layers: {}, layerOrder: [], spaceDelimited: false },
    audio: { duration: record.duration || rows.at(-1)?.end || 0 }, hasWordTiming: false,
    stats: { sentences: sentences.length, words: 0 }, posLegend: {}, sentences };
}

export async function subtitleTrack(record, file) {
  if (file.size > 64 * 1024 * 1024) throw new Error('字幕文件不能超过 64 MiB');
  return plainTrack(record, parseSubtitles(await file.text(), file.name));
}
