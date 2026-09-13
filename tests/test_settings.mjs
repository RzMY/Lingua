import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const KEY = 'linguatrack.settings.v1';
const saved = new Map();
const styles = new Map();
globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.document = {
  documentElement: { dataset: {}, style: { setProperty: (key, value) => styles.set(key, value) } },
  querySelector: () => null,
};
globalThis.localStorage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: (key) => saved.delete(key),
};
const {
  settings, initSettings, setSetting, FONT_DEFAULTS, fontSizes, setLangFontSize, resetLangFontSizes,
} = await import('../web/js/settings.js');
const {
  trackCfg, initTrackCfg, readTrackCfg, setTrackCfg, setTrackFontSize, resetTrackFontSizes, dropTrackCfg,
  deferTrackFontSizes,
} = await import('../web/js/trackcfg.js');
const fonts = () => Object.fromEntries(Object.keys(FONT_DEFAULTS).map((key) => [key, settings[key]]));

beforeEach(() => {
  saved.clear();
  styles.clear();
  initSettings(() => {});
});

test('default fonts are applied as independent pixel sizes', () => {
  assert.deepEqual(fonts(), { textSize: 25, readSize: 12, romanSize: 11.5, trSize: 16.5 });
  assert.deepEqual(Object.fromEntries(styles), {
    '--fs-text': '25px', '--fs-read': '12px', '--fs-roman': '11.5px', '--fs-tr': '16.5px',
  });
});

test('legacy percentages and named sizes migrate with the original auxiliary scaling', () => {
  for (const size of [120, 'l']) {
    saved.set(KEY, JSON.stringify({ size, theme: 'dark', rate: 1.5, track: 'lesson' }));
    initSettings();
    assert.deepEqual(fonts(), { textSize: 30, readSize: 13.5, romanSize: 13, trSize: 18.5 });
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.rate, 1.5);
    assert.equal(settings.track, 'lesson');
  }
});

test('saved per-layer sizes override legacy values and survive reload', () => {
  saved.set(KEY, JSON.stringify({ size: 120, readSize: 21, trSize: 24.5 }));
  initSettings();
  setSetting('textSize', 32);
  assert.deepEqual(fonts(), { textSize: 32, readSize: 21, romanSize: 13, trSize: 24.5 });
  assert.equal(JSON.parse(saved.get(KEY)).size, undefined);
  initSettings();
  assert.deepEqual(fonts(), { textSize: 32, readSize: 21, romanSize: 13, trSize: 24.5 });
});

test('each font change relayouts without altering other layers; theme and rate do not', () => {
  const changes = [];
  initSettings((...args) => changes.push(args));
  for (const [key, initial] of Object.entries(FONT_DEFAULTS)) {
    const previous = fonts();
    setSetting(key, initial + 2);
    assert.deepEqual(fonts(), { ...previous, [key]: initial + 2 });
    assert.deepEqual(changes.at(-1), [key, initial + 2, true]);
  }
  setSetting('theme', 'dark');
  assert.deepEqual(changes.at(-1), ['theme', 'dark', false]);
  setSetting('rate', 1.5);
  assert.deepEqual(changes.at(-1), ['rate', 1.5, false]);
  setSetting('rate', 1.5);
  setSetting('size', 160);
  assert.equal(changes.length, 6);
});

test('font input is bounded and invalid values preserve the current value', () => {
  setSetting('readSize', '22.3');
  assert.equal(settings.readSize, 22.5);
  for (const value of ['', ' ', 'bad', null, undefined, NaN, Infinity, {}, [], true]) {
    setSetting('readSize', value);
    assert.equal(settings.readSize, 22.5);
  }
  setSetting('readSize', 1000);
  assert.equal(settings.readSize, 64);
  setSetting('readSize', -10);
  assert.equal(settings.readSize, 8);
  saved.set(KEY, JSON.stringify({ readSize: null, romanSize: {}, textSize: 0, trSize: 500 }));
  initSettings();
  assert.deepEqual(fonts(), { textSize: 8, readSize: 12, romanSize: 11.5, trSize: 64 });
});

test('corrupt or unavailable storage still allows changing fonts', (t) => {
  for (const value of ['broken', 'null', '[]', '42']) {
    saved.set(KEY, value);
    initSettings();
    assert.deepEqual(fonts(), FONT_DEFAULTS);
  }
  t.mock.method(localStorage, 'getItem', () => { throw new Error('Storage unavailable'); });
  t.mock.method(localStorage, 'setItem', () => { throw new Error('Storage unavailable'); });
  initSettings();
  setSetting('readSize', 20);
  assert.equal(settings.readSize, 20);
  assert.equal(styles.get('--fs-read'), '20px');
});

