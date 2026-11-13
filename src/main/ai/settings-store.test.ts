import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AISettingsStore, type SecretCodec } from './settings-store';
import { projectSchema, createProject } from '../../shared/project';

function testCodec(): SecretCodec {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

async function directoryTest(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yingxu-ai-store-'));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

const settings = { baseUrl: 'https://example.com/v1', model: 'test-model', timeoutSeconds: 60 };
const apiKey = 'sk-unit-test-not-a-real-key';

test('配置持久化：密文、0600、视图无 Key，重建 store 可读', async () => {
  await directoryTest(async (directory) => {
    const codec = testCodec();
    const store = new AISettingsStore(directory, codec);
    assert.equal((await store.getView()).hasKey, false);
    const view = await store.save({ settings, apiKey });
    assert.equal(view.hasKey, true);
    assert.ok(!JSON.stringify(view).includes(apiKey));
    const filePath = path.join(directory, 'ai-settings.json');
    assert.ok(!(await readFile(filePath, 'utf8')).includes(apiKey));
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await new AISettingsStore(directory, codec).getCredentials()).apiKey, apiKey);
    assert.deepEqual(await readdir(directory), ['ai-settings.json']);
  });
});

test('系统加密不可用时拒绝保存 Key，允许无 Key 设置且不回退明文', async () => {
  await directoryTest(async (directory) => {
    const codec: SecretCodec = { isEncryptionAvailable: () => false, encryptString() { throw new Error('不应调用'); }, decryptString() { throw new Error('不应调用'); } };
    const store = new AISettingsStore(directory, codec);
    await assert.rejects(store.save({ settings, apiKey }), /不.*明文/);
    assert.deepEqual(await readdir(directory), []);
    assert.equal((await store.save({ settings })).hasKey, false);
    await assert.rejects(store.getCredentials(), /请先/);
  });
});

test('空 Key 保持不变，变更地址必须显式换 Key 或删除', async () => {
  await directoryTest(async (directory) => {
    const store = new AISettingsStore(directory, testCodec());
    await store.save({ settings, apiKey });
    await store.save({ settings: { ...settings, model: 'new-model' }, apiKey: '' });
    assert.equal((await store.getCredentials()).apiKey, apiKey);
    const changed = { ...settings, baseUrl: 'https://another.example/v1' };
    await assert.rejects(store.save({ settings: changed }), /重新输入 Key/);
    assert.equal((await store.getView()).settings.baseUrl, settings.baseUrl);
    const cleared = await store.save({ settings: changed, clearKey: true });
    assert.equal(cleared.hasKey, false);
    await assert.rejects(store.getCredentials(), /请先/);
  });
});

test('加密失败／配置损坏保留原文件，不透传敏感错误', async () => {
  await directoryTest(async (directory) => {
    const codec = testCodec();
    const store = new AISettingsStore(directory, codec);
    await store.save({ settings, apiKey });
    const filePath = path.join(directory, 'ai-settings.json');
    const original = await readFile(filePath, 'utf8');
    codec.encryptString = () => { throw new Error(`敏感：${apiKey}`); };
    await assert.rejects(store.save({ settings, apiKey }), (error: unknown) => error instanceof Error && !error.message.includes(apiKey) && error.message.includes('原配置未修改'));
    assert.equal(await readFile(filePath, 'utf8'), original);
    await writeFile(filePath, '损坏配置');
    await assert.rejects(store.save({ settings }), /损坏/);
    assert.equal(await readFile(filePath, 'utf8'), '损坏配置');
  });
});

test('解密失败不向调用者暴露 codec 错误或密钥', async () => {
  await directoryTest(async (directory) => {
    const codec = testCodec();
    const store = new AISettingsStore(directory, codec);
    await store.save({ settings, apiKey });
    codec.decryptString = () => { throw new Error(apiKey); };
    await assert.rejects(store.getCredentials(), (error: unknown) => error instanceof Error && !error.message.includes(apiKey));
    assert.equal((await store.save({ settings, clearKey: true })).hasKey, false);
  });
});

test('旧项目可迁移默认字段；项目不会保存 API Key／服务配置', () => {
  const project = createProject();
  const legacy = { ...project } as Record<string, unknown>;
  delete legacy.rewriteHistory;
  legacy.scenes = project.scenes.map((scene) => { const value = { ...scene } as Record<string, unknown>; delete value.description; return value; });
  legacy.apiKey = apiKey;
  legacy.aiSettings = settings;
  const parsed = projectSchema.parse(legacy);
  assert.deepEqual(parsed.rewriteHistory, []);
  assert.equal(parsed.scenes[0].description, '');
  assert.ok(!JSON.stringify(parsed).includes(apiKey));
  assert.ok(!('aiSettings' in parsed));
});
