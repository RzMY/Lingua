/** Per-media, sparse reveal progress. Sentence fingerprints reject stale token indices. */
import { hash53 } from './util.js';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const index = (v) => Number.isSafeInteger(v) && v >= 0;
export const blindWord = (word) => !!word?.text?.trim() && word.pos !== 'punct';

export function normalizeBlindRead(value) {
  const revealed = {};
  if (object(value?.revealed)) for (const [i, row] of Object.entries(value.revealed)) {
    if (!/^(0|[1-9]\d*)$/.test(i) || !Number.isSafeInteger(+i)
      || !object(row) || typeof row.signature !== 'string' || !Array.isArray(row.words)) continue;
    const words = [...new Set(row.words.filter(index))];
    if (words.length) revealed[i] = { signature: row.signature, words };
  }
  const out = { enabled: value?.enabled === true || value?.enabled === 1, revealed };
  const translations = {};
  if (object(value?.translations)) for (const [i, row] of Object.entries(value.translations)) {
    if (!/^(0|[1-9]\d*)$/.test(i) || !Number.isSafeInteger(+i)
      || !object(row) || typeof row.signature !== 'string' || !Array.isArray(row.texts)) continue;
    const texts = [...new Set(row.texts.filter((text) => typeof text === 'string' && text.length))];
    if (texts.length) translations[i] = { signature: row.signature, texts };
  }
  if (Object.keys(translations).length) out.translations = translations;
  return out;
}

export class BlindReadProgress {
  constructor(track, saved) {
    this.track = track;
    this.rows = new Map();
    this.signatures = new Map();
    this.translations = new Map();
    const progress = normalizeBlindRead(saved);
    for (const [key, row] of Object.entries(progress.revealed)) {
      const i = +key, sentence = track.sentences[i];
      if (!sentence || row.signature !== this.signature(i)) continue;
      const words = new Set(row.words.filter((j) => blindWord(sentence.words[j])));
      if (words.size) this.rows.set(i, words);
    }
    for (const [key, row] of Object.entries(progress.translations || {})) {
      const i = +key;
      if (track.sentences[i] && row.signature === this.signature(i)) {
        this.translations.set(i, new Set(row.texts));
      }
    }
  }

  signature(i) {
    if (!this.signatures.has(i)) {
      const s = this.track.sentences[i];
      this.signatures.set(i, String(hash53(JSON.stringify([s.start, s.end, s.text,
        s.words.map((w) => [w.text, w.read || '', w.roman || ''])]))));
    }
    return this.signatures.get(i);
  }

  has(i, j) { return this.rows.get(i)?.has(j) || false; }

  reveal(i, j) {
    if (!blindWord(this.track.sentences[i]?.words[j]) || this.has(i, j)) return false;
    if (!this.rows.has(i)) this.rows.set(i, new Set());
    this.signature(i);
    this.rows.get(i).add(j);
    return true;
  }

  translationHash(i) {
    const s = this.track.sentences[i];
    return String(hash53(JSON.stringify([s.translationLang || '', s.translation])));
  }

  hasTranslation(i) {
    return !!this.track.sentences[i]?.translation?.trim()
      && (this.translations.get(i)?.has(this.translationHash(i)) || false);
  }

  revealTranslation(i) {
    if (!this.track.sentences[i]?.translation?.trim() || this.hasTranslation(i)) return false;
    if (!this.translations.has(i)) this.translations.set(i, new Set());
    this.signature(i);
    this.translations.get(i).add(this.translationHash(i));
    return true;
  }

  revealSentence(i) {
    const sentence = this.track.sentences[i];
    if (!sentence) return false;
    let changed = false;
    sentence.words.forEach((_, j) => { if (this.reveal(i, j)) changed = true; });
    return this.revealTranslation(i) || changed;
  }

  hideSentence(i) {
    const words = this.rows.delete(i);
    // Clear every saved translation of this sentence so changing language cannot reveal it again.
    const translations = this.translations.delete(i);
    return words || translations;
  }

  snapshot(enabled) {
    const revealed = {};
    for (const [i, words] of this.rows) {
      revealed[i] = { signature: this.signature(i), words: [...words].sort((a, b) => a - b) };
    }
    const out = { enabled: !!enabled, revealed };
    if (this.translations.size) {
      out.translations = {};
      for (const [i, texts] of this.translations) {
        out.translations[i] = { signature: this.signature(i), texts: [...texts] };
      }
    }
    return out;
  }
}
