import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateSpeechBatch, generateSpeechClip } from './speech-client';
import { AIRequestError } from './client';
import { AISettingsStore, type SecretCodec } from './settings-store';
import { parsePcmWave, loadPcmWave } from '../audio/wav';
import { aiSettingsSchema } from '../../shared/ai';
import { speechRequestSchema, speechSceneDuration, type SpeechRequest } from '../../shared/speech';
import { adoptSceneSpeech, createProject, projectSchema } from '../../shared/project';
import { pcmTone, startMockSpeech } from '../../../scripts/helpers/mock-speech';

const apiKey = 'sk-local-speech-test-only';
async function fixture(action: (mock: Awaited<ReturnType<typeof startMockSpeech>>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.resolve('artifacts/speech-unit-'));
  const mock = await startMockSpeech();
  try { await action(mock, directory); }
  finally { await mock.close(); await rm(directory, { recursive: true, force: true }); }
}
function request(texts: string[]): SpeechRequest {
  return { id: randomUUID(), voice: 'test-voice', speed: 1.1, scenes: texts.map((text, index) => ({ sceneId: `s-${index}`, text })) };
}

test('配音协议：拒绝空文字／音色、非法语速、重复镜头、超过 100 镜及完整 endpoint', () => {
  assert.equal(speechRequestSchema.safeParse(request(['你好'])).success, true);
  for (const value of [request([]), request([' ']), request(['字'.repeat(181)]), request(Array.from({ length: 101 }, () => 'x')), { ...request(['x']), voice: ' ' }, { ...request(['x']), speed: 0 }, { ...request(['x']), speed: 4.1 }, { ...request(['x']), scenes: [{ sceneId: 's', text: 'a' }, { sceneId: 's', text: 'b' }] }]) assert.equal(speechRequestSchema.safeParse(value).success, false);
  assert.equal(aiSettingsSchema.safeParse({ baseUrl: 'https://example.com/v1/audio/speech', model: 'm', timeoutSeconds: 5 }).success, false);
});

test('WAV 解析：从采样数计算时长，接受单双声道，剥离元数据', () => {
  for (const channels of [1, 2]) {
    const input = pcmTone(1.101, 440, 24000, channels);
    const wave = parsePcmWave(input);
    assert.equal(wave.duration, 1.101); assert.equal(wave.frames, 26424); assert.equal(wave.channels, channels);
    const metadata = Buffer.from('LIST\x04\0\0\0test', 'binary');
    const enriched = Buffer.concat([input.subarray(0, 36), metadata, input.subarray(36)]);
    enriched.writeUInt32LE(enriched.length - 8, 4);
    assert.deepEqual(parsePcmWave(enriched).buffer, input);
  }
});

test('WAV 防护：拒绝损坏长度、空／超长音频、非 PCM16、异常采样率与不完整采样', () => {
  const valid = pcmTone();
  const mutations: [number, number, 2 | 4][] = [[4, 0xffffffff, 4], [20, 3, 2], [22, 3, 2], [24, 100, 4], [28, 1, 4], [32, 1, 2], [34, 8, 2], [40, 3, 4]];
  for (const [offset, value, width] of mutations) {
    const bytes = Buffer.from(valid); if (width === 2) bytes.writeUInt16LE(value, offset); else bytes.writeUInt32LE(value, offset);
    assert.throws(() => parsePcmWave(bytes));
  }
  for (const bytes of [Buffer.from('ID3mp3'), valid.subarray(0, 40), pcmTone(0), pcmTone(60.01), Buffer.alloc(25 * 1024 * 1024)]) assert.throws(() => parsePcmWave(bytes));
});