test('language sizes inherit legacy settings and stay isolated across reloads', () => {
  saved.set(KEY, JSON.stringify({ size: 'l', readSize: 21 }));
  initSettings();
  const legacy = fontSizes('ja');
  setLangFontSize('ja', 'textSize', 40);
  setLangFontSize('EN', 'romanSize', '18.3');
  assert.deepEqual(fontSizes('ja'), { ...legacy, textSize: 40 });
  assert.deepEqual(fontSizes('en'), { ...legacy, romanSize: 18.5 });
  assert.deepEqual(fontSizes('fr'), legacy);
  initSettings();
  assert.equal(fontSizes('ja').textSize, 40);
  assert.equal(fontSizes('en').romanSize, 18.5);
  resetLangFontSizes('ja');
  assert.deepEqual(fontSizes('ja'), FONT_DEFAULTS);
  assert.equal(fontSizes('en').romanSize, 18.5);
  assert.deepEqual(fontSizes('fr'), legacy);
});

test('audio overrides affect only that audio and preserve inheritance for untouched sizes', () => {
  setLangFontSize('ja', 'textSize', 31);
  setLangFontSize('en', 'textSize', 28);
  const global = saved.get(KEY);
  const changes = [];
  initTrackCfg('ja-one', 'ja', null, (...args) => changes.push(args));
  assert.equal(styles.get('--fs-text'), '31px');
  setTrackFontSize('textSize', 44);
  assert.deepEqual(changes.at(-1), ['textSize', 44, true]);
  setTrackCfg('tr', 1);
  assert.deepEqual(JSON.parse(saved.get('linguatrack.track.ja-one')).fonts, { textSize: 44 });
  assert.equal(saved.get(KEY), global);
  initTrackCfg('ja-two', 'ja');
  assert.equal(styles.get('--fs-text'), '31px');
  assert.deepEqual(trackCfg.fonts, {});
  initTrackCfg('en-one', 'en');
  assert.equal(styles.get('--fs-text'), '28px');
  initSettings();
  initTrackCfg('ja-one', 'ja');
  assert.equal(styles.get('--fs-text'), '44px');
  assert.equal(trackCfg.tr, 1);
  setLangFontSize('ja', 'readSize', 19);
  setLangFontSize('ja', 'textSize', 33);
  assert.equal(styles.get('--fs-text'), '44px');
  assert.equal(styles.get('--fs-read'), '19px');
  resetTrackFontSizes();
  assert.equal(styles.get('--fs-text'), '33px');
  assert.equal(JSON.parse(saved.get('linguatrack.track.ja-one')).fonts, undefined);
  assert.equal(trackCfg.tr, 1);
  dropTrackCfg('ja-one');
  assert.deepEqual(readTrackCfg('ja-one', 'ja').fonts, {});
});

test('theme and playback rate changes keep the active audio font overrides', () => {
  setLangFontSize('en', 'romanSize', 17);
  initTrackCfg('lesson', 'en');
  setTrackFontSize('textSize', 37);
  for (const [key, value] of [['theme', 'dark'], ['rate', 1.5], ['track', 'lesson']]) {
    setSetting(key, value);
    assert.equal(styles.get('--fs-text'), '37px');
    assert.equal(styles.get('--fs-roman'), '17px');
  }
  setLangFontSize('ja', 'textSize', 50);
  assert.equal(styles.get('--fs-text'), '37px');
});

test('sparse and invalid saved overrides are normalized and unsupported audio layers cannot be changed', () => {
  saved.set(KEY, JSON.stringify({ fonts: {
    ja: { textSize: 35, readSize: 'bad', romanSize: 100 }, en: null, fr: [],
  } }));
  initSettings();
  assert.deepEqual(fontSizes('ja'), { ...FONT_DEFAULTS, textSize: 35, romanSize: 64 });
  assert.deepEqual(fontSizes('en'), FONT_DEFAULTS);
  assert.deepEqual(fontSizes('fr'), FONT_DEFAULTS);
  saved.set('linguatrack.track.lesson', JSON.stringify({ fonts: { textSize: null, trSize: 23.2 } }));
  initTrackCfg('lesson', 'ja', ['tr', 'pos']);
  assert.deepEqual(trackCfg.fonts, { trSize: 23 });
  assert.equal(styles.get('--fs-text'), '35px');
  setTrackFontSize('readSize', 30);
  setTrackFontSize('romanSize', 30);
  setTrackFontSize('unexpected', 30);
  for (const value of ['', 'bad', null, {}, [], Infinity]) setTrackFontSize('trSize', value);
  assert.deepEqual(trackCfg.fonts, { trSize: 23 });
  setTrackFontSize('textSize', 1000);
  assert.equal(styles.get('--fs-text'), '64px');
  setTrackFontSize('trSize', -1);
  assert.equal(styles.get('--fs-tr'), '8px');
});

