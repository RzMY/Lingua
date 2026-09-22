/** Isolated browser checks for subtitle setup, navigation and initial module loading.
 * node tests/check_frontend.cjs [playwright-module] [base-url]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5173';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const shots = path.resolve('.cache/frontend-qa');
  await fs.mkdir(shots, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.route('**/api/health*', (route) => route.fulfill({ json: { version: 'test' } }));
    await page.goto(base + '/index.html');
    await page.locator('#homeBlank').waitFor();
    const initial = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter((r) => r.name.includes('/js/')).map((r) => ({ name: r.name.split('/js/')[1], bytes: r.decodedBodySize })));
    for (const deferred of ['workbench.js', 'workbench-media.js', 'asr-mp3.js', 'backup-ui.js', 'font-settings.js', 'video-settings.js', 'subtitles.js']) {
      assert.ok(!initial.some((r) => r.name === deferred), deferred + ' must load on demand');
    }
    console.log('Initial JS:', initial.length, 'modules,', initial.reduce((n, r) => n + r.bytes, 0), 'bytes');
    const id = await page.evaluate(async () => {
      const { createTrack } = await import('/js/library.js');
      const bytes = await fetch('/assets/audio-probe.wav').then((r) => r.arrayBuffer());
      const record = await createTrack(new File([bytes], 'Evening reflections.wav', { type: 'audio/wav' }), { lang: 'en' });
      return record.id;
    });
    await page.reload();
    await page.locator('.card-hit').waitFor();
    await page.evaluate(() => {
      window.savedCard = document.querySelector('.card');
      document.querySelector('.card-hit').focus();
      window.savedFocus = document.activeElement;
      window.cardMutations = 0;
      new MutationObserver((changes) => { window.cardMutations += changes.length; })
        .observe(document.getElementById('trackList'), { childList: true });
      dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(200);
    assert.deepEqual(await page.evaluate(() => ({ reused: savedCard === document.querySelector('.card'),
      focus: savedFocus === document.activeElement, mutations: cardMutations })), { reused: true, focus: true, mutations: 0 });
    await page.locator('[data-go="viewSet"]').click();
    await page.getByRole('button', { name: '字幕字号', exact: true }).click();
    await page.locator('.font-preview').first().waitFor();
    await page.locator('.sheet-head [aria-label="关闭"]').click();
    await page.evaluate(async () => (await import('/js/config.js')).setConfig({ experimental: 1 }));
    await page.locator('[data-go="viewWorkbench"]').click();
    await page.locator('.workbench-file').first().waitFor();
    await page.locator('[data-go="viewSet"]').click();
    await page.locator('[data-go="viewHome"]').click();
    assert.equal(await page.locator('#viewHome').isVisible(), true);

    await page.goto(base + '/player.html?track=' + id + '&setup=1&debug');
    await page.locator('.setup-pick').waitFor();
    assert.equal(await page.getByRole('button', { name: '开始分析', exact: true }).isDisabled(), true);
    const noOverflow = async () => assert.equal(await page.evaluate(() => {
      const s = document.getElementById('setup'); return s.scrollWidth > s.clientWidth;
    }), false, 'subtitle setup must not overflow horizontally');
    await noOverflow();
    await page.screenshot({ path: path.join(shots, 'setup-light-mobile.png'), animations: 'disabled' });
    await page.locator('.setup-options summary').click();
    await page.screenshot({ path: path.join(shots, 'setup-options-mobile.png'), animations: 'disabled' });
    await page.locator('.setup-options summary').click();
    await page.locator('#setup input[type=file]').setInputFiles({ name: 'wrong.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    assert.equal(await page.getByRole('button', { name: '只导入字幕', exact: true }).isDisabled(), true);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(['1\n00:00:00,000 --> 00:00:01,000\nHello world.\n'],
        'A long subtitle filename — 夜晚的语言练习与听力随记.srt', { type: 'text/plain' }));
      document.querySelector('.setup-card').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
    });
    assert.equal(await page.getByRole('button', { name: '只导入字幕', exact: true }).isEnabled(), true);
    await page.evaluate(async () => (await import('/js/settings.js')).setSetting('theme', 'dark'));
    await page.screenshot({ path: path.join(shots, 'setup-dark-mobile.png'), animations: 'disabled' });
    for (const viewport of [{ width: 320, height: 740 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await noOverflow();
      await page.screenshot({ path: path.join(shots, 'setup-' + viewport.width + '.png'), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    let release;
    await page.route('**/api/analyze*', async (route) => {
      await new Promise((resolve) => { release = resolve; });
      await route.fulfill({ status: 503, json: { error: '暂时不可用，请重试' } });
    });
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.setup-bar.is-busy'));
    assert.equal(await page.locator('.setup-pick').isDisabled(), true);
    assert.equal(await page.locator('#setup fieldset').evaluate((n) => n.disabled), true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.setup-bar i').evaluate((n) => getComputedStyle(n).animationName), 'none');
    while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await page.waitForFunction(() => !document.querySelector('#setup fieldset').disabled);
    await page.getByRole('button', { name: '只导入字幕', exact: true }).click();
    await page.waitForFunction(() => window.LT?.track?.S === 1 && !LT.engine.suspended);
    assert.equal(await page.locator('#setup').isVisible(), false);
    await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === 'running'));
    await page.reload();
    // URL still requests setup: the saved subtitle must be available without another picker.
    await page.waitForFunction(() => document.querySelector('.setup-pick.has-file'));
    assert.equal(await page.getByRole('button', { name: '开始分析', exact: true }).isEnabled(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: lazy modules, unchanged card reuse/focus, navigation, responsive setup, drag/drop, error recovery, raw import and reduced motion');
  } finally { await browser.close(); }
})().catch((err) => { console.error(err); process.exitCode = 1; });
