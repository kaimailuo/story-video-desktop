import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captionSvg, exportVideo, ExportCancelled, resolveFfmpeg } from './exporter';
import { createDemo } from './demo';
import { projectSchema, splitScript } from '../shared/project';

const exec = promisify(execFile);

async function withDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'yingxu-test-'));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('分镜规则：保留中文句子、限制长度与总数', () => {
  const scenes = splitScript('你好。\n这是第二幕！最后一个镜头');
  assert.equal(scenes.length, 3);
  assert.equal(scenes[0].text, '你好。');
  assert.equal(splitScript('长'.repeat(121)).length, 3);
  assert.deepEqual(splitScript(' \n '), []);
  assert.throws(() => splitScript('镜头。'.repeat(101)), /100/);
});

test('项目校验拒绝非法时长、超长字幕和未知版本', async () => {
  await withDirectory(async (directory) => {
    const project = await createDemo(directory);
    assert.equal(projectSchema.safeParse(project).success, true);
    assert.equal(projectSchema.safeParse({ ...project, version: 2 }).success, false);
    assert.equal(projectSchema.safeParse({ ...project, scenes: [{ ...project.scenes[0], duration: 0 }] }).success, false);
    assert.equal(projectSchema.safeParse({ ...project, scenes: [{ ...project.scenes[0], text: '字'.repeat(181) }] }).success, false);
  });
});

test('字幕转义 XML，避免把文案当作 SVG 执行', () => {
  const svg = captionSvg('<script>&"你好', 720, 1280);
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;&amp;&quot;你好'));
});

test('导出竖屏 MP4：中文字幕、推进、淡入淡出、配音和循环音乐', { timeout: 120000 }, async () => {
  await withDirectory(async (directory) => {
    const project = await createDemo(path.join(directory, '素材 含空格'));
    project.scenes = project.scenes.slice(0, 2).map((scene) => ({ ...scene, duration: 1 }));
    project.narrationPath = project.bgmPath;
    const outputPath = path.join(directory, '成片 含空格.mp4');
    const progress: number[] = [];
    await exportVideo({ project, outputPath, signal: new AbortController().signal, size: { width: 320, height: 568 }, onProgress: (percent) => progress.push(percent) });
    const { stdout } = await exec('/usr/local/bin/ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath]);
    const probe = JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string }[]; format: { duration: string } };
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
    assert.equal(video?.codec_name, 'h264');
    assert.equal(video?.width, 320); assert.equal(video?.height, 568);
    assert.equal(video?.pix_fmt, 'yuv420p'); assert.equal(audio?.codec_name, 'aac');
    assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.15);
    assert.equal(progress.at(-1), 100);
    assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.yingxu-export-')));
  });
});

test('导出横屏静态画面：无字幕、无输入音频时补 AAC 静音轨', { timeout: 120000 }, async () => {
  await withDirectory(async (directory) => {
    const project = await createDemo(path.join(directory, 'assets'));
    project.scenes = [{ ...project.scenes[0], duration: 1, motion: 'still' }];
    project.aspect = 'landscape'; project.captions = false; project.transition = 'cut';
    project.bgmPath = null;
    const outputPath = path.join(directory, 'landscape.mp4');
    await exportVideo({ project, outputPath, signal: new AbortController().signal, size: { width: 568, height: 320 }, onProgress: () => {} });
    const { stdout } = await exec('/usr/local/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', outputPath]);
    const probe = JSON.parse(stdout) as { streams: { codec_name: string; width?: number; height?: number }[] };
    assert.equal(probe.streams[0].width, 568);
    assert.ok(probe.streams.some((stream) => stream.codec_name === 'aac'));
  });
});

test('取消导出终止任务、清理临时文件，不覆盖已有成片', { timeout: 30000 }, async () => {
  await withDirectory(async (directory) => {
    const project = await createDemo(path.join(directory, 'assets'));
    project.scenes = [{ ...project.scenes[0], duration: 60 }];
    const outputPath = path.join(directory, 'existing.mp4');
    await writeFile(outputPath, '原有文件');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(exportVideo({
        project, outputPath, signal: controller.signal, size: { width: 320, height: 568 },
        onProgress: (percent) => { if (percent === 0) timer = setTimeout(() => controller.abort(), 300); },
      }), ExportCancelled);
    } finally { if (timer) clearTimeout(timer); }
    assert.equal(await readFile(outputPath, 'utf8'), '原有文件');
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.yingxu-export-')));
  });
});

test('缺失素材在渲染前报错，原输出保持不变', async () => {
  await withDirectory(async (directory) => {
    const project = await createDemo(path.join(directory, 'assets'));
    project.scenes[0].imagePath = path.join(directory, 'missing.png');
    const outputPath = path.join(directory, 'existing.mp4');
    await writeFile(outputPath, '已有视频');
    await assert.rejects(exportVideo({ project, outputPath, signal: new AbortController().signal, onProgress: () => {} }), /素材不存在/);
    assert.equal(await readFile(outputPath, 'utf8'), '已有视频');
  });
});

test('随包 FFmpeg 可执行，且包含 H.264 编码器', async () => {
  const binary = await resolveFfmpeg();
  const { stdout } = await exec(binary, ['-hide_banner', '-encoders']);
  assert.match(stdout, /libx264/);
});

test('FFmpeg 启动失败时清理中间文件，保留已有输出', async () => {
  await withDirectory(async (directory) => {
    const project = await createDemo(path.join(directory, 'assets'));
    project.scenes = [{ ...project.scenes[0], duration: 1 }];
    const outputPath = path.join(directory, 'existing.mp4');
    await writeFile(outputPath, '不能覆盖');
    await assert.rejects(exportVideo({
      project, outputPath, signal: new AbortController().signal, onProgress: () => {},
      ffmpegPath: path.join(directory, 'not-installed'), size: { width: 320, height: 568 },
    }), /无法启动 FFmpeg/);
    assert.equal(await readFile(outputPath, 'utf8'), '不能覆盖');
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.yingxu-export-')));
  });
});
