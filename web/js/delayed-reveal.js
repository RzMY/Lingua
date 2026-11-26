/** Reveal state is derived from the media clock, never accumulated or persisted. */
import { blindWord } from './blind-read.js';

export class DelayedRevealProgress {
  constructor(track) {
    this.track = track;
    this.time = 0;
    this.rows = new Map();
  }

  setTime(time) { this.time = Number.isFinite(time) ? time : 0; }

  row(i) {
    if (!this.rows.has(i)) {
      const s = this.track.sentences[i];
      const ends = s.words.map((word) => {
        if (!blindWord(word)) return Infinity;
        // Untimed words wait for the sentence end; do not invent word alignment.
        const end = s.wordTiming && Number.isFinite(word.start) && Number.isFinite(word.end)
          && word.end >= word.start ? word.end : s.end;
        return Math.max(s.start, Math.min(s.end, end));
      });
      const boundaries = ends.filter(Number.isFinite);
      const end = boundaries.length ? Math.max(...boundaries) : s.end;
      // Short sentences get a proportionately short lead, always after their start.
      const translation = end - Math.min(0.5, Math.max(0, end - s.start) * 0.1);
      boundaries.push(translation);
      this.rows.set(i, { ends, translation, boundaries: [...new Set(boundaries)].sort((a, b) => a - b) });
    }
    return this.rows.get(i);
  }

  has(i, j) { return this.time >= this.row(i).ends[j]; }
  hasTranslation(i) { return this.time >= this.row(i).translation; }

  /** A cheap revision for each mounted sentence; DOM changes only at reveal boundaries. */
  state(i) {
    const times = this.row(i).boundaries;
    let lo = 0, hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid] <= this.time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
