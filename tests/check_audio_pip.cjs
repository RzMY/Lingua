/** Real browser/media PiP regression in an isolated context.
 * node tests/check_audio_pip.cjs [playwright-module] [base-url] [mp4-fixture]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5196';
const fixture = process.argv[4];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const output = path.resolve('.cache/audio-pip-qa'); await fs.mkdir(output, { recursive: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base + '/player.html');
    let videoBytes = fixture ? Array.from(await fs.readFile(fixture)) : null;
    await page.evaluate(async (videoBytes) => {
      const { put } = await import('/js/store.js');
      const rate = 8000, samples = rate * 30, bytes = new Uint8Array(44 + samples * 2);
      const v = new DataView(bytes.buffer), s = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
      s(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); s(8, 'WAVE'); s(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      s(36, 'data'); v.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 330 / rate) * 700, true);
      for (const kind of videoBytes ? ['audio', 'video'] : ['audio']) {
        const id = 'pip-' + kind, type = kind === 'video' ? 'video/mp4' : 'audio/wav';
        await put('tracks', id, { id, title: '画中画测试 · ' + kind, lang: 'en', status: 'ready',
          audio: { name: kind === 'video' ? 'lesson.mp4' : 'lesson.wav', type }, duration: 30 });
        await put('audio', id, new Blob([kind === 'video' ? new Uint8Array(videoBytes) : bytes], { type }));
        await put('data', id, { schemaVersion: 2, id, title: 'Lesson', audio: { duration: 30 }, lang: { code: 'en' },
          sentences: ['Listen to the first sentence.', 'Keep practising every day.', 'The audio keeps playing.'].map((text, i) => ({
            i, start: i * 10, end: i * 10 + 10, text, words: text.split(' ').map((text) => ({ text, pos: 'noun' })),
          })) });
      }
    }, videoBytes);
    await page.addInitScript(() => {
      window.nativePipCalls = [];
      const native = new URLSearchParams(location.search).get('native');
      if (!native) return;
      let state = {}, serial = 0, position = 0, anchor = performance.now();
      const snap = () => ({ ...state, serial: ++serial,
        position: state.paused ? position : position + (performance.now() - anchor) / 1000 * state.rate });
      const audioPlayer = {
        begin: async ({ session }) => {
          state = { session, revision: 0, rate: 1, duration: 30, ready: false, paused: true, ended: false, waiting: false, seeking: false };
          position = 0; serial = 0;
        },
        append: async () => {}, prepare: async () => { state.ready = true; return snap(); },
        command: async (value) => {
          position = snap().position; anchor = performance.now(); state.revision = value.revision;
          if (value.action === 'play') state.paused = false;
          if (value.action === 'pause') state.paused = true;
          if (value.action === 'seek') position = value.position;
          if (value.action === 'rate') state.rate = value.rate;
          return snap();
        }, state: async () => snap(), release: async () => {},
      };
      window.LinguaNative = { platform: 'ios', markReady: async () => {}, captionPip: native === 'supported' ? {
        open: async (value) => window.nativePipCalls.push(['open', value]),
        update: async (value) => window.nativePipCalls.push(['update', value]),
        close: async (value) => window.nativePipCalls.push(['close', value]),
      } : null, audioPlayer: native === 'supported' ? audioPlayer : null };
    });
    for (const kind of videoBytes ? ['audio', 'video'] : ['audio']) {
      for (const native of ['', 'old', 'supported']) {
        await page.goto(base + '/player.html?track=pip-' + kind + '&debug&native=' + native);
        await page.waitForFunction(() => window.LT?.track && LT.engine.audio.readyState >= 2);
        if (native === 'supported' && kind === 'audio') {
          assert.equal(await page.evaluate(() => LT.engine.audio.nativeAudio), true);
          assert.equal(await page.locator('#audio').getAttribute('src'), null);
        }
        const button = page.locator('#btnAudioPip');
        assert.equal(await button.isVisible(), native === 'supported');
        if (native !== 'supported') {
          await page.screenshot({ path: path.join(output, kind + '-' + (native || 'browser') + '.png') });
          continue;
        }
        await page.evaluate(() => { LT.engine.seek(12); LT.engine.audio.playbackRate = 1.5; });
        await page.locator('#btnPlay').click();
        await page.waitForFunction(() => !LT.engine.audio.paused && !LT.engine.audio.seeking && LT.engine.audio.readyState >= 2);
        await button.click();
        try { await page.waitForFunction(() => document.querySelector('#app.is-audio-pip')); }
        catch (error) {
          console.error({ kind, native, state: await page.evaluate(() => ({
            readyState: LT.engine.audio.readyState, paused: LT.engine.audio.paused,
            toast: document.getElementById('toast').textContent, calls: window.nativePipCalls,
          })) });
          throw error;
        }
        const state = await page.evaluate(() => window.nativePipCalls.find(([name]) => name === 'open')[1]);
        assert.ok(state.position >= 12); assert.equal(state.rate, 1.5); assert.equal(state.paused, false);
        assert.equal(state.sentences[1].text, 'Keep practising every day.');
        assert.equal(await page.locator('video').count(), 1);
        assert.equal(await page.evaluate(() => !!document.pictureInPictureElement), false);
        await page.locator('#btnDisplay').click();
        const row = page.locator('.row').filter({ has: page.locator('b', { hasText: /^系统字幕字号$/ }) });
        await row.locator('input').fill('28'); await row.locator('input').press('Tab');
        await page.waitForFunction(() => window.nativePipCalls.some(([name, value]) => name === 'update' && value.captionSize === 28));
        await page.locator('.sheet-head [aria-label="关闭"]').click();
        await button.click();
        await page.waitForFunction(() => !document.querySelector('#app.is-audio-pip'));
        assert.equal(await page.evaluate(() => LT.engine.audio.paused), false);
        assert.equal(await page.evaluate(() => LT.engine.audio.playbackRate), 1.5);
        await page.screenshot({ path: path.join(output, kind + '-native-entry.png') });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: entry gating, native bridge wiring, caption size, original audio/video continuity; UIKit rendering requires iPhone QA');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
