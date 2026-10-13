/** Isolated real-browser favorites checks. node tests/check_favorites.cjs [playwright-module] [base-url] */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const engines = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5173';

(async () => {
  const shots = path.resolve('.cache/favorites-qa'); await fs.mkdir(shots, { recursive: true });
  for (const name of (process.env.FAVORITES_BROWSER ? [process.env.FAVORITES_BROWSER] : ['chromium', 'webkit'])) {
    const browser = await engines[name].launch({ headless: true });
    let stage = 'start';
    const watchdog = setTimeout(() => { console.error(name + ' timed out at ' + stage); void browser.close(); }, 45000);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      await page.addInitScript(() => {
        window.favoriteSpeech = { texts: [], cancelled: 0 };
        window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
        Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
          getVoices: () => [], speak: (u) => { window.favoriteSpeech.texts.push(u.text); u.onstart?.(); },
          cancel: () => window.favoriteSpeech.cancelled++,
        } });
      });
      const openFilters = async () => {
        await page.getByRole('button', { name: /^筛选收藏/ }).click();
        await page.waitForFunction(() => document.querySelector('.sheet.is-open')?.contains(document.activeElement));
      };
      const setFilter = async (label, value) => {
        await openFilters();
        await page.getByRole('group', { name: label, exact: true }).locator(`[data-value="${value}"]`).click();
        await page.getByRole('button', { name: '完成', exact: true }).click();
      };
      const errors = []; page.on('pageerror', (err) => errors.push(err.message));
      await page.goto(base + '/index.html#favorites');
      await page.getByText('收藏你的第一个词句', { exact: true }).waitFor();
      assert.equal(await page.locator('.favorites').getByRole('button', { name: '导出', exact: true }).count(), 0);
      assert.equal(await page.locator('.fav-blank p').count(), 0);
      await page.screenshot({ path: path.join(shots, name + '-empty.png') });
      stage = 'seed';
      await page.evaluate(async () => {
        const { writeBatch } = await import('/js/store.js');
        const { favoriteWordKey } = await import('/js/favorite-learning.js');
        const duration = 12, rate = 8000, bytes = new ArrayBuffer(44 + duration * rate * 2), v = new DataView(bytes);
        const str = (at, text) => [...text].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
        str(0, 'RIFF'); v.setUint32(4, bytes.byteLength - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        str(36, 'data'); v.setUint32(40, bytes.byteLength - 44, true);
        const id = 'favorites-qa', row = (value) => [{ key: id, value, track: id }];
        await writeBatch({
          tracks: row({ id, title: 'Small steps, every day', lang: 'en', status: 'ready', duration,
            audio: { name: 'lesson.wav', type: 'audio/wav' }, createdAt: new Date().toISOString() }),
          audio: row({ storage: 'chunks-v1', prefix: id + '|media', count: 1, type: 'audio/wav', size: bytes.byteLength }),
          audioChunks: [{ key: id + '|media|0', value: bytes, track: id }],
          data: row({ schemaVersion: 2, id, title: 'Small steps, every day', lang: { code: 'en' },
            audio: { duration }, hasWordTiming: true, sentences: [
              { i: 0, text: 'Keep going.', start: 1, end: 4, wordTiming: true,
                words: [{ text: 'Keep', pos: 'verb', read: 'kiːp', start: 1, end: 2 }, { text: 'going', pos: 'verb', start: 2, end: 4 }] },
              { i: 1, text: 'Small steps make a difference.', start: 5, end: 8, words: [
                { text: 'Small', pos: 'adj', read: 'smɔːl' }, { text: 'steps', pos: 'noun', lemma: 'step', read: 'steps' },
                { text: 'make', pos: 'verb' }, { text: 'a', pos: 'det' }, { text: 'difference', pos: 'noun' },
              ] },
            ] }),
          word: [{ key: favoriteWordKey(id, 'zh-CN', 0, 0, 'Keep', 'Keep going.'), track: id,
            value: { gloss: '坚持', note: '鼓励对方继续努力。', forms: [{ text: 'keep going', gloss: '继续前进' }] } }],
          chat: [{ key: id + '|1', track: id, value: { text: 'Small steps make a difference.', msgs: [
            { role: 'user', content: '解释这句' }, { role: 'assistant', content: '**make a difference** 表示产生影响。<img src=x onerror=alert(1)>' },
          ] } }],
        });
        localStorage.setItem('linguatrack.track.' + id, JSON.stringify({ tr: 0, card: 1 }));
      });
      stage = 'player'; console.log(name + ': seed complete');
      await page.goto(base + '/player.html?track=favorites-qa&debug');
      const word = page.locator('.s[data-i="0"] .w[data-j="0"]'); await word.click();
      await page.locator('.wc-favorite').click();
      await page.waitForFunction(() => document.querySelector('.wc-favorite')?.getAttribute('aria-pressed') === 'true');
      await page.screenshot({ path: path.join(shots, name + '-word.png') });
      await page.locator('.wc-a-main').click();
      // Reopen the same card to check persistent saved state.
      await word.click();
      await page.waitForFunction(() => document.querySelector('.wc-favorite')?.getAttribute('aria-pressed') === 'true');
      await page.locator('.wc-a-main').click();
      const s = page.locator('.s[data-i="1"]');
      const r = await s.boundingBox(); await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down(); await page.waitForTimeout(550); await page.mouse.up();
      await page.locator('#explainFavorite button').click();
      await page.waitForFunction(() => document.querySelector('#explainFavorite button')?.getAttribute('aria-pressed') === 'true');
      await page.screenshot({ path: path.join(shots, name + '-sentence.png') });
      await page.locator('#btnExplainClose').click();
      await page.goto(base + '/index.html#favorites');
      await page.waitForFunction(() => document.querySelectorAll('.fav-card').length === 2);
      // Details and notes render untrusted text literally.
      stage = 'details';
      const keepCard = () => page.locator('.fav-card').filter({ has: page.getByRole('button', { name: '查看收藏详情：Keep', exact: true }) });
      assert.equal(await page.locator('.fav-source').count(), 0);
      await keepCard().locator('.fav-context').click();
      await page.getByRole('heading', { name: '相关词组与形式', exact: true }).waitFor();
      assert.equal(await page.locator('.fav-detail').getByText('Small steps, every day', { exact: true }).count(), 0);
      assert.match(await page.locator('.fav-forms').innerText(), /keep going/);
      await page.getByRole('button', { name: '标准发音', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.favoriteSpeech.texts), ['Keep']);
      if (name === 'chromium') {
        await page.waitForFunction(() => ![...document.querySelectorAll('.fav-sounds button')][0].disabled);
        await page.getByRole('button', { name: '原文音频', exact: true }).click();
        await page.waitForFunction(() => { const audio = document.querySelector('body > audio'); return audio && !audio.paused && audio.currentTime >= .96; });
        await page.waitForFunction(() => !document.querySelector('body > audio'));
      }
      await page.screenshot({ path: path.join(shots, `${name}-word-detail.png`) });
      await page.getByRole('textbox', { name: '学习笔记' }).fill('鼓励自己，坚持下去。<img src=x onerror=alert(1)>');
      await page.getByRole('button', { name: '保存笔记', exact: true }).click();
      await page.locator('.fav-note').waitFor(); assert.equal(await page.locator('.fav-note img').count(), 0);
      const sentenceCard = page.locator('.fav-card').filter({ has: page.getByRole('button', { name: '查看收藏详情：Small steps make a difference.', exact: true }) });
      await sentenceCard.locator('.fav-answer').click();
      await page.getByRole('heading', { name: '句子拆解', exact: true }).waitFor();
      assert.match(await page.locator('.fav-breakdown').innerText(), /原形 step/);
      await page.getByRole('heading', { name: '大模型讲解', exact: true }).waitFor();
      assert.equal(await page.locator('.fav-model-notes img').count(), 0);
      await page.getByRole('button', { name: '标准发音', exact: true }).click();
      assert.equal(await page.evaluate(() => window.favoriteSpeech.texts.at(-1)), 'Small steps make a difference.');
      await page.screenshot({ path: path.join(shots, `${name}-sentence-detail.png`) });
      if (name === 'chromium') {
        await page.waitForFunction(() => !document.querySelector('.fav-sounds button').disabled);
        await page.getByRole('button', { name: '原文音频', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('body > audio')?.currentTime >= 5);
      }
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      assert.equal(await page.locator('body > audio').count(), 0);
      assert.ok(await page.evaluate(() => window.favoriteSpeech.cancelled > 0));
      stage = 'filters';
      await keepCard().getByRole('button', { name: '标为掌握', exact: true }).click();
      await setFilter('学习状态', 'mastered');
      await page.waitForFunction(() => document.querySelectorAll('.fav-card').length === 1);
      assert.equal(await page.locator('.fav-filter-button').getAttribute('aria-label'), '筛选收藏（已应用）');
      await openFilters();
      assert.equal(await page.getByRole('group', { name: '学习状态', exact: true }).locator('[aria-pressed="true"]').getAttribute('data-value'), 'mastered');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.fav-filter-button').getAttribute('aria-expanded'), 'false');
      await page.getByRole('searchbox', { name: '搜索收藏' }).fill('鼓励');
      await page.waitForTimeout(180); assert.equal(await page.locator('.fav-card').count(), 1);
      await page.getByRole('button', { name: '清空', exact: true }).click();
      await setFilter('学习状态', '');
      await page.getByRole('button', { name: '单词 1', exact: true }).click();
      assert.equal(await page.locator('.fav-card').count(), 1);
      await page.getByRole('button', { name: '全部 2', exact: true }).click();
      await page.getByRole('button', { name: '自测', exact: true }).click();
      assert.equal(await keepCard().locator('.fav-answer').isVisible(), false);
      await keepCard().getByRole('button', { name: '查看释义', exact: true }).click();
      assert.equal(await keepCard().locator('.fav-answer').isVisible(), true);
      await page.getByRole('button', { name: '自测', exact: true }).click();
      await keepCard().getByRole('button', { name: '移除收藏：Keep', exact: true }).click();
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.fav-card').length === 2);
      await page.reload(); await page.locator('.fav-note').waitFor();
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async (theme) => (await import('/js/settings.js')).setSetting('theme', theme), theme);
        // Even reduced-motion CSS transitions need a render tick to finish in WebKit.
        await page.waitForFunction((theme) => getComputedStyle(document.querySelector('.fav-review span')).color
          === (theme === 'dark' ? 'rgb(238, 241, 227)' : 'rgb(27, 31, 22)'), theme);
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
        await page.waitForTimeout(100); // SVG <use> shadow styles settle after their host transitions.
        await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) });
      }
      for (const width of [320, 720]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(async () => (await import('/js/config.js')).setConfig({ experimental: 1 }));
        const overflow = await page.evaluate(() => [...document.querySelectorAll('#viewFavorites, .fav-toolbar, .fav-kinds, .fav-card, .nav')]
          .some((el) => el.scrollWidth > el.clientWidth + 1));
        assert.equal(overflow, false, `${name} ${width}px horizontal overflow`);
        const centers = await page.locator('.fav-toolbar button').evaluateAll((buttons) => buttons.map((button) => {
          const r = button.getBoundingClientRect(); return r.y + r.height / 2;
        }));
        assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, `${name} ${width}px toolbar stays on one row`);
        const offset = await page.locator('.fav-remove').first().evaluate((button) => {
          const b = button.getBoundingClientRect(), i = button.querySelector('svg').getBoundingClientRect();
          return Math.abs((b.x + b.width / 2) - (i.x + i.width / 2));
        });
        assert.ok(offset < 1, `${name} delete icon is centered`);
        await page.screenshot({ path: path.join(shots, `${name}-${width}.png`) });
      }
      await page.setViewportSize({ width: 320, height: 844 });
      await setFilter('语言', 'en');
      await setFilter('排序', 'old');
      await openFilters();
      assert.equal(await page.locator('.fav-filter-button use').getAttribute('href'), '#i-filter');
      assert.equal(await page.locator('.fav-filter-panel select, .fav-filter-panel [role="combobox"], .fav-filter-panel [role="listbox"]').count(), 0);
      await page.screenshot({ path: path.join(shots, `${name}-filters.png`) });
      const state = page.getByRole('group', { name: '学习状态', exact: true });
      await state.getByRole('button', { name: '待复习', exact: true }).tap();
      assert.equal(await state.locator('[aria-pressed="true"]').getAttribute('data-value'), 'pending');
      await state.getByRole('button', { name: '已掌握', exact: true }).press('Enter');
      assert.equal(await state.locator('[aria-pressed="true"]').getAttribute('data-value'), 'mastered');
      const rowsFit = await page.locator('.fav-filter-row .segs').evaluateAll((groups) => groups.every((group) => {
        const rects = [...group.children].map((button) => button.getBoundingClientRect());
        return group.scrollWidth <= group.clientWidth + 1 && Math.max(...rects.map((r) => r.y)) - Math.min(...rects.map((r) => r.y)) < 1;
      }));
      assert.ok(rowsFit, `${name} all filter options fit on one row`);
      await page.getByRole('dialog').getByRole('button', { name: '重置筛选', exact: true }).click();
      assert.equal(await page.getByRole('group', { name: '语言', exact: true }).locator('[aria-pressed="true"]').getAttribute('data-value'), '');
      assert.equal(await page.getByRole('group', { name: '排序', exact: true }).locator('[aria-pressed="true"]').getAttribute('data-value'), 'new');
      await page.getByRole('button', { name: '完成', exact: true }).click();
      assert.equal(await page.locator('.fav-filter-button').getAttribute('aria-label'), '筛选收藏');
      await keepCard().getByRole('button', { name: '回到原文', exact: true }).click();
      await page.waitForURL('**/player.html?**favorite=**');
      if (name === 'chromium') {
        await page.waitForFunction(() => Math.abs(document.querySelector('#audio').currentTime - 1) < 0.1);
      } else {
        // Windows WebKit may lack a WAV decoder. Verify its deferred metadata path separately.
        await page.locator('#viewport .s[data-i="0"]').waitFor();
        const mediaReady = await page.evaluate(() => document.querySelector('#audio').readyState >= 1);
        if (!mediaReady) {
          await page.evaluate(() => document.querySelector('#audio').dispatchEvent(new Event('loadedmetadata')));
          console.log('webkit: WAV decoding unavailable; testing deferred seek callback only');
        }
        await page.waitForFunction(() => Math.abs(document.querySelector('#audio').currentTime - 1) < 0.1);
      }
      await page.goto(base + '/index.html#favorites');
      await page.evaluate(async () => (await import('/js/store.js')).wipeTrackAll('favorites-qa'));
      await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.fav-card').length === 2);
      await keepCard().getByRole('button', { name: '回到原文', exact: true }).click();
      await page.getByText('源媒体已删除，收藏原文和笔记仍保留', { exact: true }).waitFor();
      await keepCard().locator('.fav-reading').click();
      await page.getByRole('heading', { name: '相关词组与形式', exact: true }).waitFor();
      await page.getByText('原文音频不可用，请补充源媒体文件', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '标准发音', exact: true }).isEnabled(), true);
      assert.equal(await page.locator('.fav-detail').evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
      await page.getByRole('button', { name: '标准发音', exact: true }).click();
      const cancelled = await page.evaluate(() => window.favoriteSpeech.cancelled);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.ok(await page.evaluate(() => window.favoriteSpeech.cancelled) > cancelled);
      assert.deepEqual(errors, []); console.log(`${name}: favorites persistence, actions, source seek and layouts passed`);
    } finally { clearTimeout(watchdog); await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
