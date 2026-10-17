/** Voice identity, preview interaction and responsive appearance with deterministic OS voices. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.argv[3] || 'http://127.0.0.1:5185');
    await page.evaluate(async () => {
      window.previews = []; window.cancelled = 0;
      speechSynthesis.getVoices = () => [
        { name: 'Samantha', lang: 'en-US', voiceURI: 'same', localService: true },
        { name: 'Samantha', lang: 'en-US', voiceURI: 'same', localService: true },
        { name: 'Samantha', lang: 'en-GB', voiceURI: 'same', localService: true },
        { name: 'Karen', lang: 'en-AU', voiceURI: 'karen', localService: true },
        { name: 'Network Voice', lang: 'en-US', voiceURI: 'online', localService: false },
      ];
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      speechSynthesis.speak = (utterance) => { previews.push(utterance); utterance.onstart?.(); };
      speechSynthesis.cancel = () => { cancelled++; };
      (await import('/js/settings.js')).setPronunciation({ voices: { en: 'same' } });
      (await import('/js/pronunciation-settings.js')).openPronunciationSheet();
    });
    assert.equal(await page.getByRole('button', { name: '在线音色', exact: true }).getAttribute('aria-pressed'), 'false');
    await page.locator('[data-voice-language="en"]').click();
    assert.equal(await page.locator('.voice-pack-downloads').count(), 0);
    assert.equal(await page.getByRole('radio', { name: /Network Voice/ }).count(), 0);
    assert.equal(await page.getByRole('radio').count(), 4);
    assert.equal(await page.locator('[role=radio][aria-checked=true]').count(), 1);
    await page.getByRole('radio', { name: 'Samantha 美国英语' }).click();
    assert.equal(await page.locator('[role=radio][aria-checked=true]').count(), 1);
    assert.equal(await page.evaluate(() => previews.at(-1).voice.lang), 'en-US');
    await page.getByRole('button', { name: '试听Samantha · 英国英语', exact: true }).click();
    assert.equal(await page.evaluate(() => previews.at(-1).voice.lang), 'en-GB');
    assert.equal(await page.getByRole('radio', { name: 'Samantha 美国英语' }).getAttribute('aria-checked'), 'true');
    await page.getByRole('radio', { name: 'Samantha 美国英语' }).focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('[role=radio][aria-checked=true]').count(), 1);
    const shots = path.resolve('.cache/pronunciation-qa'); await fs.mkdir(shots, { recursive: true });
    for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(async (theme) => (await import('/js/settings.js')).setSetting('theme', theme), theme);
      assert.equal(await page.locator('.sheet-body').evaluate((node) => node.scrollWidth > node.clientWidth), false);
      await page.screenshot({ path: path.join(shots, `voice-preview-${width}-${theme}.png`), animations: 'disabled' });
    }
    await page.locator('.sheet-head [aria-label=关闭]').click();
    assert.equal(await page.evaluate(() => cancelled), 3);
    await page.getByRole('button', { name: '在线音色', exact: true }).click();
    await page.locator('[data-voice-language=en]').click();
    assert.equal(await page.getByRole('radio').count(), 5);
    assert.equal(await page.locator('.voice-pack-downloads').count(), 1);
    assert.ok((await page.locator('.voice-pack-downloads').textContent()).includes('Hugging Face'));
    await page.getByRole('radio', { name: /Network Voice/ }).click();
    const saved = await page.evaluate(async () => (await import('/js/settings.js')).settings.pronunciation.voices.en);
    await page.locator('.sheet-head [aria-label=关闭]').click();
    await page.getByRole('button', { name: '在线音色', exact: true }).click();
    assert.ok(!(await page.locator('[data-voice-language=en]').textContent()).includes('Network Voice'));
    await page.locator('[data-voice-language=en]').click();
    assert.equal(await page.locator('.voice-pack-downloads').count(), 0);
    assert.equal(await page.getByRole('radio', { name: /Network Voice/ }).count(), 0);
    assert.equal(await page.getByRole('radio', { name: '自动选择', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.evaluate(async () => (await import('/js/settings.js')).settings.pronunciation.voices.en), saved);
    await page.locator('.sheet-head [aria-label=关闭]').click();
    for (const language of ['ja', 'ko']) {
      await page.locator(`[data-voice-language=${language}]`).click();
      assert.ok(!/语音包|Supertonic|OpenRAIL|下载|模型/.test(await page.locator('.sheet-body').textContent()));
      await page.locator('.sheet-head [aria-label=关闭]').click();
    }
    await page.reload();
    await page.evaluate(async () => (await import('/js/pronunciation-settings.js')).openPronunciationSheet());
    assert.equal(await page.getByRole('button', { name: '在线音色', exact: true }).getAttribute('aria-pressed'), 'false');
    await page.screenshot({ path: path.join(shots, 'online-voices-off.png'), animations: 'disabled' });
    assert.deepEqual(errors, []);
    console.log('Voice selection and preview checks passed');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
