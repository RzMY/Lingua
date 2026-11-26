/** Chromium media-clock and layout checks: node tests/check_delayed_reveal.cjs [playwright] [url] [video.mp4] */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5188';

(async () => {
  const video = process.argv[4] ? [...await fs.readFile(process.argv[4])] : null;
  const output = path.resolve('.cache/delayed-reveal-qa');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/index.html');
    const ids = await page.evaluate(async (video) => {
      const { createTrack, saveAnalysis } = await import('/js/library.js');
      const { sourceSpec } = await import('/js/langs.js');
      const bytes = new Uint8Array(44 + 8000 * 30 * 2), view = new DataView(bytes.buffer);
      const ascii = (at, value) => [...value].forEach((c, i) => bytes[at + i] = c.charCodeAt(0));
      ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVEfmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data');
      view.setUint32(40, bytes.length - 44, true);
      const ids = [];
      for (const kind of video ? ['audio', 'video'] : ['audio']) {
        const file = kind === 'audio' ? new File([bytes], '延迟揭晓.wav', { type: 'audio/wav' })
          : new File([new Uint8Array(video)], '延迟揭晓.mp4', { type: 'video/mp4' });
        const record = await createTrack(file, { lang: 'en' });
        const sentences = Array.from({ length: 6 }, (_, i) => ({ i, start: i * 5, end: i * 5 + 4,
          text: 'Hello world.', wordTiming: i !== 1, translations: { 'zh-CN': '你好，世界。' },
          words: [
            { text: 'Hello', read: 'həˈləʊ', roman: 'hello', pos: 'interj', start: i * 5, end: i * 5 + 2 },
            { text: 'world', read: 'wɜːld', roman: 'world', pos: 'noun', start: i * 5 + 2, end: i * 5 + 4 },
            { text: '.', pos: 'punct' },
          ],
        }));
        await saveAnalysis(record.id, { id: record.id, schemaVersion: 2, lang: sourceSpec('en'),
          audio: { duration: 30 }, hasWordTiming: true, sentences });
        localStorage.setItem('linguatrack.track.' + record.id, JSON.stringify({ tr: 1, read: 1, roman: 1, card: 1 }));
        ids.push({ id: record.id, kind });
      }
      return ids;
    }, video);
    for (const { id, kind } of ids) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(base + '/player.html?track=' + id + '&debug');
      await page.waitForFunction(() => window.LT?.track?.S === 6 && window.LT.engine.audio.readyState >= 1);
      if (kind === 'video') await page.evaluate(() => {
        document.documentElement.requestFullscreen = undefined;
        document.documentElement.webkitRequestFullscreen = undefined;
      });
      const word = (i, j) => page.locator(`#viewport .s[data-i="${i}"] .w[data-j="${j}"]`);
      const tr = page.locator('#viewport .s[data-i="0"] .s-tr');
      const controls = page.locator('#blindControls');
      const action = (name) => controls.locator(`[data-blind-action="${name}"]`);
      const seek = async (time) => {
        await page.evaluate((time) => window.LT.engine.seek(time), time);
        await page.waitForFunction((time) => !window.LT.engine.audio.seeking
          && Math.abs(window.LT.engine.audio.currentTime - time) < .01, time);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      const sizes = () => word(0, 0).evaluate((n) => [n.offsetWidth, n.offsetHeight]);
      const before = await sizes();
      await page.locator('[data-mode="delayed"]').click();
      await page.waitForFunction(() => document.querySelector('#viewport .s[data-i="0"] .s-tr-text')?.textContent);
      assert.deepEqual(await controls.locator('button:visible').evaluateAll((nodes) => nodes.map((n) => n.dataset.blindAction)),
        ['prev', 'play', 'next']);
      assert.deepEqual(await sizes(), before);
      await word(0, 0).click(); await tr.click();
      assert.equal(await word(0, 0).getAttribute('data-blind'), 'hidden');
      assert.equal(await tr.getAttribute('data-blind'), 'hidden');
      assert.equal(await page.evaluate(() => window.LT.engine.audio.currentTime), 0);
      await seek(1.85); await action('play').click();
      await page.waitForFunction(() => document.querySelector('#viewport .s[data-i="0"] .w[data-j="0"]')?.dataset.blind === 'revealed');
      await action('play').click();
      assert.equal(await word(0, 1).getAttribute('data-blind'), 'hidden');
      await seek(3.65);
      assert.equal(await tr.getAttribute('data-blind'), 'revealed');
      assert.equal(await word(0, 1).getAttribute('data-blind'), 'hidden');
      await seek(4.2);
      assert.equal(await word(0, 1).getAttribute('data-blind'), 'revealed');
      await seek(0);
      assert.equal(await word(0, 0).getAttribute('data-blind'), 'hidden');
      assert.equal(await tr.getAttribute('data-blind'), 'hidden');
      const rail = await page.locator('#seek .seek-hit').boundingBox();
      await page.mouse.move(rail.x + rail.width * 4.2 / 30, rail.y + rail.height / 2);
      await page.mouse.down();
      await page.waitForFunction(() => window.LT.engine.scrubbing
        && document.querySelector('#viewport .s[data-i="0"] .w[data-j="1"]')?.dataset.blind === 'revealed');
      await page.mouse.move(rail.x, rail.y + rail.height / 2);
      await page.waitForFunction(() => document.querySelector('#viewport .s[data-i="0"] .w[data-j="0"]')?.dataset.blind === 'hidden');
      await page.mouse.up();
      await action('next').click();
      await page.waitForFunction(() => window.LT.reader.activeS === 1);
      await seek(8.5);
      assert.equal(await word(1, 0).getAttribute('data-blind'), 'hidden', 'sentence timing does not use stray word timestamps');
      await seek(9.1);
      assert.equal(await word(1, 0).getAttribute('data-blind'), 'revealed');
      await action('prev').click();
      await page.waitForFunction(() => window.LT.reader.activeS === 0);
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (kind === 'video' && width > 844) {
          await page.waitForFunction(() => document.querySelector('#app').classList.contains('is-immersive'));
          await page.locator('#videoStage').dispatchEvent('pointerdown');
          await action('play').dispatchEvent('pointerdown');
          await page.waitForFunction(() => document.querySelector('#app').classList.contains('controls-visible'));
          await page.waitForFunction(() => getComputedStyle(document.querySelector('#player')).opacity === '1');
        }
        await controls.waitFor({ state: 'visible' });
        // Let the visibility transition and SVG use instances finish painting after rotation.
        await page.waitForTimeout(250);
        const box = await controls.boundingBox(), play = await action('play').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width);
        assert.ok(Math.abs(play.x + play.width / 2 - box.x - box.width / 2) < 1);
        await page.screenshot({ path: path.join(output, `${kind}-${width}.png`) });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await seek(7);
      await page.reload();
      await page.waitForFunction(() => window.LT?.reader?.delayed && window.LT.engine.audio.currentTime > 6.9);
      assert.equal(await page.locator('[data-mode="delayed"]').getAttribute('aria-pressed'), 'true');
      await controls.waitFor({ state: 'visible' });
      await seek(0);
      assert.equal(await word(0, 0).getAttribute('data-blind'), 'hidden');
      console.log(`${kind}: playback, seeking, untimed subtitles, reload and responsive controls passed`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
