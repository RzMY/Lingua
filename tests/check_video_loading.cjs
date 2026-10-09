/** Paused entry regression with real video decoding and optional native clock stubs.
 * node tests/check_video_loading.cjs [playwright-module] [base-url] /path/to/30-second.mp4
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5186';

(async () => {
  const bytes = await fs.readFile(process.argv[4]);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const platform of ['browser', 'ios', 'android']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      try {
        await context.addInitScript((platform) => {
          window.nativePlayCalls = 0;
          if (platform === 'browser') return;
          let state, serial = 0;
          const snapshot = () => ({ ...state, serial: ++serial });
          window.LinguaNative = {
            platform, nativeVideoAudio: true, markReady: async () => {},
            audioPlayer: {
              async begin({ session }) {
                serial = 0;
                state = { session, position: 0, duration: 30, rate: 1, paused: true, ended: false,
                  waiting: false, seeking: false, ready: false, revision: 0 };
              },
              async append() {},
              async prepare() { state.ready = true; return snapshot(); },
              async command(command) {
                state.revision = command.revision;
                if (command.action === 'seek') state.position = command.position;
                if (command.action === 'rate') state.rate = command.rate;
                if (command.action === 'play') { state.paused = false; window.nativePlayCalls++; }
                if (command.action === 'pause') state.paused = true;
                return snapshot();
              },
              async state() { return snapshot(); },
              async release() {},
            },
          };
        }, platform);
        const page = await context.newPage(), errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/fixture.mp4', (route) => route.fulfill({ body: bytes, contentType: 'video/mp4' }));
        await page.goto(base + '/index.html');
        const id = await page.evaluate(async () => {
          const { createPreparedTrack, saveAnalysis } = await import('./js/library.js');
          const blob = await (await fetch('/fixture.mp4')).blob();
          const record = await createPreparedTrack(new File([blob], 'Loading.mp4', { type: 'video/mp4' }), null);
          await saveAnalysis(record.id, { schemaVersion: 2, id: record.id, title: record.title, audio: { duration: 30 },
            lang: { code: 'en', spaceDelimited: true, layers: {}, features: [] },
            sentences: [{ i: 0, start: 0, end: 30, text: 'Hello.', words: [{ text: 'Hello.', pos: 'noun', start: 0, end: 30 }] }] });
          return record.id;
        });
        for (const position of [0, 12]) {
          if (position) {
            await page.evaluate((position) => LT.engine.seek(position), position);
            await page.waitForFunction((position) => !LT.engine.audio.seeking && Math.abs(LT.engine.audio.currentTime - position) < 0.05, position);
          }
          await page.goto(base + '/player.html?track=' + id + '&debug');
          await page.waitForFunction((position) => {
            const video = document.getElementById('video'), media = window.LT?.engine.audio;
            return media && document.querySelector('.has-video') && video.readyState >= 2 && !video.seeking
              && video.paused && media.paused && Math.abs(video.currentTime - position) < 0.1
              && Math.abs(media.currentTime - position) < 0.1;
          }, position);
          const frame = await page.evaluate(() => {
            const video = document.getElementById('video');
            const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18;
            const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 32, 18);
            const pixels = ctx.getImageData(0, 0, 32, 18).data;
            return { visible: pixels.some((value, i) => i % 4 !== 3 && value > 20),
              nativePlays: nativePlayCalls, muted: video.muted };
          });
          assert.equal(frame.visible, true, `${platform}: decoded picture at ${position}s`);
          assert.equal(frame.nativePlays, 0, 'preparing a frame must not play native sound');
          if (platform !== 'browser') assert.equal(frame.muted, true);
          await page.locator('#btnVideoRotate').evaluate((button) => button.click());
          await page.waitForFunction(() => document.getElementById('app').classList.contains('is-immersive'));
          // Chromium's classic PiP uses the real decoded video and a fresh user gesture.
          await page.evaluate(() => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined }));
          await page.locator('#app').evaluate((app) => app.classList.add('controls-visible'));
          await page.locator('#btnToolPip').click();
          await page.waitForFunction(() => document.pictureInPictureElement === document.getElementById('video'));
          assert.equal(await page.evaluate(() => LT.engine.audio.paused && nativePlayCalls === 0), true);
          await page.evaluate(() => document.exitPictureInPicture());
          console.log(`PASS ${platform}: paused frame at ${position}s, landscape and real video PiP before playback`);
        }
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
