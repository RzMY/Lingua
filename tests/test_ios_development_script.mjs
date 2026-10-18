import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

// Exercise the resource wrapper on Windows as well; macOS tests execute the
// actual Swift encoder and WKWebView controller with a persisted snapshot.
const source = await readFile(new URL('../ios/App/App/DevelopmentCache.swift', import.meta.url), 'utf8');
const template = source.match(/return """\r?\n([\s\S]*?)\r?\n\s*"""/)[1];
assert.ok(template.includes('\\(stateJSON)'), 'Swift must interpolate its encoded settings');
const origin = 'http://dev.example:5173';
const host = 'a'.repeat(64);
const script = template.replace('\\(stateJSON)', JSON.stringify({ origin, host,
  paths: ['/lingua/js/lazy.js', '/lingua/css/base.css', '/lingua/assets/reference.wav'] }));

function harness() {
  const calls = [];
  class XHR { open(...args) { calls.push(['xhr', ...args]); } }
  const window = { fetch: (...args) => { calls.push(['fetch', ...args]); } };
  vm.runInNewContext(script, { window, XMLHttpRequest: XHR, URL, Request,
    location: { href: `${origin}/lingua/player.html?track=123` } });
  return { window, XHR, calls };
}

test('iOS snapshot fetch/XHR uses the custom scheme for exact cached paths, including subdirectories', () => {
  const h = harness();
  h.window.fetch('./js/lazy.js?v=2#source', { cache: 'no-store' });
  assert.deepEqual(h.calls.pop(), ['fetch', `lingua-dev://${host}/lingua/js/lazy.js?v=2#source`, { cache: 'no-store' }]);
  new h.XHR().open('GET', new URL(`${origin}/lingua/css/base.css?theme=dark`), true);
  assert.deepEqual(h.calls.pop(), ['xhr', 'GET', `lingua-dev://${host}/lingua/css/base.css?theme=dark`, true]);
  assert.equal(h.window.__linguaDevelopmentTarget, origin);
  assert.equal(h.window.__linguaCachedHost, host);
});

test('iOS snapshot mapping preserves Request options and leaves APIs, media and unlisted/external paths untouched', () => {
  const h = harness();
  const request = new Request(`${origin}/lingua/assets/reference.wav`, { headers: { 'X-Test': 'preserved' }, cache: 'no-store' });
  h.window.fetch(request);
  const mapped = h.calls.pop()[1];
  assert.equal(mapped.url, `lingua-dev://${host}/lingua/assets/reference.wav`);
  assert.equal(mapped.headers.get('X-Test'), 'preserved');
  assert.equal(mapped.cache, 'no-store');
  for (const input of ['/api/health', './js/not-cached.js', './media/user.mp4', './player.html?track=123',
    'https://other.example/lingua/js/lazy.js', `lingua-dev://${host}/lingua/js/lazy.js`]) {
    h.window.fetch(input);
    assert.equal(h.calls.pop()[1], input);
  }
  const api = new Request(`${origin}/api/health`);
  h.window.fetch(api);
  assert.equal(h.calls.pop()[1], api);
});

test('iOS refresh disables the snapshot wrappers so the next document fetches live source', () => {
  const h = harness();
  h.window.__linguaUseCache = false;
  h.window.fetch('./js/lazy.js');
  assert.equal(h.calls.pop()[1], './js/lazy.js');
  new h.XHR().open('GET', './css/base.css');
  assert.equal(h.calls.pop()[2], './css/base.css');
});
