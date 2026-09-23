/** Frontend review: setting panels, keyboard access, errors and responsive layout.
 * node tests/check_frontend_review.cjs [playwright-module] [base-url]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5198';
const output = path.resolve('.cache/frontend-review');

(async () => {
  await fs.mkdir(output, { recursive: true });
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      page.setDefaultTimeout(8000);
      page.on('pageerror', (error) => errors.push(error.message));
      let backend = 'ok', model = 'empty';
      await page.route('**/api/health*', async (route) => {
        if (backend === 'html') return route.fulfill({ status: 200, body: '<html>internal gateway 私密错误</html>' });
        if (backend === 'unauthorized') return route.fulfill({ status: 401, body: 'private token 私密错误' });
        return route.fulfill({ json: { ok: true, version: 'review', schemaVersion: 2 } });
      });
      await page.route('**/chat/completions', (route) => model === 'unauthorized'
        ? route.fulfill({ status: 401, body: '<html>private key 私密错误</html>' })
        : route.fulfill({ json: { choices: [{ message: { content: model === 'empty' ? '' : '{"ok":true}' } }] } }));
      await page.goto(base + '/index.html#set');
      const settle = async () => page.waitForFunction(() => {
        const sheet = document.querySelector('.sheet');
        return sheet?.classList.contains('is-open') && Math.abs(sheet.getBoundingClientRect().bottom - innerHeight) < 1;
      });
      const close = async () => {
        await page.locator('.sheet-head [aria-label="关闭"]').click();
        await page.waitForFunction(() => !document.querySelector('.sheet')?.classList.contains('is-open'));
      };
      const open = async (name) => {
        await page.locator('#setBody').getByRole('button', { name: new RegExp('^' + name) }).click();
        await settle();
      };
      const checkLayout = async (name) => {
        // Navigation hit areas intentionally extend through the card padding via ::before.
        const bad = await page.evaluate(() => [...document.querySelectorAll('.page:not([hidden]), .sheet.is-open, .sheet.is-open .rows, .sheet.is-open .row:not(.row-nav), .sheet.is-open .field, .sheet.is-open .segs')]
          .filter((node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 1)
          .map((node) => ({ cls: node.className, text: node.textContent.slice(0, 70), width: node.clientWidth, scroll: node.scrollWidth })));
        assert.deepEqual(bad, [], name + ': horizontal overflow');
      };

      // A real keyboard must remain inside the modal, then return to its opener.
      const font = page.getByRole('button', { name: '字幕字号', exact: true });
      await font.focus(); await page.keyboard.press('Enter'); await settle();
      await page.waitForFunction(() => document.activeElement.closest('.sheet'));
      for (let i = 0; i < 24; i++) {
        await page.keyboard.press(i % 5 ? 'Tab' : 'Shift+Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement.closest('.sheet')), true);
      }
      await page.keyboard.press('Escape');
      assert.equal(await font.evaluate((node) => node === document.activeElement), true);
      assert.equal(await page.locator('.sheet').evaluate((node) => node.inert), true);

      await open('分析后端');
      backend = 'html';
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '返回格式异常' }).waitFor();
      backend = 'unauthorized';
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '访问令牌' }).waitFor();
      assert.doesNotMatch(await page.locator('.sheet-body').innerText(), /private|私密|html/);
      backend = 'ok'; await close();

      await page.evaluate(async () => (await import('/js/config.js')).setConfig({ baseUrl: location.origin, model: 'test' }));
      await open('大模型');
      for (const [state, expected] of [['empty', '未返回内容'], ['unauthorized', '身份验证失败'], ['ok', '连接成功']]) {
        model = state;
        await page.getByRole('button', { name: '测试连接', exact: true }).click();
        await page.getByRole('status').filter({ hasText: expected }).waitFor();
        assert.doesNotMatch(await page.locator('.sheet-body').innerText(), /private|私密|html/);
      }
      await page.getByRole('button', { name: '显示API Key', exact: true }).click();
      assert.equal(await page.getByLabel('API Key', { exact: true }).getAttribute('type'), 'text');
      await page.getByRole('button', { name: '隐藏API Key', exact: true }).click();
      await close();

      await open('调用参数');
      const before = await page.getByRole('spinbutton', { name: '上文句数', exact: true }).inputValue();
      await page.getByRole('spinbutton', { name: '上文句数', exact: true }).fill('');
      await page.keyboard.press('Tab');
      assert.equal(await page.getByRole('spinbutton', { name: '上文句数', exact: true }).inputValue(), before);
      await close();

      for (const [width, height] of [[320, 640], [390, 844], [844, 390], [1280, 800]]) {
        await page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(async (theme) => (await import('/js/settings.js')).setSetting('theme', theme), theme);
          await page.getByRole('button', { name: '首页', exact: true }).click();
          await page.getByRole('button', { name: '设置', exact: true }).click();
          await checkLayout('settings');
          if (width === 390) await page.screenshot({ path: path.join(output, `${engine.name()}-${theme}-settings.png`), animations: 'disabled' });
          for (const name of ['分析后端', '大模型', '调用参数', '译文语言', '字幕字号', '系统字幕字号', '视频设置', '导出数据', '导入数据', '存储明细']) {
            await open(name); await checkLayout(name);
            if (width === 390 && ['大模型', '调用参数', '字幕字号', '视频设置', '导出数据'].includes(name)) {
              await page.screenshot({ path: path.join(output, `${engine.name()}-${theme}-${name}.png`), animations: 'disabled' });
            }
            await close();
          }
          await open('语言默认值'); await checkLayout('languages');
          await page.locator('.sheet-body .row-nav').filter({ hasText: /^日语/ }).click(); await settle();
          await checkLayout('language defaults');
          await page.locator('.sheet-head [aria-label="关闭"]').click(); await settle(); await close();
          await open('提示词');
          await page.locator('.sheet-body').getByRole('button', { name: /^翻译 · 系统提示词/ }).click(); await settle();
          await checkLayout('prompt editor');
          await page.locator('.sheet-head [aria-label="关闭"]').click(); await settle(); await close();
          console.log(`${engine.name()} ${width}×${height} ${theme}: settings panels passed`);
        }
      }

      // Storage failures must preserve the edit, enable retry and avoid uncaught promises.
      await page.goto(base + '/index.html');
      const trackId = await page.evaluate(async () => {
        const { createTrack, saveAnalysis } = await import('/js/library.js');
        const { sourceSpec } = await import('/js/langs.js');
        const bytes = await fetch('/assets/audio-probe.wav').then((r) => r.arrayBuffer());
        const record = await createTrack(new File([bytes], 'Review.wav', { type: 'audio/wav' }), { lang: 'en' });
        await saveAnalysis(record.id, { schemaVersion: 2, id: record.id, title: record.title,
          lang: sourceSpec('en'), audio: { duration: 1 }, sentences: [{ i: 0, start: 0, end: 1, text: 'Hello.',
            words: [{ text: 'Hello.', read: 'həˈləʊ', pos: 'noun' }] }], stats: { sentences: 1, words: 1 } });
        return record.id;
      });
      await page.reload();
      await page.getByRole('button', { name: '更多操作' }).click();
      await page.getByRole('menuitem', { name: '重命名', exact: true }).click(); await settle();
      await page.getByLabel('标题', { exact: true }).fill('Updated');
      await page.evaluate(() => {
        window.originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          const request = window.originalPut.apply(this, args);
          if (this.name === 'tracks') request.addEventListener('success', () => this.transaction.abort());
          return request;
        };
      });
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.locator('#toast').filter({ hasText: '重命名失败' }).waitFor();
      assert.equal(await page.getByLabel('标题', { exact: true }).inputValue(), 'Updated');
      assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isEnabled(), true);
      assert.equal(await page.evaluate(async (id) => (await (await import('/js/library.js')).getTrack(id)).title, trackId), 'Review');
      await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('button', { name: 'Updated · 打开', exact: true }).waitFor();
      const storageResult = await page.evaluate(async (id) => {
        const store = await import('/js/store.js'), lib = await import('/js/library.js');
        const originalAdd = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args) {
          const request = originalAdd.apply(this, args);
          if (this.name === 'tracks') request.addEventListener('success', () => this.transaction.abort());
          return request;
        };
        let importRejected = false;
        try { await lib.createTrack(new File(['bytes'], 'failed-import.wav', { type: 'audio/wav' })); }
        catch { importRejected = true; }
        finally { IDBObjectStore.prototype.add = originalAdd; }
        const pending = await store.snapshot(['tracks', 'audio', 'audioChunks']);
        const noPartialImport = Object.values(pending).every((rows) => rows.every((row) => !row.key.startsWith('failed-import')));
        for (const name of store.CACHE_STORES) {
          await store.writeBatch({ [name]: [{ key: id + '|review', value: { test: true }, track: id },
            { key: 'other|review', value: { test: true }, track: 'other' }] });
        }
        const originalDelete = IDBObjectStore.prototype.delete;
        IDBObjectStore.prototype.delete = function (...args) {
          const request = originalDelete.apply(this, args);
          if (this.name === 'word') request.addEventListener('success', () => this.transaction.abort());
          return request;
        };
        let wipeRejected = false;
        try { await store.wipeTrack(id); } catch { wipeRejected = true; }
        finally { IDBObjectStore.prototype.delete = originalDelete; }
        const retained = await store.snapshot(store.CACHE_STORES);
        const rollback = Object.values(retained).every((rows) => rows.length === 2);
        const removed = await store.wipeTrack(id);
        const other = await store.snapshot(store.CACHE_STORES);
        const isolated = Object.values(other).every((rows) => rows.length === 1 && rows[0].track === 'other');
        const originalClear = IDBObjectStore.prototype.clear;
        IDBObjectStore.prototype.clear = function (...args) {
          const request = originalClear.apply(this, args);
          if (this.name === 'word') request.addEventListener('success', () => this.transaction.abort());
          return request;
        };
        let clearRejected = false;
        try { await store.clearAll(); } catch { clearRejected = true; }
        finally { IDBObjectStore.prototype.clear = originalClear; }
        const allRetained = Object.values(await store.snapshot(store.CACHE_STORES)).every((rows) => rows.length === 1);
        await store.clearAll();
        const empty = Object.values(await store.snapshot(store.CACHE_STORES)).every((rows) => !rows.length);
        return { importRejected, noPartialImport, wipeRejected, rollback, removed, isolated, clearRejected, allRetained, empty };
      }, trackId);
      assert.deepEqual(storageResult, { importRejected: true, noPartialImport: true, wipeRejected: true, rollback: true,
        removed: 4, isolated: true, clearRejected: true, allRetained: true, empty: true });
      model = 'unauthorized';
      await page.goto(base + '/player.html?track=' + trackId + '&debug');
      await page.waitForFunction(() => window.LT?.track?.S === 1);
      await page.locator('.w').first().click();
      const wordCard = page.getByRole('dialog', { name: /Hello/ });
      await wordCard.getByText('释义加载失败', { exact: true }).waitFor();
      assert.match(await wordCard.innerText(), /检查 API Key/);
      await page.waitForFunction(() => !!document.activeElement.closest('.wcard'));
      for (let i = 0; i < 7; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement.closest('.wcard')), true);
      }
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.wcard').evaluate((node) => node.inert), true);
      await page.locator('#btnExplain').click();
      await page.getByText(/讲解失败：.*API Key/).waitFor();
      assert.doesNotMatch(await page.locator('.sheet-body').innerText(), /private|私密|html/);
      await close();
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine.name()}: keyboard, connection failures, empty responses, secret fields, numeric edits, durable imports, storage rollback, word cards and explanations`);
      await context.close();
    } finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
