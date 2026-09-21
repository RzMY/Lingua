/** Real media, local imports and setting previews in fresh browser contexts.
 * node tests/check_optional_subtitles.cjs [playwright-module] [base-url] [mp4-fixture]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5173';
const fixture = process.argv[4];

(async () => {
  const shots = path.resolve('.cache/optional-subtitles-qa');
  await fs.mkdir(shots, { recursive: true });
  for (const browserType of [chromium]) {
    const browser = await browserType.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = [];
      let analyses = 0;
      page.on('pageerror', (err) => errors.push(err.message));
      await page.route('**/api/health*', (route) => route.fulfill({ json: { version: 'test' } }));
      await page.route('**/api/analyze*', (route) => {
        analyses++;
        const q = new URL(route.request().url()).searchParams;
        return route.fulfill({ json: { track: { schemaVersion: 2, id: q.get('id'), title: 'Optional',
          lang: { code: 'en', layers: { read: 'IPA', roman: 'Lemma' }, layerOrder: ['read', 'roman'],
            features: ['read', 'roman', 'tr', 'pos', 'card'] }, audio: { duration: 30 },
          sentences: [{ i: 0, start: 0, end: 30, text: 'Hello world.', wordTiming: false,
            words: [{ text: 'Hello', pos: 'interj', read: 'hello' }, { text: 'world.', pos: 'noun' }] }],
          stats: { sentences: 1, words: 2 } } } });
      });
      await page.goto(base + '/index.html');
      await page.locator('[data-go="viewSet"]').click();
      await page.getByRole('button', { name: /^视频设置/ }).click();
      await page.locator('.video-preview').waitFor();
      const position = page.getByRole('spinbutton', { name: '字幕位置 (%)', exact: true });
      await position.fill('60'); await position.press('Tab');
      await page.screenshot({ path: path.join(shots, browserType.name() + '-global-video.png') });
      await page.getByRole('button', { name: /^视频字幕字号/ }).click();
      const size = page.getByRole('spinbutton', { name: '原文字号 (px)', exact: true });
      await size.fill('32'); await size.press('Tab');
      assert.equal(await page.locator('.video-preview .font-preview-text').first().evaluate((n) => getComputedStyle(n).fontSize), '32px');
      await page.screenshot({ path: path.join(shots, browserType.name() + '-video-font.png') });
      await page.locator('.sheet-head [aria-label="关闭"]').click();
      await page.getByRole('button', { name: /^视频设置/ }).click();
      await page.getByRole('button', { name: /^系统字幕字号/ }).click();
      const caption = page.getByRole('spinbutton', { name: '系统字幕字号 (px)' });
      await caption.fill('28'); await caption.press('Tab');
      assert.equal(await page.locator('.caption-preview-text').evaluate((n) => getComputedStyle(n).fontSize), '28px');
      await page.screenshot({ path: path.join(shots, browserType.name() + '-caption.png') });
      const videoBytes = [...await fs.readFile(fixture)];
      const ids = await page.evaluate(async (bytes) => {
        const { createTrack } = await import('/js/library.js');
        const video = await createTrack(new File([new Uint8Array(bytes)], 'Optional.mp4', { type: 'video/mp4' }), { lang: 'en' });
        const rate = 8000, samples = rate * 30, wav = new Uint8Array(44 + samples * 2);
        const view = new DataView(wav.buffer);
        const str = (at, text) => [...text].forEach((c, i) => { wav[at + i] = c.charCodeAt(0); });
        str(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        str(36, 'data'); view.setUint32(40, samples * 2, true);
        const audio = await createTrack(new File([wav], 'Optional.wav', { type: 'audio/wav' }), { lang: 'en' });
        return { video: video.id, audio: audio.id };
      }, videoBytes);
      for (const [kind, id] of Object.entries(ids)) {
        await page.goto(base + '/player.html?track=' + id + '&debug');
        await page.waitForFunction(() => window.LT?.track && LT.engine.audio.readyState >= 2);
        assert.equal(await page.locator('#setup').isVisible(), false);
        assert.equal(await page.evaluate(() => LT.track.S), 0);
        assert.equal(await page.evaluate(async () => (await import('/js/trackcfg.js')).trackCfg.video.captionSize), 28);
        await page.locator('#btnPlay').click();
        await page.waitForFunction(() => LT.engine.audio.currentTime > .1);
        await page.locator('#btnPlay').click();
        await page.getByRole('button', { name: '导入字幕（可选）', exact: true }).click();
        await page.getByRole('button', { name: '跳过，直接播放' }).click();
        assert.equal(await page.locator('#setup').isVisible(), false);
        await page.getByRole('button', { name: '导入字幕（可选）', exact: true }).click();
        await page.locator('#setup input[type=file]').setInputFiles({ name: 'optional.srt', mimeType: 'text/plain',
          buffer: Buffer.from('1\n00:00:00,000 --> 00:00:15,000\nHello world.\n\n2\n00:00:15,000 --> 00:00:30,000\nKeep learning every day.\n') });
        await page.getByRole('button', { name: '只导入字幕', exact: true }).click();
        await page.waitForFunction(() => LT.track.S === 2);
        assert.equal(analyses, kind === 'video' ? 0 : 1);
        assert.equal(await page.locator('#btnExplain').isDisabled(), true);
        await page.reload();
        await page.waitForFunction(() => LT.track?.S === 2 && LT.engine.audio.readyState >= 2);
        assert.equal(await page.locator('#setup').isVisible(), false);
        await page.locator('#btnPlay').click();
        await page.waitForFunction(() => LT.engine.audio.currentTime > .1);
        await page.locator('#btnPlay').click();
        await page.evaluate(() => LT.engine.seek(17));
        await page.waitForFunction(() => LT.reader.activeS === 1);
        await page.screenshot({ path: path.join(shots, browserType.name() + '-' + kind + '-raw.png') });
        await page.locator('#btnDisplay').click();
        await page.getByRole('button', { name: /^字幕管理/ }).click();
        await page.getByRole('button', { name: '开始分析', exact: true }).click();
        await page.waitForFunction(() => LT.track.S === 1 && LT.track.supports('read'));
        assert.equal(await page.locator('#btnExplain').isDisabled(), false);
      }
      assert.equal(analyses, 2);
      await page.goto(base + '/player.html?track=' + ids.video + '&debug');
      await page.waitForFunction(() => LT.track && document.querySelector('.has-video'));
      for (const viewport of [{ width: 844, height: 390 }, { width: 1440, height: 900 }]) {
        await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
        await page.setViewportSize(viewport);
        await page.evaluate(() => document.getElementById('btnToolSettings').click());
        await page.getByRole('button', { name: '字幕字号', exact: true }).click();
        await page.screenshot({ path: path.join(shots, browserType.name() + '-font-' + viewport.width + '.png') });
        const bounds = await page.locator('.sheet').evaluate((n) => ({ width: n.offsetWidth, height: n.offsetHeight, viewW: innerWidth, viewH: innerHeight }));
        assert.ok(bounds.width <= bounds.viewW && bounds.height <= bounds.viewH, JSON.stringify(bounds));
        await page.locator('.sheet-head [aria-label="关闭"]').click();
      }
      assert.deepEqual(errors, []);
      console.log('PASS ' + browserType.name() + ': optional subtitles, playback, later analysis, global inheritance and previews');
    } finally { await browser.close(); }
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
