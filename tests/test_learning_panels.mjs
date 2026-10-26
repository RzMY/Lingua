import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const { outputFiles } = await build({ stdin: { contents: `
  export { put, get } from './web/js/store.js';
  export { setTrackCfg } from './web/js/trackcfg.js';
  export { isCardOpen } from './web/js/card.js';
  export { chatOpen } from './web/js/chat.js';
  export { listFavorites, favoriteDraft, saveFavorite } from './web/js/favorites.js';
  export { plainTrack } from './web/js/subtitles.js';
  export { Track } from './web/js/track.js';
  export { translationKey } from './web/js/translate.js';
  export { config } from './web/js/config.js';
  export const start = () => import('./web/js/main.js');`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'PanelTest' });
const html = await readFile(new URL('../web/player.html', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function harness(t, kind = 'audio', { plain = false, favoriteTime } = {}) {
  const dom = new JSDOM(html, { url: 'https://localhost/player.html?track=lesson&debug',
    runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, doc = w.document, errors = [], calls = [];
  w.structuredClone = structuredClone;
  t.after(() => {
    w.dispatchEvent(new w.Event('pagehide')); w.close();
    assert.deepEqual(errors, []);
  });
  w.console.warn = () => {};
  w.console.error = (...args) => errors.push(args.map(String).join(' '));
  w.addEventListener('error', (event) => errors.push(event.message));
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => ({ measureText: (text) => ({ width: text.length * 8 }) });
  w.Element.prototype.setPointerCapture = w.Element.prototype.releasePointerCapture = () => {};
  w.URL.createObjectURL = () => 'blob:lesson';
  w.URL.revokeObjectURL = () => {};
  let now = 1000, nextId = 0;
  const timers = new Map(), frames = new Map();
  Object.defineProperty(w.performance, 'now', { value: () => now });
  w.setTimeout = (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; };
  w.clearTimeout = (id) => timers.delete(id);
  w.requestAnimationFrame = (fn) => { const id = ++nextId; frames.set(id, fn); return id; };
  w.cancelAnimationFrame = (id) => frames.delete(id);
  const frame = () => {
    const pending = [...frames.values()]; frames.clear();
    for (const fn of pending) fn(now);
  };
  const advance = (ms) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.fn(); }
    }
  };
  Object.defineProperties(w.HTMLMediaElement.prototype, {
    paused: { configurable: true, get() { return this._paused !== false; } },
    readyState: { configurable: true, value: 4 },
    duration: { configurable: true, value: 30 },
  });
  w.HTMLMediaElement.prototype.play = function () {
    calls.push(['play', this.id]);
    if (this.paused) { this._paused = false; this.dispatchEvent(new w.Event('play')); }
    return Promise.resolve();
  };
  w.HTMLMediaElement.prototype.pause = function () {
    calls.push(['pause', this.id]);
    if (!this.paused) { this._paused = true; this.dispatchEvent(new w.Event('pause')); }
  };
  w.HTMLMediaElement.prototype.load = () => {};
  w.HTMLMediaElement.prototype.addTextTrack = () => ({ mode: 'disabled', cues: [], addCue() {}, removeCue() {} });
  const video = doc.getElementById('video');
  Object.defineProperties(video, { videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
  w.eval(outputFiles[0].text);
  const api = w.PanelTest;
  w.localStorage.setItem('linguatrack.track.lesson', JSON.stringify({ tr: 0, card: 1 }));
  await api.put('tracks', 'lesson', { id: 'lesson', title: 'Lesson', lang: 'en', status: 'ready',
    duration: 30, audio: { name: kind === 'video' ? 'lesson.mp4' : 'lesson.wav', type: `${kind}/test` } });
  await api.put('audio', 'lesson', new w.Blob(['fixture']));
  await api.put('data', 'lesson', { id: 'lesson', schemaVersion: 2, audio: { duration: 30 },
    lang: { code: 'en', spaceDelimited: true, layers: {}, layerOrder: [], features: ['card', 'pos'] },
    hasWordTiming: true, sentences: [
      { text: 'Hello world.', start: 0, end: 10, wordTiming: true, words: [
        { text: 'Hello', pos: 'noun', start: 0, end: 4 },
        { text: 'world', pos: 'noun', start: 4, end: 10 }, { text: '.', pos: 'punct' },
      ] },
      { text: 'Welcome.', start: 10, end: 30, wordTiming: true,
        words: [{ text: 'Welcome', pos: 'noun', start: 10, end: 30 }] },
    ] });
  if (plain) await api.put('data', 'lesson', api.plainTrack(await api.get('tracks', 'lesson'),
    [{ text: 'Plain subtitle.', start: 0, end: 10 }]));
  if (favoriteTime !== undefined) {
    const data = await api.get('data', 'lesson');
    const i = favoriteTime === 0 ? 0 : 1;
    data.sentences[i].start = favoriteTime;
    data.sentences[i].words[0].start = favoriteTime;
    await api.put('data', 'lesson', data);
    const f = api.favoriteDraft({ track: api.Track.fromData(data), i });
    await api.saveFavorite(f);
    await api.put('tracks', 'lesson', { ...await api.get('tracks', 'lesson'), position: 17 });
    w.history.replaceState(null, '', '?track=lesson&debug&favorite=' + encodeURIComponent(f.id));
  }
  await api.start();
  for (let i = 0; i < 30 && !w.LT?.track; i++) await flush();
  assert.ok(w.LT?.track, 'the real playback page must finish loading');
  frame();
  const media = w.LT.engine.audio;
  assert.equal(media.id, kind);
  const find = (selector) => {
    const node = doc.querySelector(selector); assert.ok(node, selector); return node;
  };
  const word = () => find('#viewport .s[data-i="0"] .w[data-j="1"]');
  const pointer = (node, type, y = 10) => node.dispatchEvent(Object.assign(
    new w.Event(type, { bubbles: true, cancelable: true }),
    { pointerId: 1, clientX: 10, clientY: y, button: 0, isPrimary: true }));
  const open = async (panel) => {
    if (panel === 'word') word().click();
    else if (panel === 'chat') find('#btnExplain').click();
    else {
      const target = word();
      pointer(target, 'pointerdown'); advance(500); pointer(target, 'pointerup');
      target.click(); // Browsers synthesize a click after releasing a long press.
    }
    await flush(); frame();
    assert.equal(panel === 'word' ? api.isCardOpen() : panel === 'chat'
      ? api.chatOpen() : !find('#explainPanel').hidden, true);
  };
  const close = (panel, method = 'button') => {
    if (method === 'escape') {
      const target = find(panel === 'word' ? '.wcard' : '.sheet');
      target.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else if (method === 'scrim') find(panel === 'word' ? '.wc-scrim' : '.scrim').click();
    else if (method === 'drag') {
      const grip = find('.sheet-grip');
      pointer(grip, 'pointerdown'); pointer(grip, 'pointermove', 150); pointer(grip, 'pointerup', 150);
    } else if (method === 'toggle') find('#btnExplain').click();
    else find(panel === 'word' ? '.wc-a-main' : '.sheet-head [aria-label="关闭"]').click();
  };
  calls.length = 0;
  return { w, doc, api, media, calls, find, word, pointer, advance, frame, open, close };
}

test('unanalysed subtitles expose sentence collection without showing fake word analysis', async (t) => {
  const h = await harness(t, 'audio', { plain: true });
  const sentence = h.find('#viewport .s');
  h.pointer(sentence, 'pointerdown'); h.advance(500); h.pointer(sentence, 'pointerup');
  await flush(); h.frame();
  assert.equal(h.find('#explainTitle').hidden, true);
  assert.equal(h.find('#explainPreview .s-words').textContent, 'Plain subtitle.');
  assert.equal(h.doc.querySelectorAll('#explainBody .gw').length, 0);
  h.find('#explainFavorite button').click();
  for (let i = 0; i < 12; i++) await flush();
  assert.equal((await h.api.listFavorites())[0].text, 'Plain subtitle.');
});

for (const favoriteTime of [0, 28]) test(`favorite entry at ${favoriteTime}s overrides saved progress and bypasses resume thresholds`, async (t) => {
  const h = await harness(t, 'audio', { favoriteTime });
  assert.equal(h.media.currentTime, favoriteTime);
  assert.equal(h.media.paused, true);
});

for (const kind of ['audio', 'video']) {
  test(`${kind}: word and long-press sentence favorites work without a model and survive panel reopening`, async (t) => {
    const h = await harness(t, kind);
    h.w.structuredClone = structuredClone;
    await h.open('word');
    const save = h.find('.wc-favorite');
    save.click(); save.click();
    for (let i = 0; i < 12; i++) await flush();
    assert.equal(save.getAttribute('aria-pressed'), 'true');
    assert.equal((await h.api.listFavorites()).length, 1);
    h.close('word'); await h.open('word');
    assert.equal(h.find('.wc-favorite').getAttribute('aria-pressed'), 'true');
    h.close('word'); await h.open('explain');
    h.find('#explainFavorite button').click();
    for (let i = 0; i < 12; i++) await flush();
    const saved = await h.api.listFavorites();
    assert.equal(saved.length, 2);
    assert.equal(saved.find((f) => f.kind === 'word').text, 'world');
    assert.equal(saved.find((f) => f.kind === 'sentence').text, 'Hello world.');
    h.close('explain'); await h.open('explain');
    assert.equal(h.find('#explainFavorite button').getAttribute('aria-pressed'), 'true');
    h.find('#explainFavorite button').click();
    for (let i = 0; i < 12; i++) await flush();
    assert.equal((await h.api.listFavorites()).length, 1);
  });

  test(`${kind}: learning panels pause and every dismissal resumes at the same time and speed`, async (t) => {
    const h = await harness(t, kind);
    for (const [panel, methods] of [
      ['word', ['button', 'scrim', 'escape']], ['explain', ['button', 'scrim', 'escape', 'drag']],
      ['chat', ['button', 'scrim', 'escape', 'drag', 'toggle']],
    ]) {
      for (const method of methods) {
        h.media.currentTime = 6; h.media.playbackRate = 1.5;
        await h.media.play(); h.frame(); h.calls.length = 0;
        await h.open(panel);
        assert.equal(h.media.paused, true, `${panel} opens paused`);
        const at = panel === 'word' ? 4 : 6;
        assert.equal(h.media.currentTime, at, 'word cards retain click-to-seek');
        h.close(panel, method);
        assert.equal(h.media.paused, false, `${panel} resumes on ${method}`);
        assert.equal(h.media.currentTime, at);
        assert.equal(h.media.playbackRate, 1.5);
        assert.deepEqual(h.calls, [['pause', kind], ['play', kind]]);
        assert.equal(h.find('#btnPlay').getAttribute('aria-label'), '暂停');
      }
    }
  });

  test(`${kind}: media that was already paused stays paused after each panel closes`, async (t) => {
    const h = await harness(t, kind);
    for (const panel of ['word', 'explain', 'chat']) {
      await h.open(panel); h.close(panel);
      assert.equal(h.media.paused, true, panel);
    }
    assert.equal(h.calls.some(([action]) => action === 'play'), false);
  });
}

test('overlapping word cards and repeated sentence details resume only after the last one closes', async (t) => {
  const h = await harness(t);
  for (const first of ['explain', 'word']) {
      await h.media.play();
      await h.open('explain'); await h.open('explain'); await h.open('word');
      h.close(first);
      assert.equal(h.media.paused, true);
      h.close(first === 'explain' ? 'word' : 'explain');
      assert.equal(h.media.paused, false);
  }
});

test('sentence details show the cached translation with playback translations hidden and keep the selected cue', async (t) => {
  const h = await harness(t);
  await h.api.put('tr', h.api.translationKey('lesson', 'zh-CN', 'Hello world.'), '你好，世界。');
  h.media.currentTime = 16; await h.media.play(); h.frame();
  await h.open('explain');
  assert.equal(h.find('.sheet').classList.contains('sheet-explain'), true);
  assert.equal(h.find('#explainPreview .s-tr').textContent, '你好，世界。');
  assert.equal(h.find('#explainPreview .s').dataset.i, '0');
  assert.equal(h.find('#explainBody .gw-text').textContent, 'Hello');
  h.w.LT.engine.onCursor(1, 0, true);
  assert.equal(h.find('#explainPreview .s').dataset.i, '0');
  h.find('#explainFavorite button').click();
  for (let i = 0; i < 12; i++) await flush();
  assert.equal((await h.api.listFavorites())[0].text, 'Hello world.');
});

for (const kind of ['audio', 'video']) test(`${kind}: sentence detail actions use the selected cue and transfer the playback pause`, async (t) => {
  const h = await harness(t, kind);
  h.media.currentTime = 16; await h.media.play(); h.frame(); h.calls.length = 0;
  await h.open('explain');
  const actions = () => [...h.doc.querySelectorAll('.explain-actions button')];
  h.find('#explainPreview .w[data-j="1"]').click();
  actions().find((b) => b.textContent === '大模型讲解').click();
  await flush(); h.frame();
  assert.equal(h.api.chatOpen(), true);
  assert.equal(h.find('#sheetTitle').textContent, '讲解 · 第 1 句');
  assert.equal(h.find('#explainPanel').hidden, true);
  assert.equal(h.media.paused, true);
  assert.equal(h.calls.some(([action]) => action === 'play'), false);
  h.close('chat');
  assert.equal(h.find('#explainPanel').hidden, false);
  assert.equal(h.find('#explainPreview .w.is-cur').dataset.j, '1');
  assert.equal(h.media.paused, true);
  h.calls.length = 0;
  actions().find((b) => b.textContent === '修改').click();
  for (let i = 0; i < 12; i++) await flush(); h.frame();
  assert.equal(h.find('.subtitle-editor textarea').value, 'Hello world.');
  assert.equal(h.media.paused, true);
  assert.equal(h.calls.some(([action]) => action === 'play'), false);
  h.find('.sheet-head [aria-label="关闭"]').click();
  assert.equal(h.find('#explainPanel').hidden, false);
  assert.equal(h.find('#explainPreview .w.is-cur').dataset.j, '1');
  assert.equal(h.media.paused, true);
  assert.equal(h.media.currentTime, 16);
  h.close('explain');
  assert.equal(h.media.paused, false);
});

test('word cards disabled, punctuation, sentence seeks and cancelled long presses keep playing', async (t) => {
  const h = await harness(t);
  await h.media.play(); h.calls.length = 0;
  h.api.setTrackCfg('card', 0); h.word().click();
  assert.equal(h.api.isCardOpen(), false);
  h.api.setTrackCfg('card', 1);
  h.find('#viewport .s[data-i="0"] .w[data-j="2"]').click();
  h.find('#viewport .s[data-i="1"]').click();
  const word = h.word();
  h.pointer(word, 'pointerdown'); h.advance(200); h.pointer(word, 'pointercancel'); h.advance(500);
  assert.equal(h.find('#explainPanel').hidden, true);
  assert.equal(h.media.paused, false);
  assert.equal(h.calls.length, 0);
});

test('opening subtitle management clears pending resume before dismissing learning panels', async (t) => {
  const h = await harness(t);
  await h.media.play(); await h.open('explain');
  h.find('#btnDisplay').click();
  const manage = [...h.doc.querySelectorAll('.sheet button')]
    .find((button) => button.textContent.includes('字幕管理'));
  assert.ok(manage); manage.click();
  assert.equal(h.find('#setup').hidden, false);
  assert.equal(h.find('#explainPanel').hidden, true);
  assert.equal(h.media.paused, true);
});

test('leaving the playback page discards pending automatic resume', async (t) => {
  const h = await harness(t);
  await h.media.play(); await h.open('word');
  h.w.dispatchEvent(new h.w.Event('pagehide'));
  h.close('word');
  assert.equal(h.media.paused, true);
});

test('closing a panel cannot resume a replacement media source', async (t) => {
  const h = await harness(t);
  await h.media.play(); await h.open('word');
  h.media.src = 'blob:replacement';
  h.close('word');
  assert.equal(h.media.paused, true);
});

async function openEditor(h) {
  if (h.find('#explainPanel').hidden) await h.open('explain');
  [...h.doc.querySelectorAll('.explain-actions button')].find((b) => b.textContent === '修改').click();
  for (let i = 0; i < 12; i++) await flush();
  h.frame();
  assert.equal(h.find('#sheetTitle').textContent, '修改字幕');
  return {
    input: (index, text) => {
      const field = h.doc.querySelectorAll('.subtitle-editor textarea')[index];
      field.value = text; field.dispatchEvent(new h.w.Event('input', { bubbles: true }));
    },
    flag: (label) => h.find(`.subtitle-editor [aria-label="${label}"]`),
    save: () => [...h.doc.querySelectorAll('.sheet-foot button')].find((b) => b.textContent === '保存').click(),
  };
}

for (const kind of ['audio', 'video']) test(`${kind}: detail editor persists one cue and returns to its updated details without seeking or resetting repeat/speed`, async (t) => {
  const h = await harness(t, kind);
  h.w.File = File; h.w.Blob = Blob;
  h.w.fetch = () => { throw new Error('unexpected network request'); };
  await h.api.put('tr', h.api.translationKey('lesson', 'zh-CN', 'Hello world.'), '原译文');
  h.media.currentTime = 6; h.media.playbackRate = 1.5;
  h.w.LT.engine.setRepeat(1);
  await h.media.play(); h.frame();
  const edit = await openEditor(h);
  assert.equal(h.media.currentTime, 6);
  assert.equal(h.media.paused, true);
  assert.equal(edit.flag('重新分析').getAttribute('aria-pressed'), 'true');
  assert.equal(edit.flag('重新翻译').getAttribute('aria-pressed'), 'true');
  edit.flag('重新分析').click(); edit.flag('重新翻译').click();
  edit.input(0, 'A corrected sentence.'); edit.input(1, '人工修正'); edit.save();
  for (let i = 0; i < 20; i++) await flush(); h.frame();
  assert.equal(h.find('#explainPanel').hidden, false);
  const data = await h.api.get('data', 'lesson');
  assert.equal(data.sentences[0].text, 'A corrected sentence.');
  assert.equal(data.sentences[0].translations['zh-CN'], '人工修正');
  assert.equal(data.sentences[0].wordTiming, false);
  assert.equal(data.sentences[1].words[0].start, 10);
  assert.match(h.find('#viewport .s[data-i="0"] .s-words').textContent, /A corrected sentence/);
  assert.equal(h.find('#viewport .s[data-i="0"] .s-tr').textContent, '人工修正');
  assert.equal(h.media.currentTime, 6);
  assert.equal(h.media.paused, true);
  assert.match(h.find('#explainPreview .s-words').textContent, /A corrected sentence/);
  assert.equal(h.find('#explainPreview .s-tr').textContent, '人工修正');
  assert.equal(h.media.playbackRate, 1.5);
  assert.equal(h.w.LT.engine.repeat, 1);
  h.advance(600);
  const reopened = await openEditor(h);
  assert.equal(reopened.flag('重新分析').getAttribute('aria-pressed'), 'false');
  assert.equal(reopened.flag('重新翻译').getAttribute('aria-pressed'), 'true');
});

test('plain subtitle editor defaults both operations off; validation/failure retain draft and cancel leaves data intact', async (t) => {
  const h = await harness(t, 'audio', { plain: true });
  h.w.File = File; h.w.Blob = Blob; h.w.Headers = Headers;
  h.w.fetch = async () => Response.json({ track: { sentences: [] } });
  const edit = await openEditor(h);
  for (const label of ['重新分析', '重新翻译']) assert.equal(edit.flag(label).getAttribute('aria-pressed'), 'false');
  edit.input(0, ' '); edit.save();
  assert.match(h.find('.subtitle-editor [role="status"]').textContent, /不能为空/);
  edit.input(0, 'My draft'); edit.flag('重新分析').click(); edit.save();
  for (let i = 0; i < 12; i++) await flush();
  assert.match(h.find('.subtitle-editor [role="status"]').textContent, /分析结果/);
  assert.equal(h.find('.subtitle-editor textarea').value, 'My draft');
  h.find('.sheet-head [aria-label="关闭"]').click();
  assert.equal((await h.api.get('data', 'lesson')).sentences[0].text, 'Plain subtitle.');
  assert.equal(h.media.paused, true);
});

test('vertical scroll and cancelled swipe never open subtitle actions or trigger a long press', async (t) => {
  const h = await harness(t);
  const target = h.find('#viewport .s');
  h.pointer(target, 'pointerdown'); h.pointer(target, 'pointermove', 120);
  h.pointer(target, 'pointerup', 120); h.advance(600);
  assert.equal(h.doc.documentElement.classList.contains('sheet-open'), false);
  assert.equal(h.find('#explainPanel').hidden, true);
  const pointer = (type, x) => target.dispatchEvent(Object.assign(new h.w.Event(type, { bubbles: true }),
    { pointerId: 1, clientX: x, clientY: 10, button: 0, isPrimary: true }));
  pointer('pointerdown', 180); pointer('pointermove', 90); pointer('pointercancel', 90);
  pointer('pointerup', 90); h.advance(600);
  assert.equal(h.doc.documentElement.classList.contains('sheet-open'), false);
});

for (const kind of ['audio', 'video']) test(`${kind}: detail word selections leave the main clock intact without pronunciation controls`, async (t) => {
  const h = await harness(t, kind);
  h.media.currentTime = 16; h.media.playbackRate = 1.5;
  await h.media.play(); h.frame(); await h.open('explain'); h.calls.length = 0;
  assert.deepEqual([...h.doc.querySelectorAll('.explain-actions button')].map((b) => b.textContent), ['收藏', '修改', '大模型讲解']);
  h.find('#explainPreview .w[data-j="1"]').click();
  assert.equal(h.find('#explainPreview .w.is-cur').dataset.j, '1');
  assert.equal(h.find('#explainBody .gw.is-cur').dataset.j, '1');
  h.find('#explainBody .gw[data-j="0"] .gw-pick').click();
  assert.equal(h.find('#explainPreview .w.is-cur').dataset.j, '0');
  h.w.LT.engine.onCursor(0, 1, false);
  assert.equal(h.find('#explainPreview .w.is-cur').dataset.j, '0');
  assert.equal(h.api.isCardOpen(), false);
  assert.equal(h.find('#sheetTitle').textContent, '句子拆解 · 1 / 2');
  assert.equal(h.doc.querySelector('.sheet-explain .explain-sound'), null);
  assert.equal(h.media.currentTime, 16);
  assert.equal(h.media.paused, true);
  assert.equal(h.media.playbackRate, 1.5);
  assert.equal(h.calls.some(([action, id]) => action === 'play' && id === kind), false);
  h.close('explain');
  assert.equal(h.doc.querySelector('audio[hidden][playsinline]'), null);
  assert.equal(h.media.paused, false);
  assert.equal(h.media.currentTime, 16);
});

test('left swiping subtitles has no edit entry and suppresses the release click', async (t) => {
  const h = await harness(t);
  h.media.currentTime = 16; await h.media.play(); h.frame(); h.calls.length = 0;
  const target = h.word();
  const pointer = (type, x) => target.dispatchEvent(Object.assign(new h.w.Event(type, { bubbles: true }),
    { pointerId: 1, clientX: x, clientY: 10, button: 0, isPrimary: true }));
  pointer('pointerdown', 180); pointer('pointermove', 90); pointer('pointerup', 90); target.click();
  h.advance(600);
  assert.equal(h.doc.documentElement.classList.contains('sheet-open'), false);
  assert.equal(h.api.isCardOpen(), false);
  assert.equal(h.media.currentTime, 16);
  assert.equal(h.media.paused, false);
});

test('leaving or replacing a detail child never reopens the sentence panel or resumes playback', async (t) => {
  const h = await harness(t);
  await h.media.play(); await h.open('explain');
  [...h.doc.querySelectorAll('.explain-actions button')].find((b) => b.textContent === '修改').click();
  for (let i = 0; i < 12; i++) await flush();
  h.find('#btnDisplay').click();
  assert.equal(h.find('#explainPanel').hidden, true);
  assert.notEqual(h.find('#sheetTitle').textContent, '句子拆解 · 1 / 2');
  h.close('explain');
  await h.open('explain');
  [...h.doc.querySelectorAll('.explain-actions button')].find((b) => b.textContent === '大模型讲解').click();
  await flush(); h.w.dispatchEvent(new h.w.Event('pagehide'));
  h.close('chat');
  assert.equal(h.find('#explainPanel').hidden, true);
  assert.equal(h.media.paused, true);
});
