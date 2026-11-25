/** Real-browser blind-reading layout, interaction and persistence checks.
 * node tests/check_blind_read.cjs [playwright-module] [base-url] [30-second.mp4]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const engines = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5188';

(async () => {
  const videoBytes = process.argv[4] ? [...await fs.readFile(process.argv[4])] : null;
  const output = path.resolve('.cache/blind-read-qa');
  await fs.mkdir(output, { recursive: true });
  for (const name of ['chromium', 'webkit']) {
    const browser = await engines[name].launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(10000);
      await page.goto(base + '/index.html');
      const ids = await page.evaluate(async (videoBytes) => {
        const { createTrack, saveAnalysis } = await import('/js/library.js');
        const { sourceSpec } = await import('/js/langs.js');
        const rate = 8000, bytes = new Uint8Array(44 + rate * 30 * 2), view = new DataView(bytes.buffer);
        const ascii = (at, text) => [...text].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
        ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVEfmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data');
        view.setUint32(40, bytes.length - 44, true);
        const ids = [];
        for (const kind of videoBytes ? ['audio', 'video'] : ['audio']) {
          const lang = kind === 'audio' ? 'ja' : 'en';
          const file = kind === 'audio' ? new File([bytes], '盲读练习.wav', { type: 'audio/wav' })
            : new File([new Uint8Array(videoBytes)], 'Blind reading.mp4', { type: 'video/mp4' });
          const record = await createTrack(file, { lang });
          const words = lang === 'ja' ? [
            { text: '今回', read: 'こんかい', roman: 'konkai', pos: 'noun' },
            { text: 'の', roman: 'no', pos: 'particle' },
            { text: '企画', read: 'きかく', roman: 'kikaku', pos: 'noun' },
            { text: 'の', roman: 'no', pos: 'particle' },
            { text: 'コンセプト', roman: 'konseputo', pos: 'noun' },
            { text: 'は', roman: 'wa', pos: 'particle' },
            { text: 'ファン', roman: 'fuan', pos: 'noun' },
            { text: 'トラック', roman: 'torakku', pos: 'noun' },
            { text: '一発', read: 'いっぱつ', roman: 'ippatsu', pos: 'noun' },
            { text: '撮り', read: 'とり', roman: 'tori', pos: 'verb' },
            { text: 'で', roman: 'de', pos: 'particle' }, { text: '。', pos: 'punct' },
          ] : [
            { text: 'We', read: 'wiː', roman: 'we', pos: 'pron' },
            { text: 'were', read: 'wɜː', roman: 'be', pos: 'aux' },
            { text: 'running', read: 'ˈrʌnɪŋ', roman: 'run', pos: 'verb' },
            { text: 'quickly', read: 'ˈkwɪkli', roman: 'quickly', pos: 'adv' },
            { text: 'yesterday', read: 'ˈjestədeɪ', roman: 'yesterday', pos: 'adv' },
            { text: '.', pos: 'punct' },
          ];
          // Leave a one-second gap to exercise revealing a completed sentence before the next cue.
          const sentences = Array.from({ length: 6 }, (_, i) => ({ i, start: i * 5, end: i * 5 + 4,
            text: words.map((w) => w.text).join(lang === 'ja' ? '' : ' '), wordTiming: i !== 1,
            translations: { 'zh-CN': lang === 'ja' ? '这次企划的主题是一次拍摄完成。' : '我们昨天跑得很快。' },
            words: words.map((w, j) => ({ ...w, ...(i === 1 || w.pos === 'punct' ? {} : {
              start: i * 5 + j * 4 / (words.length - 1), end: i * 5 + (j + 1) * 4 / (words.length - 1),
            }) })),
          }));
          await saveAnalysis(record.id, { schemaVersion: 2, id: record.id, lang: sourceSpec(lang),
            sentences, hasWordTiming: true, audio: { duration: 30 } });
          localStorage.setItem('linguatrack.track.' + record.id, JSON.stringify({ tr: 1, read: 1, roman: 1, card: 1 }));
          ids.push({ id: record.id, kind });
        }
        return ids;
      }, name === 'chromium' ? videoBytes : null);
      for (const { id, kind } of ids) {
        await page.goto(base + '/player.html?track=' + id + '&debug');
        await page.waitForFunction(() => window.LT?.track?.S === 6);
        // Windows WebKit's media codecs are unavailable in this test environment.
        // Its checks cover real DOM/layout and local restore; Chromium covers media timing.
        if (name === 'chromium') await page.waitForFunction(() => window.LT.engine.audio.readyState >= 1);
        if (kind === 'video') await page.waitForFunction(() => document.querySelector('#app').classList.contains('has-video'));
        const word = (j) => page.locator(`#viewport .s[data-i="0"] .w[data-j="${j}"]`);
        const translation = page.locator('#viewport .s[data-i="0"] .s-tr');
        await page.waitForFunction(() => document.querySelector('#viewport .s[data-i="0"] .s-tr-text')?.textContent);
        const dimensions = () => page.locator('#viewport .s[data-i="0"] .w').evaluateAll((nodes) =>
          nodes.map((n) => [n.getBoundingClientRect().width, n.getBoundingClientRect().height]));
        const before = await dimensions();
        const controls = page.locator('#blindControls');
        const action = (name) => controls.locator(`[data-blind-action="${name}"]`);
        const playerHeight = await page.locator('#player').evaluate((n) => n.getBoundingClientRect().height);
        assert.equal(await controls.isVisible(), false);
        await page.locator('[data-mode="blind"]').click();
        assert.ok(await controls.isVisible());
        assert.deepEqual(await controls.locator('button').evaluateAll((buttons) =>
          buttons.map((button) => button.dataset.blindAction)), ['hide', 'prev', 'play', 'next', 'reveal']);
        assert.equal(await controls.textContent().then((text) => text.trim()), '');
        assert.equal(await page.locator('#player').evaluate((n) => n.getBoundingClientRect().height), playerHeight,
          'floating controls do not increase the original player height');
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(await dimensions(), before, 'mode changes retain grid layout');
        assert.equal(await word(2).getAttribute('data-blind'), 'hidden');
        const layers = await word(2).evaluate((n) => [...n.children].slice(0, 4)
          .map((c) => ({ visibility: getComputedStyle(c).visibility, display: getComputedStyle(c).display,
            inline: c.getAttribute('style'), className: c.className })));
        assert.ok(layers.every((layer) => layer.visibility === 'hidden' || layer.display === 'none'), JSON.stringify(layers));
        assert.equal(await word(2).locator('.w-mask').evaluate((n) => getComputedStyle(n).display), 'block');
        const centered = await word(2).evaluate((n) => {
          const word = n.getBoundingClientRect(), mask = n.querySelector('.w-mask').getBoundingClientRect();
          const shell = getComputedStyle(n, '::before');
          const center = word.top + (parseFloat(shell.top) + word.height - parseFloat(shell.bottom)) / 2;
          return Math.abs(center - (mask.top + mask.height / 2));
        });
        assert.ok(centered < .75, 'mask rectangle centers inside its shell');
        assert.equal(await translation.getAttribute('data-blind'), 'hidden');
        assert.equal(await translation.locator('.s-tr-text').evaluate((n) => getComputedStyle(n).visibility), 'hidden');
        assert.equal(await translation.locator('.w-mask').count(), 0);
        const inactiveColors = await page.locator('#viewport .s:not(.is-active) .w[data-blind="hidden"]').evaluateAll((nodes) =>
          nodes.map((n) => getComputedStyle(n, '::before').backgroundColor));
        const neutral = inactiveColors[0];
        assert.ok(inactiveColors.length && inactiveColors.every((color) => color === neutral), 'unfocused shells stay neutral');
        const activeColors = await page.locator('#viewport .s.is-active .w[data-blind="hidden"]').evaluateAll((nodes) =>
          nodes.map((n) => getComputedStyle(n, '::before').backgroundColor));
        assert.ok(activeColors.length && activeColors.every((color) => color !== neutral), 'every focused word uses its part-of-speech color');
        const time = await page.evaluate(() => window.LT.engine.audio.currentTime);
        await word(2).click();
        assert.equal(await word(2).getAttribute('data-blind'), 'revealed');
        assert.equal(await word(2).evaluate((n) => getComputedStyle(n, '::before').content), 'none');
        assert.equal(await page.evaluate(() => window.LT.engine.audio.currentTime), time);
        assert.equal(await page.locator('.wcard, .sheet.is-open').count(), 0);
        assert.deepEqual(await dimensions(), before, 'revealing retains word widths and heights');
        await word(0).focus(); await page.keyboard.press('Enter');
        assert.equal(await word(0).getAttribute('data-blind'), 'revealed');
        await page.evaluate(() => {
          const { reader } = window.LT;
          reader.unmount(0); reader.cache.delete(0); reader.mount(0, 0);
          window.LT.engine.seek(.2);
        });
        assert.equal(await word(2).getAttribute('data-blind'), 'revealed');
        assert.equal(await word(1).getAttribute('data-blind'), 'hidden');
        await page.locator('[data-mode="read"]').click();
        assert.equal(await word(1).getAttribute('data-blind'), null);
        await page.locator('[data-mode="blind"]').click();
        assert.equal(await word(2).getAttribute('data-blind'), 'revealed');
        for (const [width, theme] of (kind === 'video'
          ? [[390, 'light'], [320, 'dark']] : [[1280, 'light'], [390, 'light'], [320, 'dark']])) {
          await page.setViewportSize({ width, height: 844 });
          await page.evaluate(async (theme) => (await import('/js/settings.js')).setSetting('theme', theme), theme);
          await page.waitForFunction(() => document.querySelector('#viewport').clientWidth > 0);
          await page.screenshot({ path: path.join(output, `${name}-${kind}-${width}-${theme}.png`) });
          assert.equal(await word(1).getAttribute('data-blind'), 'hidden');
          assert.ok(await word(1).locator('.w-mask').isVisible());
          assert.ok(await page.locator('#scroller').evaluate((n) => n.scrollWidth <= n.clientWidth + 1));
          assert.ok(await controls.evaluate((n) => {
            const bar = n.getBoundingClientRect();
            return n.scrollWidth <= n.clientWidth + 1 && [...n.querySelectorAll('button')].every((button) => {
              const r = button.getBoundingClientRect();
              return r.left >= bar.left && r.right <= bar.right && r.height >= 44 && r.width >= 44;
            }) && bar.bottom + 10 <= document.querySelector('#player').getBoundingClientRect().top;
          }), 'five icon buttons float separately above the original player with usable touch targets');
        }
        const translationHeight = await translation.evaluate((n) => n.getBoundingClientRect().height);
        const translationTime = await page.evaluate(() => window.LT.engine.audio.currentTime);
        await translation.click();
        assert.equal(await translation.getAttribute('data-blind'), 'revealed');
        assert.equal(await translation.evaluate((n) => getComputedStyle(n, '::before').content), 'none');
        assert.equal(await translation.evaluate((n) => n.getBoundingClientRect().height), translationHeight);
        assert.equal(await page.evaluate(() => window.LT.engine.audio.currentTime), translationTime);
        await page.locator('[data-mode="read"]').click();
        await page.locator('[data-mode="blind"]').click();
        assert.equal(await translation.getAttribute('data-blind'), 'revealed');
        await page.evaluate(async (id) => {
          window.LT.engine.seek(6);
          await (await import('/js/library.js')).setPosition(id, 6);
        }, id);
        await page.reload();
        await page.waitForFunction(() => window.LT?.track);
        if (name === 'chromium') await page.waitForFunction(() => window.LT.engine.audio.currentTime >= 5.5);
        assert.equal(await page.locator('[data-mode="blind"]').getAttribute('aria-pressed'), 'true');
        await page.evaluate(() => window.LT.engine.seek(.2));
        await page.waitForFunction(() => document.querySelector('#viewport .s[data-i="0"]'));
        assert.equal(await word(2).getAttribute('data-blind'), 'revealed');
        assert.equal(await word(1).getAttribute('data-blind'), 'hidden');
        await page.waitForFunction(() => document.querySelector('#viewport .s[data-i="0"] .s-tr-text')?.textContent);
        assert.equal(await translation.getAttribute('data-blind'), 'revealed');
        await action('reveal').click();
        assert.equal(await page.locator('#viewport .s[data-i="0"] [data-blind="hidden"]').count(), 0);
        assert.ok(await page.locator('#viewport .s[data-i="1"] [data-blind="hidden"]').count() > 0);
        await action('hide').click();
        assert.equal(await word(0).getAttribute('data-blind'), 'hidden');
        assert.equal(await word(2).getAttribute('data-blind'), 'hidden');
        assert.equal(await translation.getAttribute('data-blind'), 'hidden');
        await page.evaluate(() => {
          const { reader } = window.LT;
          reader.unmount(0); reader.cache.delete(0); reader.mount(0, 0);
        });
        assert.equal(await word(2).getAttribute('data-blind'), 'hidden', 'recycled sentences stay covered');
        await page.reload();
        await page.waitForFunction(() => window.LT?.track);
        await page.waitForFunction(() => document.querySelector('#viewport .s[data-i="0"] .s-tr-text')?.textContent);
        assert.equal(await word(2).getAttribute('data-blind'), 'hidden');
        assert.equal(await translation.getAttribute('data-blind'), 'hidden', 'hide survives reload');
        if (name === 'chromium') {
          await page.waitForFunction(() => window.LT.engine.audio.readyState >= 1);
          await page.evaluate(() => window.LT.engine.seek(7));
          await action('prev').click();
          assert.ok(await page.evaluate(() => window.LT.engine.audio.currentTime < .02));
          await action('prev').click();
          assert.equal(await page.evaluate(() => window.LT.engine.audio.currentTime), 0);
          await page.evaluate(() => {
            document.querySelector('[data-blind-action="next"]').click();
            document.querySelector('[data-blind-action="next"]').click();
            document.querySelector('[data-blind-action="reveal"]').click();
          });
          assert.ok(Math.abs(await page.evaluate(() => window.LT.engine.audio.currentTime) - 10) < .02);
          await page.waitForFunction(() => document.querySelector('#viewport .s[data-i="2"] .w[data-blind="revealed"]'));
          assert.equal(await word(2).getAttribute('data-blind'), 'hidden', 'rapid navigation reveals only the destination');
          await action('play').click();
          await page.waitForFunction(() => !window.LT.engine.audio.paused
            && document.querySelector('#btnBlindPlay').getAttribute('aria-label') === '暂停');
          assert.equal(await action('play').getAttribute('aria-label'), '暂停');
          assert.equal(await page.locator('#playText').textContent(), '暂停');
          assert.ok(await action('play').locator('.ic-pause').isVisible());
          assert.equal(await action('play').locator('.ic-play').isVisible(), false);
          await page.locator('#btnPlay').click();
          await page.waitForFunction(() => document.querySelector('#btnBlindPlay').getAttribute('aria-label') === '播放');
          assert.equal(await action('play').getAttribute('aria-label'), '播放');
          await page.locator('#btnPlay').click();
          await action('play').click();
          assert.ok(await page.evaluate(() => window.LT.engine.audio.paused));
          await page.evaluate(() => window.LT.engine.seek(26));
          await action('next').click();
          assert.ok(Math.abs(await page.evaluate(() => window.LT.engine.audio.currentTime) - 25) < .02);
          await page.evaluate(() => window.LT.engine.seek(.2));
        }
        await page.locator('[data-mode="read"]').click();
        assert.equal(await controls.isVisible(), false);
        await page.locator('[data-mode="blind"]').click();
        assert.ok(await controls.isVisible());
        if (kind === 'video') {
          await page.evaluate(() => {
            document.documentElement.requestFullscreen = undefined;
            document.documentElement.webkitRequestFullscreen = undefined;
          });
          await page.setViewportSize({ width: 844, height: 390 });
          await page.waitForFunction(() => document.querySelector('#app').classList.contains('is-immersive'));
          await page.locator('#videoStage').dispatchEvent('pointerdown');
          // A toolbar pointerdown uses the same chrome visibility path as touch/keyboard controls.
          await action('hide').dispatchEvent('pointerdown');
          await page.waitForFunction(() => document.querySelector('#app').classList.contains('controls-visible'));
          await action('reveal').click();
          await action('hide').click();
          await page.waitForFunction(() => getComputedStyle(document.querySelector('#player')).opacity === '1');
          assert.ok(await controls.evaluate((n) => {
            const bar = n.getBoundingClientRect(), tools = document.querySelector('.tools').getBoundingClientRect();
            return bar.top >= document.querySelector('.topbar').getBoundingClientRect().bottom
              && bar.bottom <= tools.top && bar.left >= 0 && bar.right <= innerWidth;
          }), 'immersive controls fit between topbar and original toolbar');
          await page.screenshot({ path: path.join(output, `${name}-${kind}-landscape-dark.png`) });
          await page.keyboard.press('Escape');
          await controls.waitFor({ state: 'hidden' });
          assert.equal(await controls.isVisible(), false, 'blind controls follow immersive chrome visibility');
          await page.setViewportSize({ width: 390, height: 844 });
          await page.waitForFunction(() => !document.querySelector('#app').classList.contains('is-immersive'));
        }
        if (name === 'chromium' && kind === 'audio') {
          await page.setViewportSize({ width: 390, height: 680 });
          for (const input of ['mouse', 'touch']) for (const target of ['word', 'translation']) {
            await page.evaluate(() => {
              const { engine } = window.LT;
              engine.audio.pause();
              engine.seekSentence(0, 0);
            });
            await page.waitForFunction(() => window.LT.reader.activeS === 0);
            await page.evaluate(() => window.LT.engine.setFollow(true));
            await page.waitForFunction(() => document.querySelector('#scroller').scrollTop < 6);
            await action('play').click();
            await page.waitForFunction(() => window.LT.engine.audio.currentTime >= 4.6);
            await action('play').click();
            assert.ok(await page.evaluate(() => window.LT.engine.audio.paused
              && window.LT.engine.audio.currentTime >= window.LT.track.sEnd[0]
              && window.LT.engine.audio.currentTime < window.LT.track.sStart[1]), 'paused between sentences');
            await action('hide').click();
            const masked = target === 'word' ? word(2) : translation;
            assert.equal(await masked.getAttribute('data-blind'), 'hidden');
            const pausedTime = await page.evaluate(() => window.LT.engine.audio.currentTime);
            if (input === 'touch') await masked.tap(); else await masked.click();
            assert.equal(await masked.getAttribute('data-blind'), 'revealed');
            assert.equal(await page.evaluate(() => window.LT.engine.audio.currentTime), pausedTime);
            assert.ok(await page.evaluate(() => window.LT.engine.follow));
            await action('play').click();
            await page.waitForFunction(() => window.LT.reader.activeS === 1);
            await page.waitForFunction(() => document.querySelector('#scroller').scrollTop > 20,
              null, { timeout: 1000 });
            assert.ok(await page.evaluate(() => window.LT.engine.audio.currentTime < window.LT.track.sStart[2]),
              `${input} ${target} reveal follows the very next sentence`);
            await action('play').click();
          }
          // Revealing must also respect an intentional manual-scroll opt-out.
          await page.evaluate(() => window.LT.engine.seekSentence(0, 4.65));
          await page.waitForFunction(() => document.querySelector('#scroller').scrollTop < 6);
          await action('hide').click();
          await word(2).hover();
          await page.mouse.wheel(0, 40);
          await page.waitForFunction(() => !window.LT.engine.follow);
          await word(2).tap();
          assert.equal(await word(2).getAttribute('data-blind'), 'revealed');
          assert.equal(await page.locator('#btnPin').getAttribute('aria-pressed'), 'false');
          await page.evaluate(() => window.LT.engine.setFollow(true));
          // No-subtitle and missing-media states use the same enablement as the existing player.
          await page.evaluate(async (id) => {
            const { trackData, saveAnalysis } = await import('/js/library.js');
            const data = await trackData(id);
            await saveAnalysis(id, { ...data, sentences: [] });
          }, id);
          await page.reload();
          await page.waitForFunction(() => window.LT?.track?.S === 0);
          for (const name of ['reveal', 'hide', 'prev', 'next']) assert.ok(await action(name).isDisabled());
          assert.equal(await action('play').isDisabled(), false);
          await page.evaluate(async (id) => {
            const { getTrack, patchTrack } = await import('/js/library.js');
            const { del } = await import('/js/store.js');
            const record = await getTrack(id);
            await del('audio', id);
            await patchTrack(id, { audio: { ...record.audio, missing: true } });
          }, id);
          await page.reload();
          await page.waitForFunction(() => window.LT?.track && document.querySelector('#btnPlay').disabled);
          assert.ok(await action('play').isDisabled());
        }
        console.log(`PASS ${name} ${kind}: masks, toolbar, navigation, playback, layout, LRU and persistence${name === 'webkit' ? ' (DOM; media timing excluded)' : ''}`);
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
