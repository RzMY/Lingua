import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { config } from '../web/js/config.js';
import { chat, chatJSON, chatStream, probe, LLMError } from '../web/js/llm.js';
import { errorMessage } from '../web/js/errors.js';

const messages = [{ role: 'user', content: 'test' }];
const reply = (content, finish_reason = 'stop') => Response.json({ choices: [{ message: { content }, finish_reason }] });
beforeEach(() => Object.assign(config, { baseUrl: 'https://model.example', model: 'test', apiKey: '', jsonMode: 1, timeout: 10 }));

test('regular and streaming model failures provide Chinese guidance without exposing server bodies', async (t) => {
  for (const status of [400, 401, 403, 404, 413, 422, 429, 500, 503]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>private key 私密内容</html>', { status }));
    for (const run of [() => chat({ messages, retries: 0 }), () => chatStream({ messages })]) {
      await assert.rejects(run(), (error) => {
        assert.ok(error instanceof LLMError);
        assert.equal(error.status, status);
        assert.match(error.message, /请/);
        assert.doesNotMatch(error.message, /private|私密|html/);
        return true;
      });
    }
    t.mock.restoreAll();
  }
});

test('empty model content and malformed success responses cannot report connection success', async (t) => {
  for (const content of ['', '   ', null, []]) {
    t.mock.method(globalThis, 'fetch', async () => reply(content));
    await assert.rejects(probe(), /未返回内容/);
    await assert.rejects(chatStream({ messages }), /未返回内容/);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Sign in</html>'));
  await assert.rejects(probe(), /返回格式异常/);
  await assert.rejects(chatStream({ messages }), /返回格式异常/);
});

test('JSON fallback still executes with zero network retries', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    return body.response_format ? new Response('Unsupported', { status: 400 }) : reply('{"ok":true}');
  });
  assert.equal(await probe(), '{"ok":true}');
  assert.equal(bodies.length, 2);
  assert.equal(config.jsonMode, 0);
  assert.equal(bodies[1].response_format, undefined);
});

test('invalid structured output is actionable and does not echo the model output', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => reply('Private model output 私密内容'));
  await assert.rejects(chatJSON({ messages, retries: 0 }), (error) => /JSON/.test(error.message)
    && !/Private|私密/.test(error.message));
});

test('output truncation increases the limit once then points to the actual setting', async (t) => {
  const caps = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    caps.push(JSON.parse(init.body).max_tokens); return reply('', 'length');
  });
  await assert.rejects(chat({ messages, maxTokens: 256, retries: 0 }), /设置 → 调用参数.*输出上限/);
  assert.deepEqual(caps, [256, 512]);
});

test('timeouts stay visible in regular and streaming requests while user cancellation stays an AbortError', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const regular = chat({ messages, retries: 0 });
  t.mock.timers.tick(10000);
  await assert.rejects(regular, /超时/);
  const stream = chatStream({ messages });
  t.mock.timers.tick(60000);
  await assert.rejects(stream, (error) => error.name === 'LLMError' && /超时/.test(error.message));
  const controller = new AbortController();
  const cancelled = chatStream({ messages, signal: controller.signal }); controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
});

test('network and mixed-content failures use targeted guidance without raw browser exceptions', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(chat({ messages, retries: 0 }), (error) => /CORS/.test(error.message) && !/Failed to fetch/.test(error.message));
  globalThis.location = { protocol: 'https:' };
  t.after(() => { delete globalThis.location; });
  config.baseUrl = 'http://model.example';
  await assert.rejects(chat({ messages, retries: 0 }), /使用 HTTPS/);
});

test('platform and native error codes preserve the recovery action and hide internal detail', () => {
  assert.match(errorMessage(new DOMException('Quota exceeded', 'QuotaExceededError')), /存储空间不足/);
  assert.equal(errorMessage(new Error('AVAudioSession failed'), '播放失败，请重试'), '播放失败，请重试');
  const timeout = Object.assign(new Error('原生回调缺失（PIP_START_NO_CALLBACK）'), { code: 'PIP_START_NO_CALLBACK' });
  assert.match(errorMessage(timeout), /启动超时.*重试/);
  assert.doesNotMatch(errorMessage(timeout), /PIP_|回调|权限/);
});

test('streaming errors after a partial answer stay visible without reflecting the error payload', async (t) => {
  const partial = 'data: {"choices":[{"delta":{"content":"部分讲解"}}]}\n\n';
  t.mock.method(globalThis, 'fetch', async () => new Response(partial + 'data: {"error":{"message":"private 私密数据"}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }));
  const deltas = [];
  await assert.rejects(chatStream({ messages, onDelta: (text) => deltas.push(text) }), (error) => /生成中断.*重试/.test(error.message)
    && !/private|私密/.test(error.message));
  assert.deepEqual(deltas, ['部分讲解']);
});

test('streaming parser accepts split chunks and a final line without a newline', async (t) => {
  const encoder = new TextEncoder();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    for (const part of ['data: null\n\ndata: {"choices":[{"delta":', '{"content":"完整讲解"}}]}']) controller.enqueue(encoder.encode(part));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.equal(await chatStream({ messages }), '完整讲解');
});
