import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createFakeIndexedDB } from './idb_fake.mjs';

// store.js reads these globals when it is imported.
const fake = createFakeIndexedDB();
const page = new EventTarget();
const doc = Object.assign(new EventTarget(), { hidden: false });
globalThis.indexedDB = fake;
globalThis.addEventListener = page.addEventListener.bind(page);
globalThis.document = doc;
const store = await import('../web/js/store.js');

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const lifecycle = (type, persisted) => page.dispatchEvent(Object.assign(new Event(type), { persisted }));
const visibility = (hidden) => { doc.hidden = hidden; doc.dispatchEvent(new Event('visibilitychange')); };
const state = (promise) => {
  const box = { done: false };
  promise.then((value) => Object.assign(box, { done: true, value }),
    (error) => Object.assign(box, { done: true, error }));
  return box;
};

/** A read-write transaction from another document of the same origin. */
function foreignWrite(key, value) {
  const tx = fake.connect().transaction('tracks', 'readwrite');
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve('ok');
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
  tx.objectStore('tracks').put({ v: value, track: key, at: 0 }, key);
  return { tx, done };
}

afterEach(async () => {
  fake.holdRequest = null;
  fake.holdCommit = null;
  fake.openError = null;
  fake.deferOpen = false;
  for (const tx of fake.transactions) tx.release?.();
  for (const tx of fake.stalledCommits.splice(0)) if (tx.state === 'committing') tx.commit();
  await settle();
  if (doc.hidden) visibility(false);
});

test('pagehide aborts a frozen read so another page can write, then replays it after pageshow', async () => {
  await store.put('tracks', 'k1', 0, 'k1');
  // The page is frozen before the success event of this read is delivered.
  fake.holdRequest = (tx) => tx.mode === 'readonly';
  const read = state(store.get('tracks', 'k1', { strict: true }));
  await settle();
  assert.equal(read.done, false);
  lifecycle('pagehide', true);
  // Before the fix this write waited forever behind the cached page's transaction.
  const other = foreignWrite('k1', 1);
  assert.equal(await Promise.race([other.done, settle(40).then(() => 'blocked')]), 'ok');
  await settle();
  assert.equal(read.done, false, 'an interrupted read is retried, not reported as a failure');
  fake.holdRequest = null;
  lifecycle('pageshow', true);
  await settle();
  assert.deepEqual({ done: read.done, value: read.value, error: read.error }, { done: true, value: 1, error: undefined });
});

test('work requested while the page is frozen starts only after pageshow', async () => {
  lifecycle('pagehide', true);
  const created = fake.created;
  const read = state(store.get('tracks', 'k1'));
  await settle();
  assert.equal(fake.created, created);
  assert.equal(read.done, false);
  lifecycle('pageshow', true);
  await settle();
  assert.equal(read.value, 1);
});

test('a page that is being destroyed is left to the browser', async () => {
  fake.holdRequest = (tx) => tx.mode === 'readonly';
  const read = state(store.get('tracks', 'k1'));
  await settle();
  const aborted = fake.aborted;
  lifecycle('pagehide', false);
  assert.equal(fake.aborted, aborted);
  fake.holdRequest = null;
  for (const tx of fake.transactions) tx.release();
  await settle();
  assert.equal(read.value, 1);
});

test('an interrupted batch undoes its localStorage change before it is replayed', async () => {
  const steps = [];
  // Only the commit marker is delivered: beforeCommit runs, the batch itself stays open.
  fake.holdRequest = (tx, request) => tx.mode === 'readwrite' && request.key !== '__backup_commit__';
  const batch = state(store.writeBatch({ tracks: [{ key: 'batch', value: 'B', track: 'batch' }] }, {
    beforeCommit: () => { steps.push('apply'); return () => steps.push('rollback'); },
  }));
  await settle();
  assert.deepEqual(steps, ['apply']);
  lifecycle('pagehide', true);
  assert.deepEqual(steps, ['apply', 'rollback']);
  fake.holdRequest = null;
  lifecycle('pageshow', true);
  await settle();
  assert.equal(batch.done, true);
  assert.equal(batch.error, undefined);
  assert.deepEqual(steps, ['apply', 'rollback', 'apply']);
  assert.equal(await store.get('tracks', 'batch'), 'B');
});
test('a read blocked by another page fails after a visible stall instead of hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fake.holdRequest = (tx) => tx.mode === 'readwrite';
  const other = foreignWrite('k1', 2);           // e.g. a page of an older build frozen mid-write
  await settle();
  fake.holdRequest = null;
  const strict = state(store.get('tracks', 'k1', { strict: true }));
  const loose = state(store.get('tracks', 'k1'));
  await settle();
  t.mock.timers.tick(14999);
  await settle();
  assert.equal(strict.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.match(strict.error?.message || '', /本地存储暂时没有响应/);
  assert.deepEqual({ done: loose.done, value: loose.value }, { done: true, value: undefined });
  other.tx.release();
  await other.done;
  assert.equal(await store.get('tracks', 'k1', { strict: true }), 2);
});

