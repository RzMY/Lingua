/** Supertonic 3 Unicode frontend, adapted from Supertone's MIT browser example.
 * https://github.com/supertone-oss-archive/supertonic/blob/1e9799e964ea4c0dad7cde993b65c3c813a7b373/web/helper.js
 * NFKD is part of the model contract: Korean syllables and Japanese dakuten decompose.
 */
export function supertonicText(text, lang) {
  if (!['ja', 'ko'].includes(lang)) throw Error('此语音包不支持当前语言');
  let value = text.normalize('NFKD')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[–‑—]/g, '-').replace(/[_\[\]|/#→←]/g, ' ')
    .replace(/[“”]/g, '"').replace(/[‘’´`]/g, "'").replace(/[♥☆♡©\\]/g, '')
    .replaceAll('@', ' at ').replaceAll('e.g.,', 'for example, ').replaceAll('i.e.,', 'that is, ')
    .replace(/\s+([,.!?;:'])/g, '$1').replace(/"{2,}/g, '"').replace(/'{2,}/g, "'")
    .replace(/\s+/g, ' ').trim();
  if (!value) throw Error('没有可合成的发音文字');
  // Literal tags in lesson text must never select model language or expression controls.
  value = value.replaceAll('<', ' ').replaceAll('>', ' ').replace(/\s+/g, ' ').trim();
  if (!value) throw Error('没有可合成的发音文字');
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(value)) value += '.';
  return `<${lang}>${value}</${lang}>`;
}

export function supertonicIds(text, lang, indexer) {
  const characters = Array.from(supertonicText(text, lang));
  const ids = characters.map((character) => indexer[character.codePointAt(0)]);
  if (ids.some((id) => !Number.isInteger(id) || id < 0)) throw Error('语音包不支持文本中的部分字符，请修改后重试');
  return BigInt64Array.from(ids, BigInt);
}

/** Bound CJK runs and keep explicit combining marks with their base character. */
export function supertonicChunks(text, max = 120) {
  const parts = String(text).trim().match(/[^。！？!?\n]+[。！？!?]?|[。！？!?]/gu) || [];
  const chunks = [];
  for (const part of parts) {
    const chars = Array.from(part.trim());
    for (let at = 0; at < chars.length;) {
      let end = Math.min(at + max, chars.length);
      while (end < chars.length && /\p{Mark}/u.test(chars[end])) end++;
      chunks.push(chars.slice(at, end).join('')); at = end;
    }
  }
  if (!chunks.length) throw Error('没有可合成的发音文字');
  return chunks;
}