test('language and audio font edits still work when storage is unavailable', (t) => {
  t.mock.method(localStorage, 'getItem', () => { throw new Error('Storage unavailable'); });
  t.mock.method(localStorage, 'setItem', () => { throw new Error('Storage unavailable'); });
  setLangFontSize('ko', 'textSize', 30);
  initTrackCfg('lesson', 'ko');
  assert.equal(styles.get('--fs-text'), '30px');
  setTrackFontSize('textSize', 35);
  assert.equal(styles.get('--fs-text'), '35px');
  resetTrackFontSizes();
  assert.equal(styles.get('--fs-text'), '30px');
});

test('manual font input and repeated steps save immediately and apply one layout on close', () => {
  const changes = [];
  initTrackCfg('lesson', 'en', null, (...args) => changes.push(args));
  const finish = deferTrackFontSizes();
  const original = Object.fromEntries(styles);
  setTrackFontSize('textSize', 48);
  for (let i = 0; i < 20; i++) setTrackFontSize('textSize', 48 + (i + 1) * 0.5);
  for (let i = 0; i < 12; i++) setTrackFontSize('textSize', 58 - (i + 1) * 0.5);
  setTrackFontSize('readSize', 24);
  assert.deepEqual(fontSizes('en', trackCfg.fonts), { ...FONT_DEFAULTS, textSize: 52, readSize: 24 });
  assert.deepEqual(JSON.parse(saved.get('linguatrack.track.lesson')).fonts, { textSize: 52, readSize: 24 });
  assert.deepEqual(Object.fromEntries(styles), original);
  assert.deepEqual(changes, []);
  setSetting('theme', 'dark');
  setSetting('rate', 1.5);
  setTrackCfg('pos', 0);
  assert.deepEqual(Object.fromEntries(styles), original);
  changes.length = 0;
  finish();
  assert.equal(styles.get('--fs-text'), '52px');
  assert.equal(styles.get('--fs-read'), '24px');
  assert.deepEqual(changes, [['fonts', { textSize: 52, readSize: 24 }, true]]);
  finish();
  assert.equal(changes.length, 1);
});

test('resetting fonts during preview restores inheritance with one layout on close', () => {
  setLangFontSize('ja', 'textSize', 30);
  saved.set('linguatrack.track.lesson', JSON.stringify({ fonts: { textSize: 42 } }));
  const changes = [];
  initTrackCfg('lesson', 'ja', null, (...args) => changes.push(args));
  const finish = deferTrackFontSizes();
  setTrackFontSize('textSize', 50);
  resetTrackFontSizes();
  assert.deepEqual(trackCfg.fonts, {});
  assert.equal(JSON.parse(saved.get('linguatrack.track.lesson')).fonts, undefined);
  assert.equal(styles.get('--fs-text'), '42px');
  assert.deepEqual(changes, []);
  finish();
  assert.equal(styles.get('--fs-text'), '30px');
  assert.deepEqual(changes, [['fonts', {}, true]]);
  setLangFontSize('ja', 'textSize', 31);
  assert.equal(styles.get('--fs-text'), '31px');
});

test('unchanged previews and a previous audio preview do not trigger a layout', () => {
  const changes = [];
  initTrackCfg('lesson', 'en', null, (...args) => changes.push(args));
  const unchanged = deferTrackFontSizes();
  setTrackFontSize('textSize', 40);
  resetTrackFontSizes();
  unchanged();
  assert.deepEqual(changes, []);
  const previous = deferTrackFontSizes();
  setTrackFontSize('textSize', 50);
  initTrackCfg('next', 'ja', null, (...args) => changes.push(args));
  previous();
  assert.equal(styles.get('--fs-text'), '25px');
  assert.deepEqual(changes, []);
  setTrackFontSize('textSize', 32);
  assert.equal(styles.get('--fs-text'), '32px');
  assert.deepEqual(changes, [['textSize', 32, true]]);
});
