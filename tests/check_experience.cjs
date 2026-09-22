/** Isolated Chromium/WebKit regression. Serve web/ before running.
 * node tests/check_experience.cjs [playwright-module] [base-url]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5187';

(async () => {
  const shots = path.resolve('.cache/experience-qa');
  await fs.mkdir(shots, { recursive: true });
  for (const type of [chromium, webkit]) {
    const browser = await type.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.classList.add('native-app');
      }));
      await page.goto(base);
      const seed = await page.evaluate(async () => {
        const lib = await import('/js/library.js');
        const { exportBackup, importBackup } = await import('/js/backup.js');
        const rate = 16000, samples = rate * 60, wav = new Uint8Array(44 + samples * 2);
        const view = new DataView(wav.buffer);
        const str = (at, text) => [...text].forEach((c, i) => { wav[at + i] = c.charCodeAt(0); });
        str(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        str(36, 'data'); view.setUint32(40, samples * 2, true);
        const audio = await lib.createTrack(new File([wav], 'Lesson.wav', { type: 'audio/wav' }), { lang: 'en' });
        const video = await lib.createTrack(new File(['video'], 'Lesson.mp4', { type: 'video/mp4' }), { lang: 'en' });
        const srt = Array.from({ length: 30 }, (_, i) => `${i + 1}\n00:00:${String(i * 2).padStart(2, '0')},000 --> 00:00:${String(i * 2 + 1).padStart(2, '0')},900\nLesson sentence number ${i + 1}.`).join('\n\n');
        const { plainTrack, parseSubtitles } = await import('/js/subtitles.js');
        for (const [record, name] of [[audio, 'audio.srt'], [video, 'video.srt']]) {
          await lib.saveAnalysis(record.id, plainTrack(record, parseSubtitles(srt, name)), { transcriptName: name });
        }
        const backup = await exportBackup();
        await lib.removeTrack(audio.id); await lib.removeTrack(video.id);
        await importBackup(backup);
        return { audio: audio.id, video: video.id, wav: [...wav], srt };
      });
      await page.goto(base + '/index.html#restore');
      await page.locator('input[aria-label="批量选择待补充文件"]').setInputFiles([
        { name: 'Lesson.wav', mimeType: 'audio/wav', buffer: Buffer.from(seed.wav) },
        { name: 'Lesson.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video') },
        { name: 'audio.srt', mimeType: 'text/plain', buffer: Buffer.from(seed.srt) },
        { name: 'video.srt', mimeType: 'text/plain', buffer: Buffer.from(seed.srt) },
      ]);
      await page.getByText('已补充 4 个文件', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(async () => {
        const lib = await import('/js/library.js');
        const records = await lib.listTracks();
        return { missing: lib.missingFiles(records).length,
          files: await Promise.all(records.map(async (r) => [(await lib.audioBlob(r.id)).size, (await lib.transcriptBlob(r.id)).size])) };
      }), { missing: 0, files: [[5, Buffer.byteLength(seed.srt)], [seed.wav.length, Buffer.byteLength(seed.srt)]] });
      await page.screenshot({ path: path.join(shots, type.name() + '-repair.png') });
      await page.locator('.sheet-head [aria-label="关闭"]').click();
      await page.getByRole('button', { name: /^系统字幕字号/ }).click();
      const caption = page.getByRole('spinbutton', { name: '系统字幕字号 (px)' });
      await caption.fill('28'); await caption.press('Tab');
      await page.locator('.sheet-head [aria-label="关闭"]').click();
      await page.getByRole('button', { name: /^视频设置/ }).click();
      await page.waitForFunction(() => {
        const sheet = document.querySelector('.sheet.is-open');
        return sheet && Math.abs(sheet.getBoundingClientRect().bottom - innerHeight) < 1;
      });
      assert.equal(await page.locator('.sheet').getByRole('button', { name: /^系统字幕字号/ }).count(), 0);
      assert.equal(await page.locator('.sheet').getByText('字幕字号', { exact: true }).count(), 0);
      assert.equal(await page.locator('.sheet').getByRole('button', { name: /^视频字幕字号/ }).count(), 0);
      await page.screenshot({ path: path.join(shots, type.name() + '-video-settings.png') });
      await page.locator('.sheet-head [aria-label="关闭"]').click();
      await page.goto(base + '/index.html');
      const sizes = await page.locator('.card-wm').evaluateAll((nodes) => nodes.map((n) => {
        const r = n.getBoundingClientRect(); return [r.width, r.height];
      }));
      assert.deepEqual(sizes, [[96, 96], [96, 96]]);
      await page.screenshot({ path: path.join(shots, type.name() + '-home.png') });
      const replacement = await page.evaluate(async (id) => {
        const { attachFiles, audioBlob, getTrack } = await import('/js/library.js');
        const { snapshot } = await import('/js/store.js');
        const chunks = async () => (await snapshot(['audioChunks'])).audioChunks.map((r) => r.key).sort();
        const before = await chunks();
        let rejected = false;
        try { await attachFiles(id, { audio: new File(['replacement'], 'Lesson.mp4', { type: 'video/mp4' }),
          transcript: new File(['invalid'], 'bad.txt') }); } catch { rejected = true; }
        const rolledBack = JSON.stringify(before) === JSON.stringify(await chunks()) && (await audioBlob(id)).size === 5;
        await attachFiles(id, { audio: new File(['replacement'], 'Lesson.mp4', { type: 'video/mp4' }) });
        return { rejected, rolledBack, size: (await audioBlob(id)).size,
          missing: (await getTrack(id)).audio.missing, sameCount: (await chunks()).length === before.length };
      }, seed.video);
      assert.deepEqual(replacement, { rejected: true, rolledBack: true, size: 11, missing: false, sameCount: true });
      await page.locator('.card-video').getByRole('button', { name: '更多操作' }).tap();
      await page.getByRole('menuitem', { name: '删除', exact: true }).tap();
      await page.locator('.confirm-acts').getByRole('button', { name: '取消', exact: true }).tap();
      assert.equal(await page.locator('.card-video').count(), 1);
      await page.locator('.card-video').getByRole('button', { name: '更多操作' }).tap();
      await page.getByRole('menuitem', { name: '删除', exact: true }).tap();
      await page.locator('.confirm-acts').getByRole('button', { name: '删除', exact: true }).tap();
      await page.waitForFunction(() => !document.querySelector('.card-video'));
      await page.goto(base + '/player.html?track=' + seed.audio + '&debug');
      await page.waitForFunction(() => window.LT?.track?.S === 30);
      await page.evaluate(() => LT.engine.seek(40));
      await page.waitForFunction(() => LT.reader.activeS === 20);
      await page.locator('#btnDisplay').click();
      await page.getByRole('button', { name: /^字幕管理/ }).click();
      await page.waitForFunction(() => !document.querySelector('.sheet.is-open')
        && document.querySelector('.sheet').getBoundingClientRect().top >= innerHeight);
      const management = await page.evaluate(() => {
        const setup = document.getElementById('setup'), reader = document.getElementById('viewport');
        window.dispatchEvent(new Event('resize')); LT.engine.markScrollDirty();
        return { top: setup.getBoundingClientRect().top, viewHeight: innerHeight,
          hidden: setup.hidden, readerHidden: reader.hidden, suspended: LT.engine.suspended, frame: LT.engine._raf };
      });
      assert.equal(management.hidden, false); assert.equal(management.readerHidden, true);
      assert.equal(management.suspended, true); assert.equal(management.frame, 0);
      assert.ok(management.top >= 0 && management.top < management.viewHeight / 2);
      await page.screenshot({ path: path.join(shots, type.name() + '-subtitle-management.png') });
      await page.getByRole('button', { name: '返回播放', exact: true }).click();
      await page.waitForFunction(() => !LT.engine.suspended && !document.getElementById('viewport').hidden);
      await page.evaluate(() => LT.engine.seek(4));
      await page.waitForFunction(() => LT.reader.activeS === 2);
      await page.locator('#scroller').dispatchEvent('touchmove');
      assert.equal(await page.locator('#btnPin').getAttribute('aria-pressed'), 'false');
      assert.equal(await page.evaluate(() => LT.engine.follow), false);
      await page.locator('#btnPin').click();
      assert.equal(await page.evaluate(() => LT.engine.follow), true);
      await page.locator('#scroller').dispatchEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
      assert.equal(await page.evaluate(() => LT.engine.follow), true);
      await page.evaluate(() => LT.relayout(true));
      assert.equal(await page.evaluate(() => LT.engine.follow), true);
      await page.locator('#scroller').dispatchEvent('wheel', { deltaY: 100 });
      assert.equal(await page.locator('#btnPin').getAttribute('aria-pressed'), 'false');
      assert.equal(await page.evaluate(async () => (await import('/js/trackcfg.js')).trackCfg.video.captionSize), 28);
      assert.deepEqual(errors, []);

      // A development origin may have stores created by much older builds, without indexes.
      const legacy = await browser.newContext();
      const old = await legacy.newPage();
      await old.goto(base + '/css/base.css');
      const result = await old.evaluate(async () => {
        const { STORES, put, get } = await import('/js/store.js');
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('linguatrack', 4);
          request.onupgradeneeded = () => STORES.forEach((s) => request.result.createObjectStore(s));
          request.onsuccess = () => { request.result.close(); resolve(); };
          request.onerror = () => reject(request.error);
        });
        const { removeTrack } = await import('/js/library.js');
        for (const s of STORES) {
          await put(s, s === 'tracks' || s === 'audio' ? 'old' : 'old|part', { data: 'mine' });
          await put(s, 'other', { data: 'keep' });
        }
        // Force a transaction failure; successful requests must not report deletion success.
        const original = IDBObjectStore.prototype.delete;
        IDBObjectStore.prototype.delete = function (key) {
          const request = original.call(this, key);
          if (this.name === 'tracks') request.onsuccess = () => this.transaction.abort();
          return request;
        };
        let rejected = false;
        try { await removeTrack('old'); } catch { rejected = true; }
        finally { IDBObjectStore.prototype.delete = original; }
        const retained = !!await get('tracks', 'old');
        await removeTrack('old');
        return { rejected, retained, checks: await Promise.all(STORES.map(async (s) => [
          await get(s, s === 'tracks' || s === 'audio' ? 'old' : 'old|part') === undefined,
          (await get(s, 'other')).data === 'keep',
        ])) };
      });
      assert.equal(result.rejected, true); assert.equal(result.retained, true);
      assert.ok(result.checks.every(([removed, kept]) => removed && kept));
      console.log(`PASS ${type.name()}: backup repair, menu layout, pin state, deletion and legacy transaction rollback`);
    } finally { await browser.close(); }
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
