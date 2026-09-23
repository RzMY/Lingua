import assert from 'node:assert/strict';
import { test } from 'node:test';
import { health, analyze, ApiError } from '../web/js/api.js';
import { config, loadConfig } from '../web/js/config.js';
import { chat } from '../web/js/llm.js';

test('saved backend token is loaded and only sent to the analysis backend', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const headers = new Headers(init.headers);
    if (url.startsWith('https://analysis.example')) {
      assert.equal(headers.get('Authorization'), 'Bearer backend-token');
      assert.ok(!url.includes('backend-token'));
      if (init.method === 'POST') assert.equal(headers.get('Content-Type'), 'text/plain; charset=utf-8');
      return Response.json({ ok: true });
    }
    assert.equal(url, 'https://model.example/v1/chat/completions');
    assert.equal(headers.get('Authorization'), 'Bearer model-key');
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  globalThis.localStorage = { getItem: () => JSON.stringify({
    apiBase: 'https://analysis.example', apiToken: ' backend-token ',
    baseUrl: 'https://model.example', apiKey: 'model-key',
  }) };
  t.after(() => { delete globalThis.localStorage; });
  loadConfig();
  await health();
  await analyze(new Blob(['transcript']));
  assert.equal(await chat({ messages: [{ role: 'user', content: 'test' }] }), 'OK');
  assert.equal(fetch.mock.callCount(), 3);
});

test('blank token omits Authorization for a local backend', async (t) => {
  config.apiToken = '  ';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    return Response.json({ ok: true });
  });
  await health();
});

test('401 responses become an actionable authentication error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Unauthorized', { status: 401 }));
  await assert.rejects(health(), (error) => error instanceof ApiError && error.status === 401
    && error.message.includes('\u8bbf\u95ee\u4ee4\u724c'));
});

test('backend failures show recovery guidance without reflecting response bodies', async (t) => {
  for (const [status, expected] of [[400, /字幕/], [403, /权限/], [404, /地址/],
    [413, /上限/], [429, /稍后/], [500, /稍后/]]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>private response 私密数据</html>', { status }));
    await assert.rejects(health(), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private|私密|html/);
      return true;
    });
    t.mock.restoreAll();
  }
});

test('HTML, empty and invalid JSON success responses do not pass the backend connection check', async (t) => {
  for (const body of ['<html>Sign in</html>', '', 'null', '[]', '{"ok":false}', '{"error":"private"}']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body));
    await assert.rejects(health(), /返回格式异常/);
    t.mock.restoreAll();
  }
});

test('backend network failures are localized and explicit cancellation stays distinguishable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(health(), (error) => /网络.*设置 → 分析后端/.test(error.message)
    && !/Failed to fetch|python/.test(error.message));
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('Aborted', 'AbortError'); });
  await assert.rejects(health(), { name: 'AbortError' });
});
