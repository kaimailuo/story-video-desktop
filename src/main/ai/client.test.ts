import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { requestAI, AIRequestError } from './client';
import { aiSettingsSchema, normalizeBaseUrl, type AIRequest } from '../../shared/ai';
import { startMockAI, mockRewrite, mockScenes } from '../../../scripts/helpers/mock-ai';

const key = 'sk-only-for-local-tests';
function contentRequest(kind: 'rewrite' | 'storyboard'): AIRequest {
  return { id: randomUUID(), kind, script: '清晨，城市还未醒来。', category: 'story', instructions: '保留原意' };
}

test('API 地址：拒绝公网明文、凭据、查询参数和完整 endpoint', () => {
  for (const baseUrl of ['http://example.com/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/#key', 'file:///tmp/a', 'https://example.com/v1/chat/completions']) {
    assert.equal(aiSettingsSchema.safeParse({ baseUrl, model: 'm', timeoutSeconds: 60 }).success, false);
  }
  assert.equal(normalizeBaseUrl(' https://example.com/v1/ '), 'https://example.com/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:9999/v1'), 'http://127.0.0.1:9999/v1');
});

test('真实 HTTP 模拟：连接测试／改写／分镜各只发送一次且请求路径正确', async () => {
  const mock = await startMockAI();
  try {
    const settings = { baseUrl: mock.baseUrl, model: 'mock-success', timeoutSeconds: 5 };
    const signal = new AbortController().signal;
    const connection = await requestAI({ settings, apiKey: key, request: { id: randomUUID(), kind: 'test' }, signal });
    assert.equal(connection.kind, 'test');
    const rewrite = await requestAI({ settings, apiKey: key, request: contentRequest('rewrite'), signal });
    assert.equal(rewrite.kind, 'rewrite');
    if (rewrite.kind === 'rewrite') assert.equal(rewrite.text, mockRewrite);
    const storyboard = await requestAI({ settings, apiKey: key, request: contentRequest('storyboard'), signal });
    assert.equal(storyboard.kind, 'storyboard');
    if (storyboard.kind === 'storyboard') assert.deepEqual(storyboard.scenes, mockScenes);
    assert.equal(mock.requests.length, 3);
    assert.ok(mock.requests.every((request) => request.url === '/v1/chat/completions' && request.authorization === `Bearer ${key}`));
    assert.ok(mock.requests.every((request) => !JSON.stringify(request.body).includes(key)));
    assert.equal(rewrite.usage?.totalTokens, 50);
  } finally { await mock.close(); }
});

test('分镜只接受校验通过的 JSON，可处理完整 JSON 代码围栏', async () => {
  const mock = await startMockAI();
  try {
    const settings = { baseUrl: mock.baseUrl, model: 'mock-fenced', timeoutSeconds: 5 };
    const result = await requestAI({ settings, apiKey: key, request: contentRequest('storyboard'), signal: new AbortController().signal });
    assert.equal(result.kind, 'storyboard');
    for (const model of ['mock-invalid-json', 'mock-invalid-scene', 'mock-extra-field', 'mock-truncated', 'mock-html', 'mock-large']) {
      await assert.rejects(requestAI({ settings: { ...settings, model }, apiKey: key, request: contentRequest('storyboard'), signal: new AbortController().signal }), (error: unknown) => error instanceof AIRequestError && error.code === 'invalid_response');
    }
  } finally { await mock.close(); }
});

test('认证／限流／服务错误不反射响应体、不泄漏 Key、不自动重试', async () => {
  const mock = await startMockAI();
  try {
    for (const [model, code] of [['mock-401', 'auth'], ['mock-429', 'rate_limit'], ['mock-503', 'provider']]) {
      const before = mock.requests.length;
      await assert.rejects(requestAI({ settings: { baseUrl: mock.baseUrl, model, timeoutSeconds: 5 }, apiKey: key, request: contentRequest('rewrite'), signal: new AbortController().signal }), (error: unknown) => error instanceof AIRequestError && error.code === code && !error.message.includes(key) && !error.message.includes('敏感服务消息'));
      assert.equal(mock.requests.length, before + 1);
    }
  } finally { await mock.close(); }
});

test('超时覆盖响应头和响应体；主动取消不会重试', async () => {
  const mock = await startMockAI();
  try {
    for (const model of ['mock-slow', 'mock-slow-body']) {
      await assert.rejects(requestAI({ settings: { baseUrl: mock.baseUrl, model, timeoutSeconds: 5 }, apiKey: key, request: contentRequest('rewrite'), signal: new AbortController().signal, timeoutMs: 60 }), (error: unknown) => error instanceof AIRequestError && error.code === 'timeout');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60);
    try {
      await assert.rejects(requestAI({ settings: { baseUrl: mock.baseUrl, model: 'mock-slow', timeoutSeconds: 5 }, apiKey: key, request: contentRequest('rewrite'), signal: controller.signal }), (error: unknown) => error instanceof AIRequestError && error.code === 'cancelled');
    } finally { clearTimeout(timer); }
    assert.equal(mock.requests.length, 3);
  } finally { await mock.close(); }
});

test('已取消的请求不发送；重定向不转发凭据', async () => {
  const mock = await startMockAI();
  try {
    const settings = { baseUrl: mock.baseUrl, model: 'mock-redirect', timeoutSeconds: 5 };
    const controller = new AbortController(); controller.abort();
    await assert.rejects(requestAI({ settings, apiKey: key, request: contentRequest('rewrite'), signal: controller.signal }), (error: unknown) => error instanceof AIRequestError && error.code === 'cancelled');
    assert.equal(mock.requests.length, 0);
    await assert.rejects(requestAI({ settings, apiKey: key, request: contentRequest('rewrite'), signal: new AbortController().signal }), (error: unknown) => error instanceof AIRequestError && error.code === 'network');
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].url, '/v1/chat/completions');
  } finally { await mock.close(); }
});
