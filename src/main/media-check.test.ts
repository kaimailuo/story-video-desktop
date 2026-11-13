import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createProject, type Project } from '../shared/project';
import { assertMediaReport, checkProjectMedia, decodeLocalAudio } from './media-check';
import { exportVideo, resolveFfmpeg } from './exporter';
import { pcmTone } from '../../scripts/helpers/mock-speech';

const exec = promisify(execFile);
async function fixture(action: (directory: string, project: Project) => Promise<void>) {
  const base = path.resolve('artifacts'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'media-unit-'));
  try {
    const project = createProject(); project.captions = false;
    const image = path.join(directory, '图片 含空格.png');
    await sharp({ create: { width: 32, height: 48, channels: 3, background: '#9875bf' } }).png().toFile(image);
    project.scenes[0].imagePath = image;
    await action(directory, project);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function speech(project: Project, file: string, duration = 1.101) {
  project.scenes[0].speech = { id: randomUUID(), path: file, text: project.scenes[0].text.trim(), duration, voice: 'local', speed: 1, model: 'mock', createdAt: new Date().toISOString() };
}

test('有效图片／全片音频只读检查，重复路径可用，无引用音轨不要求存在', async () => {
  await fixture(async (directory, project) => {
    const file = path.join(directory, '配音 音乐.wav'); await writeFile(file, pcmTone());
    project.narrationPath = file; project.bgmPath = file;
    project.scenes.push({ ...project.scenes[0], id: randomUUID() });
    const before = JSON.stringify(project); const files = await readdir(directory); const bytes = await readFile(file);
    const report = await checkProjectMedia(project);
    assert.equal(report.canExport, true); assert.equal(report.items.filter((item) => item.status === 'ok').length, 4);
    assert.equal(JSON.stringify(project), before); assert.deepEqual(await readFile(file), bytes); assert.deepEqual(await readdir(directory), files);
    project.narrationPath = null; project.bgmPath = null;
    assert.equal((await checkProjectMedia(project)).canExport, true);
  });
});

test('一次列出缺图、损坏图片、错误扩展名、目录与缺失音轨，不因首错停止', async () => {
  await fixture(async (directory, project) => {
    const bad = path.join(directory, 'bad.png'); await writeFile(bad, 'not png');
    project.scenes = [null, bad, path.join(directory, 'none.png'), directory, 'relative.png', path.join(directory, 'bad.svg')].map((imagePath) => ({ ...project.scenes[0], id: randomUUID(), imagePath }));
    project.narrationPath = path.join(directory, 'none.wav'); project.bgmPath = path.join(directory, 'bad.wav'); await writeFile(project.bgmPath, 'not audio');
    const report = await checkProjectMedia(project);
    assert.equal(report.canExport, false); assert.equal(report.items.filter((item) => item.status === 'error').length, 8);
    assert.throws(() => assertMediaReport(report), /分镜 1.*尚未导入图片/);
    assert.ok(report.items.some((item) => item.sceneIndex === 1 && item.messages.join().includes('图片损坏')));
  });
});

test('按镜 WAV：文字过期、时长改变、短镜头、损坏／缺失及帧量化保护', async () => {
  await fixture(async (directory, original) => {
    const file = path.join(directory, 'speech.wav'); await writeFile(file, pcmTone());
    original.narrationMode = 'scenes'; speech(original, file);
    for (const [mode, expected] of [['stale', '文字已过期'], ['duration', '时长已改变'], ['short', '短于实际配音'], ['corrupt', '配音缺失'], ['missing', '配音缺失']] as const) {
      const project = structuredClone(original); const scene = project.scenes[0];
      if (mode === 'stale') scene.text = 'changed';
      if (mode === 'duration') scene.speech!.duration = 1;
      if (mode === 'short') scene.duration = 1;
      if (mode === 'missing') scene.speech!.path = path.join(directory, 'missing.wav');
      if (mode === 'corrupt') { scene.speech!.path = path.join(directory, 'bad.wav'); await writeFile(scene.speech!.path, 'bad'); }
      const report = await checkProjectMedia(project);
      assert.equal(report.canExport, false); assert.match(report.items.find((item) => item.kind === 'speech')!.messages.join(), new RegExp(expected));
    }
    original.scenes[0].duration = 1.101;
    assert.equal((await checkProjectMedia(original)).canExport, false, '按 30 FPS 渲染后的短镜头也拒绝');
    original.scenes[0].duration = 34 / 30;
    assert.equal((await checkProjectMedia(original)).canExport, true);
  });
});

test('模式互斥：闲置损坏配音仅警告，按镜缺音仍静音，BGM 即使零音量仍校验', async () => {
  await fixture(async (directory, project) => {
    speech(project, path.join(directory, 'missing.wav'));
    let report = await checkProjectMedia(project);
    assert.equal(report.canExport, true); assert.equal(report.items.find((item) => item.kind === 'speech')!.status, 'warning');
    project.narrationMode = 'scenes'; project.scenes[0].speech = null; project.narrationPath = path.join(directory, 'missing.wav');
    report = await checkProjectMedia(project);
    assert.equal(report.canExport, true); assert.equal(report.items.find((item) => item.kind === 'narration')!.status, 'warning');
    assert.match(report.items.find((item) => item.kind === 'speech')!.messages.join(), /静音/);
    project.bgmPath = project.narrationPath; project.bgmVolume = 0;
    assert.equal((await checkProjectMedia(project)).canExport, false);
  });
});

test('重新检查读取磁盘而不复用旧通过结果，检查不触碰历史版本或候选', async () => {
  await fixture(async (directory, project) => {
    project.scenes[0].imageVersions = [{ id: randomUUID(), path: path.join(directory, 'old-missing.png'), source: 'imported', prompt: '', model: '', createdAt: new Date().toISOString() }];
    assert.equal((await checkProjectMedia(project)).canExport, true);
    await writeFile(project.scenes[0].imagePath!, 'replaced');
    assert.equal((await checkProjectMedia(project)).canExport, false);
    await writeFile(project.scenes[0].imagePath!, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="48"><rect width="32" height="48"/></svg>');
    assert.equal((await checkProjectMedia(project)).canExport, false, '不接受伪装扩展名的 SVG');
  });
});

test('启用烧录时聚合字幕错误，关闭烧录仍允许无效字幕草稿', async () => {
  await fixture(async (_directory, project) => {
    project.scenes[0].subtitleTimeline = { sourceText: project.scenes[0].text, sourceSpeechId: null, sourceMode: 'global', timing: 'manual', cues: [{ id: randomUUID(), text: '', start: 1, end: 0 }] };
    project.captions = true; assert.equal((await checkProjectMedia(project)).canExport, false);
    project.captions = false; assert.equal((await checkProjectMedia(project)).canExport, true);
  });
});

test('普通音频真实解码覆盖支持的六种扩展名，空音轨／伪装播放列表拒绝', { timeout: 60000 }, async () => {
  await fixture(async (directory, project) => {
    const binary = await resolveFfmpeg(); const source = path.join(directory, 'tone.wav'); await writeFile(source, pcmTone(0.2));
    for (const extension of ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg']) {
      const file = path.join(directory, `audio.${extension}`);
      await exec(binary, ['-nostdin', '-v', 'error', '-y', '-i', source, '-threads', '1', file]);
      project.bgmPath = file;
      assert.equal((await checkProjectMedia(project)).canExport, true, extension);
    }
    const empty = pcmTone(0); const file = path.join(directory, 'empty.wav'); await writeFile(file, empty);
    await assert.rejects(decodeLocalAudio(file, binary), /损坏|为空/);
    await writeFile(file, '#EXTM3U\nhttp://127.0.0.1:9/do-not-fetch\n');
    await assert.rejects(decodeLocalAudio(file, binary), /损坏/);
  });
});

test('不可读文件、检查器启动失败及超时不能视作通过；取消不吞掉中断', async () => {
  await fixture(async (directory, project) => {
    const file = path.join(directory, 'tone.wav'); await writeFile(file, pcmTone()); project.bgmPath = file;
    if (process.getuid?.() !== 0) {
      await chmod(file, 0o000);
      try { assert.equal((await checkProjectMedia(project)).canExport, false); } finally { await chmod(file, 0o600); }
    }
    assert.equal((await checkProjectMedia(project, { ffmpegPath: path.join(directory, 'missing') })).canExport, false);
    const fake = path.join(directory, 'hanging-checker');
    await writeFile(fake, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const report = await checkProjectMedia(project, { ffmpegPath: fake, audioTimeoutMs: 50 });
    assert.equal(report.canExport, false); assert.match(report.items.find((item) => item.kind === 'bgm')!.messages.join(), /超时/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(checkProjectMedia(project, { signal: controller.signal }), /abort/i);
    const running = new AbortController(); const pending = decodeLocalAudio(file, fake, running.signal);
    running.abort(); await assert.rejects(pending, /abort/i);
  });
});

test('直接调用渲染也在创建临时目录前拦截坏图／坏音频，不覆盖成片', async () => {
  await fixture(async (directory, project) => {
    const outputPath = path.join(directory, 'existing.mp4'); await writeFile(outputPath, 'keep');
    const bad = path.join(directory, 'bad.wav'); await writeFile(bad, 'bad'); project.bgmPath = bad;
    let progress = 0;
    await assert.rejects(exportVideo({ project, outputPath, signal: new AbortController().signal, onProgress: () => { progress++; } }), /素材检查未通过/);
    assert.equal(progress, 0); assert.equal(await readFile(outputPath, 'utf8'), 'keep');
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.yingxu-export-')));
  });
});
