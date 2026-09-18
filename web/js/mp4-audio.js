/** Lossless MP4 audio remux. Read only the index; media stays in file-backed Blob slices. */
const MAX_INDEX = 32 * 1024 * 1024;
const fail = (reason) => { throw new Error(`${reason}。请先用本地媒体工具导出音频后再导入`); };
const tag = (v, p) => String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + p, 4));
function boxes(v, start = 0, end = v.byteLength) {
  const result = [];
  for (let p = start; p < end;) {
    if (p + 8 > end) fail('MP4 索引不完整');
    let size = v.getUint32(p), header = 8;
    if (size === 1) {
      if (p + 16 > end) fail('MP4 索引不完整');
      size = Number(v.getBigUint64(p + 8)); header = 16;
    } else if (!size) size = end - p;
    if (!Number.isSafeInteger(size) || size < header || p + size > end) fail('MP4 索引大小无效');
    result.push({ type: tag(v, p + 4), start: p, data: p + header, end: p + size });
    p += size;
  }
  return result;
}
function child(v, parent, type) {
  const found = boxes(v, parent.data, parent.end).find((b) => b.type === type);
  if (!found) fail(`MP4 缺少 ${type} 音频索引`);
  return found;
}
function need(box, p, bytes) {
  if (p < box.data || p + bytes > box.end) fail('MP4 音频索引不完整');
}
function atom(type, payload) {
  const out = new Uint8Array(8 + payload.length), v = new DataView(out.buffer);
  v.setUint32(0, out.length);
  [...type].forEach((c, i) => out[4 + i] = c.charCodeAt(0));
  out.set(payload, 8); return out;
}

