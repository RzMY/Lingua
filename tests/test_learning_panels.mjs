import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const { outputFiles } = await build({ stdin: { contents: `
  export { put } from './web/js/store.js';
  export { setTrackCfg } from './web/js/trackcfg.js';
  export { isCardOpen } from './web/js/card.js';
  export { chatOpen } from './web/js/chat.js';
  export const start = () => import('./web/js/main.js');`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'PanelTest' });
const html = await readFile(new URL('../web/player.html', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function harness(t, kind = 'audio') {
  const dom = new JSDOM(html, { url: 'https://localhost/player.html?track=lesson&debug',
    runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, doc = w.document, errors = [], calls = [];
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
      const target = find(panel === 'word' ? '.wcard' : panel === 'chat' ? '.sheet' : '#viewport');
      target.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else if (method === 'scrim') find(panel === 'word' ? '.wc-scrim' : '.scrim').click();
    else if (method === 'drag') {
      const grip = find('.sheet-grip');
      pointer(grip, 'pointerdown'); pointer(grip, 'pointermove', 150); pointer(grip, 'pointerup', 150);
    } else if (method === 'toggle') find('#btnExplain').click();
    else find(panel === 'word' ? '.wc-a-main' : panel === 'chat'
      ? '.sheet-head [aria-label="关闭"]' : '#btnExplainClose').click();
  };
  calls.length = 0;
  return { w, doc, api, media, calls, find, word, pointer, advance, frame, open, close };
}

for (const kind of ['audio', 'video']) {
  test(`${kind}: learning panels pause and every dismissal resumes at the same time and speed`, async (t) => {
    const h = await harness(t, kind);
    for (const [panel, methods] of [
      ['word', ['button', 'scrim', 'escape']], ['explain', ['button', 'escape']],
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

test('overlapping and repeated panels resume only after the last one closes', async (t) => {
  const h = await harness(t);
  for (const top of ['word', 'chat']) {
    for (const first of ['explain', top]) {
      await h.media.play();
      await h.open('explain'); await h.open('explain'); await h.open(top);
      h.close(first);
      assert.equal(h.media.paused, true);
      h.close(first === 'explain' ? top : 'explain');
      assert.equal(h.media.paused, false);
    }
  }
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
