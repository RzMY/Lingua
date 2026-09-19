import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NATIVE_REVISION, UpdateManager, validateManifest } from '../mobile/src/update.js';
import { normalizeTarget } from '../mobile/src/channels.js';
import { apiUrl } from '../web/js/api.js';
import { config } from '../web/js/config.js';

const version = 'a'.repeat(64), checksum = 'b'.repeat(64);
const manifest = { schema: 1, appId: 'app.linguatrack.mobile', nativeRevision: NATIVE_REVISION, version,
  bundle: `bundle-${version}.zip`, checksum, size: 100 };
function fixture(overrides = {}) {
  const calls = [], saved = [];
  const updater = {
    list: async () => ({ bundles: [] }),
    download: async (options) => { calls.push(options); return { id: 'local-id', version, checksum, status: 'pending' }; },
    set: async ({ id }) => { calls.push(['activate', id]); },
    ...overrides,
  };
  const manager = new UpdateManager({ updater, fetchManifest: async () => ({ data: manifest, manifestUrl: 'https://example.org/lingua/mobile/manifest.json' }),
    save: async (state) => { saved.push(structuredClone(state)); }, state: { source: { channel: 'own', ownUrl: 'https://example.org/lingua/' }, pending: null },
    currentVersion: 'c'.repeat(64) });
  return { manager, calls, saved, updater };
}
test('target normalization accepts a site or index and rejects unsafe transports and credentials', () => {
  assert.equal(normalizeTarget(' https://example.org/lingua/index.html '), 'https://example.org/lingua/');
  assert.equal(normalizeTarget('https://example.org/lingua'), 'https://example.org/lingua/');
  for (const value of ['http://example.org', 'javascript:alert(1)', 'file:///test', 'https://user:pass@example.org',
    'https://example.org/?secret=x', 'https://example.org/#x', '']) assert.throws(() => normalizeTarget(value));
});
test('manifest binds zip URL to selected site and refuses incompatible or malformed updates', () => {
  assert.equal(validateManifest(manifest, 'https://example.org/lingua/mobile/manifest.json').url,
    `https://example.org/lingua/mobile/bundle-${version}.zip`);
  for (const patch of [{ appId: 'other' }, { schema: 2 }, { nativeRevision: NATIVE_REVISION - 1 }, { bundle: '../evil.zip' },
    { bundle: 'https://other.org/a.zip' }, { checksum: '' }, { version: '../bad' }, { size: 0 }, { size: 101 * 1024 * 1024 }]) {
    assert.throws(() => validateManifest({ ...manifest, ...patch }, 'https://example.org/'));
  }
});
test('download is verified and persisted without activating, and concurrent checks are coalesced', async () => {
  const { manager, calls, saved } = fixture();
  const a = manager.check(), b = manager.check(); assert.equal(a, b);
  await a;
  assert.equal(calls.length, 1); assert.equal(saved.length, 1);
  assert.equal(calls[0].checksum, checksum);
  assert.equal(saved[0].pending.id, 'local-id');
});
test('network and checksum failures never replace a working version or saved state', async () => {
  const { manager, calls, saved, updater } = fixture();
  manager.fetchManifest = async () => { throw Error('offline'); };
  await assert.rejects(manager.check(), /offline/);
  assert.equal(saved.length, 0); assert.equal(calls.length, 0);
  manager.fetchManifest = async () => ({ data: manifest, manifestUrl: 'https://example.org/mobile/manifest.json' });
  updater.download = async () => ({ id: 'bad', version, checksum: '0'.repeat(64) });
  await assert.rejects(manager.check(), /校验/); assert.equal(saved.length, 0);
  updater.download = async () => { throw Error('disk full'); };
  await assert.rejects(manager.check(), /disk full/); assert.equal(saved.length, 0);
});
test('same frontend and failed versions are not downloaded again', async () => {
  const { manager, calls, updater } = fixture();
  manager.currentVersion = version; assert.equal(await manager.check(), null);
  manager.currentVersion = 'old';
  updater.list = async () => ({ bundles: [{ version, status: 'error' }] });
  await assert.rejects(manager.check(), /启动失败/); assert.equal(calls.length, 0);
});
test('upstream rollback to the running version discards a stale pending update', async () => {
  const { manager, saved } = fixture();
  manager.state.pending = { id: 'obsolete', version: 'd'.repeat(64), checksum };
  manager.currentVersion = version;
  assert.equal(await manager.check(), null);
  assert.equal(manager.state.pending, null);
  assert.equal(saved[0].pending, null);
});
test('pending update survives restart and only explicit apply switches native bundle', async () => {
  const { manager, calls, updater, saved } = fixture();
  const pending = await manager.check();
  updater.list = async () => ({ bundles: [{ ...pending, status: 'pending' }] });
  const reloaded = new UpdateManager({ updater, fetchManifest: manager.fetchManifest,
    save: manager.save, state: saved[0], currentVersion: 'old' });
  assert.deepEqual(await reloaded.check(), pending); assert.equal(calls.length, 1);
  await reloaded.apply(); assert.deepEqual(calls[1], ['activate', 'local-id']);
  assert.equal(saved.at(-1).pending, null);
});
test('evicted pending bundle is downloaded again and invalid pending cannot activate', async () => {
  const { manager, calls } = fixture();
  await manager.check(); await manager.check(); assert.equal(calls.length, 2);
  await assert.rejects(manager.apply(), /失效/);
  assert.ok(calls.every((call) => !Array.isArray(call)));
});
test('failed preferences commit cannot schedule or activate an uncommitted update', async () => {
  const { manager, calls } = fixture(); manager.save = async () => { throw Error('storage unavailable'); };
  await assert.rejects(manager.check(), /storage unavailable/);
  assert.equal(manager.state.pending, null); assert.equal(calls.length, 1);
});
test('native download completed during navigation is reused even without pending preferences', async () => {
  const { manager, calls, saved } = fixture({ list: async () => ({ bundles: [
    { id: 'orphan', version, checksum, status: 'pending' },
  ] }) });
  assert.equal((await manager.check()).id, 'orphan');
  assert.equal(calls.length, 0); assert.equal(saved[0].pending.id, 'orphan');
});
test('native default backend follows selected subpath; explicit backend still wins', (t) => {
  const previous = config.apiBase;
  t.after(() => { delete globalThis.window; config.apiBase = previous; });
  globalThis.window = { LinguaNative: { target: 'https://example.org/lingua/' } };
  config.apiBase = '';
  assert.equal(apiUrl('/health'), 'https://example.org/lingua/api/health');
  config.apiBase = 'https://analysis.example/api';
  assert.equal(apiUrl('/health'), 'https://analysis.example/api/health');
  delete globalThis.window;
  config.apiBase = ''; assert.equal(apiUrl('/health'), '/api/health');
});
