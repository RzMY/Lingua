import assert from 'node:assert/strict';
import { test } from 'node:test';
import { put, del } from '../web/js/store.js';
import { flushPositions, getTrack, patchTrack, removeTrack, setDuration, setPosition,
  stagePosition } from '../web/js/library.js';

function storage() {
  const bag = new Map();
  return { getItem: (k) => bag.get(k) ?? null, setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k), get size() { return bag.size; } };
}

test('concurrent position and duration updates retain a renamed title in memory fallback', async () => {
  const id = 'concurrent-metadata';
  await put('tracks', id, { id, title: 'Original', lang: 'en', duration: 0 }, id);
  for (let i = 0; i < 10; i++) {
    await Promise.all([
      setPosition(id, 12 + i), patchTrack(id, { title: 'Renamed ' + i }), setDuration(id, 90 + i),
    ]);
    const record = await getTrack(id);
    assert.equal(record.title, 'Renamed ' + i);
    assert.equal(record.position, 12 + i);
    assert.equal(record.duration, 90 + i);
    assert.equal(record.lang, 'en');
  }
});

test('metadata patches ignore undefined fields and never recreate a removed track', async () => {
  const id = 'patch-existing';
  await put('tracks', id, { id, title: 'Keep', duration: 90 }, id);
  const record = await patchTrack(id, { title: undefined, position: 0 });
  assert.equal(record.title, 'Keep');
  assert.equal(record.position, 0);
  await del('tracks', id);
  assert.equal(await patchTrack(id, { title: 'Removed' }), null);
  assert.equal(await getTrack(id), undefined);
});

test('positions staged on exit merge into the library without overwriting newer progress', async (t) => {
  globalThis.localStorage = storage();
  t.after(() => { delete globalThis.localStorage; });
  const id = 'staged-position';
  await put('tracks', id, { id, title: 'Keep', position: 5, positionAt: '2000-01-01T00:00:00.000Z' }, id);
  stagePosition(id, 42.04);
  await flushPositions();
  const merged = await getTrack(id);
  assert.equal(merged.position, 42);
  assert.equal(merged.title, 'Keep');
  assert.equal(localStorage.size, 0, 'merged entries are cleared');

  stagePosition(id, 50);                          // staged, then superseded by a direct write
  await new Promise((r) => setTimeout(r, 5));
  await setPosition(id, 60);
  await flushPositions();
  assert.equal((await getTrack(id)).position, 60);
  assert.equal(localStorage.size, 0);

  stagePosition(id, 70);
  await removeTrack(id);                          // a re-imported id must not inherit it
  assert.equal(localStorage.size, 0);
  await put('tracks', id, { id, title: 'Reimported' }, id);
  await flushPositions();
  assert.equal((await getTrack(id)).position, undefined);
});

test('position staging tolerates unavailable or corrupt localStorage', async (t) => {
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); } };
  t.after(() => { delete globalThis.localStorage; });
  assert.doesNotThrow(() => stagePosition('any', 3));
  await flushPositions();
  globalThis.localStorage = storage();
  localStorage.setItem('linguatrack.positions.v1', '{broken');
  await flushPositions();
  localStorage.setItem('linguatrack.positions.v1', JSON.stringify({ any: { position: 'x', at: 1 } }));
  await flushPositions();
});
