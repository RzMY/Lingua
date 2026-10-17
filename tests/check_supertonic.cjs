/** Real Japanese/Korean model download + offline inference and native/Web Audio playback.
 * Fixtures are in .cache/voice-pack-qa/supertonic (see docs/ARCHITECTURE.md).
 * node tests/check_supertonic.cjs /path/to/playwright [base-url]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
(async () => {
  const manifest = JSON.parse(await fs.readFile('.cache/voice-pack-qa/supertonic/manifest.json', 'utf8'));
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(60000);
      const errors = [], downloads = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let corruptFirstDownload = true;
      await page.route('https://**/*', async (route) => {
        const url = route.request().url(); downloads.push(url);
        const fixture = manifest.find((file) => url.endsWith('/' + file.path));
        const file = fixture ? '.cache/voice-pack-qa/supertonic/' + fixture.path.split('/').at(-1)
          : url.endsWith('ort-wasm.wasm') ? 'node_modules/onnxruntime-web/dist/ort-wasm.wasm'
          : url.endsWith('ort-wasm-simd.wasm') ? 'node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm' : '';
        if (!file) { errors.push('unexpected download: ' + url); return route.abort(); }
        const bytes = await fs.readFile(file);
        if (corruptFirstDownload) { corruptFirstDownload = false; bytes[0] ^= 1; }
        await route.fulfill({ body: bytes, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
      });
      if (name === 'webkit') await page.addInitScript(() => {
        // Windows WebKit lacks audio output. Verify real inference + native PCM parameters.
        window.nativePCMCalls = [];
        window.LinguaNative = { speechPCM: true, markReady: async () => {}, speechVoices: [], speechAudio: {
          cancel: async () => {},
          playPCM: async (call) => { nativePCMCalls.push({ ...call, pcm: call.pcm.length });
            window.dispatchEvent(new CustomEvent('native-speech-state', { detail: { id: call.id, state: 'playing' } })); },
        } };
      });
      await page.goto(process.argv[3] || 'http://127.0.0.1:5187');
      await page.evaluate(async () => (await import('/js/pronunciation-settings.js')).openPronunciationSheet());
      await page.getByRole('button', { name: '在线音色', exact: true }).click();
      await page.locator('[data-voice-language=ja]').click();
      const female = 'Supertonic 3 · 女声', male = 'Supertonic 3 · 男声';
      await page.getByRole('button', { name: '下载语音包 ' + female, exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.voice-options + [role=status]').textContent.includes('SHA-256'));
      assert.equal(await page.evaluate(async () => (await import('/js/voice-packs.js')).installedVoicePack('ja_JP-supertonic3-female')), false);
      assert.equal(await page.getByRole('radio', { name: /Supertonic 3/ }).count(), 0, 'corrupted download never appears as installed');
      downloads.length = 0;
      await page.getByRole('button', { name: '下载语音包 ' + female, exact: true }).click();
      await page.getByRole('button', { name: '删除语音包 ' + female, exact: true }).waitFor();
      assert.equal(downloads.length, 9, 'first style includes seven shared model/config/license files and one ORT binary');
      await page.locator('.sheet-head [aria-label=关闭]').click();
      await page.locator('[data-voice-language=ko]').click();
      assert.ok((await page.locator('.voice-pack-downloads').textContent()).includes('0.3 MB'));
      await page.getByRole('button', { name: '下载语音包 ' + male, exact: true }).click();
      await page.getByRole('button', { name: '删除语音包 ' + male, exact: true }).waitFor();
      assert.equal(downloads.length, 10, 'Korean reuses the Japanese download and only fetches the new style');
      await page.getByRole('button', { name: '下载语音包 ' + female, exact: true }).click();
      await page.getByRole('button', { name: '删除语音包 ' + female, exact: true }).waitFor();
      await page.locator('.sheet-head [aria-label=关闭]').click();
      await page.locator('[data-voice-language=ja]').click();
      await page.getByRole('button', { name: '下载语音包 ' + male, exact: true }).click();
      await page.getByRole('button', { name: '删除语音包 ' + male, exact: true }).waitFor();
      assert.equal(downloads.length, 12, 'four style entries use one shared model');
      await page.locator('.sheet-head [aria-label=关闭]').click();
      await page.locator('[data-voice-language=ko]').click();
      await page.unroute('https://**/*');
      await page.route('https://**/*', (route) => { errors.push('unexpected synthesis request: ' + route.request().url()); return route.abort(); });
      const result = await page.evaluate(async () => {
        const packs = await import('/js/voice-packs.js'), { AudioLoudness } = await import('/js/audio-loudness.js');
        const { normalizedSpeechPCM } = await import('/js/speech-pcm.js');
        const cases = [['ja', 'ja_JP-supertonic3-female', 'こんにちは。今日はいい天気ですね。'],
          ['ko', 'ko_KR-supertonic3-male', '안녕하세요. 오늘은 날씨가 좋아요.'],
          ['ja', 'ja_JP-supertonic3-male', '学校で日本語を勉強します。'],
          ['ko', 'ko_KR-supertonic3-female', '학교에서 한국어를 공부해요.']];
        const results = [];
        for (const [lang, id, text] of cases) {
          const started = performance.now();
          const output = await packs.synthesizeVoicePack('pack:' + id, text, lang);
          const normalized = normalizedSpeechPCM(output.samples, output.sampleRate, -24);
          let peak = 0, rawPeak = 0;
          for (const n of normalized) peak = Math.max(peak, Math.abs(n));
          for (const n of output.samples) rawPeak = Math.max(rawPeak, Math.abs(n));
          const rawMeter = new AudioLoudness(output.sampleRate, 1); rawMeter.add([output.samples]);
          const applied = Math.min(4, 10 ** ((-24 - rawMeter.value()) / 20), 10 ** (-1 / 20) / rawPeak);
          const meter = new AudioLoudness(output.sampleRate, 1); meter.add([normalized]);
          const replay = await packs.synthesizeVoicePack('pack:' + id, text, lang);
          const { encodeWav } = await import('/js/workbench-media.js');
          const bytes = new Uint8Array(await encodeWav([normalized], output.sampleRate).arrayBuffer());
          let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          results.push({ lang, id, seconds: normalized.length / output.sampleRate, rate: output.sampleRate,
            time: performance.now() - started, lufs: meter.value(), expected: rawMeter.value() + 20 * Math.log10(applied), peak,
            same: replay.samples.every((n, i) => n === output.samples[i]), wav: btoa(binary) });
        }
        return results;
      });
      for (const output of result) {
        console.log(name, 'synthesis measurement', JSON.stringify({ ...output, wav: undefined }));
        assert.equal(output.rate, 44100); assert.ok(output.seconds > 1 && output.seconds < 15);
        assert.ok(Math.abs(output.lufs - output.expected) < .01, `${output.lang} output ${output.lufs} LUFS`);
        assert.ok(output.peak <= 10 ** (-1 / 20) + 1e-7); assert.ok(output.same);
        await fs.writeFile(`.cache/voice-pack-qa/supertonic/${name}-${output.id}.wav`, Buffer.from(output.wav, 'base64'));
        delete output.wav;
      }
      await page.getByRole('radio', { name: /Supertonic 3 · 男声.*已下载语音包/ }).click();
      // Preview reuses exact sample PCM from the above inference; wait for actual completion.
      await page.waitForFunction(() => !document.querySelector('.voice-listen.is-playing'), null, { timeout: 60000 });
      const status = await page.locator('.voice-options + [role=status]').textContent(); assert.equal(status, '');
      for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(async (theme) => (await import('/js/settings.js')).setSetting('theme', theme), theme);
        assert.equal(await page.locator('.sheet-body').evaluate((node) => node.scrollWidth > node.clientWidth), false);
        await page.screenshot({ path: path.resolve(`.cache/voice-pack-qa/supertonic/${name}-${width}-${theme}.png`), animations: 'disabled' });
      }
      await page.reload();
      await page.evaluate(async () => (await import('/js/pronunciation-settings.js')).openPronunciationSheet());
      await page.locator('[data-voice-language=ko]').click();
      assert.equal(await page.getByRole('radio', { name: /Supertonic 3 · 男声.*已下载语音包/ }).getAttribute('aria-checked'), 'true');
      await page.getByRole('button', { name: '删除语音包 ' + male, exact: true }).click();
      await page.getByRole('button', { name: '下载语音包 ' + male, exact: true }).waitFor();
      await page.getByRole('button', { name: '删除语音包 ' + female, exact: true }).click();
      await page.getByRole('button', { name: '下载语音包 ' + female, exact: true }).waitFor();
      const remaining = await page.evaluate(async () => {
        const packs = await import('/js/voice-packs.js'); await packs.refreshVoicePacks();
        return { japanese: packs.installedVoicePack('ja_JP-supertonic3-female'), shared: packs.hasSupertonicModels() };
      });
      assert.ok(remaining.japanese && remaining.shared, 'deleting Korean voice preserves Japanese assets');
      await page.locator('.sheet-head [aria-label=关闭]').click();
      await page.locator('[data-voice-language=ja]').click();
      await page.getByRole('button', { name: '删除语音包 ' + male, exact: true }).click();
      await page.getByRole('button', { name: '下载语音包 ' + male, exact: true }).waitFor();
      await page.getByRole('button', { name: '删除语音包 ' + female, exact: true }).click();
      await page.getByRole('button', { name: '下载语音包 ' + female, exact: true }).waitFor();
      assert.equal(await page.evaluate(async () => (await import('/js/voice-packs.js')).hasSupertonicModels()), false);
      assert.deepEqual(errors, []); console.log(name, 'Japanese/Korean offline checks passed', JSON.stringify(result));
    } finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