test('the stall timer only counts while the page is visible', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fake.holdRequest = (tx) => tx.mode === 'readwrite';
  const other = foreignWrite('k1', 3);
  await settle();
  fake.holdRequest = null;
  visibility(true);
  const read = state(store.get('tracks', 'k1', { strict: true }));
  await settle();
  t.mock.timers.tick(60000);                      // backgrounded: timers fire late on return
  await settle();
  assert.equal(read.done, false);
  visibility(false);
  t.mock.timers.tick(14999);
  await settle();
  assert.equal(read.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.match(read.error?.message || '', /本地存储暂时没有响应/);
  other.tx.release();
  await other.done;
});

test('a stalled commit is not reported as failed while it can still succeed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fake.holdCommit = (tx) => tx.mode === 'readwrite';
  const write = state(store.updateRecord('tracks', 'k1', () => 4));
  await settle();
  assert.equal(fake.stalledCommits.length, 1);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(write.done, false);
  fake.holdCommit = null;
  fake.stalledCommits.shift().commit();
  await settle();
  assert.deepEqual({ value: write.value, error: write.error }, { value: 4, error: undefined });
});

test('connections closed by the browser are reopened on the next read or write', async () => {
  let opens = fake.opens;
  fake.dropConnections();
  await settle();                                 // close event delivered
  assert.equal(await store.get('tracks', 'k1', { strict: true }), 4);
  assert.equal(fake.opens, opens + 1);
  opens = fake.opens;
  // The close event may arrive after the next transaction is requested.
  for (const db of fake.connections) db.closed = true;
  await store.put('tracks', 'k2', 'after-close', 'k2');
  assert.equal(fake.opens, opens + 1);
  assert.equal(await store.get('tracks', 'k2', { strict: true }), 'after-close');
});

test('a transient open failure is reported without switching the session to memory', async () => {
  fake.dropConnections();
  await settle();
  fake.openError = new DOMException('Connection to Indexed Database server lost', 'UnknownError');
  await assert.rejects(store.get('tracks', 'k1', { strict: true }), { name: 'UnknownError' });
  assert.equal(await store.get('tracks', 'k1'), undefined);
  assert.equal(store.isDegraded(), false);
  fake.openError = null;
  assert.equal(await store.get('tracks', 'k1', { strict: true }), 4);
});

test('only a failure on the first open switches a document to memory storage', async () => {
  fake.openError = new DOMException('denied', 'UnknownError');
  const fresh = await import('../web/js/store.js?first-open-fails');
  assert.equal(await fresh.get('tracks', 'k1'), undefined);
  assert.equal(fresh.isDegraded(), true);
  fake.openError = null;
  await fresh.put('tracks', 'mem', 'only-in-memory', 'mem');
  assert.equal(await fresh.get('tracks', 'mem'), 'only-in-memory');
  assert.equal(await store.get('tracks', 'mem'), undefined);
});

test('an open interrupted by the back/forward cache is retried, not treated as unavailable storage', async () => {
  const fresh = await import('../web/js/store.js?open-interrupted');
  fake.deferOpen = true;
  const read = state(fresh.get('tracks', 'k1', { strict: true }));
  await settle();
  assert.equal(fake.deferredOpens.length, 1);
  lifecycle('pagehide', true);
  fake.openError = new DOMException('Version change transaction on cached page is aborted', 'UnknownError');
  fake.deferOpen = false;
  fake.deferredOpens.shift()();
  await settle();
  assert.equal(read.done, false);
  assert.equal(fresh.isDegraded(), false);
  fake.openError = null;
  lifecycle('pageshow', true);
  await settle();
  assert.deepEqual({ value: read.value, error: read.error }, { value: 4, error: undefined });
});
