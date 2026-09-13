import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlaybackLog } from '../web/js/playback-log.js';

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value) };
}

function fixture(t, storage = memoryStorage()) {
  const audio = { src: 'blob:https://private.example/private-recording', currentTime: 27,
    duration: 120, paused: true, ended: false, readyState: 4, networkState: 1,
    seeking: false, playbackRate: 1, muted: false, volume: 1 };
  for (const [key, value] of Object.entries({
    navigator: { mediaSession: { playbackState: 'paused' },
      audioSession: { type: 'auto' }, userAgent: 'iPhone' },
    document: { hidden: false }, window: { sessionStorage: storage },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const create = () => createPlaybackLog(audio, {
    ios: true, standalone: true, controls: 'native-audio-element',
  });
  return { audio, log: create(), create };
}

test('manual diagnostics export fresh snapshots and distinguish requests without private URLs', (t) => {
  const { audio, log } = fixture(t);
  const initial = JSON.parse(log.report());
  log.record('action:play:native');
  audio.currentTime = 30;
  log.record('pause');
  log.record('action:play:native');
  const report = JSON.parse(log.report());
  assert.equal(report.runId, initial.runId);
  assert.equal(report.state.time, 30);
  assert.equal(report.standalone, true);
  assert.equal(report.source, 'blob');
  const actions = report.events.filter((e) => e.event === 'action:play:native');
  assert.deepEqual(actions.map((e) => e.request), [1, 2]);
  assert.ok(actions[0].seq < actions[1].seq);
  assert.ok(Date.parse(report.exportedAt) >= Date.parse(report.startedAt));
  assert.ok(!log.report().includes('private.example'));
});

test('reload and bfcache restoration retain other diagnostic runs within the limit', (t) => {
  const { log, create } = fixture(t);
  log.record('pause');
  const first = JSON.parse(log.report());
  const second = JSON.parse(create().report());
  assert.notEqual(first.runId, second.runId);
  assert.equal(second.persistence, 'sessionStorage');
  assert.ok(second.previousRuns.some((r) => r.runId === first.runId
    && r.events.some((e) => e.event === 'pause')));
  log.record('pageshow');
  const restored = JSON.parse(log.report());
  assert.equal(restored.runId, first.runId);
  assert.ok(restored.previousRuns.some((r) => r.runId === second.runId));
  let latest;
  for (let i = 0; i < 5; i++) latest = create();
  assert.equal(JSON.parse(latest.report()).previousRuns.length, 2);
});

test('manual diagnostics preserve media-resume-7 failure evidence', (t) => {
  const storage = memoryStorage();
  const previous = { version: 'media-resume-7', runId: 'previous-player',
    startedAt: '2026-09-08T13:05:09.977Z',
    events: [{ event: 'resume:sample', time: 706.517460906 }, { event: 'resume:stalled' }] };
  storage.setItem('linguatrack.playback-diagnostics.v4', JSON.stringify({
    version: 'media-resume-7', runs: [previous],
  }));
  const { log } = fixture(t, storage);
  const report = JSON.parse(log.report());
  assert.equal(report.version, 'media-resume-8');
  assert.deepEqual(report.previousRuns, [previous]);
});

test('source evidence survives navigation and excludes arbitrary private fields', (t) => {
  const { log, create } = fixture(t);
  log.setSourceInfo({ origin: 'test-http', type: 'audio/wav', bytes: 1440044,
    rangeStatus: 206, rangeSupported: true, url: 'http://private.example/private-file',
    title: 'Private title' });
  const first = JSON.parse(log.report());
  assert.deepEqual(first.sourceInfo, { origin: 'test-http', type: 'audio/wav', bytes: 1440044,
    rangeStatus: 206, rangeSupported: true });
  const next = create();
  const saved = JSON.parse(next.report()).previousRuns.find((r) => r.runId === first.runId);
  assert.deepEqual(saved.sourceInfo, first.sourceInfo);
  assert.ok(!next.report().includes('private.example'));
  assert.ok(!next.report().includes('Private title'));
});

test('diagnostics distinguish AudioSession availability from its optional state property', (t) => {
  const { log } = fixture(t);
  const report = JSON.parse(log.report());
  assert.equal(report.capabilities.audioSession, true);
  assert.equal(report.capabilities.audioSessionState, false);
  assert.equal(report.state.session, null);
  assert.equal(report.state.sessionType, 'auto');
  assert.deepEqual(report.capabilities.actions, {});
});

test('event retention is bounded and repeated exports do not displace recorded operations', (t) => {
  const { log } = fixture(t);
  for (let i = 0; i < 200; i++) log.record('action:play:native');
  const first = JSON.parse(log.report());
  assert.equal(first.events.length, 160);
  assert.equal(first.eventCount, 201);
  assert.equal(first.droppedEvents, 41);
  for (let i = 0; i < 200; i++) log.report();
  const next = JSON.parse(log.report());
  assert.deepEqual(next.events, first.events);
  assert.equal(next.droppedEvents, first.droppedEvents);
});

test('blocked or corrupt diagnostic storage falls back without throwing', (t) => {
  const { log, create } = fixture(t, {
    getItem() { throw new DOMException('denied', 'SecurityError'); },
    setItem() { throw new DOMException('full', 'QuotaExceededError'); },
  });
  assert.equal(JSON.parse(log.report()).persistence, 'memory');
  window.sessionStorage = { getItem: () => '{invalid', setItem() {} };
  assert.deepEqual(JSON.parse(create().report()).previousRuns, []);
});
