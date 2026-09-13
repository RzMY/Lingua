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
