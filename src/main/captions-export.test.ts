import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createProject, type Project } from '../shared/project';
import { compileProjectCaptions, estimateSubtitleTimeline, projectSrt } from '../shared/captions';
import { exportVideo, ExportCancelled, resolveFfmpeg } from './exporter';
import { exportSubtitles } from './subtitles';

const exec = promisify(execFile);
async function fixture(action: (directory: string, project: Project) => Promise<void>) {
  const directory = await mkdtemp(path.resolve('artifacts/captions-export-'));
  try {
    const image = path.join(directory, '黑色 图片.png');
    await sharp({ create: { width: 320, height: 180, channels: 3, background: '#000000' } }).png().toFile(image);
    const project = createProject(); project.transition = 'cut'; project.captions = true;
    project.scenes = [0, 1].map((index) => ({ id: randomUUID(), text: `第${index}镜`, prompt: '', description: '', imagePath: image, duration: 1.01, motion: 'still', subtitleTimeline: { sourceText: `第${index}镜`, sourceSpeechId: null, sourceMode: 'global', timing: 'manual', cues: (index === 0 ? [[0.2, 0.4], [0.6, 0.8], [0.8, 1]] : [[0, 0.2]]).map(([start, end], n) => ({ id: randomUUID(), text: `字幕${n}`, start, end })) } }));
    await action(directory, project);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function captionFrames(file: string): Promise<boolean[]> {
  const { stdout } = await exec(await resolveFfmpeg(), ['-v', 'error', '-i', file, '-an', '-vf', 'crop=320:80:0:100,format=gray', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 20_000_000 });
  const bytes = 320 * 80; const result: boolean[] = [];
  for (let start = 0; start < stdout.length; start += bytes) {
    let bright = 0; for (let i = start; i < start + bytes; i++) if (stdout[i] > 100) bright++;
    result.push(bright > 10);
  }
  return result;
}
const render = (project: Project, outputPath: string, onProgress: (percent: number) => void = () => undefined, signal = new AbortController().signal) => exportVideo({ project, outputPath, size: { width: 320, height: 180 }, signal, onProgress });

test('真实逐帧 MP4：出现／消失、间隙、相邻边界、跨镜偏移和 SRT 一致', { timeout: 120000 }, async () => {
  await fixture(async (directory, project) => {
    const output = path.join(directory, '时间轴.mp4'); await render(project, output);
    const frames = await captionFrames(output);
    const cues = compileProjectCaptions(project);
    assert.equal(frames.length, 60);
    frames.forEach((visible, frame) => assert.equal(visible, cues.some((cue) => cue.startFrame <= frame && frame < cue.endFrame), `全片第 ${frame} 帧`));
    const srtPath = path.join(directory, '独立.srt'); await exportSubtitles(project, srtPath);
    assert.equal(await readFile(srtPath, 'utf8'), projectSrt(project));
    assert.match(await readFile(srtPath, 'utf8'), /00:00:01,000 --> 00:00:01,200/);
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.yingxu-export-') || name.endsWith('.tmp')));
  });
});

test('关闭烧录忽略无效草稿，SRT 仍拒绝且不覆盖；旧整镜与空时间轴输出', { timeout: 120000 }, async () => {
  await fixture(async (directory, project) => {
    const srt = path.join(directory, '已有.srt'); await writeFile(srt, '原字幕');
    project.scenes[0].subtitleTimeline!.cues[0].end = 10;
    await assert.rejects(exportSubtitles(project, srt), /越界/);
    assert.equal(await readFile(srt, 'utf8'), '原字幕');
    const video = path.join(directory, '无字幕.mp4'); project.captions = false;
    await render(project, video);
    assert.ok((await captionFrames(video)).every((value) => !value));
    project.captions = true; delete project.scenes[0].subtitleTimeline; project.scenes[1].subtitleTimeline!.cues = [];
    await render(project, video);
    assert.deepEqual(await captionFrames(video), [...Array<boolean>(30).fill(true), ...Array<boolean>(30).fill(false)]);
  });
});

test('无效时间轴／FFmpeg 失败／取消不覆盖输出且清理临时文件，SRT 不要求媒体存在', { timeout: 30000 }, async () => {
  await fixture(async (directory, project) => {
    const video = path.join(directory, '已有.mp4'); await writeFile(video, '原视频');
    const bad = structuredClone(project); bad.scenes[0].subtitleTimeline!.cues[1].start = 0.3;
    await assert.rejects(render(bad, video), /重叠/);
    await assert.rejects(exportVideo({ project, outputPath: video, signal: new AbortController().signal, onProgress() {}, size: { width: 320, height: 180 }, ffmpegPath: '/not-a-binary' }), /无法启动/);
    const controller = new AbortController();
    await assert.rejects(render(project, video, (percent) => { if (percent >= 40) controller.abort(); }, controller.signal), ExportCancelled);
    assert.equal(await readFile(video, 'utf8'), '原视频');
    project.scenes.forEach((scene) => { scene.imagePath = '/missing.png'; });
    const srt = path.join(directory, '无素材.srt'); await exportSubtitles(project, srt);
    await assert.rejects(exportSubtitles(project, path.join(directory, 'wrong.txt')), /SRT 文件/);
    await assert.rejects(exportSubtitles(project, path.join(directory, 'missing', 'file.srt')));
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.yingxu-export-') || name.endsWith('.tmp')));
  });
});

test('20 条字幕单镜真实合成，单帧输入不会提前结束；重排后偏移同步', { timeout: 120000 }, async () => {
  await fixture(async (directory, project) => {
    project.scenes[0].text = '句。'.repeat(30);
    project.scenes[0].subtitleTimeline = estimateSubtitleTimeline(project.scenes[0]);
    assert.equal(project.scenes[0].subtitleTimeline.cues.length, 20);
    project.scenes.reverse();
    const output = path.join(directory, '20条.mp4'); await render(project, output);
    const frames = await captionFrames(output);
    assert.equal(frames.length, 60);
    const cues = compileProjectCaptions(project);
    frames.forEach((visible, frame) => assert.equal(visible, cues.some((cue) => cue.startFrame <= frame && frame < cue.endFrame), `20 条第 ${frame} 帧`));
  });
});
