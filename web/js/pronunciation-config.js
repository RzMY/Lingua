/** 发音偏好与存档校验; 不依赖浏览器的音频或语音实现。 */
export const PRONUNCIATION_DEFAULTS = Object.freeze({
  source: 'audio', autoPlay: false, volumeBalance: true,
});

export const speechLanguage = (value) => String(value || '').trim().replaceAll('_', '-').toLowerCase();

export function normalizePronunciation(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = { ...PRONUNCIATION_DEFAULTS, voices: {} };
  if (['audio', 'standard'].includes(src.source)) out.source = src.source;
  out.autoPlay = src.autoPlay === true || src.autoPlay === 1;
  out.volumeBalance = src.volumeBalance !== false && src.volumeBalance !== 0;
  if (src.voices && typeof src.voices === 'object' && !Array.isArray(src.voices)) {
    for (const [code, uri] of Object.entries(src.voices)) {
      const lang = speechLanguage(code);
      if (/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(lang) && typeof uri === 'string' && uri.length <= 4096 && uri) {
        out.voices[lang] = uri;
      }
    }
  }
  return out;
}
