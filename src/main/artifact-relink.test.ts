import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { RecoveryStore } from './recovery-store';
import { createProject, adoptSceneSpeech, selectSceneImage } from '../shared/project';
import { pcmTone } from '../../scripts/helpers/mock-speech';

async function fixture(action: (directory: string, store: RecoveryStore) => Promise<void>) {
  await mkdir('artifacts', { recursive: true }); const directory = await mkdtemp(path.resolve('artifacts/relink-unit-'));
  try { await action(directory, new RecoveryStore(directory)); } finally { await rm(directory, { recursive: true, force: true }); }
}
test('图片元数据持久化，重新打开后核验／预览并选择另一分镜，源文件与项目不变', async () => {
  await fixture(async (directory, store) => {
    const image = path.join(directory, '图片.png'); await sharp({ create: { width: 32, height: 48, channels: 3, background: '#9875bf' } }).png().toFile(image);
    const metadata = { id: randomUUID(), path: image, source: 'generated' as const, prompt: '原始提示词', model: 'mock', createdAt: new Date().toISOString() };
    const task = await store.begin('image', 1, randomUUID()); await store.item(task, { kind: 'image', path: image, sceneId: 'other', image: metadata }); await store.finish(task, 'done');
    const reopened = new RecoveryStore(directory); const artifact = (await reopened.overview()).tasks[0].artifacts[0];
    assert.deepEqual(artifact.image, metadata);
    const project = createProject(); const before = JSON.stringify(project); const bytes = await readFile(image);
    const result = await reopened.prepareArtifact(task, artifact.id, project.scenes[0]);
    assert.equal(result.kind, 'image');
    if (result.kind !== 'image') throw new Error();
    assert.match(result.candidate.preview, /^data:image\/jpeg;base64,/);
    assert.equal(selectSceneImage(project.scenes[0], result.candidate).imagePath, image);
    assert.equal(JSON.stringify(project), before); assert.deepEqual(await readFile(image), bytes);
  });
});
test('新配音元数据跨重开保留，匹配文字才能关联并按真实时长量化', async () => {
  await fixture(async (directory, store) => {
    const file = path.join(directory, 'speech.wav'); await writeFile(file, pcmTone());
    const project = createProject(); const clip = { id: randomUUID(), path: file, text: project.scenes[0].text.trim(), model: 'mock', voice: 'local', speed: 1, duration: 1.101, createdAt: new Date().toISOString() };
    const task = await store.begin('speech', 1); await store.item(task, { kind: 'speech', path: file, sceneId: 'old', speech: clip }); await store.finish(task, 'done');
    const reopened = new RecoveryStore(directory); const artifact = (await reopened.overview()).tasks[0].artifacts[0];
    const result = await reopened.prepareArtifact(task, artifact.id, project.scenes[0]); assert.equal(result.kind, 'speech');
    if (result.kind !== 'speech') throw new Error();
    assert.match(result.preview, /^data:audio\/wav;base64,/); assert.equal(adoptSceneSpeech(project.scenes[0], result.clip).duration, 34 / 30);
    await assert.rejects(reopened.prepareArtifact(task, artifact.id, { ...project.scenes[0], text: '改变原稿' }), /文字已改变/);
  });
});
test('旧图片按本地导入处理，旧配音缺原稿拒绝，不用当前字幕伪造元数据', async () => {
  await fixture(async (directory, store) => {
    const file = path.join(directory, 'image.png'); await sharp({ create: { width: 8, height: 8, channels: 3, background: '#eee' } }).png().toFile(file);
    const imageTask = await store.begin('image', 1); await store.item(imageTask, { kind: 'image', path: file });
    const wave = path.join(directory, 'old.wav'); await writeFile(wave, pcmTone());
    const speechTask = await store.begin('speech', 1); await store.item(speechTask, { kind: 'speech', path: wave });
    const tasks = (await store.overview()).tasks;
    const result = await store.prepareArtifact(imageTask, tasks.find((task) => task.id === imageTask)!.artifacts[0].id, createProject().scenes[0]);
    assert.ok(result.kind === 'image' && result.candidate.source === 'imported' && result.candidate.model === '');
    await assert.rejects(store.prepareArtifact(speechTask, tasks.find((task) => task.id === speechTask)!.artifacts[0].id, createProject().scenes[0]), /缺少生成原稿/);
  });
});
test('预览后文件被替换或删除，采用前重查拒绝，错误任务／产物编号不放行', async () => {
  await fixture(async (directory, store) => {
    const image = path.join(directory, 'image.png'); await sharp({ create: { width: 8, height: 8, channels: 3, background: '#eee' } }).png().toFile(image);
    const task = await store.begin('image', 1); await store.item(task, { kind: 'image', path: image }); const artifact = (await store.overview()).tasks[0].artifacts[0]; const scene = createProject().scenes[0];
    await store.prepareArtifact(task, artifact.id, scene);
    const bytes = await readFile(image); bytes[bytes.length - 1] ^= 1; await writeFile(image, bytes);
    await assert.rejects(store.prepareArtifact(task, artifact.id, scene), /内容已改变/);
    await rm(image); await assert.rejects(store.prepareArtifact(task, artifact.id, scene), /缺失/);
    await assert.rejects(store.prepareArtifact(task, randomUUID(), scene), /找不到/);
    await assert.rejects(store.prepareArtifact('../escape', artifact.id, scene));
  });
});
test('配音时长与路径元数据不符拒绝，文本／MP4／SRT 不作为分镜素材采用', async () => {
  await fixture(async (directory, store) => {
    const file = path.join(directory, 'tone.wav'); await writeFile(file, pcmTone()); const scene = createProject().scenes[0];
    const task = await store.begin('speech', 1); await store.item(task, { kind: 'speech', path: file, speech: { id: randomUUID(), path: file, text: scene.text, model: 'm', voice: 'v', speed: 1, duration: 2, createdAt: new Date().toISOString() } });
    const artifact = (await store.overview()).tasks[0].artifacts[0]; await assert.rejects(store.prepareArtifact(task, artifact.id, scene), /时长与记录/);
    const textTask = await store.begin('rewrite', 1); await store.textResult(textTask, { kind: 'rewrite', text: 'hello' }); const text = (await store.overview()).tasks.find((value) => value.id === textTask)!.artifacts[0];
    await assert.rejects(store.prepareArtifact(textTask, text.id, scene), /不支持关联/);
  });
});
