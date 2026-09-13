/** Bounded diagnostics for this tab, without media URLs or track content. */

const VERSION = 'media-resume-8';
const KEY = 'linguatrack.playback-diagnostics.v4';
const MAX_RUNS = 3;
const MAX_EVENTS = 160;

export function createPlaybackLog(audio, { ios, standalone, controls = 'unmanaged' }) {
  const since = performance.now();
  const startedAt = new Date().toISOString();
  const ms = navigator.mediaSession;
  const session = navigator.audioSession;
  let storage, previousRuns = [], request = 0;
  let persistence = 'memory';
  try { storage = window.sessionStorage; } catch { /* Keep an in-memory log. */ }
  const readRuns = () => {
    try {
      const raw = storage?.getItem(KEY);
      const saved = raw && raw.length <= 256000 ? JSON.parse(raw) : null;
      // The storage schema is unchanged; preserve evidence from the previous player.
      if (['media-resume-4', 'media-resume-5', 'media-resume-6', 'media-resume-7', VERSION].includes(saved?.version)
        && Array.isArray(saved.runs)) {
        return saved.runs.filter((r) => typeof r?.runId === 'string'
          && typeof r.startedAt === 'string' && Array.isArray(r.events))
          .slice(-MAX_RUNS).map((r) => ({ ...r, events: r.events.slice(-MAX_EVENTS) }));
      }
    } catch { /* Invalid or unavailable storage must not affect playback. */ }
    return [];
  };
  previousRuns = readRuns().slice(-(MAX_RUNS - 1));

  const run = { version: VERSION,
    runId: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    startedAt, ios, standalone, controls, userAgent: navigator.userAgent,
    navigation: performance.getEntriesByType?.('navigation')[0]?.type || 'unknown',
    capabilities: { secureContext: globalThis.isSecureContext === true,
      pageProtocol: globalThis.location?.protocol ?? null,
      mediaSession: !!ms, audioSession: !!session,
      audioSessionState: typeof session?.state === 'string', actions: {} },
    eventCount: 0, droppedEvents: 0, events: [],
  };
  const snapshot = () => ({ hidden: document.hidden,
    time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
    bufferedEnd: audio.buffered?.length ? audio.buffered.end(audio.buffered.length - 1) : null,
    paused: audio.paused, ended: audio.ended,
    ready: audio.readyState, network: audio.networkState, seeking: audio.seeking,
    rate: audio.playbackRate, muted: audio.muted, volume: audio.volume,
    session: session?.state ?? null, sessionType: session?.type ?? null,
    playbackState: ms?.playbackState ?? null,
  });
  const update = () => {
    run.elapsedMs = Math.round(performance.now() - since);
    run.state = snapshot();
    run.playbackState = run.state.playbackState;
    try { run.source = audio.src ? new URL(audio.src).protocol.slice(0, -1) : ''; }
    catch { run.source = 'unknown'; }
  };
  const persist = () => {
    if (!storage) return;
    try {
      storage.setItem(KEY, JSON.stringify({ version: VERSION, runs: [...previousRuns, run] }));
      persistence = 'sessionStorage';
    } catch { persistence = 'memory'; }
  };
  const record = (event, error = '') => {
    if (event === 'pageshow') {
      // A restored bfcache page must retain records from pages visited after it.
      previousRuns = readRuns().filter((r) => r.runId !== run.runId).slice(-(MAX_RUNS - 1));
    }
    if (event.startsWith('action:play:')) request++;
    update();
    run.events.push({ seq: ++run.eventCount, request, at: run.elapsedMs,
      event, ...run.state, error });
    if (run.events.length > MAX_EVENTS) {
      run.events.shift();
      run.droppedEvents++;
    }
    persist();
  };
  record('init');

  return {
    record,
    setSourceInfo({ origin, type, bytes, rangeStatus = null, rangeSupported = null }) {
      run.sourceInfo = {
        origin: ['library', 'file', 'test-http', 'test-blob'].includes(origin) ? origin : 'unknown',
        type: typeof type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : '',
        bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
        rangeStatus: Number.isInteger(rangeStatus) && rangeStatus >= 100 && rangeStatus <= 599
          ? rangeStatus : null,
        rangeSupported: typeof rangeSupported === 'boolean' ? rangeSupported : null,
      };
      record('source:attached:' + run.sourceInfo.origin);
    },
    actionStatus(action, supported, error = '') {
      run.capabilities.actions[action] = supported;
      record('handler:' + action + (supported ? ':registered' : ':failed'), error);
    },
    report() {
      // Exporting a snapshot must not evict the events it is meant to diagnose.
      update();
      persist();
      return JSON.stringify({ ...run, exportedAt: new Date().toISOString(),
        persistence, previousRuns }, null, 2);
    },
  };
}
