import assert from 'node:assert/strict';
import { test } from 'node:test';
import { put, del } from '../web/js/store.js';
import { getTrack, patchTrack, setDuration, setPosition } from '../web/js/library.js';

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
