/** Real Piper inference from verified fixture bytes, including offline replay and narrow layouts.
 * node tests/check_voice_packs.cjs /path/to/playwright [base-url]
 * Fixtures: .cache/voice-pack-qa/lessac.onnx{,.json}, and npm-installed runtime binaries.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
(async () => {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors = [], external = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('https://**/*', async (route) => {
        const url = route.request().url(); external.push(url);
        const file = url.endsWith('.onnx.json') ? '.cache/voice-pack-qa/lessac.onnx.json'
          : url.endsWith('.onnx') ? '.cache/voice-pack-qa/lessac.onnx'
          : url.endsWith('piper_phonemize.wasm') ? 'node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.wasm'
          : url.endsWith('piper_phonemize.data') ? 'node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.data'
          : url.endsWith('ort-wasm.wasm') ? 'node_modules/onnxruntime-web/dist/ort-wasm.wasm' : '';
        if (!file) return route.abort();
        await route.fulfill({ status: 200, body: await fs.readFile(file), contentType: 'application/octet-stream',
          headers: { 'access-control-allow-origin': '*' } });
      });
      await page.goto(process.argv[3] || 'http://127.0.0.1:5187');
      if (name === 'webkit') {
        // Windows WebKit has no audio backend. Exercise real WASM with the native
        // output contract; speaker playback remains a device acceptance check.
        await page.addInitScript(() => {
          window.LinguaNative = { speechPCM: true, markReady: async () => {}, speechAudio: {
            cancel: async () => {},
            playPCM: async ({ id }) => window.dispatchEvent(new CustomEvent('native-speech-state', { detail: { id, state: 'playing' } })),
          }, speechVoices: [] };
        });
        await page.reload();
      }
      await page.evaluate(async () => (await import('/js/pronunciation-settings.js')).openPronunciationSheet());
      await page.getByRole('button', { name: '在线音色', exact: true }).click();
      await page.locator('[data-voice-language="en"]').click();
      await page.getByRole('button', { name: '下载语音包 Lessac', exact: true }).click();
      await page.getByRole('button', { name: '删除语音包 Lessac', exact: true }).waitFor({ timeout: 60000 });
      assert.equal(external.length, 5, 'explicit download includes model, config and all common binaries');
      await page.unroute('https://**/*');
      await page.route('https://**/*', (route) => { errors.push('unexpected inference network: ' + route.request().url()); return route.abort(); });
      await page.getByRole('radio', { name: /Lessac.*已下载语音包/ }).click();
      // Test the production worker directly and measure actual generated speech after playback normalization.
      const result = await page.evaluate(async () => {
        const packs = await import('/js/voice-packs.js'), pcm = await import('/js/speech-pcm.js');
        const { AudioLoudness } = await import('/js/audio-loudness.js');
        const output = await packs.synthesizeVoicePack('pack:en_US-lessac-medium', 'Hello! It is a lovely day.', 'en');
        const normalized = pcm.normalizedSpeechPCM(output.samples, output.sampleRate, -24);
        const meter = new AudioLoudness(output.sampleRate, 1); meter.add([normalized]);
        return { rate: output.sampleRate, seconds: output.samples.length / output.sampleRate, lufs: meter.value(),
          key: (await import('/js/settings.js')).settings.pronunciation.voices.en };
      });
      assert.equal(result.rate, 22050); assert.ok(result.seconds > 1 && result.seconds < 10);
      assert.ok(Math.abs(result.lufs + 24) < .01); assert.equal(result.key, 'pack:en_US-lessac-medium');
      for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(async (theme) => (await import('/js/settings.js')).setSetting('theme', theme), theme);
        assert.equal(await page.locator('.sheet-body').evaluate((node) => node.scrollWidth > node.clientWidth), false);
        await fs.mkdir('.cache/voice-pack-qa', { recursive: true });
        await page.screenshot({ path: path.resolve(`.cache/voice-pack-qa/${name}-${width}-${theme}.png`), animations: 'disabled' });
      }
      // Page reload must retain the pack and selection; missing assets must never select system speech silently.
      await page.reload();
      await page.evaluate(async () => (await import('/js/pronunciation-settings.js')).openPronunciationSheet());
      await page.locator('[data-voice-language="en"]').click();
      await page.getByRole('radio', { name: /Lessac.*已下载语音包/ }).waitFor();
      assert.equal(await page.getByRole('radio', { name: /Lessac.*已下载语音包/ }).getAttribute('aria-checked'), 'true');
      await page.getByRole('button', { name: '删除语音包 Lessac', exact: true }).click();
      await page.getByRole('button', { name: '下载语音包 Lessac', exact: true }).waitFor();
      await page.evaluate(async () => {
        const { createPronunciation } = await import('/js/pronunciation.js');
        const events = [], session = createPronunciation({ track: { lang: 'en' }, word: { text: 'Hello' }, onState: (e) => events.push(e) });
        await session.play('standard', { onlineVoices: true, voices: { en: 'pack:en_US-lessac-medium' } }); session.dispose();
        if (!events.some((e) => e.message.includes('尚未下载或已删除'))) throw Error('missing package must produce an actionable error');
      });
      assert.deepEqual(errors, []);
      console.log(name, 'real offline voice package checks passed', JSON.stringify(result));
    } finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
