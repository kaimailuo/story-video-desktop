import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { generateImage, generateImageBatch, safeImageUrl } from './image-client';
import { AIRequestError } from './client';
import { AISettingsStore, type SecretCodec } from './settings-store';
import { aiSettingsSchema } from '../../shared/ai';
import { imageRequestSchema, type ImageRequest } from '../../shared/images';
import { createProject, projectSchema, selectSceneImage, type Scene } from '../../shared/project';
import { startMockImages } from '../../../scripts/helpers/mock-images';

const apiKey = 'sk-images-local-test-only';
async function fixture(action: (mock: Awaited<ReturnType<typeof startMockImages>>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.resolve('artifacts/image-unit-'));
  const mock = await startMockImages();
  try { await action(mock, directory); }
  finally { await mock.close(); await rm(directory, { recursive: true, force: true }); }
}
function request(prompts: string[]): ImageRequest {
  return { id: randomUUID(), size: '1024x1024', scenes: prompts.map((prompt, index) => ({ sceneId: `s-${index}`, prompt })) };
}

test('图片参数：数量、尺寸、空提示词、重复镜头与完整 endpoint 校验', () => {
  assert.equal(imageRequestSchema.safeParse(request(['test'])).success, true);
  for (const value of [request([]), request([' ']), request(Array.from({ length: 101 }, () => 'p')), { ...request(['p']), size: '1x1' }, { ...request(['p', 'p']), scenes: [{ sceneId: 's', prompt: 'p' }, { sceneId: 's', prompt: 'p' }] }]) {
    assert.equal(imageRequestSchema.safeParse(value).success, false);
  }
  assert.equal(aiSettingsSchema.safeParse({ baseUrl: 'https://example.com/v1/images/generations', model: 'm', timeoutSeconds: 5 }).success, false);
});

test('Base64 生图：请求参数、PNG 落盘与缩略图，不保存 Key、不留临时文件', async () => {
  await fixture(async (mock, directory) => {
    const result = await generateImage({ settings: { baseUrl: mock.baseUrl, model: 'mock-images', timeoutSeconds: 5 }, apiKey, prompt: '画一扇窗', size: '1024x1536', directory, signal: new AbortController().signal });
    assert.equal(result.prompt, '画一扇窗');
    assert.ok(result.preview.startsWith('data:image/jpeg;base64,'));
    assert.equal((await sharp(result.path).metadata()).format, 'png');
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), [path.basename(result.path)]);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].url, '/v1/images/generations');
    assert.equal(mock.requests[0].authorization, `Bearer ${apiKey}`);
    assert.deepEqual(mock.requests[0].body, { model: 'mock-images', prompt: '画一扇窗', n: 1, size: '1024x1536', response_format: 'b64_json' });
    assert.ok(!JSON.stringify(result).includes(apiKey));
  });
});

test('URL 下载：仅同源，不发送 Authorization，不接受跨域、凭据或重定向', async () => {
  await fixture(async (mock, directory) => {
    const options = { settings: { baseUrl: mock.baseUrl, model: 'url', timeoutSeconds: 5 }, apiKey, prompt: 'p', size: '1024x1024' as const, directory, signal: new AbortController().signal };
    await generateImage(options);
    assert.equal(mock.requests[1].url, '/picture');
    assert.equal(mock.requests[1].authorization, undefined);
    for (const model of ['cross-url', 'url-redirect', 'redirect']) {
      const before = mock.requests.length;
      await assert.rejects(generateImage({ ...options, settings: { ...options.settings, model } }), (error: unknown) => error instanceof AIRequestError && ['invalid_response', 'network'].includes(error.code));
      assert.equal(mock.requests.length - before, model === 'url-redirect' ? 2 : 1);
    }
    assert.equal(mock.requests.filter((item) => item.url === '/picture').length, 1);
    for (const url of ['https://evil.example/file', 'file:///private/a', 'https://user:pw@example.com/a', 'https://example.com/a#frag', 'http://example.com/a']) assert.throws(() => safeImageUrl(url, 'https://example.com/v1'), AIRequestError);
    assert.equal(safeImageUrl('https://example.com/a?signature=secret', 'https://example.com/v1'), 'https://example.com/a?signature=secret');
  });
});

