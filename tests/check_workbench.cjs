/** Browser smoke check. Start a static web server first; supply a Playwright module path if needed.
 * node tests/check_workbench.cjs [playwright-module-path] [base-url]
 * Uses an isolated browser context and local mocked API responses; no real ASR calls.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5184';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    let downloads = 0, asrRequests = 0;
    page.on('download', () => downloads++);
    await page.route('**/api/health*', (route) => route.fulfill({ json: { version: 'test', schemaVersion: 2 } }));
    await page.route('**/api/analyze*', (route) => route.fulfill({ status: 503, json: { error: 'test: analysis temporarily offline' } }));
    await page.route('**/v1/audio/transcriptions', async (route) => {
      asrRequests++;
      const body = route.request().postDataBuffer();
      if (asrRequests === 1) {
        assert.ok(body.includes(Buffer.from('filename="stereo.16k.mp3"')));
        assert.ok(body.includes(Buffer.from('audio/mpeg')));
        assert.equal(body.indexOf('RIFF'), -1);
      } else {
        const riff = body.indexOf('RIFF'); assert.ok(riff >= 0);
        assert.equal(body.readUInt32LE(riff + 24), 48000);
        assert.equal(body.readUInt16LE(riff + 22), 2);
      }
      assert.equal(await page.getByRole('button', { name: /取消/ }).count(), 0);
      assert.equal(route.request().headers().authorization, 'Bearer smoke-key');
      assert.ok(body.includes(Buffer.from('name="temperature"\r\n\r\n0')));
      assert.ok(body.includes(Buffer.from('name="vad_filter"\r\n\r\nTrue')));
      assert.ok(body.includes(Buffer.from('name="condition_on_previous_text"\r\n\r\nFalse')));
      assert.ok(body.includes(Buffer.from('name="hotwords"\r\n\r\nLingua Track')));
      assert.equal(body.includes(Buffer.from('name="batch_size"')), false);
      await route.fulfill({ json: { text: 'Hello.', segments: [{ start: 0, end: 0.1, text: 'Hello.' }] } });
    });
    await page.goto(base + '/index.html#workbench');
    await page.waitForFunction(() => location.hash === '');
    assert.equal(await page.locator('#navWorkbench').isVisible(), false);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '实验性功能', exact: true }).click();
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    assert.equal(await page.locator('.workbench-subtitle-import').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '导入字幕到对应音频', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '刷新音频列表', exact: true }).count(), 0);
    await page.reload(); await page.locator('#workbenchBody .workbench-card').first().waitFor();
    await page.evaluate(() => {
      window.cancelButtonSeen = false;
      new MutationObserver(() => {
        if ([...document.querySelectorAll('#viewWorkbench button')].some((b) => /取消/.test(b.textContent))) window.cancelButtonSeen = true;
      }).observe(document.querySelector('#viewWorkbench'), { childList: true, subtree: true });
    });
    const videoCheck = await page.evaluate(async () => {
      const { extractMedia, convertMedia } = await import('./js/workbench-media.js');
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      const merger = ctx.createChannelMerger(2);
      const oscillators = [440, 880].map((frequency, i) => {
        const osc = ctx.createOscillator(); osc.frequency.value = frequency; osc.connect(merger, 0, i); osc.start(); return osc;
      });
      merger.connect(dest);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      canvas.getContext('2d').fillRect(0, 0, 64, 64);
      const stream = canvas.captureStream(10);
      for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', audioBitsPerSecond: 128000 });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const done = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start(); await new Promise((r) => setTimeout(r, 600)); recorder.stop(); await done;
      oscillators.forEach((o) => o.stop()); stream.getTracks().forEach((t) => t.stop()); await ctx.close();
      const master = await extractMedia(new File(chunks, 'stereo-video.webm', { type: 'video/webm' }));
      const proxy = await convertMedia(master);
      const decoded = await new OfflineAudioContext(2, 1, master.sampleRate).decodeAudioData(await master.file.arrayBuffer());
      const left = decoded.getChannelData(0), right = decoded.getChannelData(1);
      const difference = left.reduce((sum, v, i) => sum + Math.abs(v - right[i]), 0) / left.length;
      return { sampleRate: master.sampleRate, channels: master.channels, proxyChannels: proxy.channels, difference };
    });
    assert.equal(videoCheck.sampleRate, 48000); assert.equal(videoCheck.channels, 2);
    assert.equal(videoCheck.proxyChannels, 2); assert.ok(videoCheck.difference > 0.1);
    const wav = await page.evaluate(async () => {
      const { encodeWav } = await import('./js/workbench-media.js');
      const channels = [440, 880].map((hz) => Float32Array.from({ length: 4800 }, (_, i) => 0.4 * Math.sin(2 * Math.PI * hz * i / 48000)));
      return Array.from(new Uint8Array(await encodeWav(channels, 48000, true).arrayBuffer()));
    });
    await page.locator('input[aria-label="选择视频或音频"]').setInputFiles({ name: 'stereo.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav) });
    const firstCard = page.locator('.workbench-card').first();
    assert.equal(await page.getByLabel('音频标题（可选）').count(), 0);
    assert.equal(await page.getByRole('button', { name: '打开已添加的音频' }).count(), 0);
    const extractRect = await firstCard.getByRole('button', { name: '提取聆听音频', exact: true }).boundingBox();
    const downloadRect = await firstCard.getByRole('button', { name: '下载音频', exact: true }).boundingBox();
    assert.equal(extractRect.y, downloadRect.y);
    assert.equal(await firstCard.locator('.workbench-file-copy b').textContent(), 'stereo.wav');
    const dropped = await page.evaluateHandle((wav) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(wav)], 'stereo.wav', { type: 'audio/wav' }));
      return transfer;
    }, wav);
    await firstCard.locator('.workbench-file-pick').dispatchEvent('drop', { dataTransfer: dropped });
    await dropped.dispose();
    assert.equal(await firstCard.locator('input[type="file"]').evaluate((input) => input.files[0].name), 'stereo.wav');
    await page.getByRole('button', { name: '提取聆听音频', exact: true }).click();
    await page.getByText('聆听音频已就绪', { exact: false }).waitFor();
    const master = await page.locator('audio').evaluate(async (audio) => {
      const b = await (await fetch(audio.src)).arrayBuffer(); const v = new DataView(b);
      return { rate: v.getUint32(24, true), channels: v.getUint16(22, true), format: v.getUint16(20, true), length: b.byteLength };
    });
    assert.deepEqual(master, { rate: 48000, channels: 2, format: 3, length: 38444 });
    assert.equal(await page.locator('.workbench-card').count(), 3);
    await page.getByRole('button', { name: '添加音频到首页', exact: true }).click();
    await page.getByText('聆听音频已添加到首页', { exact: false }).waitFor();
    const initial = await page.evaluate(async () => (await import('./js/library.js')).listTracks());
    assert.equal(initial.length, 1); assert.equal(initial[0].transcript, null);
    assert.equal(await page.getByRole('button', { name: '添加音频到首页', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '聆听原音频', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '开始转录', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '生成 16 kHz 音频', exact: true }).click();
    await page.getByText('已生成 · 16 kHz', { exact: false }).waitFor();
    await page.getByRole('button', { name: '转录接口配置', exact: true }).click();
    await page.locator('.sheet.is-open').waitFor();
    await page.getByLabel('接口地址', { exact: false }).fill(base + '/v1');
    await page.getByLabel('API Key', { exact: false }).fill('smoke-key');
    await page.getByRole('button', { name: 'SRT', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '词级时间戳', exact: true }).isVisible(), false);
    await page.getByRole('button', { name: '详细 JSON', exact: true }).click();
    assert.equal(await page.locator('.workbench-toggle').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('.workbench-param').count(), 7);
    assert.equal(await page.locator('.workbench-param .switch[aria-pressed="true"]').count(), 0);
    await page.getByRole('button', { name: '启用 temperature', exact: true }).click();
    await page.getByRole('button', { name: '启用 vad_filter', exact: true }).click();
    await page.getByRole('button', { name: '启用 condition_on_previous_text', exact: true }).click();
    for (const [key, value] of [['vad_filter', 'True'], ['condition_on_previous_text', 'False']]) {
      const row = page.locator('.workbench-param').filter({ has: page.getByRole('button', { name: `启用 ${key}`, exact: true }) });
      await row.getByLabel('参数值', { exact: true }).fill(value);
    }
    const batch = page.locator('.workbench-param').filter({ has: page.getByRole('button', { name: '启用 batch_size', exact: true }) });
    await batch.getByRole('button').click();
    await batch.getByLabel('参数值', { exact: true }).fill('0');
    assert.equal(await page.getByRole('button', { name: '开始转录', exact: true }).isDisabled(), true);
    await batch.getByLabel('参数值', { exact: true }).fill('32');
    await batch.getByRole('button').click();
    await page.getByRole('button', { name: '新增键值对', exact: true }).click();
    const custom = page.locator('.workbench-param').last();
    assert.equal(await page.getByRole('button', { name: '开始转录', exact: true }).isDisabled(), true);
    await custom.getByLabel('参数名', { exact: true }).fill('model');
    await page.getByText(/自定义参数 model 与内置选项冲突/).waitFor();
    await custom.getByLabel('参数名', { exact: true }).fill('temperature');
    await page.getByText(/自定义参数 temperature 重复/).waitFor();
    await custom.getByLabel('参数名', { exact: true }).fill('hotwords');
    await custom.getByLabel('参数值', { exact: true }).fill('Lingua Track');
    await page.getByRole('button', { name: '新增键值对', exact: true }).click();
    await page.locator('.workbench-param').last().getByRole('button', { name: '删除', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '开始转录', exact: true }).isEnabled(), true);
    await page.locator('.workbench-custom').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'linguatrack-workbench-params.png') });
    await page.locator('.workbench-choice').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'linguatrack-workbench-options.png') });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '转录接口配置', exact: true }).click();
    assert.equal(await page.getByLabel('接口地址', { exact: false }).inputValue(), base + '/v1');
    assert.equal(await batch.getByLabel('参数值', { exact: true }).inputValue(), '32');
    assert.equal(await batch.getByLabel('参数值', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '启用 temperature', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '开始转录', exact: true }).click();
    await page.getByText('转录完成 ·', { exact: false }).waitFor();
    await page.getByRole('button', { name: '导入字幕到对应音频', exact: true }).click();
    await page.getByText('字幕已导入，可直接播放；需要时可在播放页分析。', { exact: true }).waitFor();
    const saved = await page.evaluate(async () => {
      const lib = await import('./js/library.js'); const tracks = await lib.listTracks(); const t = tracks[0];
      const b = await (await lib.audioBlob(t.id)).arrayBuffer(); const v = new DataView(b);
      return { count: tracks.length, rate: v.getUint32(24, true), channels: v.getUint16(22, true),
        name: t.audio.name, missing: t.transcript.missing, text: await (await lib.transcriptBlob(t.id)).text() };
    });
    assert.equal(saved.count, 1); assert.equal(saved.rate, 48000); assert.equal(saved.channels, 2);
    assert.equal(saved.name, 'stereo.lossless.wav'); assert.equal(saved.missing, false);
    assert.equal(JSON.parse(saved.text).segments[0].text, 'Hello.');
    assert.equal(downloads, 0); assert.equal(asrRequests, 1);
    // A second transcript updates the same audio, without duplicating the listening master.
    await page.getByRole('button', { name: '导入后分析字幕', exact: true }).click();
    await page.getByRole('button', { name: '聆听原音频', exact: true }).click();
    await page.route('**/api/analyze*', (route) => {
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: { track: { schemaVersion: 2, id: params.get('id'), title: params.get('title'),
        lang: { code: params.get('lang') }, audio: { duration: 0.1 }, stats: { sentences: 1, words: 1 },
        sentences: [{ i: 0, start: 0, end: 0.1, text: 'Hello.', words: [] }] } } });
    });
    await page.getByRole('button', { name: '开始转录', exact: true }).click();
    await page.getByText('转录完成 ·', { exact: false }).waitFor();
    await page.getByRole('button', { name: '导入字幕到对应音频', exact: true }).click();
    await page.getByText('字幕已导入对应音频，分析完成，可以开始聆听。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '导入字幕到对应音频', exact: true }).isDisabled(), true);
    const records = await page.evaluate(async () => (await import('./js/library.js')).listTracks());
    assert.equal(records.length, 1); assert.ok(records.some((t) => t.status === 'ready'));
    await page.locator('.workbench-entry').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'linguatrack-workbench-entry.png') });
    await page.locator('.workbench-target-bar').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'linguatrack-workbench-target.png') });
    // Explicitly attach this result to another existing audio and invalidate only its old analysis/cache.
    const otherId = await page.evaluate(async () => {
      const lib = await import('./js/library.js');
      const original = (await lib.listTracks())[0];
      const other = await lib.createPreparedTrack(new File([await lib.audioBlob(original.id)], 'other.wav', { type: 'audio/wav' }), null);
      await lib.saveAnalysis(other.id, { schemaVersion: 2, sentences: [{ text: 'Old' }] });
      const store = await import('./js/store.js');
      await store.put('chat', other.id + '|0', { msgs: ['old'] }, other.id);
      await store.put('chat', original.id + '|0', { msgs: ['keep'] }, original.id);
      return other.id;
    });
    await page.getByLabel('对应的首页音频', { exact: true }).click();
    await page.locator('.sheet.is-open').waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(os.tmpdir(), 'linguatrack-workbench-picker.png') });
    await page.locator('.workbench-track-option').filter({ hasText: 'other.wav' }).click();
    await page.route('**/api/analyze*', (route) => route.fulfill({ status: 503, json: { error: 'offline' } }));
    await page.getByRole('button', { name: '导入字幕到对应音频', exact: true }).click();
    await page.getByText('字幕已保存到对应音频。字幕分析未完成', { exact: false }).waitFor();
    const replaced = await page.evaluate(async (id) => {
      const lib = await import('./js/library.js'), store = await import('./js/store.js');
      const rows = await lib.listTracks(), original = rows.find((r) => r.id !== id);
      return { count: rows.length, status: (await lib.getTrack(id)).status,
        data: await lib.trackData(id), subtitle: await (await lib.transcriptBlob(id)).text(),
        oldCache: await store.get('chat', id + '|0'), keepCache: await store.get('chat', original.id + '|0') };
    }, otherId);
    assert.equal(replaced.count, 2); assert.equal(replaced.status, 'subtitles');
    assert.equal(replaced.data.subtitleMode, 'plain');
    assert.equal(replaced.oldCache, undefined); assert.deepEqual(replaced.keepCache, { msgs: ['keep'] });
    assert.equal(JSON.parse(replaced.subtitle).segments[0].text, 'Hello.');
    // Deleting a selected target cannot silently create a duplicate or overwrite another record.
    await page.evaluate(async (id) => (await import('./js/library.js')).removeTrack(id), otherId);
    await page.getByLabel('对应的首页音频', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('button[aria-label="对应的首页音频"]').value === '');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '导入字幕到对应音频', exact: true }).isDisabled(), true);
    const screenshot = path.join(os.tmpdir(), 'linguatrack-workbench-mobile.png');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.scrim')).opacity === '0');
    await page.locator('#viewWorkbench').evaluate((el) => { el.scrollTop = 0; });
    await page.screenshot({ path: screenshot });
    for (const width of [320, 720]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.locator('#viewWorkbench').evaluate((el) => el.scrollWidth <= el.clientWidth), true);
      const a = await firstCard.getByRole('button', { name: '提取聆听音频', exact: true }).boundingBox();
      const b = await firstCard.getByRole('button', { name: '下载 WAV', exact: true }).boundingBox();
      const middle = await firstCard.getByRole('button', { name: '添加音频到首页', exact: true }).boundingBox();
      assert.equal(a.y, b.y);
      assert.equal(a.y, middle.y); assert.ok(a.x < middle.x && middle.x < b.x);
      assert.equal(await firstCard.locator('.workbench-extract-actions').evaluate((bar) =>
        [...bar.children].every((button) => button.scrollWidth <= button.clientWidth)), true);
      const gaps = await page.locator('.workbench-card').evaluateAll((cards) => cards.flatMap((card) => {
        const children = [...card.children].filter((el) => el.getBoundingClientRect().height > 0);
        return children.slice(1).map((el, i) => el.getBoundingClientRect().top - children[i].getBoundingClientRect().bottom);
      }));
      assert.ok(gaps.every((gap) => gap >= 17), 'card rows need consistent breathing room');
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByLabel('对应的首页音频', { exact: true }).click();
    await page.locator('.workbench-track-option').first().waitFor();
    const filenameCheck = await page.locator('.workbench-file-copy b, .workbench-target .workbench-entry-copy b, .workbench-track-option .workbench-entry-copy > *, .workbench-filename').evaluateAll((nodes) => {
      return nodes.map((node) => {
        const old = node.textContent;
        node.textContent = '很长的文件名_'.repeat(30) + '.m4a';
        const css = getComputedStyle(node);
        const valid = css.whiteSpace === 'nowrap' && css.textOverflow === 'ellipsis'
          && node.scrollWidth > node.clientWidth && node.getBoundingClientRect().height < 30;
        node.textContent = old; return valid;
      });
    });
    assert.ok(filenameCheck.length >= 5 && filenameCheck.every(Boolean));
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300); // Let the theme/hover color transition finish before visual QA.
    await page.screenshot({ path: path.join(os.tmpdir(), 'linguatrack-workbench-dark.png') });
    await page.getByRole('button', { name: '首页', exact: true }).click();
    await page.getByRole('button', { name: 'stereo · 打开', exact: true }).first().waitFor();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '实验性功能', exact: true }).click();
    assert.equal(await page.locator('#navWorkbench').isVisible(), false);
    assert.equal(await page.evaluate(() => window.cancelButtonSeen), false);
    await page.goto(base + '/index.html#workbench'); await page.waitForFunction(() => location.hash === '');
    assert.equal(await page.locator('#viewWorkbench').isVisible(), false);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '实验性功能', exact: true }).click();
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.getByRole('button', { name: '转录接口配置', exact: true }).click();
    await page.getByLabel('提示词（可选）', { exact: false }).fill('Lingua\nTrack');
    await page.getByRole('button', { name: '词级时间戳', exact: true }).click();
    await page.getByRole('button', { name: '新增键值对', exact: true }).click();
    const draft = page.locator('.workbench-param').last();
    await draft.getByLabel('参数值', { exact: true }).fill('unfinished');
    await page.reload();
    await page.getByRole('button', { name: '转录接口配置', exact: true }).click();
    assert.equal(await page.getByLabel('提示词（可选）', { exact: false }).inputValue(), 'Lingua\nTrack');
    assert.equal(await page.getByRole('button', { name: '词级时间戳', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('接口地址', { exact: false }).inputValue(), base + '/v1');
    assert.equal(await page.getByLabel('API Key', { exact: false }).inputValue(), 'smoke-key');
    assert.equal(await page.locator('.workbench-param').count(), 9);
    assert.equal(await batch.getByLabel('参数值', { exact: true }).inputValue(), '32');
    assert.equal(await batch.getByLabel('参数值', { exact: true }).isDisabled(), true);
    for (const [key, value] of [['vad_filter', 'True'], ['condition_on_previous_text', 'False'], ['temperature', '0']]) {
      const row = page.locator('.workbench-param').filter({ has: page.getByRole('button', { name: `启用 ${key}`, exact: true }) });
      assert.equal(await row.getByLabel('参数值', { exact: true }).inputValue(), value);
      assert.equal(await row.getByRole('button').getAttribute('aria-pressed'), 'true');
    }
    assert.equal(await page.locator('.workbench-param').nth(7).getByLabel('参数名', { exact: true }).inputValue(), 'hotwords');
    assert.equal(await draft.getByLabel('参数值', { exact: true }).inputValue(), 'unfinished');
    await page.getByText('自定义参数名称不能为空或包含换行', { exact: true }).waitFor();
    await draft.getByRole('button', { name: '删除', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '转录接口配置', exact: true }).click();
    assert.equal(await page.locator('.workbench-param').count(), 8);
    assert.deepEqual(errors, []);
    console.log('PASS: feature gate, lossless stereo master, 16 kHz ASR, multipart request, direct durable import, retryable analysis failure, no downloads, no browser errors.');
    console.log('Screenshot:', screenshot);
  } finally { await browser.close(); }
})().catch((err) => { console.error(err); process.exitCode = 1; });
