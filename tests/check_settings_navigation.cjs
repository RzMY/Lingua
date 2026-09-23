/** Isolated Chromium/WebKit regression for first-entry navigation and settings.
 * node tests/check_settings_navigation.cjs [playwright-module] [base-url]
 */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5173';

(async () => {
  for (const type of [chromium, webkit]) {
    const browser = await type.launch({ headless: true });
    try {
      for (const start of ['viewHome', 'viewSet']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/api/health*', (route) => route.fulfill({ json: { version: 'test' } }));
        await page.addInitScript(() => {
          localStorage.setItem('linguatrack.config.v1', JSON.stringify({ experimental: 1 }));
          window.entrances = [];
          const animate = Element.prototype.animate;
          Element.prototype.animate = function (frames, options) {
            if (this.id === 'viewWorkbench' || this.id === 'workbenchBody') {
              entrances.push({ id: this.id, transform: frames[0].transform });
            }
            return animate.call(this, frames, options);
          };
        });
        let release;
        const loaded = new Promise((resolve) => { release = resolve; });
        await page.route('**/js/workbench.js', async (route) => { await loaded; await route.continue(); });
        await page.goto(base + '/index.html' + (start === 'viewSet' ? '#set' : ''));
        await page.locator('#navWorkbench').click();
        release();
        await page.locator('.workbench-file').first().waitFor();
        assert.deepEqual(await page.evaluate(() => entrances), [{ id: 'viewWorkbench',
          transform: start === 'viewHome' ? 'translate(14px, 0)' : 'translate(-14px, 0)' }]);
        // Repeated entry must keep the same direction and must not remount the body.
        await page.locator(`[data-go="${start}"]`).click();
        await page.locator('#navWorkbench').click();
        assert.equal(await page.evaluate(() => entrances.length), 2);
        assert.deepEqual(await page.evaluate(() => entrances[1]), await page.evaluate(() => entrances[0]));
        assert.deepEqual(errors, []);
        await context.close();
      }

      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage(), errors = [];
      let stage = 'seed';
      page.on('pageerror', (error) => errors.push(stage + ': ' + error.message));
      await page.route('**/api/health*', (route) => route.fulfill({ json: { version: 'test' } }));
      await page.goto(base + '/index.html');
      const tracks = await page.evaluate(async () => {
        const { createTrack, saveAnalysis } = await import('/js/library.js');
        const { sourceSpec } = await import('/js/langs.js');
        const { setConfig } = await import('/js/config.js');
        const bytes = await fetch('/assets/audio-probe.wav').then((r) => r.arrayBuffer());
        const ids = {};
        for (const kind of ['audio', 'video']) {
          const file = kind === 'audio' ? new File([bytes], 'lesson.wav', { type: 'audio/wav' })
            : new File(['video'], 'lesson.mp4', { type: 'video/mp4' });
          const record = await createTrack(file, { lang: 'en' });
          await saveAnalysis(record.id, { id: record.id, schemaVersion: 2, lang: sourceSpec('en'),
            sentences: [{ text: 'First sentence.', start: 0, end: 1, words: [] },
              { text: 'Second sentence.', start: 1, end: 2, words: [] }] });
          localStorage.setItem('linguatrack.track.' + record.id, JSON.stringify({ tr: 1 }));
          ids[kind] = record.id;
        }
        setConfig({ baseUrl: location.origin + '/mock/v1', model: 'test', concurrency: 1 });
        return ids;
      });
      for (const kind of ['audio', 'video']) {
        stage = kind;
        let release;
        const ready = new Promise((resolve) => { release = resolve; });
        await page.route('**/mock/v1/chat/completions', async (route) => {
          await ready;
          await route.fulfill({ json: { choices: [{ message: { content: '{"1":"第一句。","2":"第二句。"}' } }] } });
        });
        await page.goto(base + '/player.html?track=' + tracks[kind] + '&debug');
        await page.waitForFunction(() => window.LT?.track?.S === 2);
        await page.locator('#btnDisplay').click();
        const progress = page.locator('.sheet .row').filter({ has: page.getByText('翻译进度', { exact: true }) });
        assert.match(await progress.textContent(), /0 \/ 2 句/);
        release();
        await page.waitForFunction(() => [...document.querySelectorAll('.sheet .row')]
          .some((r) => r.textContent.includes('翻译进度2 / 2 句')));

        for (const label of ['字幕字号', '系统字幕字号', ...(kind === 'video' ? ['视频字幕布局'] : [])]) {
          stage = kind + ': ' + label;
          await page.getByRole('button', { name: new RegExp('^' + label) }).click();
          if (label === '系统字幕字号') {
            const input = page.getByRole('spinbutton', { name: '系统字幕字号 (px)' });
            await input.fill('28'); await input.press('Tab');
          }
          if (label === '字幕字号') await page.keyboard.press('Escape');
          else await page.locator('.sheet-head [aria-label="关闭"]').click();
          assert.equal(await page.locator('#sheetTitle').textContent(), kind === 'audio' ? '音频配置' : '视频设置');
          assert.match(await progress.textContent(), /2 \/ 2 句/);
        }
        assert.match(await page.getByRole('button', { name: /^系统字幕字号/ }).textContent(), /28 px/);
        await page.locator('.sheet-head [aria-label="关闭"]').click();
        assert.equal(await page.locator('.sheet').getAttribute('aria-hidden'), 'true');
        await page.unroute('**/mock/v1/chat/completions');
      }
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${type.name()}: first/repeated workbench directions, first-open live progress and audio/video submenu returns`);
    } finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