test('响应防护：拒绝超限、非法 JSON／Base64、损坏图片、SVG 与多图', async () => {
  await fixture(async (mock, directory) => {
    for (const model of ['large', 'bad-json', 'bad-base64', 'corrupt', 'svg', 'multi']) {
      await assert.rejects(generateImage({ settings: { baseUrl: mock.baseUrl, model, timeoutSeconds: 5 }, apiKey, prompt: 'p', size: '1024x1024', directory, signal: new AbortController().signal }), (error: unknown) => error instanceof AIRequestError && error.code === 'invalid_response' && !error.message.includes(apiKey));
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

test('批量逐镜：失败不影响成功结果，进度递增，每镜只请求一次', async () => {
  await fixture(async (mock, directory) => {
    const progress: number[] = [];
    const result = await generateImageBatch({ settings: { baseUrl: mock.baseUrl, model: 'mock-images', timeoutSeconds: 5 }, apiKey, request: request(['first', 'fail', 'last']), directory, signal: new AbortController().signal, onProgress: (event) => progress.push(event.completed) });
    assert.equal(result.state, 'done');
    assert.deepEqual(result.items.map((item) => item.ok), [true, false, true]);
    assert.deepEqual(progress, [0, 1, 1, 2, 2, 3]);
    assert.equal(mock.requests.length, 3);
    assert.equal((await readdir(directory)).length, 2);
    assert.ok(!JSON.stringify(result).includes(apiKey));
  });
});

test('认证和限流停止后续调用，保留前面成功候选，不回显服务敏感错误', async () => {
  await fixture(async (mock, directory) => {
    for (const mode of ['auth', 'limit', 'url-auth', 'url-limit']) {
      const before = mock.requests.length;
      const result = await generateImageBatch({ settings: { baseUrl: mock.baseUrl, model: 'mock-images', timeoutSeconds: 5 }, apiKey, request: request(['ok', mode, 'must-not-send']), directory, signal: new AbortController().signal, onProgress() {} });
      assert.equal(result.state, 'stopped');
      assert.deepEqual(result.items.map((item) => item.ok), [true, false]);
      assert.equal(mock.requests.length - before, mode.startsWith('url-') ? 3 : 2);
      assert.ok(!JSON.stringify(result).includes(apiKey) && !JSON.stringify(result).includes('私密消息'));
    }
  });
});

test('取消保留已完成图片且不发送后续请求；提前取消不联网', async () => {
  await fixture(async (mock, directory) => {
    const controller = new AbortController();
    const options = { settings: { baseUrl: mock.baseUrl, model: 'mock-images', timeoutSeconds: 5 }, apiKey, request: request(['first', 'second']), directory, signal: controller.signal, onProgress(event: { completed: number }) { if (event.completed === 1) controller.abort(); } };
    const result = await generateImageBatch(options);
    assert.equal(result.state, 'cancelled');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].ok, true);
    assert.equal(mock.requests.length, 1);
    const cancelled = await generateImageBatch({ ...options, request: request(['not-sent']) });
    assert.equal(cancelled.items.length, 0);
    assert.equal(mock.requests.length, 1);
  });
});

test('请求头／读体超时及进行中取消清理临时文件，不自动重试', async () => {
  await fixture(async (mock, directory) => {
    for (const model of ['slow', 'slow-body']) {
      await assert.rejects(generateImage({ settings: { baseUrl: mock.baseUrl, model, timeoutSeconds: 5 }, apiKey, prompt: 'p', size: '1024x1024', directory, signal: new AbortController().signal, timeoutMs: 80 }), (error: unknown) => error instanceof AIRequestError && error.code === 'timeout');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 80);
    try {
      await assert.rejects(generateImage({ settings: { baseUrl: mock.baseUrl, model: 'slow', timeoutSeconds: 5 }, apiKey, prompt: 'p', size: '1024x1024', directory, signal: controller.signal }), (error: unknown) => error instanceof AIRequestError && error.code === 'cancelled');
    } finally { clearTimeout(timer); }
    assert.equal(mock.requests.length, 3);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('落盘失败停止批量，不覆盖已有文件', async () => {
  await fixture(async (mock, directory) => {
    const file = path.join(directory, 'not-a-directory');
    await writeFile(file, 'keep');
    const result = await generateImageBatch({ settings: { baseUrl: mock.baseUrl, model: 'mock-images', timeoutSeconds: 5 }, apiKey, request: request(['first', 'second']), directory: file, signal: new AbortController().signal, onProgress() {} });
    assert.equal(result.state, 'stopped');
    assert.equal(mock.requests.length, 1);
    assert.equal(await readFile(file, 'utf8'), 'keep');
  });
});

test('版本选择保留旧图，最多 20 个引用，旧项目默认兼容且不保存缩略图', () => {
  const project = createProject();
  let scene: Scene = { ...project.scenes[0], imagePath: '/old.png' };
  for (let index = 0; index < 24; index++) {
    const candidate = { id: randomUUID(), path: `/image-${index}.png`, source: 'generated' as const, prompt: 'p', model: 'm', createdAt: new Date().toISOString(), preview: 'must-not-store' };
    scene = selectSceneImage(scene, candidate);
  }
  assert.equal(scene.imageVersions?.length, 20);
  const version = scene.imageVersions![0];
  scene = selectSceneImage(scene, version);
  assert.equal(scene.imagePath, version.path);
  assert.equal(scene.imageVersions?.length, 20);
  assert.equal(scene.prompt, '');
  assert.ok(!JSON.stringify(scene).includes('must-not-store'));
  assert.equal(projectSchema.parse(project).scenes[0].imageVersions, undefined);
  const first = selectSceneImage({ ...project.scenes[0], imagePath: '/old.png' }, version);
  assert.equal(first.imageVersions![0].path, '/old.png');
});

test('图片／文本配置独立，换地址保护与删除 Key 复用安全存储规则', async () => {
  await fixture(async (_mock, directory) => {
    const codec: SecretCodec = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value).reverse(), decryptString: (value) => Buffer.from(value).reverse().toString() };
    const text = new AISettingsStore(directory, codec);
    const image = new AISettingsStore(directory, codec, 'image-settings.json');
    const settings = { baseUrl: 'https://example.com/v1', model: 'm', timeoutSeconds: 5 };
    await text.save({ settings, apiKey: 'sk-text' });
    assert.equal((await image.getView()).hasKey, false);
    await image.save({ settings, apiKey });
    await assert.rejects(image.save({ settings: { ...settings, baseUrl: 'https://other.example/v1' } }), /重新输入/);
    await image.save({ settings, clearKey: true });
    assert.equal((await text.getCredentials()).apiKey, 'sk-text');
    assert.equal((await image.getView()).hasKey, false);
  });
});