export async function extractMp4Audio(file, { signal, onStage = () => {}, segmented = false } = {}) {
  const read = async (start, length) => {
    signal?.throwIfAborted();
    const bytes = await file.slice(start, start + length).arrayBuffer();
    signal?.throwIfAborted(); return new DataView(bytes);
  };
  // Walk top-level box headers, including moov at EOF, without reading mdat/video bytes.
  let index = null;
  const media = [];
  for (let p = 0, count = 0; p < file.size;) {
    if (++count > 100000 || p + 8 > file.size) fail('MP4 容器无效');
    const v = await read(p, Math.min(16, file.size - p));
    let size = v.getUint32(0), header = 8;
    if (size === 1) {
      if (v.byteLength < 16) fail('MP4 容器不完整');
      size = Number(v.getBigUint64(8)); header = 16;
    } else if (!size) size = file.size - p;
    if (!Number.isSafeInteger(size) || size < header || p + size > file.size) fail('MP4 容器大小无效');
    const type = tag(v, 4);
    if (type === 'moof') fail('暂不支持分片 MP4 的本地音轨提取');
    if (type === 'moov') {
      if (index || size > MAX_INDEX) fail('MP4 音频索引过大或重复');
      index = await read(p, size);
    }
    if (type === 'mdat') media.push({ start: p + header, end: p + size });
    p += size;
  }
  if (!index) fail('MP4 缺少音轨索引');
  onStage('正在分离原始音轨（不重新编码）…');
  const v = index, moov = boxes(v)[0], top = boxes(v, moov.data, moov.end);
  if (top.some((b) => b.type === 'mvex')) fail('暂不支持分片 MP4 的本地音轨提取');
  const trak = top.find((b) => {
    if (b.type !== 'trak') return false;
    const mdia = child(v, b, 'mdia'), hdlr = child(v, mdia, 'hdlr');
    need(hdlr, hdlr.data, 12); return tag(v, hdlr.data + 8) === 'soun';
  });
  if (!trak) fail('视频没有可提取的音轨');
  const mdia = child(v, trak, 'mdia'), mdhd = child(v, mdia, 'mdhd');
  need(mdhd, mdhd.data, 1);
  const version = v.getUint8(mdhd.data), timeAt = mdhd.data + (version === 1 ? 20 : 12);
  if (version > 1) fail('MP4 音轨时间格式不支持');
  need(mdhd, timeAt, version === 1 ? 12 : 8);
  const timescale = v.getUint32(timeAt);
  const duration = (version === 1 ? Number(v.getBigUint64(timeAt + 4)) : v.getUint32(timeAt + 4)) / timescale;
  const stbl = child(v, child(v, mdia, 'minf'), 'stbl'), stsd = child(v, stbl, 'stsd');
  need(stsd, stsd.data, 8);
  const entries = boxes(v, stsd.data + 8, stsd.end);
  if (entries.length !== 1 || v.getUint32(stsd.data + 4) !== 1
    || !['mp4a', 'alac'].includes(entries[0].type)) fail('暂不支持此 MP4 音轨编码（支持 AAC / ALAC）');
  const entry = entries[0]; need(entry, entry.data, 28);
  if (v.getUint16(entry.data + 8) !== 0) fail('暂不支持此 QuickTime 音轨格式');
  const channels = v.getUint16(entry.data + 16), sampleRate = v.getUint32(entry.data + 24) / 65536;
  if (!(duration > 0 && Number.isFinite(duration)) || channels < 1 || channels > 32 || sampleRate < 8000) fail('MP4 音轨参数无效');
  const stsz = child(v, stbl, 'stsz'), stsc = child(v, stbl, 'stsc');
  const offsets = boxes(v, stbl.data, stbl.end).find((b) => ['stco', 'co64'].includes(b.type));
  if (!offsets) fail('MP4 缺少音频位置索引');
  need(stsz, stsz.data, 12); need(stsc, stsc.data, 8); need(offsets, offsets.data, 8);
  const fixed = v.getUint32(stsz.data + 4), samples = v.getUint32(stsz.data + 8);
  if (!fixed) need(stsz, stsz.data + 12, samples * 4);
  const runs = v.getUint32(stsc.data + 4), chunks = v.getUint32(offsets.data + 4);
  const width = offsets.type === 'co64' ? 8 : 4;
  need(stsc, stsc.data + 8, runs * 12); need(offsets, offsets.data + 8, chunks * width);
  if (!runs || !chunks || !samples) fail('MP4 音轨为空');
  const mapping = [];
  for (let i = 0; i < runs; i++) {
    const at = stsc.data + 8 + i * 12, first = v.getUint32(at), count = v.getUint32(at + 4);
    if (!count || (i === 0 ? first !== 1 : first <= mapping[i - 1].first)
      || first > chunks || v.getUint32(at + 8) !== 1) fail('MP4 音频分块索引无效');
    mapping.push({ first, count });
  }
  // Preserve the audio track and its edit list; omit video tracks and their indexes.
  const mvhd = child(v, moov, 'mvhd');
  const movieHeader = new Uint8Array(v.buffer.slice(mvhd.start, mvhd.end));
  const trackBytes = new Uint8Array(v.buffer.slice(trak.start, trak.end)), trackView = new DataView(trackBytes.buffer);
  const ftyp = atom('ftyp', new Uint8Array([77, 52, 65, 32, 0, 0, 0, 0, 77, 52, 65, 32, 105, 115, 111, 109, 109, 112, 52, 50]));
  // Use an extended mdat header; co64 input retains 64-bit output offsets.
  const start = ftyp.length + 8 + movieHeader.length + trackBytes.length + 16;
  const positions = segmented ? new Float64Array(samples) : null;
  const sizes = segmented ? new Uint32Array(samples) : null;
  const parts = []; let total = 0, sample = 0, run = 0;
  for (let i = 0; i < chunks; i++) {
    if (i && i % 256 === 0) { await new Promise((r) => setTimeout(r, 0)); signal?.throwIfAborted(); }
    if (run + 1 < runs && i + 1 === mapping[run + 1].first) run++;
    const count = mapping[run].count;
    if (sample + count > samples) fail('MP4 音频样本数量无效');
    let length = fixed * count;
    if (!fixed) for (let s = 0; s < count; s++) length += v.getUint32(stsz.data + 12 + (sample + s) * 4);
    const at = offsets.data + 8 + i * width;
    const offset = width === 8 ? Number(v.getBigUint64(at)) : v.getUint32(at);
    if (!Number.isSafeInteger(offset) || !media.some((m) => offset >= m.start && offset + length <= m.end)) fail('MP4 音频位置超出媒体数据');
    if (segmented) {
      let cursor = offset;
      for (let s = 0; s < count; s++) {
        const n = sample + s, size = fixed || v.getUint32(stsz.data + 12 + n * 4);
        positions[n] = cursor; sizes[n] = size; cursor += size;
      }
    }
    if (width === 4 && start + total > 0xffffffff) fail('提取音轨超过 MP4 位置索引上限');
    if (width === 8) trackView.setBigUint64(at - trak.start, BigInt(start + total));
    else trackView.setUint32(at - trak.start, start + total);
    if (!segmented) parts.push(file.slice(offset, offset + length));
    total += length; sample += count;
  }
  if (sample !== samples || !total) fail('MP4 音频样本索引不完整');
  if (segmented) return segmentPlan({ file, v, moov, trak, mdia, mdhd, mvhd, stbl, stsd,
    positions, sizes, timescale, sampleRate, channels, duration, signal, ftyp });
  const payload = new Uint8Array(movieHeader.length + trackBytes.length);
  payload.set(movieHeader); payload.set(trackBytes, movieHeader.length);
  const mdat = new Uint8Array(16), header = new DataView(mdat.buffer);
  header.setUint32(0, 1); mdat.set([109, 100, 97, 116], 4); header.setBigUint64(8, BigInt(total + 16));
  signal?.throwIfAborted();
  return { file: new File([ftyp, atom('moov', payload), mdat, ...parts],
    (file.name.replace(/\.[^.]+$/, '') || 'audio') + '.lossless.m4a', { type: 'audio/mp4' }),
  sampleRate, channels, duration };
}

