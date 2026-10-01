/** Real history restoration, delayed library reads and cross-document metadata writes.
 * node tests/check_home_return.cjs [playwright-module] [base-url]
 * Chromium's full headless browser is required: headless shell disables bfcache.
 */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5173';

(async () => {
  for (const engine of [chromium, webkit]) {
    const cached = engine === chromium;
    const browser = await engine.launch({ headless: true,
      ...(cached ? { channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] } : {}) });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
      });
      await context.addInitScript(() => {
        window.returnQA = { restored: 0, hold: false, reads: [] };
        addEventListener('pageshow', (event) => { if (event.persisted) returnQA.restored++; });
        const getAll = IDBObjectStore.prototype.getAll;
        IDBObjectStore.prototype.getAll = function (...args) {
          const request = getAll.apply(this, args);
          if (this.name === 'tracks' && returnQA.hold) {
            Object.defineProperty(request, 'onsuccess', { set(callback) {
              request.addEventListener('success', (event) => returnQA.reads.push(() => callback.call(request, event)));
            } });
          }
          return request;
        };
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base + '/index.html');
      const id = await page.evaluate(async () => {
        const { createTrack } = await import('/js/library.js');
        const bytes = new Uint8Array(16044), view = new DataView(bytes.buffer);
        for (const [at, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) {
          for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
        }
        view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 16000, true);
        return (await createTrack(new File([bytes], 'history.wav', { type: 'audio/wav' }),
          { title: 'Before entering player' })).id;
      });
      await page.reload();
      const card = page.locator(`.card[data-track-id="${id}"]`);
      const readTrack = () => page.evaluate(async (id) => (await import('/js/library.js')).getTrack(id), id);
      const waitSaved = async (title) => {
        await page.waitForFunction(({ id, title }) => document.querySelector(`[data-track-id="${id}"] .card-hit`)
          ?.getAttribute('aria-label') === title + ' · 打开', { id, title });
        assert.equal((await readTrack()).title, title);
      };
      const releaseReads = async () => {
        await page.evaluate(() => { returnQA.hold = false; returnQA.reads.splice(0).reverse().forEach((read) => read()); });
        await page.waitForTimeout(80);
      };
      for (const phase of ['menu', 'editing', 'saved', 'unchanged']) {
        await card.waitFor();
        await page.evaluate(() => { returnQA.card = document.querySelector('.card'); returnQA.hold = true; });
        await card.locator('.card-hit').tap();
        await page.waitForURL('**/player.html?track=*', { waitUntil: 'commit' });
        await page.evaluate(async (id) => {
          const { setDuration, setPosition } = await import('/js/library.js');
          await setDuration(id, 90); await setPosition(id, 12);
        }, id);
        if (phase === 'menu' || phase === 'saved') await page.goBack({ waitUntil: 'commit' });
        else {
          // The back button is present before the main module wires it; wait for boot.
          await page.waitForFunction(() => document.querySelector('#audio')?.currentSrc
            || document.querySelector('#state')?.textContent.includes('不存在'));
          await page.locator('#btnBack').tap();
          await page.waitForFunction(() => location.pathname.endsWith('/index.html'));
        }
        if (cached) {
          assert.ok(await page.evaluate(() => returnQA.restored > 0), 'must restore the old document from bfcache');
        } else {
          // WebKit's automation backend does not restore page cache. Exercise its
          // pageshow handler with held reads as well as the real button/history back.
          await card.waitFor();
          await page.evaluate(async (id) => {
            returnQA.card = document.querySelector('.card'); returnQA.hold = true;
            await (await import('/js/library.js')).setDuration(id, 91);
            dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
            dispatchEvent(new Event('visibilitychange'));
          }, id);
        }
        await page.waitForFunction(() => returnQA.reads.length > 0);
        await card.locator('.card-a').tap();
        if (phase === 'menu') {
          await releaseReads();
          assert.equal(await page.evaluate(() => returnQA.card === document.querySelector('.card')), true,
            'an open menu must keep a connected card as its target');
        }
        await page.getByRole('menuitem', { name: '重命名', exact: true }).tap();
        const editor = card.getByRole('textbox', { name: '文件名' });
        const title = phase === 'unchanged' ? await editor.textContent() : 'After return: ' + phase;
        if (phase !== 'unchanged') await editor.fill(title);
        if (phase === 'editing' || phase === 'unchanged') {
          await releaseReads();
          assert.equal(await editor.textContent(), title, 'late metadata must not overwrite the active draft');
          assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.card-t')), true);
        }
        await page.locator('.wordmark').tap();
        await waitSaved(title);
        if (phase === 'saved') {
          await releaseReads();
          await waitSaved(title); // A read begun before this rename must not undo it.
        }
        assert.equal(await page.evaluate(() => returnQA.card === document.querySelector('.card')), true);
        assert.equal(await card.locator('.card-a').isEnabled(), true);
      }

      // Independent library modules share IndexedDB, as the player and cached home do.
      const writer = await context.newPage();
      await writer.goto(base + '/index.html');
      for (let i = 0; i < 10; i++) {
        await page.evaluate(async (id) => (await import('/js/library.js')).patchTrack(id, { title: 'Old title' }), id);
        await Promise.all([
          writer.evaluate(async ({ id, i }) => {
            const library = await import('/js/library.js');
            await Promise.all([library.setPosition(id, i + 15), library.setDuration(id, i + 120)]);
          }, { id, i }),
          page.evaluate(async ({ id, i }) => (await import('/js/library.js')).patchTrack(id,
            { title: 'Concurrent rename ' + i }), { id, i }),
        ]);
        const record = await readTrack();
        assert.equal(record.title, 'Concurrent rename ' + i);
        assert.equal(record.position, i + 15);
        assert.equal(record.duration, i + 120);
      }
      await writer.close();
      // Transaction aborts must reject and preserve the original, then permit retry.
      const abort = await page.evaluate(async (id) => {
        const lib = await import('/js/library.js'), originalPut = IDBObjectStore.prototype.put;
        const before = (await lib.getTrack(id)).title;
        IDBObjectStore.prototype.put = function (...args) {
          const req = originalPut.apply(this, args);
          if (this.name === 'tracks') req.addEventListener('success', () => this.transaction.abort());
          return req;
        };
        let rejected = false;
        try { await lib.patchTrack(id, { title: 'Aborted' }); } catch { rejected = true; }
        finally { IDBObjectStore.prototype.put = originalPut; }
        return { before, after: (await lib.getTrack(id)).title, rejected };
      }, id);
      assert.equal(abort.rejected, true);
      assert.equal(abort.after, abort.before);
      await page.reload();
      assert.equal(await card.locator('.card-t').textContent(), 'Concurrent rename 9');
      assert.deepEqual(errors, []);
      console.log(`${engine.name()}: ${cached ? 'real bfcache' : 'history + simulated cached'} return, delayed refresh, concurrent writes and rollback passed`);
    } finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
