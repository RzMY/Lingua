/** Browser layout regression for the iOS bridge path (UIKit still requires device QA).
 * node tests/check_native_video.cjs [playwright-module] [base-url] /path/to/video.mp4
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5189';

(async () => {
  const bytes = await fs.readFile(process.argv[4]);
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/fixture.mp4', (route) => route.fulfill({ body: bytes, contentType: 'video/mp4' }));
      // Headless browsers have no notch: supply physical safe areas to exercise the CSS mapping.
      await page.route('**/*.css', async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(/env\(safe-area-inset-(top|right|bottom|left), 0px\)/g,
          (_, side) => `var(--device-safe-${side}, 0px)`);
        await route.fulfill({ response, body });
      });
      await page.addInitScript(() => {
        window.LinguaNative = { platform: 'ios', markReady: async () => {}, target: '' };
        window.fullscreenRequests = 0;
        document.addEventListener('DOMContentLoaded', () => {
          document.documentElement.classList.add('native-app');
          document.documentElement.style.setProperty('--device-safe-top', '47px');
          document.documentElement.style.setProperty('--device-safe-bottom', '34px');
          document.documentElement.requestFullscreen = async () => { window.fullscreenRequests++; };
          document.documentElement.webkitRequestFullscreen = () => { window.fullscreenRequests++; };
        });
      });
      await page.goto(base + '/index.html');
      const id = await page.evaluate(async () => {
        const { createPreparedTrack, saveAnalysis } = await import('./js/library.js');
        const blob = await (await fetch('/fixture.mp4')).blob();
        // Buffer-backed storage avoids the Windows WebKit test runner's File/IDB limitation.
        const record = await createPreparedTrack(new File([blob], 'Native video.mp4', { type: 'video/mp4' }), null);
        await saveAnalysis(record.id, { schemaVersion: 2, id: record.id, title: record.title, audio: { duration: 30 },
          lang: { code: 'en', spaceDelimited: true, layers: {}, features: [] },
          sentences: [{ i: 0, start: 0, end: 30, text: 'Hello.', words: [{ text: 'Hello.', pos: 'noun', start: 0, end: 30 }] }] });
        return record.id;
      });
      await page.goto(base + '/player.html?track=' + id + '&debug');
      if (name === 'webkit') {
        // Windows WebKit has no H.264 decoder. Exercise its real CSS/layout engine
        // with explicit video metadata; real MP4 playback is covered by Chromium.
        await page.waitForFunction(() => window.LT?.track);
        await page.evaluate(() => {
          const video = document.getElementById('video');
          Object.defineProperty(video, 'videoWidth', { value: 1280 });
          Object.defineProperty(video, 'videoHeight', { value: 720 });
          video.dispatchEvent(new Event('loadedmetadata'));
        });
      }
      try {
        await page.waitForFunction(() => window.LT?.track && document.querySelector('.has-video'));
      } catch (error) {
        console.error(name, await page.evaluate(() => ({ body: document.body.innerText,
          mediaError: document.getElementById('video')?.error?.message, track: !!window.LT?.track })), errors);
        throw error;
      }
      await page.evaluate(() => { window.originalVideo = document.getElementById('video'); });
      const click = async (id) => {
        await page.locator('#' + id).evaluate((node) => node.click());
        await page.waitForTimeout(80);
      };
      const check = async (immersive) => {
        await page.waitForFunction((value) => document.getElementById('app').classList.contains('is-immersive') === value, immersive);
        const data = await page.evaluate(() => {
          const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
          return { app: rect('app'), stage: rect('videoStage'), fullscreenRequests, sameVideo: originalVideo === document.getElementById('video'),
            width: innerWidth, height: innerHeight, rotated: document.body.classList.contains('video-rotated'),
            topPadding: getComputedStyle(document.querySelector('.topbar')).paddingLeft,
            bottomPadding: getComputedStyle(document.querySelector('.player')).right };
        });
        assert.equal(data.fullscreenRequests, 0);
        assert.equal(data.sameVideo, true);
        const box = immersive ? data.stage : data.app;
        assert.ok(Math.abs(box.x) < 1 && Math.abs(box.y) < 1, JSON.stringify(data));
        assert.ok(Math.abs(box.width - data.width) < 1 && Math.abs(box.height - data.height) < 1, JSON.stringify(data));
        if (data.rotated) {
          assert.equal(data.topPadding, '47px');
          assert.equal(data.bottomPadding, '34px');
        }
      };
      await check(false);
      // Use actual touch input: DOM .click() bypasses WebKit's synthetic-click path.
      const tap = async (id) => {
        const box = await page.locator('#' + id).boundingBox();
        assert.ok(box, `${id} must be visible`);
        assert.equal(await page.evaluate(({ id, box }) => {
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return hit?.closest('button')?.id === id;
        }, { id, box }), true, `${name}: ${id} must not be covered by a toast or video`);
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      };
      const closeDialog = async () => {
        await page.locator('.sheet-acts [aria-label="关闭"]').tap();
        await page.waitForFunction(() => !document.querySelector('.scrim.is-open'));
        await page.waitForFunction(() => {
          const sheet = document.querySelector('.sheet');
          return !sheet || sheet.getBoundingClientRect().top >= innerHeight;
        });
      };
      for (const subtitles of [1, 0]) {
        await page.evaluate(async (value) => {
          const { setVideoCfg } = await import('./js/trackcfg.js');
          setVideoCfg({ subtitles: value });
          document.getElementById('app').classList.remove('controls-visible');
        }, subtitles);
        for (const id of ['btnPin', 'btnRepeat']) {
          const before = await page.locator('#' + id).evaluate((button) => button.getAttribute('aria-pressed') + button.textContent);
          await tap(id);
          const after = await page.locator('#' + id).evaluate((button) => button.getAttribute('aria-pressed') + button.textContent);
          assert.notEqual(after, before, `${name}: ${id} responds on first tap`);
        }
        for (const id of ['btnSpeed', 'btnExplain']) {
          await tap(id);
          await page.waitForFunction(() => document.querySelector('.sheet.is-open'));
          await closeDialog();
        }
        assert.equal(await page.locator('#app').evaluate((node) => node.classList.contains('controls-visible')), false,
          `${name}: portrait toolbar does not reveal picture controls (subtitles=${subtitles})`);
      }
      await page.evaluate(async () => {
        const { setVideoCfg } = await import('./js/trackcfg.js');
        setVideoCfg({ subtitles: 1 });
      });
      if (name === 'chromium') {
        await tap('btnPlay');
        await page.waitForFunction(() => !document.getElementById('video').paused);
        await tap('btnPlay');
        assert.equal(await page.locator('#video').evaluate((video) => video.paused), true);
      }
      for (let i = 0; i < 3; i++) {
        await click('btnVideoRotate'); await check(true);
        await click('btnToolRotate'); await check(false);
      }
      await click('btnVideoRotate');
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => !document.body.classList.contains('video-rotated'));
      await check(true);
      await page.setViewportSize({ width: 390, height: 844 }); await check(false);
      assert.equal(await page.locator('body').evaluate((node) => node.classList.contains('video-rotated')), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}: portrait toolbar first-touch response, native iOS bridge path, repeated fullscreen, physical rotation, safe areas and unchanged media${name === 'webkit' ? ' (synthetic metadata; no H.264 decoder on Windows)' : ''}`);
    } finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
