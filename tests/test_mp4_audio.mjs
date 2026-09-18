import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractMedia } from '../web/js/workbench-media.js';
import { extractMp4Audio } from '../web/js/mp4-audio.js';

const atom = (type, ...parts) => {
  const data = Buffer.concat(parts), b = Buffer.alloc(8 + data.length);
  b.writeUInt32BE(b.length); b.write(type, 4); data.copy(b, 8); return b;
};
const words = (...values) => {
  const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v, i * 4)); return b;
};
function fixture({ large = false, co64 = false, tail = true, fixed = false, badOffset = false, editDuration } = {}) {
  const ftyp = atom('ftyp', Buffer.from('isom0000'));
  const mdatSize = large ? 500 * 1024 * 1024 : 32;
  const mdat = words(mdatSize, 0x6d646174);
  const audio = [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8])];
  const makeMoov = (shift) => {
    const hdlr = atom('hdlr', words(0, 0), Buffer.from('soun'));
    const mdhd = atom('mdhd', words(0, 0, 0, 48000, 2048));
    const entry = Buffer.alloc(28); entry.writeUInt16BE(1, 6); entry.writeUInt16BE(2, 16);
    entry.writeUInt16BE(16, 18); entry.writeUInt32BE(48000 * 65536, 24);
    const positions = [ftyp.length + shift + 8, ftyp.length + shift + mdatSize - 4];
    if (badOffset) positions[1] += 100000;
    const offsets = co64 ? Buffer.concat(positions.map((p) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(p)); return b; })) : words(...positions);
    const stbl = atom('stbl', atom('stsd', words(0, 1), atom('mp4a', entry)),
      atom('stts', words(0, 1, 2, 1024)), atom('stsc', words(0, 1, 1, 1, 1)),
      atom('stsz', fixed ? words(0, 4, 2) : words(0, 0, 2, 4, 4)), atom(co64 ? 'co64' : 'stco', words(0, 2), offsets));
    const edits = editDuration === undefined ? words(0, 0) : words(0, 1, editDuration, 0, 65536);
    const track = atom('trak', atom('tkhd', Buffer.alloc(84)), atom('edts', atom('elst', edits)),
      atom('mdia', mdhd, hdlr, atom('minf', stbl)));
    const video = atom('trak', atom('mdia', atom('hdlr', words(0, 0), Buffer.from('vide'))));
    const movie = Buffer.alloc(100); movie.writeUInt32BE(1000, 12);
    return atom('moov', atom('mvhd', movie), video, track);
  };
  let moov = makeMoov(0); if (!tail) moov = makeMoov(moov.length);
  const mdatStart = ftyp.length + (tail ? 0 : moov.length), moovStart = tail ? ftyp.length + mdatSize : ftyp.length;
  const regions = [{ at: 0, data: ftyp }, { at: mdatStart, data: mdat },
    { at: mdatStart + 8, data: audio[0] }, { at: mdatStart + mdatSize - 4, data: audio[1] }, { at: moovStart, data: moov }];
  let readBytes = 0, maxRead = 0;
  // Sparse file double: its advertised 500 MiB is real in offset space, and any
  // attempt to materialize the video payload fails rather than hiding in a tiny mock.
  const file = { name: 'movie.mp4', size: ftyp.length + mdatSize + moov.length,
    arrayBuffer() { throw new Error('whole video read'); },
    slice(start, end) {
      assert.ok(end - start <= 4096, 'must not materialize video');
      const b = Buffer.alloc(end - start);
      for (const r of regions) {
        const a = Math.max(start, r.at), z = Math.min(end, r.at + r.data.length);
        if (z > a) r.data.copy(b, a - start, a - r.at, z - r.at);
      }
      const blob = new Blob([b]);
      blob.arrayBuffer = async () => { readBytes += b.length; maxRead = Math.max(maxRead, b.length); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
      return blob;
    } };
  return { file, stats: () => ({ readBytes, maxRead }) };
}

for (const tail of [true, false]) for (const co64 of [true, false]) for (const fixed of [true, false]) {
  test(`MP4 remux preserves audio and rewrites offsets: tail=${tail} co64=${co64} fixed=${fixed}`, async () => {
    const { file, stats } = fixture({ large: true, tail, co64, fixed });
    const out = await extractMedia(file), b = Buffer.from(await out.file.arrayBuffer());
    assert.equal(out.file.name, 'movie.lossless.m4a'); assert.equal(out.buffer, undefined);
    assert.equal(out.sampleRate, 48000); assert.equal(out.channels, 2); assert.equal(out.duration, 2048 / 48000);
    assert.equal(b.includes(Buffer.from('vide')), false); assert.ok(b.includes(Buffer.from('edts')));
    const table = b.indexOf(co64 ? 'co64' : 'stco');
    const offsets = [0, 1].map((i) => co64 ? Number(b.readBigUInt64BE(table + 12 + i * 8)) : b.readUInt32BE(table + 12 + i * 4));
    assert.deepEqual([...b.subarray(offsets[0], offsets[0] + 4)], [1, 2, 3, 4]);
    assert.deepEqual([...b.subarray(offsets[1], offsets[1] + 4)], [5, 6, 7, 8]);
    assert.ok(out.file.size < 1024); assert.ok(stats().readBytes < 2048);
  });
}

test('invalid offsets, truncated indexes and fragmented MP4 fail without decoding', async () => {
  await assert.rejects(extractMedia(fixture({ badOffset: true }).file), /位置超出/);
  await assert.rejects(extractMedia(new File([atom('ftyp', Buffer.from('isom')), atom('moof')], 'frag.mp4')), /分片/);
  await assert.rejects(extractMedia(new File([words(100, 0x6d6f6f76)], 'bad.mp4')), /大小无效/);
});

test('abort interrupts header reads before audio assembly', async () => {
  const { file } = fixture({ large: true }), controller = new AbortController();
  const slice = file.slice;
  file.slice = (...args) => { controller.abort(); return slice(...args); };
  await assert.rejects(extractMedia(file, { signal: controller.signal }), { name: 'AbortError' });
});

test('ASR windows cap rounded-up movie duration at the real sample end, preserving shorter edits', async () => {
  for (const editDuration of [43, 42]) {
    const plan = await extractMp4Audio(fixture({ editDuration }).file, { segmented: true });
    const expected = Math.min(editDuration / 1000, 2048 / 48000);
    assert.equal(plan.duration, expected);
    const segments = [];
    for await (const segment of plan.segments()) segments.push(segment);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].duration, expected);
    assert.ok(segments[0].skip + segments[0].duration <= 2048 / 48000);
    // The listening master still preserves the original edit list unchanged.
    const master = await extractMedia(fixture({ editDuration }).file);
    const bytes = Buffer.from(await master.file.arrayBuffer());
    assert.equal(bytes.readUInt32BE(bytes.indexOf('elst') + 12), editDuration);
  }
});
