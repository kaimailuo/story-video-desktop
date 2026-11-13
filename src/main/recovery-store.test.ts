import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { RecoveryStore, atomicJson } from './recovery-store';
import { createProject } from '../shared/project';
import type { DraftInput } from '../shared/recovery';
import { generateSpeechBatch } from './ai/speech-client';
import { generateImageBatch } from './ai/image-client';
import { pcmTone, startMockSpeech } from '../../scripts/helpers/mock-speech';
import { startMockImages } from '../../scripts/helpers/mock-images';

async function fixture(action: (directory: string, store: RecoveryStore) => Promise<void>) {
  const directory = await mkdtemp(path.resolve('artifacts/recovery-unit-'));
  try { await action(directory, new RecoveryStore(directory)); } finally { await rm(directory, { recursive: true, force: true }); }
}
const draft = (): DraftInput => ({ id: randomUUID(), revision: 1, sourceFilePath: '/原手动项目.json', project: createProject() });

test('自动草稿完整保存／重开，与手动文件分离，去除未知字段并限制权限', async () => {
  await fixture(async (directory, store) => {
    const input = draft(); input.sourceFilePath = path.join(directory, 'manual.json');
    await writeFile(input.sourceFilePath, '手动原件');
    input.project.script = '待恢复文案';
    await store.saveDraft({ ...input, apiKey: 'not-persisted' } as DraftInput);
    const restored = await new RecoveryStore(directory).loadDraft(input.id);
    assert.equal(restored.project.script, '待恢复文案');
    assert.equal(await readFile(input.sourceFilePath, 'utf8'), '手动原件');
    const file = path.join(store.directory, 'drafts', `${input.id}.json`);
    assert.ok(!(await readFile(file, 'utf8')).includes('not-persisted'));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await store.overview()).drafts[0].sceneCount, 1);
  });
});

test('异步乱序与旧请求不覆盖较新草稿，放弃标记不会被旧版复活', async () => {
  await fixture(async (_directory, store) => {
    const input = draft();
    await Promise.all([store.saveDraft({ ...input, revision: 3, project: { ...input.project, title: '新内容' } }), store.saveDraft({ ...input, revision: 2 })]);
    assert.equal((await store.loadDraft(input.id)).project.title, '新内容');
    await assert.rejects(store.dismissDraft(input.id, 2), /草稿已更新/);
    await store.dismissDraft(input.id, 3); await store.saveDraft({ ...input, revision: 3 });
    assert.equal((await store.overview()).drafts.length, 0);
    await assert.rejects(store.loadDraft(input.id), /已经放弃/);
    await store.saveDraft({ ...input, revision: 4 });
    assert.equal((await store.overview()).drafts.length, 1);
  });
});

test('损坏草稿不覆盖、不删除；单条坏记录不阻塞其他草稿和任务', async () => {
  await fixture(async (_directory, store) => {
    const input = draft(); await store.saveDraft(input);
    const file = path.join(store.directory, 'drafts', `${input.id}.json`); await writeFile(file, '损坏原内容');
    await assert.rejects(store.saveDraft({ ...input, revision: 2 }), /原草稿损坏/);
    assert.equal(await readFile(file, 'utf8'), '损坏原内容');
    await store.saveDraft(draft()); const task = await store.begin('test', 1); await store.finish(task, 'failed');
    const overview = await store.overview(); assert.equal(overview.drafts.length, 1); assert.equal(overview.tasks.length, 1); assert.ok(overview.warnings.length);
  });
});

test('原子写失败保留旧文件，清理仅本任务临时文件；拒绝路径穿越编号', async () => {
  await fixture(async (directory, store) => {
    const file = path.join(directory, '原子.json'); await atomicJson(file, { original: true });
    await assert.rejects(atomicJson(file, { bad: BigInt(1) }));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { original: true });
    assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.tmp')));
    await assert.rejects(store.loadDraft('../x')); await assert.rejects(store.begin('test', 1, '../x'));
    await store.saveDraft(draft()); // 队列在失败之后仍可工作。
  });
});

test('任务逐镜落盘，区分部分完成／失败／取消；重开不自动重发', async () => {
  await fixture(async (directory, store) => {
    const id = await store.begin('speech', 3, randomUUID());
    const wave = path.join(directory, '音频.wav'); await writeFile(wave, pcmTone());
    await store.item(id, { kind: 'speech', path: wave, sceneId: 's1' }); await store.item(id);
    await store.finish(id, 'done');
    const task = (await new RecoveryStore(directory).overview()).tasks.find((item) => item.id === id)!;
    assert.equal(task.state, 'partial'); assert.equal(task.processed, 2); assert.equal(task.succeeded, 1); assert.equal(task.failed, 1);
    const fail = await store.begin('image', 2); await store.item(fail); await store.finish(fail, 'partial');
    const cancel = await store.begin('mp4', 1); await store.finish(cancel, 'cancelled');
    const overview = await store.overview(); assert.equal(overview.tasks.find((item) => item.id === fail)!.state, 'failed'); assert.equal(overview.tasks.find((item) => item.id === cancel)!.state, 'cancelled');
  });
});

