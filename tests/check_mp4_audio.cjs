/** Real 500 MiB file regression. Supply Playwright path, base URL and a small AAC MP4 fixture.
 * Pads mdat with unused bytes, keeps real AAC/video samples and shifts the EOF moov.
 * node tests/check_mp4_audio.cjs <playwright> <url> <fixture.mp4>
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5184';
const source = path.resolve(process.argv[4]);
const large = path.join(path.dirname(source), 'large-500m.mp4');
const original = fs.readFileSync(source);
const boxes = [];
for (let p = 0; p < original.length;) {
  const size = original.readUInt32BE(p); assert.ok(size >= 8);
  boxes.push({ p, size, type: original.toString('ascii', p + 4, p + 8) }); p += size;
}
const mdat = boxes.find((b) => b.type === 'mdat'), moov = boxes.find((b) => b.type === 'moov');
assert.equal(moov.p, mdat.p + mdat.size, 'fixture needs moov directly after mdat');
const length = 500 * 1024 * 1024, moovAt = length - moov.size;
const prefix = Buffer.from(original.subarray(0, moov.p)); prefix.writeUInt32BE(moovAt - mdat.p, mdat.p);
const fd = fs.openSync(large, 'w');
try { fs.writeSync(fd, prefix); fs.writeSync(fd, original.subarray(moov.p), 0, moov.size, moovAt); fs.ftruncateSync(fd, length); }
finally { fs.closeSync(fd); }
(async () => {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(base + '/index.html');
      await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'qa'; document.body.append(input); });
      await page.locator('#qa').setInputFiles(source);
      const sourcePlayable = await page.evaluate(async () => {
        const audio = document.createElement('audio'); audio.preload = 'metadata';
        const ready = new Promise((resolve) => { audio.onloadedmetadata = () => resolve(true); audio.onerror = () => resolve(false); });
        audio.src = URL.createObjectURL(document.querySelector('#qa').files[0]); return ready;
      });
      await page.locator('#qa').setInputFiles(large);
      const result = await page.evaluate(async (sourcePlayable) => {
        const { extractMedia, convertMedia } = await import('./js/workbench-media.js');
        const input = document.querySelector('#qa').files[0];
        input.arrayBuffer = () => { throw new Error('whole video read'); };
        const out = await extractMedia(input);
        const bytes = Array.from(new Uint8Array(await out.file.arrayBuffer()));
        const audio = document.createElement('audio'); audio.preload = 'metadata';
        if (!sourcePlayable) {
          return { size: out.file.size, sampleRate: out.sampleRate, channels: out.channels,
            playbackSkipped: 'browser also fails to play the original small MP4 fixture', bytes };
        }
        const ready = new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = () => reject(new Error('M4A preview failed')); });
        audio.src = URL.createObjectURL(out.file); await ready;
        const decoded = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await out.file.arrayBuffer());
        const left = decoded.getChannelData(0), right = decoded.getChannelData(1);
        const difference = left.reduce((n, s, i) => n + Math.abs(s - right[i]), 0) / left.length;
        const proxy = await convertMedia(out);
        const proxyDecoded = await new OfflineAudioContext(2, 1, 16000).decodeAudioData(await proxy.file.arrayBuffer());
        return { size: out.file.size, sampleRate: out.sampleRate, channels: out.channels,
          duration: audio.duration, decodedDuration: decoded.duration, difference,
          proxyRate: proxyDecoded.sampleRate, proxyChannels: proxyDecoded.numberOfChannels,
          bytes };
      }, sourcePlayable);
      assert.ok(result.size < 100000); assert.equal(result.sampleRate, 48000); assert.equal(result.channels, 2);
      if (!result.playbackSkipped) {
        assert.ok(Math.abs(result.duration - 2) < 0.05); assert.ok(Math.abs(result.decodedDuration - 2) < 0.05);
        assert.ok(result.difference > 0.1); assert.equal(result.proxyRate, 16000); assert.equal(result.proxyChannels, 2);
      }
      if (name === 'webkit') assert.deepEqual(Buffer.from(result.bytes), fs.readFileSync(path.join(path.dirname(source), 'chromium.m4a')));
      fs.writeFileSync(path.join(path.dirname(source), `${name}.m4a`), Buffer.from(result.bytes));
      delete result.bytes; console.log(name, 'PASS', JSON.stringify(result));
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '实验性功能', exact: true }).click();
      await page.getByRole('button', { name: '工作台', exact: true }).click();
      await page.locator('input[aria-label="选择视频或音频"]').setInputFiles(large);
      await page.getByRole('button', { name: '提取聆听音频', exact: true }).click();
      await page.getByText('聆听音频已就绪', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: '下载 M4A', exact: true }).isEnabled(), true);
      assert.equal(await page.locator('.workbench-audio').getAttribute('preload'), 'none');
      await page.getByRole('button', { name: '添加音频到首页', exact: true }).click();
      try { await page.getByText(/聆听音频已添加到首页|添加失败：/).waitFor({ timeout: 10000 }); }
      catch (err) { console.log('Import stalled:', await page.locator('.workbench-card').first().innerText()); throw err; }
      const importStatus = await page.locator('.workbench-card').first().locator('.pane-note').last().textContent();
      assert.ok(importStatus.includes('聆听音频已添加到首页'), importStatus);
      const stored = await page.evaluate(async () => {
        const lib = await import('./js/library.js'), track = (await lib.listTracks())[0];
        return Array.from(new Uint8Array(await (await lib.audioBlob(track.id)).arrayBuffer()));
      });
      assert.deepEqual(Buffer.from(stored), fs.readFileSync(path.join(path.dirname(source), `${name}.m4a`)));
      await page.reload();
      const reopened = await page.evaluate(async () => {
        const lib = await import('./js/library.js'), store = await import('./js/store.js');
        const track = (await lib.listTracks())[0];
        const bytes = Array.from(new Uint8Array(await (await lib.audioBlob(track.id)).arrayBuffer()));
        await lib.removeTrack(track.id);
        return { bytes, chunks: (await store.stats()).audioChunks };
      });
      assert.deepEqual(reopened.bytes, stored); assert.equal(reopened.chunks, 0);
      console.log(name, 'PASS: 500 MiB MP4 through experimental workbench UI');
    } finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
