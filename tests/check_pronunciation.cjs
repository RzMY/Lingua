/** Real browser media boundaries, main playback isolation and responsive pronunciation UI.
 * node tests/check_pronunciation.cjs [playwright-module] [base-url]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const engines = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5185';

(async () => {
  const mode = process.argv[4] || 'chromium';
  const browser = mode === 'android' ? await engines.chromium.connectOverCDP('http://127.0.0.1:9238')
    : await engines[mode].launch({ headless: true });
  const shots = path.resolve('.cache/pronunciation-qa', process.argv[4] || 'chromium');
  await fs.mkdir(shots, { recursive: true });
  try {
    const page = mode === 'android' ? browser.contexts()[0].pages()[0]
      : await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/health*', (route) => route.fulfill({ json: { version: 'test' } }));
    const fixture = process.argv[5] ? await fs.readFile(process.argv[5]) : null;
    if (mode === 'webkit') {
      // Windows WebKit cannot play even an unmodified Blob URL. Check its real media
      // clock with an HTTP WAV; Blob playback is exercised by Chromium and Android.
      await page.addInitScript(() => { URL.createObjectURL = () => '/assets/audio-probe.wav'; });
    }
    await page.goto(base + '/index.html');
    await page.evaluate(async ({ engine, fixtureBase64 }) => {
      const { put } = await import('/js/store.js');
      const rate = 16000, frames = rate * 3;
      const bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes);
      const ascii = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
      ascii(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
      view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, frames * 2, true);
      for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.sin(i / rate * 440 * 2 * Math.PI) * 4000, true);
      const audio = fixtureBase64 ? new Blob([Uint8Array.from(atob(fixtureBase64), (c) => c.charCodeAt(0))], { type: 'audio/mp4' })
        : new Blob([bytes], { type: 'audio/wav' });
      await put('tracks', 'pronunciation', { id: 'pronunciation', title: 'Pronunciation test', lang: 'en', status: 'ready',
        duration: 3, audio: { name: fixtureBase64 ? 'sample.m4a' : 'sample.wav', type: audio.type, size: audio.size } });
      await put('audio', 'pronunciation', engine === 'webkit'
        ? { storage: 'chunks-v1', prefix: 'pronunciation', count: 1, type: 'audio/wav' } : audio);
      if (engine === 'webkit') await put('audioChunks', 'pronunciation|0', bytes);
      await put('data', 'pronunciation', { id: 'pronunciation', lang: { code: 'en', name: '英语',
        spaceDelimited: true, layers: {}, layerOrder: [], features: ['card', 'pos'] },
      audio: { duration: 3 }, hasWordTiming: true, sentences: [
        { text: 'Hello world.', start: 0, end: 1.4, wordTiming: true, words: [
          { text: 'Hello', read: 'həˈləʊ', pos: 'noun', start: .3, end: .65 },
          { text: 'world', read: 'wɜːld', pos: 'noun', start: .65, end: 1 }, { text: '.', pos: 'punct' },
        ] }, { text: 'Welcome.', start: 1.4, end: 3, wordTiming: false,
          words: [{ text: 'Welcome', pos: 'noun' }] },
      ] });
      const { hash53 } = await import('/js/util.js');
      await put('word', 'pronunciation|zh-CN|0|1|' + hash53('world\u0001Hello world.'),
        { gloss: '世界', note: '在问候语中指向周围的世界。', forms: ['worlds'] }, 'pronunciation');
      localStorage.setItem('linguatrack.track.pronunciation', JSON.stringify({ tr: 0, card: 1 }));
      (await import('/js/settings.js')).setPronunciation({ source: 'audio', autoPlay: false });
    }, { engine: mode, fixtureBase64: fixture?.toString('base64') });
    await page.goto(base + '/player.html?track=pronunciation&debug');
    try { await page.waitForFunction(() => window.LT?.track); }
    catch (error) { console.error(await page.locator('body').innerText(), errors); throw error; }
    if (!fixture && mode !== 'android') {
      const levels = await page.evaluate(async () => {
        const reference = LT.track.pronunciationLoudness;
        await reference.ready;
        const full = reference.volume(), media = LT.engine.audio;
        const before = { volume: media.volume, muted: media.muted, time: media.currentTime };
        media.volume = .5;
        const half = reference.volume();
        media.muted = true;
        const muted = reference.volume();
        media.volume = before.volume; media.muted = before.muted;
        return { full, half, muted, moved: media.currentTime !== before.time,
          canDecode: !!(window.OfflineAudioContext || window.webkitOfflineAudioContext) };
      });
      const expected = levels.canDecode ? 4000 / 32768 / Math.sqrt(2) / .1 : 1;
      assert.ok(Math.abs(levels.full - expected) < .001, JSON.stringify(levels));
      assert.ok(Math.abs(levels.half - expected / 2) < .001, JSON.stringify(levels));
      assert.equal(levels.muted, 0); assert.equal(levels.moved, false);
      console.log('Real decoded loudness:', levels);
    }
    await page.evaluate(() => {
      window.clips = [];
      const create = document.createElement.bind(document);
      document.createElement = (tag, options) => {
        const node = create(tag, options);
        if (tag === 'audio') {
          const log = { node, events: [] }; clips.push(log);
          const play = node.play.bind(node);
          node.play = () => play().catch((error) => {
            log.events.push({ event: 'play-error', name: error.name, message: error.message }); throw error;
          });
          const pause = node.pause.bind(node);
          node.pause = () => {
            log.events.push({ event: 'stop', time: node.currentTime, at: performance.now() });
            pause();
          };
          for (const event of ['playing', 'pause', 'ended', 'timeupdate', 'seeked']) node.addEventListener(event,
            () => log.events.push({ event, time: node.currentTime, at: performance.now() }));
        }
        return node;
      };
    });
    await page.locator('#btnPlay').click();
    await page.locator('#viewport .s[data-i="0"] .w[data-j="1"]').click();
    await page.locator('.wcard.is-open').waitFor();
    const mainAt = await page.evaluate(async () => {
      (await import('/js/settings.js')).setPronunciation({ audioRate: .75, volume: 0 });
      return LT.engine.audio.currentTime;
    });
    await page.getByRole('button', { name: '播放音频发音', exact: true }).click();
    try { await page.waitForFunction(() => clips[0]?.events.some((event) => event.event === 'playing'), null, { timeout: 10000 }); }
    catch (error) {
      console.error(JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('.wc-sound-status').textContent,
        clips: clips.map(({ node, events }) => ({ events, src: node.src, error: node.error?.message,
          code: node.error?.code, ready: node.readyState, paused: node.paused })) }))));
      throw error;
    }
    assert.equal(await page.evaluate(() => clips[0].node.playbackRate), 1);
    assert.equal(await page.evaluate(() => clips[0].node.volume), 1);
    await page.waitForFunction(() => clips[0]?.node.getAttribute('src') === null);
    const result = await page.evaluate(() => ({
      events: clips[0].events, mainAt: LT.engine.audio.currentTime, paused: LT.engine.audio.paused,
      status: document.querySelector('.wc-sound-status').textContent,
    }));
    assert.equal(result.paused, true);
    assert.ok(Math.abs(result.mainAt - mainAt) < .02, 'clip must not move main playback');
    const played = result.events.filter((event) => event.event === 'stop');
    assert.ok(played.some((event) => event.time >= 1.04 && event.time <= 1.18), JSON.stringify(result));
    assert.ok(!result.status.includes('失败') && !result.status.includes('超时'), result.status);
    console.log('Real clip:', JSON.stringify(result));

    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async (theme) => (await import('/js/settings.js')).setSetting('theme', theme), theme);
        assert.equal(await page.locator('.wcard').evaluate((node) => node.scrollWidth > node.clientWidth), false);
        await page.screenshot({ path: path.join(shots, `card-${width}-${theme}.png`), animations: 'disabled' });
      }
    }
    await page.getByRole('button', { name: '播放音频发音', exact: true }).click();
    await page.locator('.wc-a-main').click();
    assert.equal(await page.evaluate(() => clips.every(({ node }) => node.paused)), true);
    assert.equal(await page.evaluate(() => LT.engine.audio.paused), false, 'closing resumes the main media');
    await page.locator('#btnPlay').click();
    await page.locator('#viewport .s[data-i="1"] .w').click();
    assert.equal(await page.getByRole('button', { name: '播放音频发音', exact: true }).isDisabled(), true);
    assert.match(await page.locator('.wc-sound-status').textContent(), /词级时间戳/);
    await page.locator('.wc-a-main').click();
    await page.locator('#btnDisplay').click();
    await page.getByRole('button', { name: '发音设置', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '音量均衡', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: /音量校准/ }).count(), 0, 'calibration belongs to global settings');
    await page.getByRole('button', { name: '音量均衡', exact: true }).click();
    await page.getByRole('button', { name: '标准', exact: true }).click();
    await page.getByRole('button', { name: '打开词卡自动发音', exact: true }).click();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.locator('.sheet-body').evaluate((node) => node.scrollWidth > node.clientWidth), false);
      await page.screenshot({ path: path.join(shots, `settings-${width}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 320, height: 900 });
    if (await page.locator('[data-voice-language="en"]').isEnabled()) {
      await page.locator('[data-voice-language="en"]').click();
      await page.screenshot({ path: path.join(shots, 'settings-voices-320.png'), animations: 'disabled' });
      await page.locator('.sheet-head [aria-label="关闭"]').click();
    }
    await page.locator('.sheet-head [aria-label="关闭"]').click();
    await page.getByRole('heading', { name: '音频配置', exact: true }).waitFor();
    if (mode === 'android') {
      // Verify the installed WebView's persisted settings directly; CDP viewport emulation
      // does not resize Android's native input surface for subsequent home navigation.
      assert.deepEqual(await page.evaluate(async () => {
        const { readTrackCfg } = await import('/js/trackcfg.js');
        const { pronunciation } = readTrackCfg('pronunciation', 'en');
        return { source: pronunciation.source, autoPlay: pronunciation.autoPlay };
      }), { source: 'standard', autoPlay: true });
      assert.deepEqual(errors, []);
      console.log('Android native playback and pronunciation settings passed:', shots);
      return;
    }
    await page.goto(base + '/index.html#set');
    await page.locator('#viewSet').waitFor();
    await page.getByRole('button', { name: '发音设置', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '标准', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByRole('button', { name: '打开词卡自动发音', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByRole('button', { name: '音量均衡', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: /音量校准/ }).click();
    assert.equal(await page.getByRole('spinbutton', { name: '标准发音音量 (%)', exact: true }).inputValue(), '50');
    await page.getByRole('button', { name: '播放参考音频', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio')?.currentTime > .1);
    assert.equal(await page.locator('audio').evaluate((node) => node.volume), 1);
    if (await page.getByRole('button', { name: '试听标准发音', exact: true }).isEnabled()) {
      await page.evaluate(() => {
        window.calibrationSpeech = [];
        speechSynthesis.speak = (u) => { calibrationSpeech.push({ text: u.text, volume: u.volume }); u.onstart?.(); };
      });
      await page.getByRole('button', { name: '试听标准发音', exact: true }).click();
      assert.equal(await page.locator('audio').count(), 0, 'TTS stops the reference');
      assert.deepEqual(await page.evaluate(() => calibrationSpeech.at(-1)), { text: 'Hello! It is a lovely day.', volume: .5 });
    }
    await page.getByRole('button', { name: '减小标准发音音量', exact: true }).click();
    assert.equal(await page.getByRole('spinbutton', { name: '标准发音音量 (%)', exact: true }).inputValue(), '45');
    if (await page.getByRole('button', { name: '试听标准发音', exact: true }).isEnabled()) {
      await page.getByRole('button', { name: '试听标准发音', exact: true }).click();
      assert.ok(Math.abs(await page.evaluate(() => calibrationSpeech.at(-1).volume) - .45) < 1e-6);
    }
    await page.getByRole('button', { name: '停止试听', exact: true }).click();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async (theme) => (await import('/js/settings.js')).setSetting('theme', theme), theme);
        assert.equal(await page.locator('.sheet-body').evaluate((node) => node.scrollWidth > node.clientWidth), false);
        await page.screenshot({ path: path.join(shots, `calibration-${width}-${theme}.png`), animations: 'disabled' });
      }
    }
    await page.getByRole('button', { name: '播放参考音频', exact: true }).click();
    await page.locator('.sheet-head [aria-label="关闭"]').click();
    assert.equal(await page.locator('audio').count(), 0);
    assert.match(await page.getByRole('button', { name: /音量校准/ }).textContent(), /45%/);
    await page.reload();
    await page.getByRole('button', { name: '发音设置', exact: true }).click();
    assert.match(await page.getByRole('button', { name: /音量校准/ }).textContent(), /45%/);
    assert.deepEqual(errors, []);
    console.log('Pronunciation browser checks passed:', shots);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