test('退出的旧进程任务标为中断，活跃进程不误判，保留已完成产物', async () => {
  await fixture(async (directory, store) => {
    const id = await store.begin('mp4', 1);
    const record = path.join(store.directory, 'tasks', `${id}.json`);
    const task = JSON.parse(await readFile(record, 'utf8')) as Record<string, unknown>;
    task.ownerPid = 2147483647; await atomicJson(record, task);
    const live = await store.begin('speech', 2);
    const overview = await new RecoveryStore(directory).overview();
    assert.equal(overview.tasks.find((item) => item.id === id)!.state, 'interrupted');
    assert.equal(overview.tasks.find((item) => item.id === live)!.state, 'running');
  });
});

test('大小与 SHA-256 检出同长度替换、缺失及损坏音频，不自动重生成', async () => {
  await fixture(async (directory, store) => {
    const id = await store.begin('speech', 1); const file = path.join(directory, 'speech.wav'); const bytes = pcmTone();
    await writeFile(file, bytes); await store.item(id, { kind: 'speech', path: file }); await store.finish(id, 'done');
    const artifact = (await store.overview()).tasks[0].artifacts[0];
    assert.equal((await store.checkArtifact(id, artifact.id)).valid, true);
    bytes[100] ^= 1; await writeFile(file, bytes);
    assert.match((await store.checkArtifact(id, artifact.id)).message, /SHA-256 不匹配/);
    await rm(file); assert.equal((await store.checkArtifact(id, artifact.id)).valid, false);
  });
});

test('图片／文本／SRT 产物校验，文本结果权限且不保存服务配置', async () => {
  await fixture(async (directory, store) => {
    const id = await store.begin('image', 1); const image = path.join(directory, 'image.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toFile(image);
    await store.item(id, { kind: 'image', path: image }); await store.finish(id, 'done');
    const text = await store.begin('rewrite', 1); await store.textResult(text, { kind: 'rewrite', text: '可恢复结果', model: 'local' }); await store.finish(text, 'done');
    const srtId = await store.begin('srt', 1); const srt = path.join(directory, 'file.srt'); await writeFile(srt, '1\n00:00:00,000 --> 00:00:01,000\n文字'); await store.item(srtId, { kind: 'srt', path: srt });
    for (const task of (await store.overview()).tasks) for (const artifact of task.artifacts) assert.equal((await store.checkArtifact(task.id, artifact.id)).valid, true);
    const result = path.join(store.directory, 'results', `${text}.json`);
    assert.equal((await stat(result)).mode & 0o777, 0o600); assert.match(await readFile(result, 'utf8'), /可恢复结果/);
  });
});

test('配音逐镜记录失败即停止后续请求，已成功文件与候选保留', async () => {
  const mock = await startMockSpeech();
  try {
    await fixture(async (directory) => {
      const batch = await generateSpeechBatch({ settings: { baseUrl: mock.baseUrl, model: 'mock-speech', timeoutSeconds: 5 }, apiKey: 'fake', request: { id: randomUUID(), voice: 'v', speed: 1, scenes: [{ sceneId: 'one', text: 'first' }, { sceneId: 'two', text: 'last' }] }, directory, signal: new AbortController().signal, onProgress() {}, async onItem() { throw new Error('disk'); } });
      assert.equal(mock.requests.length, 1); assert.equal(batch.state, 'stopped'); assert.equal(batch.items.length, 1); assert.ok(batch.warning);
      assert.ok(batch.items[0].ok); if (batch.items[0].ok) assert.ok((await stat(batch.items[0].clip.path)).size > 0);
    });
  } finally { await mock.close(); }
});

test('图片逐镜记录失败即停止后续请求，保留已生成图片', async () => {
  const mock = await startMockImages();
  try {
    await fixture(async (directory) => {
      const batch = await generateImageBatch({ settings: { baseUrl: mock.baseUrl, model: 'mock-image', timeoutSeconds: 5 }, apiKey: 'fake', request: { id: randomUUID(), size: '1024x1024', scenes: [{ sceneId: 'one', prompt: 'first' }, { sceneId: 'two', prompt: 'second' }] }, directory, signal: new AbortController().signal, onProgress() {}, async onItem() { throw new Error('disk'); } });
      assert.equal(mock.requests.length, 1); assert.equal(batch.state, 'stopped'); assert.ok(batch.warning); assert.ok(batch.items[0].ok);
    });
  } finally { await mock.close(); }
});
