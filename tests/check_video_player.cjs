/** Real-media regression, in an isolated browser context with mocked subtitle analysis.
 * node tests/check_video_player.cjs [playwright-module] [base-url] /path/to/30-second.mp4
 * Serve web/ first. Fixture needs a video track and duration >= 20 seconds.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:5186';
const fixture = process.argv[4];

(async () => {
  assert.ok(fixture, 'Pass a playable MP4 fixture with duration >= 20 seconds');
  const bytes = await fs.readFile(fixture);
  const shots = path.resolve('.cache/video-player-qa');
  await fs.mkdir(shots, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    let systemSheetWidth = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/health*', (route) => route.fulfill({ json: { version: 'test', schemaVersion: 2 } }));
    await page.route('**/api/analyze*', (route) => {
      const q = new URL(route.request().url()).searchParams;
      const texts = ['Welcome to the video lesson.', 'Listen and follow the subtitles.',
        'Tap a word to replay this sentence.', 'Rotate your screen while learning.',
        'Your playback position stays the same.', 'Keep practising every day.'];
      const sentences = texts.map((text, i) => ({ i, start: i * 4, end: i * 4 + 4,
        text, wordTiming: true, words: text.split(' ').map((word, j, words) => ({
          text: word, read: 'reading', roman: 'lemma', pos: 'noun',
          start: i * 4 + j * 4 / words.length, end: i * 4 + (j + 1) * 4 / words.length,
        })) }));
      return route.fulfill({ json: { ok: true, track: { schemaVersion: 2,
        id: q.get('id'), title: q.get('title'), audio: { duration: 30 },
        lang: { code: 'en', spaceDelimited: true, layers: { read: 'IPA', roman: 'Lemma' },
          layerOrder: ['read', 'roman'], features: ['read', 'roman', 'tr', 'pos', 'card'] },
        hasWordTiming: true, sentences, stats: { sentences: 6, words: 36 } } } });
    });
    await page.goto(base + '/index.html');
    await page.locator('#fileAudio').setInputFiles({ name: 'Video lesson.mp4', mimeType: 'video/mp4', buffer: bytes });
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await page.locator('.card-video').waitFor();
    await page.waitForFunction(() => {
      const sheet = document.querySelector('.sheet');
      return !sheet || sheet.getBoundingClientRect().top >= innerHeight;
    });
    assert.equal(await page.locator('.card-video .art use').getAttribute('href'), '#i-video');
    assert.equal(await page.locator('.card-video .card-wm use').getAttribute('href'), '#i-video');
    assert.equal(await page.locator('.card-video .art').evaluate((el) => getComputedStyle(el).borderRadius), '50%');
    assert.match(await page.locator('.card-video .card-in').evaluate((el) => getComputedStyle(el).backgroundImage), /gradient/);
    await page.screenshot({ path: path.resolve('.cache/video-player-qa/home.png') });
    await page.getByRole('button', { name: 'Video lesson · 打开', exact: true }).click();
    await page.locator('#setup input[type=file]').setInputFiles({ name: 'lesson.srt', mimeType: 'text/plain',
      buffer: Buffer.from('1\n00:00:00,000 --> 00:00:04,000\nWelcome to the video lesson.\n') });
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.app.has-video') && document.querySelector('#video').readyState >= 2);
    const trackId = new URL(page.url()).searchParams.get('track');
    await page.goto(base + '/player.html?track=' + trackId + '&debug');
    await page.waitForFunction(() => window.LT?.track && document.querySelector('.app.has-video'));
    await page.evaluate(() => {
      window.mediaBeforeRotation = document.querySelector('#video');
      window.readerBeforeRotation = LT.reader;
      window.loadEvents = 0;
      mediaBeforeRotation.addEventListener('loadstart', () => window.loadEvents++);
    });

    async function bounds(landscape) {
      await page.waitForFunction((expected) => document.querySelector('#app').classList.contains('is-immersive') === expected, landscape);
      const boxes = await page.evaluate(() => {
        const rect = (id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        return { video: rect('videoStage'), reader: rect('scroller'), player: rect('player'),
          width: innerWidth, height: innerHeight, position: getComputedStyle(document.querySelector('#scroller')).position };
      });
      for (const b of [boxes.video, boxes.reader]) {
        assert.ok(b.height > 50 && b.width > 100, JSON.stringify(boxes));
        assert.ok(b.x >= -1 && b.right <= boxes.width + 1 && b.y >= 0 && b.bottom <= boxes.height + 1, JSON.stringify(boxes));
      }
      if (landscape) {
        assert.equal(boxes.position, 'absolute');
        assert.ok(boxes.reader.y > boxes.video.y && boxes.reader.bottom < boxes.video.bottom);
      } else assert.ok(boxes.reader.y >= boxes.video.bottom - 1);
      if (!landscape) assert.ok(boxes.player.y >= boxes.video.bottom - 1);
      else assert.ok(boxes.video.y === 0 && boxes.video.height >= boxes.height - 1);
    }
    const reveal = async () => {
      if (!await page.locator('#app').evaluate((el) => el.classList.contains('controls-visible'))) {
        await page.waitForFunction(() => !document.querySelector('.scrim.is-open'));
        const point = await page.evaluate(() => {
          const video = document.querySelector('#video'), b = video.getBoundingClientRect();
          for (const fy of [.2, .12, .5, .85]) for (const fx of [.5, .2, .8, .05]) {
            const x = b.x + b.width * fx, y = b.y + b.height * fy;
            if (document.elementFromPoint(x, y) === video) return { x, y };
          }
        });
        assert.ok(point, 'picture must expose a tappable area');
        await page.mouse.click(point.x, point.y);
        await page.waitForFunction(() => document.querySelector('#app').classList.contains('controls-visible'));
      }
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#player')).visibility === 'visible');
    };
    await bounds(false);
    assert.equal(await page.evaluate(() => document.querySelector('#app').style.getPropertyValue('--cue-size')), '20px');
    // 原生小窗: 画面和字幕一起进系统小窗, 播放页原位只剩收回提示。
    assert.equal(await page.locator('#btnVideoPip').isVisible(), false);
    await reveal();
    assert.equal(await page.locator('#btnVideoPip').isVisible(), true);
    await page.screenshot({ path: path.join(shots, 'portrait-controls.png') });
    const trBefore = await page.evaluate(async () => {
      const { trackCfg, setTrackCfg } = await import('/js/trackcfg.js');
      const before = trackCfg.tr ? 1 : 0;
      if (!before) setTrackCfg('tr', 1);   // 小窗里的译文跟着这个开关走
      LT.reader.setTranslation(0, '欢迎来到视频课。');
      LT.vlist.invalidate([0]);
      return before;
    });
    await page.locator('#btnPlay').click();
    await page.waitForFunction(() => LT.engine.audio.currentTime > 0.5);
    await reveal();
    await page.locator('#btnVideoPip').click();
    await page.waitForFunction(() => {
      const doc = window.documentPictureInPicture.window?.document;
      return !!doc?.querySelector('.pip-subs') && getComputedStyle(doc.querySelector('.pip-subs')).position === 'absolute';
    });
    const pipShot = await page.evaluate(() => {
      const doc = window.documentPictureInPicture.window.document;
      return { hasVideo: !!doc.querySelector('video'), text: doc.querySelector('.pip-text').textContent,
        tr: doc.querySelector('.pip-tr').textContent, trShown: !doc.querySelector('.pip-tr').hidden,
        theme: doc.documentElement.dataset.theme === document.documentElement.dataset.theme,
        widthVar: doc.querySelector('.pip-subs').style.getPropertyValue('--pip-width'),
        videoAway: !document.querySelector('#videoStage video'),
        note: !document.querySelector('#videoPipNote').hidden,
        pressed: document.querySelector('#btnVideoPip').getAttribute('aria-pressed') };
    });
    assert.deepEqual(pipShot, { hasVideo: true, text: 'Welcome to the video lesson.', tr: '欢迎来到视频课。',
      trShown: true, theme: true, widthVar: '96%', videoAway: true, note: true, pressed: 'true' });
    const pipPage = context.pages().find((candidate) => candidate !== page);
    if (pipPage) await pipPage.screenshot({ path: path.join(shots, 'pip.png') });
    const pipTime = await page.evaluate(() => LT.engine.audio.currentTime);
    await page.waitForFunction((from) => LT.engine.audio.currentTime > from + 0.3, pipTime);
    await page.evaluate(() => LT.engine.seek(5));
    await page.waitForFunction(() => window.documentPictureInPicture.window.document.querySelector('.pip-text').textContent
      === 'Listen and follow the subtitles.');
    // 字幕开关直接管小窗里的那一层
    await page.evaluate(async () => { const { setVideoCfg } = await import('/js/trackcfg.js'); setVideoCfg({ subtitles: 0 }); });
    await page.waitForFunction(() => window.documentPictureInPicture.window.document.querySelector('.pip-subs').hidden);
    await page.evaluate(async () => { const { setVideoCfg } = await import('/js/trackcfg.js'); setVideoCfg({ subtitles: 1 }); });
    await page.waitForFunction(() => !window.documentPictureInPicture.window.document.querySelector('.pip-subs').hidden);
    await page.locator('#videoPipNote').click();
    await page.waitForFunction(() => !window.documentPictureInPicture.window && !!document.querySelector('#videoStage video'));
    assert.equal(await page.locator('#videoPipNote').isHidden(), true);
    assert.equal(await page.locator('#btnVideoPip').getAttribute('aria-pressed'), 'false');
    await page.locator('#btnPlay').click();

    // 经典回退 (Safari/iOS): 系统只画 <video>, 所以整条时间轴镜像成一条原生字幕轨。
    const classic = await page.evaluate(async () => {
      const video = document.querySelector('#video');
      const ownApi = Object.getOwnPropertyDescriptor(window, 'documentPictureInPicture');
      const tr = document.documentElement.dataset.tr;
      document.documentElement.dataset.tr = '1';
      Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: null });
      Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => null });
      video.requestPictureInPicture = async () => {
        Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => video });
        video.dispatchEvent(new Event('enterpictureinpicture'));
      };
      document.exitPictureInPicture = async () => {
        Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => null });
        video.dispatchEvent(new Event('leavepictureinpicture'));
      };
      document.querySelector('#btnVideoPip').click();
      await new Promise((done) => setTimeout(done, 60));
      const track = video.textTracks[0];
      const cues = [...(track?.cues || [])].map((cue) => ({ start: cue.startTime, text: cue.text }));
      const opened = { mode: track?.mode, cues: cues.length, first: cues[0],
        note: !document.querySelector('#videoPipNote').hidden };
      document.querySelector('#btnVideoPip').click();
      await new Promise((done) => setTimeout(done, 60));
      const closed = { mode: track?.mode, note: !document.querySelector('#videoPipNote').hidden };
      document.documentElement.dataset.tr = tr;
      if (ownApi) Object.defineProperty(window, 'documentPictureInPicture', ownApi);
      else delete window.documentPictureInPicture;
      return { opened, closed };
    });
    assert.deepEqual(classic.opened, { mode: 'showing', cues: 6,
      first: { start: 0, text: 'Welcome to the video lesson.\n欢迎来到视频课。' }, note: true });
    assert.deepEqual(classic.closed, { mode: 'disabled', note: false });

    // 没有系统小窗接口的宿主 (WebClip / WebView) 只提示, 不再自造页面内浮层顶替。
    const refused = await page.evaluate(async () => {
      const video = document.querySelector('#video');
      const own = {
        api: Object.getOwnPropertyDescriptor(window, 'documentPictureInPicture'),
        pip: Object.getOwnPropertyDescriptor(video, 'requestPictureInPicture'),
        webkit: Object.getOwnPropertyDescriptor(video, 'webkitSetPresentationMode'),
      };
      Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: null });
      Object.defineProperty(video, 'requestPictureInPicture', { configurable: true, value: undefined });
      Object.defineProperty(video, 'webkitSetPresentationMode', { configurable: true, value: undefined });
      document.querySelector('#btnVideoPip').click();
      await new Promise((done) => setTimeout(done, 80));
      const state = { mini: document.querySelectorAll('.video-mini').length,
        toast: document.querySelector('#toast').textContent,
        inStage: !!document.querySelector('#videoStage video'),
        pressed: document.querySelector('#btnVideoPip').getAttribute('aria-pressed') };
      for (const [target, key, descriptor] of [[window, 'documentPictureInPicture', own.api],
        [video, 'requestPictureInPicture', own.pip], [video, 'webkitSetPresentationMode', own.webkit]]) {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      }
      return state;
    });
    assert.deepEqual(refused, { mini: 0, toast: '这个宿主没有系统小窗接口', inStage: true, pressed: 'false' });
    if (!trBefore) await page.evaluate(async () => (await import('/js/trackcfg.js')).setTrackCfg('tr', 0));
    await page.locator('#btnPlay').click();
    await page.waitForFunction(() => document.querySelector('#video').currentTime > 0.3);
    await page.locator('#btnPlay').click();
    await page.evaluate(() => { LT.engine.seek(9); document.querySelector('#video').playbackRate = 1.5; });
    await page.waitForFunction(() => LT.reader.activeS === 2 && !document.querySelector('#video').seeking);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#scroller')).position === 'absolute');
    await bounds(true);
    await page.waitForFunction(() => !document.querySelector('#app').classList.contains('controls-visible'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#player')).visibility === 'hidden');
    assert.equal(await page.locator('#btnPlay').isVisible(), false);
    assert.equal(await page.locator('#btnVideoSettings').count(), 0);
    assert.equal(await page.locator('#seek').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => ({ sameMedia: mediaBeforeRotation === document.querySelector('#video'),
      sameReader: readerBeforeRotation === LT.reader, loads: loadEvents, at: document.querySelector('#video').currentTime,
      rate: document.querySelector('#video').playbackRate })), { sameMedia: true, sameReader: true, loads: 0, at: 9, rate: 1.5 });
    await page.evaluate(() => LT.engine.scrollToActive());
    await page.locator('.s[data-i="2"] .w').first().click();
    await page.waitForFunction(() => Math.abs(document.querySelector('#video').currentTime - 8) < 0.05);
    await page.keyboard.press('Escape');
    await reveal();
    await page.locator('#seek').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => {
      const video = document.querySelector('#video');
      return Math.abs(video.currentTime - 13) < 0.05 && !video.seeking && video.readyState >= 2;
    });
    assert.equal(await page.locator('#seek').isVisible(), true);
    assert.equal(await page.locator('#btnToolFit').isVisible(), true);
    assert.equal(await page.locator('#btnToolSubtitles').isVisible(), true);
    assert.equal(await page.locator('#btnToolSettings').isVisible(), true);
    assert.equal(await page.locator('#btnToolPip').isVisible(), true);
    assert.equal(await page.locator('#btnToolRotate').isVisible(), true);
    assert.equal(await page.locator('#btnVideoRotate').isVisible(), false);
    assert.equal(await page.locator('.video-actions').count(), 0);
    assert.ok(Math.abs(await page.locator('.topbar').evaluate((el) => el.getBoundingClientRect().width) - 844) < 1);
    // 切句后虚拟列表会重挂节点, 等当前句稳定下来再取色, 免得量到正在卸载的那一个。
    const activeColor = await page.evaluate(async () => {
      for (let i = 0; i < 40; i++) {
        const el = document.querySelector('.s.is-active .w-text');
        if (el && el.isConnected) {
          const color = getComputedStyle(el).color;
          if (color) return color;
        }
        await new Promise((done) => requestAnimationFrame(done));
      }
      return '';
    });
    assert.equal(activeColor, 'rgb(255, 255, 255)');
    const oneLine = await page.evaluate(() => ({
      visible: [...document.querySelectorAll('#viewport .s')].filter((el) => getComputedStyle(el).display !== 'none').length,
      wrap: getComputedStyle(document.querySelector('.s.is-active .s-words')).flexWrap,
      translation: getComputedStyle(document.querySelector('.s.is-active .s-tr')).whiteSpace,
      overflow: getComputedStyle(document.querySelector('#scroller')).overflowX,
    }));
    assert.deepEqual(oneLine, { visible: 1, wrap: 'nowrap', translation: 'nowrap', overflow: 'auto' });

    // 横屏也能直接进小窗: 画面交给系统窗口后, 舞台只剩可以点回来的占位提示。
    await page.locator('#btnToolPip').click();
    await page.waitForFunction(() => !!window.documentPictureInPicture.window);
    assert.equal(await page.locator('#videoStage video').count(), 0);
    assert.equal(await page.locator('#videoPipNote').isVisible(), true);
    await page.locator('#videoPipNote').click();
    await page.waitForFunction(() => !window.documentPictureInPicture.window && !!document.querySelector('#videoStage video'));
    assert.equal(await page.locator('#app').evaluate((el) => el.classList.contains('is-immersive')), true);
    await page.locator('#btnRepeat').click();
    assert.equal(await page.locator('#btnRepeat').getAttribute('aria-pressed'), 'true');
    await page.locator('#btnRepeat').click(); await page.locator('#btnRepeat').click();
    await page.waitForFunction(() => !document.querySelector('#app').classList.contains('controls-visible'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#player')).visibility === 'hidden');
    assert.equal(await page.locator('#btnPlay').isVisible(), false);
    assert.equal(await page.locator('#seek').isVisible(), false);

    // Gestures use real pointer events on the picture, above the subtitle window.
    const point = async (x, y = .18) => {
      const b = await page.locator('#video').boundingBox();
      return { x: b.x + b.width * x, y: b.y + b.height * y };
    };
    const doubleTap = async (x) => { const p = await point(x); await page.mouse.dblclick(p.x, p.y, { delay: 75 }); };
    await doubleTap(.5);
    await page.waitForFunction(() => !document.querySelector('#video').paused);
    await doubleTap(.5);
    await page.waitForFunction(() => document.querySelector('#video').paused);
    await page.evaluate(() => LT.engine.seek(13));
    await doubleTap(.2);
    await page.waitForFunction(() => Math.abs(document.querySelector('#video').currentTime - 3) < .1);
    await doubleTap(.8);
    await page.waitForFunction(() => Math.abs(document.querySelector('#video').currentTime - 13) < .1);
    const swipe = async (x1, y1, x2, y2) => {
      const a = await point(x1, y1), b = await point(x2, y2);
      await page.mouse.move(a.x, a.y); await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
    };
    await swipe(.2, .18, .2, .38);
    assert.match(await page.locator('#video').evaluate((el) => el.style.filter), /brightness\(0\.7/);
    await swipe(.8, .18, .8, .38);
    assert.ok(Math.abs(await page.locator('#video').evaluate((el) => el.volume) - .7) < .03);
    await swipe(.3, .18, .5, .18);
    await page.waitForFunction(() => Math.abs(document.querySelector('#video').currentTime - 19) < .2);
    await page.evaluate(() => { LT.engine.seek(9); document.querySelector('#video').playbackRate = 1.25; });
    await doubleTap(.5);
    const center = await point(.5);
    await page.mouse.move(center.x, center.y); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('#video').playbackRate === 2);
    await page.mouse.up();
    assert.equal(await page.locator('#video').evaluate((el) => el.playbackRate), 1.25);
    await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('#video').playbackRate === 2);
    await page.locator('#video').dispatchEvent('pointercancel');
    await page.mouse.up();
    assert.equal(await page.locator('#video').evaluate((el) => el.playbackRate), 1.25);
    await doubleTap(.5);
    await page.waitForFunction(() => document.querySelector('#video').paused);
    await page.evaluate(() => { LT.engine.seek(8); LT.engine.scrollToActive(); });
    await page.waitForFunction(() => LT.reader.activeS === 2);
    await page.evaluate(() => LT.engine.scrollToActive());
    await page.waitForFunction(() => {
      const word = document.querySelector('.s[data-i="2"] .w').getBoundingClientRect();
      const scroller = document.querySelector('#scroller').getBoundingClientRect();
      return word.top >= scroller.top && word.bottom <= scroller.bottom;
    });
    const word = await page.locator('.s[data-i="2"] .w').first().boundingBox();
    await page.mouse.move(word.x + word.width / 2, word.y + word.height / 2); await page.mouse.down();
    await page.locator('#explainPanel').waitFor();
    await page.mouse.up();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#explainPanel').isVisible(), false);
    // Return to neutral volume/brightness before persistence checks below.
    await page.evaluate(async () => {
      document.querySelector('#video').style.filter = '';
      const { setVideoCfg } = await import('/js/trackcfg.js'); setVideoCfg({ volume: 100 });
    });

    // Video settings persist and never replace the media element or its current time.
    await reveal();
    await page.locator('#btnToolSettings').click();
    const editPercent = async (label, value) => {
      const input = page.getByRole('spinbutton', { name: label + ' (%)', exact: true });
      await input.fill(String(value)); await input.press('Tab');
    };
    await editPercent('字幕位置', 70);
    const sheetStyle = await page.locator('.sheet.is-open').evaluate((el) => ({
      filter: getComputedStyle(el).backdropFilter,
      width: el.getBoundingClientRect().width,
      topbar: getComputedStyle(document.querySelector('.topbar')).visibility,
      tools: getComputedStyle(document.querySelector('.tools')).visibility,
      scrim: getComputedStyle(document.querySelector('.scrim')).backdropFilter,
    }));
    assert.equal(sheetStyle.filter, 'none');
    assert.equal(sheetStyle.scrim, 'none');
    assert.equal(sheetStyle.topbar, 'hidden');
    assert.equal(sheetStyle.tools, 'hidden');
    assert.ok(sheetStyle.width < 844 * .96);
    systemSheetWidth = sheetStyle.width;
    await editPercent('字幕窗口宽度', 75);
    await editPercent('字幕背景透明度', 45);
    assert.equal(await page.locator('.sheet.is-open').getByRole('spinbutton', { name: '音量 (%)' }).count(), 0);
    assert.equal(await page.locator('.sheet.is-open').getByRole('button', { name: '静音', exact: true }).count(), 0);
    const blur = page.getByRole('spinbutton', { name: '字幕背景模糊 (px)', exact: true });
    await blur.fill('18'); await blur.press('Tab');
    // 系统小窗里的字幕由系统画, 字号只能靠 ::cue 传进去 —— 默认给一个能读的值, 并且可调。
    const cueSize = page.getByRole('spinbutton', { name: '系统字幕字号 (px)', exact: true });
    await cueSize.fill('26'); await cueSize.press('Tab');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#app'))
      .getPropertyValue('--cue-size').trim()), '26px');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#app').evaluate((el) => el.style.getPropertyValue('--subtitle-blur')), '18px');
    await reveal();
    await page.locator('#btnToolFit').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#video')).objectFit === 'cover');
    const placement = await page.evaluate(() => {
      const v = document.querySelector('#videoStage').getBoundingClientRect();
      const s = document.querySelector('#scroller').getBoundingClientRect();
      return { top: s.top - v.top, width: s.width / v.width, height: s.height / v.height,
        fit: getComputedStyle(document.querySelector('#video')).objectFit };
    });
    assert.ok(placement.top > 0 && placement.top < 150, JSON.stringify(placement));
    assert.ok(Math.abs(placement.width - 0.75) < 0.01);
    assert.equal(placement.fit, 'cover');
    await reveal();
    await page.locator('#btnToolSubtitles').click();
    assert.equal(await page.locator('#scroller').isVisible(), false);
    await reveal();
    await page.locator('#btnToolSubtitles').click();
    assert.equal(await page.locator('#scroller').isVisible(), true);
    await reveal();
    await page.locator('#btnToolSettings').click();
    await page.locator('.sheet.is-open').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#btnVideoFullscreen').count(), 0);

    await page.reload();
    await page.waitForFunction(() => window.LT?.track && document.querySelector('.has-video'));
    assert.deepEqual(await page.evaluate(async () => {
      const { trackCfg } = await import('/js/trackcfg.js');
      return trackCfg.video;
    }), { fit: 'cover', subtitles: 1, position: 70, width: 75, height: 55,
      transparency: 45, blur: 18, captionSize: 26, volume: 100, muted: 0 });
    await reveal();
    await page.locator('#btnToolSettings').click();
    await page.getByRole('button', { name: '重置字幕布局', exact: true }).click();
    await page.getByRole('button', { name: 'IPA', exact: true }).click();
    await page.getByRole('button', { name: 'Lemma', exact: true }).click();
    await page.getByRole('button', { name: '翻译', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.read), '0');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.roman), '0');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.tr), '1');
    // Cached translations enter the same virtual reader and follow visibility settings.
    await page.evaluate(() => {
      LT.reader.setTranslation(2, '点击单词可以重播这句话。'.repeat(20));
      LT.vlist.invalidate([2]);
    });
    await page.waitForFunction(() => document.querySelector('#scroller').scrollWidth > document.querySelector('#scroller').clientWidth);
    await page.getByRole('button', { name: '字幕字号', exact: true }).click();
    const font = page.locator('.sheet.is-open input[type=number]').first();
    await font.fill('28'); await font.press('Tab');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--fs-text').trim() === '28px');
    await reveal();
    await page.locator('#btnToolSettings').click();
    await page.getByRole('button', { name: 'IPA', exact: true }).click();
    await page.getByRole('button', { name: 'Lemma', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.evaluate(() => LT.engine.seek(8));

    const settled = () => page.waitForFunction(() => {
      const sheet = document.querySelector('.sheet');
      return !sheet || sheet.getBoundingClientRect().top >= innerHeight;
    });
    await settled();
    const bottomGap = await page.evaluate(() => innerHeight - document.querySelector('#scroller').getBoundingClientRect().bottom);
    assert.ok(bottomGap >= 0 && bottomGap <= 6, `subtitle bottom gap ${bottomGap}`);
    await page.screenshot({ path: path.join(shots, 'landscape.png') });
    await page.setViewportSize({ width: 1280, height: 800 }); await bounds(true);
    await page.setViewportSize({ width: 320, height: 568 }); await bounds(false);
    await page.setViewportSize({ width: 390, height: 844 }); await bounds(false);
    await page.screenshot({ path: path.join(shots, 'portrait.png') });
    await page.waitForFunction(() => !document.querySelector('#app').classList.contains('controls-visible'));
    assert.equal(await page.locator('#btnVideoRotate').isVisible(), false);
    const lightTopbar = await page.locator('.topbar').evaluate((el) => getComputedStyle(el).backgroundColor);
    await reveal();
    assert.equal(await page.locator('#btnVideoRotate').isVisible(), true);
    await page.locator('#btnDisplay').click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.keyboard.press('Escape');
    await settled();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.notEqual(await page.locator('.topbar').evaluate((el) => getComputedStyle(el).backgroundColor), lightTopbar);
    await page.screenshot({ path: path.join(shots, 'portrait-dark.png') });
    // 小窗跟着亮/暗主题走
    await reveal();
    await page.locator('#btnVideoPip').click();
    await page.waitForFunction(() => window.documentPictureInPicture.window?.document.documentElement.dataset.theme === 'dark');
    const pipDark = context.pages().find((candidate) => candidate !== page);
    if (pipDark) await pipDark.screenshot({ path: path.join(shots, 'pip-dark.png') });
    await page.locator('#videoPipNote').click();
    await page.waitForFunction(() => !window.documentPictureInPicture.window && !!document.querySelector('#videoStage video'));
    await page.setViewportSize({ width: 844, height: 390 }); await bounds(true);
    await page.screenshot({ path: path.join(shots, 'landscape-dark.png') });
    await reveal();
    await page.locator('#btnToolSettings').click();
    await page.locator('.sheet.is-open').waitFor();
    await page.waitForFunction(() => Math.abs(document.querySelector('.sheet').getBoundingClientRect().bottom - innerHeight) < 1);
    await page.screenshot({ path: path.join(shots, 'settings-dark.png') });
    await page.keyboard.press('Escape');
    await page.goto(base + '/index.html');
    await page.locator('.card-video').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(shots, 'home-dark.png') });
    await page.goto(base + '/player.html?track=' + trackId + '&debug');
    await page.waitForFunction(() => window.LT?.track && document.querySelector('.has-video'));
    await page.evaluate(async (id) => { const { setPosition } = await import('/js/library.js'); await setPosition(id, 9); }, trackId);
    await page.reload();
    await page.waitForFunction(() => Math.abs(document.querySelector('#video').currentTime - 9) < 0.1);

    // Filename-only restore with missing video: supplement bytes and reuse the subtitle analysis.
    await page.evaluate(async (id) => {
      const { patchTrack } = await import('/js/library.js');
      const { del } = await import('/js/store.js');
      await del('audio', id); await patchTrack(id, { audio: { name: 'Video lesson.mp4', missing: true } });
    }, trackId);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#btnPlay').disabled);
    await page.locator('input[type=file][aria-label$=" 音频或视频"]').setInputFiles({ name: 'Video lesson.mp4', mimeType: 'video/mp4', buffer: bytes });
    await page.waitForFunction(() => !document.querySelector('#btnPlay').disabled && document.querySelector('.has-video'));
    await page.keyboard.press('Escape');

    // Existing audio keeps its original full-height reader in both orientations.
    const audioId = await page.evaluate(async (videoId) => {
      const { createTrack, saveAnalysis, trackData } = await import('/js/library.js');
      const data = new ArrayBuffer(44 + 8000 * 2 * 30), v = new DataView(data);
      const str = (p, s) => [...s].forEach((c, i) => v.setUint8(p + i, c.charCodeAt(0)));
      str(0, 'RIFF'); v.setUint32(4, data.byteLength - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true);
      v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, data.byteLength - 44, true);
      const record = await createTrack(new File([data], 'audio.wav', { type: 'audio/wav' }));
      await saveAnalysis(record.id, { ...await trackData(videoId), id: record.id });
      return record.id;
    }, trackId);
    await page.goto(base + '/index.html');
    await page.locator('.card:not(.card-video)').first().waitFor();
    assert.match(await page.locator('.card:not(.card-video) .card-in').first()
      .evaluate((el) => getComputedStyle(el).backgroundImage), /gradient/);
    await page.goto(base + '/player.html?track=' + audioId + '&debug');
    await page.waitForFunction(() => LT.track && document.querySelector('#audio').readyState >= 2);
    await page.locator('#btnPlay').click(); await page.waitForFunction(() => document.querySelector('#audio').currentTime > 0.2);
    await page.locator('#btnPlay').click();
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await page.locator('#videoStage').isVisible(), false);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#scroller')).position), 'relative');
    }
    // Forced landscape also works when fullscreen/orientation lock is unavailable.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/player.html?track=' + trackId + '&debug');
    await page.waitForFunction(() => window.LT?.track && document.querySelector('.has-video'));
    await page.evaluate(() => {
      document.documentElement.requestFullscreen = undefined;
      document.documentElement.webkitRequestFullscreen = undefined;
    });
    await reveal();
    await page.locator('#btnVideoRotate').click();
    await page.waitForFunction(() => document.body.classList.contains('video-rotated'));
    const logical = await page.evaluate(() => ({ width: document.querySelector('#app').clientWidth,
      height: document.querySelector('#app').clientHeight, chip: LT.metrics.chipH }));
    assert.ok(logical.width > logical.height && logical.chip < 150, JSON.stringify(logical));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('video-immersive')), true);
    assert.equal(await page.evaluate(() => document.querySelector('meta[name=theme-color]').content), '#000000');
    await reveal();
    await page.locator('#btnToolSettings').click();
    await page.locator('.sheet.is-open').waitFor();
    // The page-rotation fallback rotates the whole body, so the physical bounding box swaps
    // axes; compare the logical (layout) width the viewer actually perceives.
    const forcedLogical = await page.evaluate(() => {
      const sheet = document.querySelector('.sheet.is-open');
      const app = document.querySelector('#app');
      return { width: sheet.offsetWidth, height: sheet.offsetHeight,
        viewWidth: app.clientWidth, viewHeight: app.clientHeight,
        blur: getComputedStyle(sheet).backdropFilter,
        scrim: getComputedStyle(document.querySelector('.scrim')).backdropFilter };
    });
    assert.ok(Math.abs(forcedLogical.width - systemSheetWidth) < 1,
      `sheet width ${forcedLogical.width} != ${systemSheetWidth} (${JSON.stringify(forcedLogical)})`);
    assert.ok(forcedLogical.width <= forcedLogical.viewWidth && forcedLogical.height <= forcedLogical.viewHeight,
      JSON.stringify(forcedLogical));
    assert.equal(forcedLogical.blur, 'none');
    assert.equal(forcedLogical.scrim, 'none');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('body').evaluate((el) => el.classList.contains('video-rotated')), true);
    await reveal();
    await page.locator('#seek').evaluate((el) => el.focus());
    const seekTarget = await page.evaluate(() => {
      const hit = document.querySelector('#seek .seek-hit').getBoundingClientRect();
      const box = document.querySelector('#seek').getBoundingClientRect();
      return { x: box.x + box.width / 2, y: hit.y + hit.height / 2 };
    });
    await page.locator('#seek').evaluate((el, point) => {
      const init = { pointerId: 7, bubbles: true, clientX: point.x, clientY: point.y };
      el.dispatchEvent(new PointerEvent('pointerdown', init));
      el.dispatchEvent(new PointerEvent('pointerup', init));
    }, seekTarget);
    await page.waitForFunction(() => Math.abs(document.querySelector('#video').currentTime - 15) < .3);
    await page.screenshot({ path: path.join(shots, 'forced-landscape.png') });
    await page.locator('#btnToolRotate').click();
    await page.waitForFunction(() => !document.body.classList.contains('video-rotated'));
    assert.equal(await page.evaluate(() => document.querySelector('meta[name=theme-color]').content), '#15170f');
    assert.deepEqual(errors, []);
    console.log('PASS: video cards, import, playback, immersive/forced rotation, gestures/cancellation, explain restore, toolbar, seek, layout/layers/fonts/blur, persistence, themes, resume, repair, audio regression');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
