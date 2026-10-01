/** Inline rename regression, including repeated deletion with an empty title.
 * node tests/check_home_rename.cjs [playwright-module] [base-url]
 */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5173';

(async () => {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 600 }, reducedMotion: 'reduce', isMobile: true, hasTouch: true,
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/api/health*', (route) => route.fulfill({ json: { languages: [] } }));
      await page.goto(base + '/index.html');
      await page.evaluate(async () => {
        const { createTrack } = await import('/js/library.js');
        for (let i = 0; i < 9; i++) {
          await createTrack(new File(['media'], `lesson-${i}.mp3`, { type: 'audio/mpeg' }),
            { title: i === 4 ? 'Long title '.repeat(12) : `Lesson ${i}` });
        }
      });
      await page.reload();
      for (const index of [0, 4, 8]) {
        const card = page.locator('.card').nth(index);
        const id = await card.getAttribute('data-track-id');
        const original = await card.locator('.card-t').textContent();
        const edit = async () => {
          await card.locator('.card-a').click();
          await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
          return card.getByRole('textbox', { name: '文件名' });
        };
        const editor = await edit();
        assert.equal(await card.locator('input, textarea, form, .field-acts').count(), 0);
        await editor.press('Backspace'); // The original title is selected on entry.
        assert.equal(await editor.textContent(), '');
        const snapshot = () => editor.evaluate((node) => {
          const rect = node.closest('.card').getBoundingClientRect();
          return {
            html: node.innerHTML, y: rect.y, height: rect.height,
            scroll: document.getElementById('viewHome').scrollTop,
            focused: document.activeElement === node,
          };
        });
        const empty = await snapshot();
        for (const key of ['Backspace', 'Backspace', 'Delete', 'Control+Backspace']) {
          await editor.press(key);
          assert.deepEqual(await snapshot(), empty, `empty ${key} must not move or alter the editor`);
        }
        // Mobile keyboards can emit beforeinput without a useful keydown.
        for (const inputType of ['deleteContentBackward', 'deleteContentForward', 'deleteWordBackward']) {
          const prevented = await editor.evaluate((node, inputType) => {
            const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
            node.dispatchEvent(event);
            return event.defaultPrevented;
          }, inputType);
          assert.equal(prevented, true, inputType);
          assert.deepEqual(await snapshot(), empty);
        }
        assert.equal(await editor.evaluate((node) => {
          const event = new InputEvent('beforeinput', {
            inputType: 'deleteCompositionText', isComposing: true, bubbles: true, cancelable: true,
          });
          node.dispatchEvent(event);
          return event.defaultPrevented;
        }), false, 'IME composition must remain under the input method’s control');
        await editor.press('Enter');
        await card.locator('[contenteditable]').waitFor({ state: 'detached' });
        assert.equal(await card.locator('.card-t').textContent(), original);
        await edit();
        await editor.press('Backspace');
        await editor.press('Backspace');
        await page.keyboard.insertText('New title!');
        await editor.press('Backspace');
        assert.equal(await editor.textContent(), 'New title', 'nonempty titles still delete normally');
        await editor.press('Enter');
        await card.locator('[contenteditable]').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(async (id) => {
          const { getTrack } = await import('/js/library.js');
          return (await getTrack(id)).title;
        }, id), 'New title');
      }
      // Touch must end editing before the browser decides whether to synthesize a click.
      // WebKit suppresses the click after preventDefault(pointerdown), and disabled
      // menu buttons do not blur the title, leaving both actions stuck in edit mode.
      for (const exit of ['card', 'menu']) {
        for (const value of ['Renamed by touch', 'unchanged', '', 'failed write']) {
          await page.goto(base + '/index.html');
          const card = page.locator('.card').first();
          const original = await card.locator('.card-t').textContent();
          await card.locator('.card-a').tap();
          await page.getByRole('menuitem', { name: '重命名', exact: true }).tap();
          const editor = card.getByRole('textbox', { name: '文件名' });
          await editor.fill(value === 'unchanged' ? original : value);
          if (value === 'failed write') await page.evaluate(() => {
            const original = IDBDatabase.prototype.transaction;
            IDBDatabase.prototype.transaction = function (stores, mode, ...args) {
              if (mode === 'readwrite') {
                IDBDatabase.prototype.transaction = original;
                throw new DOMException('Test write failure', 'QuotaExceededError');
              }
              return original.call(this, stores, mode, ...args);
            };
          });
          if (exit === 'card') await card.locator('.card-hit').tap({ position: { x: 15, y: 15 } });
          else await card.locator('.card-a').tap();
          await card.locator('[contenteditable]').waitFor({ state: 'detached' });
          if (value === 'failed write') await page.waitForFunction(() =>
            document.getElementById('toast').textContent.startsWith('重命名失败'));
          assert.equal(new URL(page.url()).pathname, '/index.html', 'the exit tap must not open the player');
          assert.equal(await card.evaluate((node) => node.classList.contains('is-renaming')), false);
          assert.equal(await card.locator('.card-a').isEnabled(), true);
          assert.equal(await card.locator('.card-t').textContent(),
            value === 'Renamed by touch' ? value : original);
          if (!await page.getByRole('menu').count()) await card.locator('.card-a').tap();
          await page.getByRole('menuitem', { name: '重命名', exact: true }).waitFor();
          await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
          await page.keyboard.press('Escape');
          await page.getByRole('menu').waitFor({ state: 'detached' });
          // Tap where the editable title used to be, not just the empty card margin.
          const title = await card.locator('.card-t').boundingBox();
          await page.touchscreen.tap(title.x + title.width / 2, title.y + title.height / 2);
          await page.waitForURL((url) => url.pathname === '/player.html' && url.searchParams.has('track'),
            { waitUntil: 'commit' });
        }
      }
      // Keep one live page/card for repeated edits. Suppress blur to model a native
      // WebView losing its editing focus without delivering that event to JS.
      await page.goto(base + '/index.html');
      const repeated = page.locator('.card').first();
      const repeatedId = await repeated.getAttribute('data-track-id');
      await repeated.evaluate((node) => {
        window.renameCardNode = node;
        window.renameTitleNode = node.querySelector('.card-t');
        window.suppressRenameBlur = (event) => {
          if (event.target === window.renameTitleNode) event.stopImmediatePropagation();
        };
        document.addEventListener('blur', window.suppressRenameBlur, true);
      });
      for (let i = 0; i < 6; i++) {
        await repeated.locator('.card-a').tap();
        await page.getByRole('menuitem', { name: '重命名', exact: true }).tap();
        const editor = repeated.getByRole('textbox', { name: '文件名' });
        await editor.fill('连续改名 ' + i);
        await page.evaluate(() => dispatchEvent(new Event('visibilitychange')));
        await page.waitForTimeout(80);
        assert.equal(await editor.textContent(), '连续改名 ' + i, 'refresh must retain the next draft');
        if (i % 3 === 0) await repeated.locator('.card-hit').tap({ position: { x: 15, y: 15 } });
        else if (i % 3 === 1) await page.locator('.wordmark').tap();
        else await editor.evaluate((node) => node.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertParagraph', bubbles: true, cancelable: true,
        })));
        await page.waitForFunction(({ id, title }) => {
          const card = [...document.querySelectorAll('.card')].find((node) => node.dataset.trackId === id);
          return card.querySelector('.card-hit').getAttribute('aria-label') === title + ' · 打开';
        }, { id: repeatedId, title: '连续改名 ' + i });
        assert.equal(await page.evaluate(async (id) => {
          const { getTrack } = await import('/js/library.js');
          return (await getTrack(id)).title;
        }, repeatedId), '连续改名 ' + i);
        assert.equal(await repeated.evaluate((node) => node === window.renameCardNode
          && node.querySelector('.card-t') === window.renameTitleNode), true,
        'saving must retain the live editing host instead of replacing it during keyboard dismissal');
        assert.equal(await repeated.locator('[contenteditable]').count(), 0);
        assert.equal(await repeated.locator('.card-a').isEnabled(), true);
        assert.equal(await repeated.locator('.card-hit').getAttribute('aria-label'), '连续改名 ' + i + ' · 打开');
      }
      await page.evaluate(() => document.removeEventListener('blur', window.suppressRenameBlur, true));
      await repeated.locator('.card-hit').tap();
      await page.waitForURL((url) => url.pathname === '/player.html', { waitUntil: 'commit' });
      await page.goto(base + '/index.html');
      assert.equal(await page.locator(`.card[data-track-id="${repeatedId}"] .card-t`).textContent(), '连续改名 5');
      assert.deepEqual(errors, []);
      console.log(`${engine.name()}: deletion, touch access, six consecutive saves without blur, stable card identity and persistence passed`);
    } finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
