/** Browser regression: real long AAC, segment continuity, durable import, cleanup and cancel. */
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(process.argv[3] || 'http://127.0.0.1:5184');
    await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'qa'; document.body.append(i); });
    await page.locator('#qa').setInputFiles(process.argv[4]);
    const result = await page.evaluate(async () => {
      const { extractMedia, convertMedia } = await import('./js/workbench-media.js');
      const lib = await import('./js/library.js');
      const original = document.querySelector('#qa').files[0];
      const reference = original.size < 32 * 1024 * 1024
        ? await new OfflineAudioContext(2, 1, 16000).decodeAudioData(await original.arrayBuffer()) : null;
      const master = await extractMedia(original);
      const record = await lib.createPreparedTrack(master.file, null, { duration: master.duration });
      const hash = async (blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).join(',');
      const before = await hash(master.file);
      const native = OfflineAudioContext.prototype.decodeAudioData;
      const windows = [];
      OfflineAudioContext.prototype.decodeAudioData = async function (bytes) {
        const decoded = await native.call(this, bytes); windows.push(decoded.duration); return decoded;
      };
      let out;
      try { out = await convertMedia(master); } finally { OfflineAudioContext.prototype.decodeAudioData = native; }
      const bytes = await out.file.arrayBuffer();
      const compressedBytes = bytes.byteLength;
      const proxy = await native.call(new OfflineAudioContext(out.channels, 1, 16000), bytes);
      const channels = proxy.numberOfChannels, frames = proxy.length;
      // MP3 adds codec delay/padding. Align before comparing the lossy waveform.
      let shift = 0, best = Infinity;
      if (reference) for (let offset = 0; offset < 2048; offset++) {
        let error = 0;
        for (let i = 2000; i < Math.min(reference.length, 6000); i += 7) {
          error += Math.abs(proxy.getChannelData(0)[i + offset] - reference.getChannelData(0)[i]);
        }
        if (error < best) { best = error; shift = offset; }
      }
      let sum = 0, maximum = 0;
      for (let i = 0; i < Math.min(frames - shift, reference?.length || 0); i++) {
        const error = Math.abs(proxy.getChannelData(0)[i + shift] - reference.getChannelData(0)[i]);
        sum += error; if (i > 160 && i < frames - 160) maximum = Math.max(maximum, error);
      }
      // Simulate per-window decoder differences while decoding the actual M4A
      // normally on retry; compare every output sample with whole-stream decode.
      const fallbacks = [];
      const directory = await navigator.storage.getDirectory();
      const tempNames = async () => { const names = []; for await (const name of directory.keys()) names.push(name); return names.sort(); };
      for (const failure of ['short', 'channels', 'decode']) {
        const tempBefore = await tempNames();
        let calls = 0;
        OfflineAudioContext.prototype.decodeAudioData = async function (bytes) {
          if (++calls === 1) {
            if (failure === 'decode') throw new Error('window decode failed');
            return { numberOfChannels: failure === 'channels' ? 32 : channels,
              duration: failure === 'short' ? 0.001 : 100 };
          }
          return native.call(this, bytes);
        };
        try {
          const retry = await convertMedia(master);
          const reference = await native.call(new OfflineAudioContext(channels, 1, 16000), await master.file.arrayBuffer());
          const { encodeAsrMp3 } = await import('./js/asr-mp3.js');
          const expected = await encodeAsrMp3(reference, master.file.name);
          const same = await hash(expected.file) === await hash(retry.file);
          await expected.release?.();
          await retry.release?.();
          fallbacks.push({ failure, calls, same, cleaned: JSON.stringify(await tempNames()) === JSON.stringify(tempBefore) });
        } finally { OfflineAudioContext.prototype.decodeAudioData = native; }
      }
      await master.release(); await out.release();
      const after = await hash(await lib.audioBlob(record.id));
      const store = await import('./js/store.js');
      const chunksBefore = (await store.stats()).audioChunks;
      const add = IDBObjectStore.prototype.add;
      let calls = 0, failed = false;
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === 'audioChunks' && ++calls === 2) throw new DOMException('test quota', 'QuotaExceededError');
        return add.apply(this, args);
      };
      try { await lib.createPreparedTrack(new File([new Uint8Array(3 * 1024 * 1024)], 'fail.wav'), null); }
      catch { failed = true; }
      finally { IDBObjectStore.prototype.add = add; }
      const chunksAfter = (await store.stats()).audioChunks;
      // Abort a new conversion after the first window and verify temporary files are removed.
      const root = await navigator.storage.getDirectory();
      const names = async () => { const all = []; for await (const name of root.keys()) if (name.startsWith('lingua-media-')) all.push(name); return all.sort(); };
      const tempBefore = await names(), controller = new AbortController();
      let aborted = false;
      try {
        await convertMedia({ file: original }, { signal: controller.signal, onStage: (stage) => {
          if (stage.includes('%') && !stage.includes(' 0%')) controller.abort();
        } });
      } catch (e) { aborted = e.name === 'AbortError'; }
      return { fallbacks, frames, channels, sampleRate: proxy.sampleRate, compressedBytes,
        pcmBytes: Math.round(out.duration * 16000) * channels * 2,
        referenceFrames: reference?.length || Math.round(master.duration * 16000), averageError: sum / frames, maximum,
        inputSize: original.size, windows: windows.length, maxWindow: Math.max(...windows), sameStoredBytes: before === after,
        failed, chunksBefore, chunksAfter, count: (await lib.listTracks()).length, aborted, tempBefore, tempAfter: await names() };
    });
    console.log(JSON.stringify(result));
    assert.ok(result.windows >= 3);
    assert.ok(result.maxWindow < 13);
    assert.ok(Math.abs(result.frames - result.referenceFrames) <= 2048);
    assert.equal(result.sampleRate, 16000); assert.ok(result.compressedBytes < result.pcmBytes / 7);
    assert.ok(result.averageError < 0.01); assert.ok(result.maximum < 0.06);
    assert.ok(result.fallbacks.every((f) => f.calls === 2 && f.same && f.cleaned));
    assert.equal(result.sameStoredBytes, true); assert.equal(result.aborted, true);
    assert.deepEqual(result.tempAfter, result.tempBefore);
    assert.equal(result.failed, true); assert.equal(result.chunksAfter, result.chunksBefore); assert.equal(result.count, 1);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
