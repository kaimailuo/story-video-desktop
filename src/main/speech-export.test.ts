import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exportVideo, ExportCancelled, resolveFfmpeg } from './exporter';
import { createDemo } from './demo';
import { adoptSceneSpeech, type Project } from '../shared/project';
import { pcmTone } from '../../scripts/helpers/mock-speech';
import { assertSpeechTimeline, audioWindow, decodeAudio } from '../../scripts/helpers/check-speech-audio';

async function fixture(action: (directory: string, project: Project) => Promise<void>) {
  const directory = await mkdtemp(path.resolve('artifacts/speech-export-'));
  try {
    const project = await createDemo(path.join(directory, '素材 含空格'));
    project.narrationMode = 'scenes'; project.bgmPath = null; project.captions = false; project.transition = 'cut';
    project.scenes = project.scenes.map((scene, index) => ({ ...scene, text: index === 0 ? 'first' : index === 1 ? 'missing' : 'last', duration: 1, motion: 'still' }));
    for (const index of [0, 2]) {
      const duration = index === 0 ? 1.101 : 0.6;
      const file = path.join(directory, `配音 ${index}.wav`);
      await writeFile(file, pcmTone(duration, index === 0 ? 440 : 880, index === 0 ? 24000 : 48000, index === 0 ? 1 : 2));
      project.scenes[index] = adoptSceneSpeech(project.scenes[index], { id: randomUUID(), path: file, text: project.scenes[index].text, duration, voice: 'v', speed: 1, model: 'm', createdAt: new Date().toISOString() });
    }
    await action(directory, project);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('按镜真实导出：采样率／声道归一化，顺序、缺音静音及尾部补齐，不混入全片音频', { timeout: 120000 }, async () => {
  await fixture(async (directory, project) => {
    project.narrationPath = path.join(directory, '不存在的全片配音.wav');
    project.scenes[0].duration = 1.5;
    const outputPath = path.join(directory, 'speech.mp4');
    await exportVideo({ project, outputPath, signal: new AbortController().signal, size: { width: 160, height: 284 }, onProgress() {} });
    const audio = await decodeAudio(await resolveFfmpeg(), outputPath);
    assertSpeechTimeline(audio, 1.5, 1);
    assert.ok(audioWindow(audio, 1.25, 1.4).rms < 0.001, '首镜多余时长应补静音');
    assert.ok(Math.abs(audio.length / 16000 - 3.5) < 0.05);
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.yingxu-export-')));
  });
});

test('导出防截断／过期／替换／损坏／缺失检查，失败不覆盖成片', async () => {
  await fixture(async (directory, original) => {
    const outputPath = path.join(directory, 'existing.mp4'); await writeFile(outputPath, '已有视频');
    for (const mode of ['short', 'stale', 'duration', 'missing', 'corrupt']) {
      const project = structuredClone(original); const scene = project.scenes[0];
      if (mode === 'short') scene.duration = 1;
      if (mode === 'stale') scene.text = '改了';
      if (mode === 'duration') scene.speech!.duration = 1;
      if (mode === 'missing') scene.speech!.path = path.join(directory, 'missing.wav');
      if (mode === 'corrupt') { scene.speech!.path = path.join(directory, 'bad.wav'); await writeFile(scene.speech!.path, 'not wav'); }
      await assert.rejects(exportVideo({ project, outputPath, signal: new AbortController().signal, onProgress() {} }), mode === 'short' ? /短于实际配音/ : mode === 'stale' ? /文字已过期/ : mode === 'duration' ? /时长已改变/ : /配音缺失/);
      assert.equal(await readFile(outputPath, 'utf8'), '已有视频');
    }
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.yingxu-export-')));
  });
});

test('全片模式忽略按镜引用及过期；按镜模式混入 BGM 并保持缺配音镜头时间轴', { timeout: 120000 }, async () => {
  await fixture(async (directory, project) => {
    const binary = await resolveFfmpeg();
    const global = path.join(directory, 'global.wav'); await writeFile(global, pcmTone(1, 220));
    project.narrationPath = global; project.narrationMode = 'global';
    project.scenes[0].text = '改变文字'; project.scenes[0].speech!.path = path.join(directory, 'missing.wav');
    const globalOutput = path.join(directory, 'global.mp4');
    await exportVideo({ project, outputPath: globalOutput, signal: new AbortController().signal, size: { width: 160, height: 284 }, onProgress() {} });
    const globalAudio = await decodeAudio(binary, globalOutput);
    assert.ok(audioWindow(globalAudio, 0.2, 0.5, 220).amplitude > 0.1);
    assert.ok(audioWindow(globalAudio, 0.2, 0.5, 440).amplitude < 0.005);
    project.narrationMode = 'scenes'; project.scenes[0].speech = null; project.scenes[2].speech = null;
    project.bgmPath = global; project.bgmVolume = 0.2;
    const bgmOutput = path.join(directory, 'bgm.mp4');
    await exportVideo({ project, outputPath: bgmOutput, signal: new AbortController().signal, size: { width: 160, height: 284 }, onProgress() {} });
    const bgmAudio = await decodeAudio(binary, bgmOutput);
    const amplitude = audioWindow(bgmAudio, 1.4, 1.7, 220).amplitude;
    assert.ok(amplitude > 0.02 && amplitude < 0.07, '仅 BGM 按配置音量循环，全片配音不能叠加');
  });
});

test('按镜导出取消清理临时音频，不覆盖已有输出', { timeout: 30000 }, async () => {
  await fixture(async (directory, project) => {
    const controller = new AbortController();
    const outputPath = path.join(directory, 'cancel.mp4'); await writeFile(outputPath, '保留');
    await assert.rejects(exportVideo({ project, outputPath, signal: controller.signal, size: { width: 160, height: 284 }, onProgress(percent) { if (percent >= 85) controller.abort(); } }), ExportCancelled);
    assert.equal(await readFile(outputPath, 'utf8'), '保留');
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.yingxu-export-')));
  });
});
