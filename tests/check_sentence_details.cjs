/** Isolated layout and interaction checks for long-press sentence details.
 * node tests/check_sentence_details.cjs [playwright-module] [base-url]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const engines = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5173';

(async () => {
  const output = path.resolve('.cache/sentence-details-qa');
  await fs.mkdir(output, { recursive: true });
  for (const name of ['chromium', 'webkit']) {
    const browser = await engines[name].launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(10000);
      await page.goto(base + '/index.html');
      const id = await page.evaluate(async () => {
        const { createTrack, saveAnalysis } = await import('/js/library.js');
        const { sourceSpec } = await import('/js/langs.js');
        const bytes = await fetch('/assets/audio-probe.wav').then((r) => r.arrayBuffer());
        const record = await createTrack(new File([bytes], 'Sentence details.wav', { type: 'audio/wav' }), { lang: 'ja' });
        const words = [
          { text: '明日', read: 'あした', roman: 'ashita', pos: 'noun' },
          { text: 'は', roman: 'wa', pos: 'particle' },
          { text: '図書館', read: 'としょかん', roman: 'toshokan', pos: 'noun' },
          { text: 'で', roman: 'de', pos: 'particle' },
          { text: '日本語', read: 'にほんご', roman: 'nihongo', pos: 'noun' },
          { text: 'を', roman: 'o', pos: 'particle' },
          { text: '勉強', read: 'べんきょう', roman: 'benkyou', pos: 'noun' },
          { text: 'します', roman: 'shimasu', pos: 'verb', lemma: 'する', conj: '丁寧形' },
          { text: '。', pos: 'punct' },
        ];
        const sentence = { text: words.map((w) => w.text).join(''), start: 0, end: 2, words, wordTiming: false,
          translations: { 'zh-CN': '明天我会在图书馆学习日语。' } };
        await saveAnalysis(record.id, { schemaVersion: 2, id: record.id, lang: sourceSpec('ja'),
          sentences: [sentence], hasWordTiming: false, audio: { duration: 2 } });
        localStorage.setItem('linguatrack.track.' + record.id, JSON.stringify({ tr: 0, read: 1, roman: 1, pos: 1 }));
        return record.id;
      });
      const open = async () => {
        if (await page.locator('.sheet-explain.is-open').isVisible()) return;
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const box = await page.locator('#viewport .s .w').first().boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.locator('.sheet-explain.is-open').waitFor();
        await page.mouse.up();
        await page.waitForFunction(() => document.querySelector('#explainPreview .s-tr')?.textContent);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      await page.goto(base + '/player.html?track=' + id + '&debug');
      await page.waitForFunction(() => window.LT?.track?.S === 1);
      const readerHeight = await page.locator('#scroller').evaluate((n) => n.clientHeight);
      for (const [width, height, theme] of [[390, 844, 'light'], [320, 740, 'dark'], [1440, 900, 'light'], [844, 390, 'dark']]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(async (theme) => (await import('/js/settings.js')).setSetting('theme', theme), theme);
        await open();
        const layout = await page.evaluate(() => {
          const sheet = document.querySelector('.sheet-explain'), preview = document.querySelector('#explainPreview');
          const words = document.querySelector('#explainBody'), footer = document.querySelector('.sheet-foot');
          const rect = (n) => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
          return { sheet: rect(sheet), preview: rect(preview), words: rect(words), footer: rect(footer),
            overflow: [...sheet.querySelectorAll('.explain-preview, .explain-words, .explain-actions')]
              .some((n) => n.scrollWidth > n.clientWidth + 1),
            translation: preview.querySelector('.s-tr').textContent,
            translationVisible: getComputedStyle(preview.querySelector('.s-tr')).display !== 'none',
            count: words.querySelectorAll('.gw').length };
        });
        assert.equal(layout.overflow, false);
        assert.equal(layout.translation, '明天我会在图书馆学习日语。');
        assert.equal(layout.translationVisible, true);
        assert.equal(layout.count, 8);
        assert.equal(await page.locator('.sheet-explain #sheetTitle').textContent(), '句子拆解 · 1 / 1');
        assert.equal(await page.locator('.sheet-explain .explain-sound').count(), 0);
        assert.deepEqual(await page.locator('.explain-actions button').allTextContents(), ['收藏', '修改', '大模型讲解']);
        const before = await page.locator('#audio').evaluate((n) => n.currentTime);
        await page.locator('#explainBody .gw[data-j="2"] .gw-pick').click();
        assert.equal(await page.locator('#explainPreview .w.is-cur').getAttribute('data-j'), '2');
        assert.equal(await page.locator('#audio').evaluate((n) => n.currentTime), before);
        assert.ok(layout.words.height >= 48, 'the word list retains at least one tappable row: ' + JSON.stringify({ width, height, layout }));
        assert.ok(layout.preview.bottom <= layout.words.top && layout.words.bottom <= layout.footer.top + 1);
        assert.ok(Math.abs(layout.sheet.bottom - height) < 1);
        if (height > 500) assert.ok(Math.abs(layout.sheet.height - height * .68) < 1);
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) });
        await page.locator('#explainBody').evaluate((n) => n.scrollTop = n.scrollHeight);
        const previewTop = (await page.locator('#explainPreview').boundingBox()).y;
        assert.ok(Math.abs(previewTop - layout.preview.top) < 1, JSON.stringify({ layout, previewTop }));
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.querySelector('.sheet').contains(document.activeElement)), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#explainPanel').isVisible(), false);
        await open();
        await page.getByRole('button', { name: '修改', exact: true }).click();
        await page.locator('.subtitle-editor').waitFor();
        assert.ok(Math.abs((await page.locator('.sheet').boundingBox()).height - layout.sheet.height) < 1, 'subtitle editor shares the sentence detail height');
        await page.locator('.sheet-head [aria-label="关闭"]').click();
        await page.locator('.sheet-explain.is-open').waitFor();
        await open();
        await page.getByRole('button', { name: '大模型讲解', exact: true }).click();
        await page.locator('.sheet-chat.is-open').waitFor();
        assert.ok(Math.abs((await page.locator('.sheet').boundingBox()).height - layout.sheet.height) < 1, 'model explanation shares the sentence detail height');
        await page.locator('.sheet-head [aria-label="关闭"]').click();
        await page.locator('.sheet-explain.is-open').waitFor();
        await page.keyboard.press('Escape');
      }
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.locator('#scroller').evaluate((n) => n.clientHeight), readerHeight);
      await open();
      await page.getByRole('button', { name: '修改', exact: true }).click();
      await page.locator('.subtitle-editor').waitFor();
      assert.equal(await page.locator('.subtitle-editor textarea').first().inputValue(), '明日は図書館で日本語を勉強します。');
      await page.locator('.sheet-head [aria-label="关闭"]').click();
      await page.locator('.sheet-explain.is-open').waitFor();
      await open();
      await page.getByRole('button', { name: '大模型讲解', exact: true }).click();
      await page.locator('.sheet-chat.is-open').waitFor();
      assert.equal(await page.locator('#sheetTitle').textContent(), '讲解 · 第 1 句');
      await page.locator('.sheet-head [aria-label="关闭"]').click();
      await page.locator('.sheet-explain.is-open').waitFor();
      await page.keyboard.press('Escape');
      // Exercise the same CSS canvas used by physical and fallback video rotation.
      for (const rotated of [false, true]) {
        await page.setViewportSize(rotated ? { width: 390, height: 844 } : { width: 844, height: 390 });
        await page.evaluate((rotated) => {
          document.documentElement.classList.add('video-immersive');
          document.body.classList.toggle('video-rotated', rotated);
          document.body.style.setProperty('--video-view-w', '844px');
          document.body.style.setProperty('--video-view-h', '390px');
          document.body.style.setProperty('--rotated-width', '844px');
          document.body.style.setProperty('--rotated-height', '390px');
        }, rotated);
        await open();
        const logicalHeight = () => page.locator('.sheet-sentence').evaluate((n) => n.offsetHeight);
        const detailHeight = await logicalHeight();
        assert.ok(Math.abs(detailHeight - 390 * .86) < 1);
        await page.screenshot({ path: path.join(output, `${name}-video-${rotated ? 'rotated' : 'landscape'}.png`) });
        await page.getByRole('button', { name: '修改', exact: true }).click();
        await page.locator('.subtitle-editor').waitFor();
        assert.equal(await logicalHeight(), detailHeight);
        await page.keyboard.press('Escape');
        await page.locator('.sheet-explain.is-open').waitFor();
        await open();
        await page.getByRole('button', { name: '大模型讲解', exact: true }).click();
        await page.locator('.sheet-chat.is-open').waitFor();
        assert.equal(await logicalHeight(), detailHeight);
        await page.keyboard.press('Escape');
        await page.locator('.sheet-explain.is-open').waitFor();
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
          document.documentElement.classList.remove('video-immersive');
          document.body.classList.remove('video-rotated');
        });
      }
      assert.deepEqual(errors, []);
      console.log(name + ': sentence details layout, translation, scrolling and actions passed');
    } finally { await browser.close(); }
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