test('单镜：正确请求、原子落盘、精确时长和权限，不存 Key，不留临时文件', async () => {
  await fixture(async (mock, directory) => {
    const clip = await generateSpeechClip({ settings: { baseUrl: mock.baseUrl, model: 'mock-speech', timeoutSeconds: 5 }, apiKey, text: '你好', voice: 'test-voice', speed: 1.1, directory, signal: new AbortController().signal });
    assert.equal(clip.duration, 1.101); assert.equal((await loadPcmWave(clip.path)).duration, 1.101);
    assert.equal((await stat(clip.path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), [path.basename(clip.path)]);
    assert.deepEqual(mock.requests[0], { url: '/v1/audio/speech', authorization: `Bearer ${apiKey}`, body: { model: 'mock-speech', input: '你好', voice: 'test-voice', speed: 1.1, response_format: 'wav' } });
    assert.ok(!JSON.stringify(clip).includes(apiKey));
  });
});

test('响应防护：大小、格式与重定向；不反射供应商错误，不自动重试', async () => {
  await fixture(async (mock, directory) => {
    for (const model of ['large', 'corrupt', 'float', 'auth', 'limit', 'fail', 'redirect']) {
      const before = mock.requests.length;
      await assert.rejects(generateSpeechClip({ settings: { baseUrl: mock.baseUrl, model, timeoutSeconds: 5 }, apiKey, text: 'x', voice: 'v', speed: 1, directory, signal: new AbortController().signal }), (error: unknown) => error instanceof AIRequestError && !error.message.includes(apiKey) && !error.message.includes('私密错误'));
      assert.equal(mock.requests.length - before, 1);
    }
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(loadPcmWave('relative.wav'), /本地 WAV/);
  });
});

test('批量串行与部分成功：普通失败可继续，进度递增', async () => {
  await fixture(async (mock, directory) => {
    const progress: number[] = [];
    const batch = await generateSpeechBatch({ settings: { baseUrl: mock.baseUrl, model: 'mock-speech', timeoutSeconds: 5 }, apiKey, request: request(['first', 'fail', 'last']), directory, signal: new AbortController().signal, onProgress: (event) => progress.push(event.completed) });
    assert.equal(batch.state, 'done'); assert.deepEqual(batch.items.map((item) => item.ok), [true, false, true]);
    assert.deepEqual(progress, [0, 1, 1, 2, 2, 3]); assert.equal(mock.requests.length, 3);
    assert.equal((await readdir(directory)).length, 2);
  });
});

test('认证／限流停止后续调用并保留成功，不泄漏服务错误', async () => {
  await fixture(async (mock, directory) => {
    for (const mode of ['auth', 'limit']) {
      const before = mock.requests.length;
      const batch = await generateSpeechBatch({ settings: { baseUrl: mock.baseUrl, model: 'mock-speech', timeoutSeconds: 5 }, apiKey, request: request(['first', mode, 'must-not-send']), directory, signal: new AbortController().signal, onProgress() {} });
      assert.equal(batch.state, 'stopped'); assert.deepEqual(batch.items.map((item) => item.ok), [true, false]);
      assert.equal(mock.requests.length - before, 2); assert.ok(!JSON.stringify(batch).includes(apiKey));
    }
  });
});

test('取消保留已成功结果，提前取消不联网', async () => {
  await fixture(async (mock, directory) => {
    const controller = new AbortController();
    const options = { settings: { baseUrl: mock.baseUrl, model: 'mock-speech', timeoutSeconds: 5 }, apiKey, request: request(['first', 'last']), directory, signal: controller.signal, onProgress(event: { completed: number }) { if (event.completed === 1) controller.abort(); } };
    const batch = await generateSpeechBatch(options);
    assert.equal(batch.state, 'cancelled'); assert.equal(batch.items.length, 1); assert.equal(batch.items[0].ok, true);
    assert.equal((await generateSpeechBatch(options)).items.length, 0); assert.equal(mock.requests.length, 1);
  });
});

test('超时覆盖响应头／体，进行中取消不重试、不留文件', async () => {
  await fixture(async (mock, directory) => {
    for (const model of ['slow', 'slow-body']) await assert.rejects(generateSpeechClip({ settings: { baseUrl: mock.baseUrl, model, timeoutSeconds: 5 }, apiKey, text: 'x', voice: 'v', speed: 1, directory, signal: new AbortController().signal, timeoutMs: 80 }), (error: unknown) => error instanceof AIRequestError && error.code === 'timeout');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 80);
    try { await assert.rejects(generateSpeechClip({ settings: { baseUrl: mock.baseUrl, model: 'slow', timeoutSeconds: 5 }, apiKey, text: 'x', voice: 'v', speed: 1, directory, signal: controller.signal }), (error: unknown) => error instanceof AIRequestError && error.code === 'cancelled'); }
    finally { clearTimeout(timer); }
    assert.equal(mock.requests.length, 3); assert.deepEqual(await readdir(directory), []);
  });
});

test('落盘失败停止批量，不覆盖已有文件', async () => {
  await fixture(async (mock, directory) => {
    const file = path.join(directory, 'keep'); await writeFile(file, '保留');
    const batch = await generateSpeechBatch({ settings: { baseUrl: mock.baseUrl, model: 'mock-speech', timeoutSeconds: 5 }, apiKey, request: request(['first', 'last']), directory: file, signal: new AbortController().signal, onProgress() {} });
    assert.equal(batch.state, 'stopped'); assert.equal(mock.requests.length, 1); assert.equal(await readFile(file, 'utf8'), '保留');
  });
});

test('采用：30 FPS 向上量化、至少 1 秒、文字过期保护与旧项目兼容', () => {
  assert.equal(speechSceneDuration(1.101), 34 / 30); assert.equal(speechSceneDuration(0.6), 1);
  assert.equal(speechSceneDuration(60), 60); assert.equal(speechSceneDuration(1.1), 1.1);
  for (const value of [0, -1, 60.1, NaN]) assert.throws(() => speechSceneDuration(value));
  const project = createProject(); const scene = project.scenes[0];
  const clip = { id: randomUUID(), path: '/test.wav', text: scene.text, voice: 'v', speed: 1, model: 'm', duration: 1.101, createdAt: new Date().toISOString() };
  assert.equal(adoptSceneSpeech(scene, clip).duration, 34 / 30);
  assert.throws(() => adoptSceneSpeech({ ...scene, text: '变了' }, clip), /文字已改变/);
  assert.equal(projectSchema.parse(project).narrationMode, undefined);
});

test('三类配置独立，配音换地址保护、删除 Key 与加密不可用拒绝明文', async () => {
  await fixture(async (_mock, directory) => {
    const codec: SecretCodec = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value).reverse(), decryptString: (value) => Buffer.from(value).reverse().toString() };
    const speech = new AISettingsStore(directory, codec, 'speech-settings.json');
    const settings = { baseUrl: 'https://example.com/v1', model: 'm', timeoutSeconds: 5 };
    await speech.save({ settings, apiKey });
    assert.equal((await new AISettingsStore(directory, codec).getView()).hasKey, false);
    assert.equal((await new AISettingsStore(directory, codec, 'image-settings.json').getView()).hasKey, false);
    await assert.rejects(speech.save({ settings: { ...settings, baseUrl: 'https://other.example/v1' } }), /重新输入/);
    const unavailable = new AISettingsStore(directory, { ...codec, isEncryptionAvailable: () => false }, 'speech-settings.json');
    await assert.rejects(unavailable.getCredentials());
    await speech.save({ settings, clearKey: true }); assert.equal((await speech.getView()).hasKey, false);
  });
});