const words = (...values) => {
  const out = new Uint8Array(values.length * 4), v = new DataView(out.buffer);
  values.forEach((value, i) => v.setUint32(i * 4, value)); return out;
};
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out;
};

/** Build short independently decodable MP4 windows with packet overlap. No full PCM buffer. */
function segmentPlan({ file, v, moov, trak, mdia, mdhd, mvhd, stbl, stsd,
  positions, sizes, timescale, sampleRate, channels, duration, signal, ftyp }) {
  const stts = child(v, stbl, 'stts'); need(stts, stts.data, 8);
  const runs = v.getUint32(stts.data + 4); need(stts, stts.data + 8, runs * 8);
  const ticks = new Float64Array(sizes.length + 1);
  let sample = 0;
  for (let i = 0; i < runs; i++) {
    const at = stts.data + 8 + i * 8, count = v.getUint32(at), delta = v.getUint32(at + 4);
    if (!delta || sample + count > sizes.length) fail('MP4 音轨时间索引无效');
    for (let n = 0; n < count; n++, sample++) ticks[sample + 1] = ticks[sample] + delta;
  }
  if (sample !== sizes.length) fail('MP4 音轨时间索引不完整');
  const movieScaleAt = mvhd.data + (v.getUint8(mvhd.data) === 1 ? 20 : 12);
  need(mvhd, movieScaleAt, 4); const movieScale = v.getUint32(movieScaleAt);
  let trim = 0, lead = 0;
  const edts = boxes(v, trak.data, trak.end).find((b) => b.type === 'edts');
  if (edts) {
    const elst = child(v, edts, 'elst'); need(elst, elst.data, 8);
    const version = v.getUint8(elst.data), entries = v.getUint32(elst.data + 4), width = version === 1 ? 20 : 12;
    need(elst, elst.data + 8, entries * width);
    let seenMedia = false;
    for (let i = 0; i < entries; i++) {
      const at = elst.data + 8 + i * width;
      const length = version === 1 ? Number(v.getBigUint64(at)) : v.getUint32(at);
      const time = version === 1 ? Number(v.getBigInt64(at + 8)) : v.getInt32(at + 4);
      if (version > 1 || v.getUint32(at + width - 4) !== 65536 || seenMedia) fail('暂不支持此音轨的复杂剪辑时间轴');
      if (time === -1) lead += length / movieScale;
      else { trim = time / timescale; duration = length / movieScale; seenMedia = true; }
    }
  }
  // elst uses movie ticks (often milliseconds), while stts uses audio ticks.
  // A rounded-up edit duration must not ask the decoder for nonexistent tail samples.
  const available = ticks[sizes.length] / timescale - trim;
  if (!(available > 0) || trim < 0) fail('MP4 音轨剪辑范围无效');
  duration = Math.min(duration, available);
  const raw = (box) => new Uint8Array(v.buffer.slice(box.start, box.end));
  const stamp = (box, seconds, scale) => {
    const out = raw(box), view = new DataView(out.buffer), data = box.data - box.start;
    const version = view.getUint8(data), at = data + (box.type === 'tkhd' ? (version ? 28 : 20) : (version ? 24 : 16));
    if (at + (version ? 8 : 4) > out.length) fail('MP4 时间头不完整');
    if (version) view.setBigUint64(at, BigInt(Math.round(seconds * scale)));
    else view.setUint32(at, Math.round(seconds * scale));
    return out;
  };
  return { duration: lead + duration, sampleRate, channels,
    async *segments() {
      // Bound decoded windows to ~12 s; overlap absorbs codec and resampling edges.
      let first = 0;
      if (lead) yield { silence: lead, duration: lead };
      for (let time = 0; time < duration; time += 12) {
        signal?.throwIfAborted();
        const begin = trim + time, end = trim + Math.min(duration, time + 12);
        while (first + 1 < ticks.length && ticks[first + 1] / timescale <= begin) first++;
        const a = Math.max(0, first - 8);
        let b = first + 1;
        while (b < sizes.length && ticks[b] / timescale < end) b++;
        b = Math.min(sizes.length, b + 8);
        const seconds = (ticks[b] - ticks[a]) / timescale;
        const tables = [], lengths = [], timing = [];
        for (let i = a; i < b; i++) {
          lengths.push(sizes[i]);
          const delta = ticks[i + 1] - ticks[i];
          if (timing.length && timing[timing.length - 1] === delta) timing[timing.length - 2]++;
          else timing.push(1, delta);
        }
        tables.push(raw(stsd), atom('stts', concat([words(0, timing.length / 2), words(...timing)])),
          atom('stsc', words(0, 1, 1, b - a, 1)), atom('stsz', concat([words(0, 0, b - a), words(...lengths)])));
        let offset = 0;
        const rebuild = (box) => {
          if (box.type === 'stbl') return atom('stbl', concat([...tables, atom('stco', words(0, 1, offset))]));
          if (box.type === 'mdhd') return stamp(box, seconds, timescale);
          if (['tkhd', 'mvhd'].includes(box.type)) return stamp(box, seconds, movieScale);
          if (['moov', 'trak', 'mdia', 'minf'].includes(box.type)) {
            return atom(box.type, concat(boxes(v, box.data, box.end).filter((c) =>
              c.type !== 'edts' && (box.type !== 'moov' || c.start === trak.start || c.type === 'mvhd'))
              .map(rebuild)));
          }
          return raw(box);
        };
        let header = rebuild(moov); offset = ftyp.length + header.length + 8; header = rebuild(moov);
        const size = lengths.reduce((n, value) => n + value, 0);
        const media = [];
        for (let i = a; i < b; i++) media.push(file.slice(positions[i], positions[i] + sizes[i]));
        yield { file: new Blob([ftyp, header, words(size + 8, 0x6d646174), ...media], { type: 'audio/mp4' }),
          skip: begin - ticks[a] / timescale, duration: end - begin, time: lead + time };
      }
    },
  };
}
