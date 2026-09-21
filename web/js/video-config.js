/** Per-video preferences, stored in the existing track config and user-data backup. */
export const VIDEO_DEFAULTS = Object.freeze({
  fit: 'contain', subtitles: 1, position: 0, width: 96, height: 55,
  transparency: 15, blur: 10, captionSize: 20, volume: 100, muted: 0,
});
export const VIDEO_RANGES = Object.freeze({
  position: [0, 100], width: [50, 100], height: [25, 75], transparency: [0, 100], blur: [0, 30], volume: [0, 100],
  captionSize: [12, 36],
});

export function normalizeVideo(value) {
  const out = { ...VIDEO_DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  if (['contain', 'cover'].includes(value.fit)) out.fit = value.fit;
  for (const key of ['subtitles', 'muted']) {
    if ([0, 1, false, true].includes(value[key])) out[key] = value[key] ? 1 : 0;
  }
  for (const [key, [min, max]] of Object.entries(VIDEO_RANGES)) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) {
      out[key] = Math.max(min, Math.min(max, Math.round(value[key])));
    }
  }
  return out;
}

/** Keep only explicit overrides so untouched fields keep inheriting global defaults. */
export function videoOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = normalizeVideo(value);
  return Object.fromEntries(Object.keys(VIDEO_DEFAULTS).filter((key) =>
    Object.hasOwn(value, key) && (key in VIDEO_RANGES
      ? typeof value[key] === 'number' && Number.isFinite(value[key])
      : key === 'fit' ? ['contain', 'cover'].includes(value[key])
        : [0, 1, false, true].includes(value[key]))).map((key) => [key, normalized[key]]));
}
