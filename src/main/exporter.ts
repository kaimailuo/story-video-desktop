import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { projectSchema, type Project } from '../shared/project';
import { resolveFfmpeg } from './media-files';
import { sceneWave } from './audio/scene-wave';
import { assertMediaReport, checkProjectMedia } from './media-check';
export { assertMedia, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, resolveFfmpeg } from './media-files';
import { compileSceneCaptions, compileProjectCaptions } from '../shared/captions';

export interface RenderOptions {
  project: Project;
  outputPath: string;
  signal: AbortSignal;
  onProgress: (percent: number, message: string) => void;
  ffmpegPath?: string;
  size?: { width: number; height: number };
}

export class ExportCancelled extends Error {
  constructor() { super('已取消导出'); this.name = 'ExportCancelled'; }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportCancelled();
}

function escapeXml(text: string): string {
  return Array.from(text).filter((char) => {
    const code = char.codePointAt(0)!;
    return code >= 32 || code === 9 || code === 10 || code === 13;
  }).join('').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] ?? char);
}

export function captionSvg(text: string, width: number, height: number): string {
  const fontSize = Math.round(width * (width < height ? 0.047 : 0.034));
  const limit = Math.floor(width * 0.84 / fontSize);
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const chars = Array.from(paragraph);
    if (!chars.length) lines.push('');
    for (let index = 0; index < chars.length; index += limit) lines.push(chars.slice(index, index + limit).join(''));
  }
  const lineHeight = Math.round(fontSize * 1.5);
  const baseline = height - Math.round(height * 0.09) - (lines.length - 1) * lineHeight;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <g font-family="PingFang SC,Heiti SC,Arial,sans-serif" font-size="${fontSize}" font-weight="600" text-anchor="middle" fill="white" stroke="#111827" stroke-width="${Math.max(2, fontSize * 0.09)}" paint-order="stroke fill" stroke-linejoin="round">
    ${lines.map((line, index) => `<text x="${width / 2}" y="${baseline + index * lineHeight}">${escapeXml(line)}</text>`).join('')}
    </g></svg>`;
}

async function runFfmpeg(binary: string, args: string[], options: {
  signal: AbortSignal;
  cwd: string;
  duration: number;
  progress: (fraction: number) => void;
}): Promise<void> {
  checkAbort(options.signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-progress', 'pipe:1', '-nostats', ...args], {
      cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1500);
      killTimer.unref();
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, 60 * 60 * 1000);
    timeout.unref();
    options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const value = Number(line.slice(12));
          if (Number.isFinite(value)) options.progress(Math.max(0, Math.min(1, value / 1_000_000 / options.duration)));
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener('abort', stop);
    };
    child.once('error', (error) => { cleanup(); reject(new Error(`无法启动 FFmpeg：${error.message}`)); });
    child.once('close', (code) => {
      cleanup();
      if (options.signal.aborted) reject(new ExportCancelled());
      else if (timedOut) reject(new Error('媒体处理超时，请减少分镜数量或降低分辨率。'));
      else if (code !== 0) reject(new Error(`FFmpeg 处理失败：\n${stderr || `退出码 ${code}`}`));
      else resolve();
    });
  });
}

export async function exportVideo(options: RenderOptions): Promise<string> {
  const parsed = projectSchema.parse(options.project);
  const project = { ...parsed, scenes: parsed.scenes.map((scene) => ({ ...scene, duration: Math.round(scene.duration * 30) / 30 })) };
  checkAbort(options.signal);
  if (project.captions) compileProjectCaptions(project);
  if (!path.isAbsolute(options.outputPath) || path.extname(options.outputPath).toLowerCase() !== '.mp4') {
    throw new Error('导出目标必须是本地 MP4 文件。');
  }
  try { assertMediaReport(await checkProjectMedia(project, { signal: options.signal, ffmpegPath: options.ffmpegPath })); }
  catch (error) { checkAbort(options.signal); throw error; }
  const binary = options.ffmpegPath ?? await resolveFfmpeg();
  const short = project.resolution === '1080p' ? 1080 : 720;
  const long = project.resolution === '1080p' ? 1920 : 1280;
  const { width, height } = options.size ?? (project.aspect === 'portrait' ? { width: short, height: long } : { width: long, height: short });
  if (![width, height].every((value) => Number.isInteger(value) && value >= 160 && value <= 1920 && value % 2 === 0)) {
    throw new Error('视频尺寸必须是 160–1920 范围内的偶数。');
  }
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  const work = await mkdtemp(path.join(path.dirname(options.outputPath), '.yingxu-export-'));
  const total = project.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  let completed = 0;
  let lastPercent = -1;
  const report = (percent: number, message: string) => {
    const next = Math.max(lastPercent, Math.min(100, Math.floor(percent)));
    if (next !== lastPercent) { lastPercent = next; options.onProgress(next, message); }
  };
  try {
    report(0, '准备素材');
    const segmentNames: string[] = [];
    for (const [index, scene] of project.scenes.entries()) {
      checkAbort(options.signal);
      const name = `scene-${String(index).padStart(3, '0')}.mp4`;
      segmentNames.push(name);
      const captions = project.captions ? compileSceneCaptions(scene, project.narrationMode) : [];
      const normalizedImage = path.join(work, `image-${index}.png`);
      await sharp(scene.imagePath!, { limitInputPixels: 80_000_000 }).rotate()
        .resize(width, height, { fit: 'cover' }).png().toFile(normalizedImage);
      checkAbort(options.signal);
      const input = ['-loop', '1', '-framerate', '30', '-i', normalizedImage];
      const overlays: { x: number; y: number }[] = [];
      for (const [cueIndex, cue] of captions.entries()) {
        checkAbort(options.signal);
        const captionPath = path.join(work, `caption-${index}-${cueIndex}.png`);
        // 静态单帧输入，不循环解码整幅透明画布；仅保留有字区域降低多条字幕内存。
        const { data, info } = await sharp(Buffer.from(captionSvg(cue.text, width, height))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let left = width; let right = -1; let top = height; let bottom = -1;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * info.channels + 3]) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
        }
        if (right < 0) throw new Error(`分镜 ${index + 1} 的第 ${cueIndex + 1} 条字幕无法绘制。`);
        await sharp(data, { raw: info }).extract({ left, top, width: right - left + 1, height: bottom - top + 1 }).png().toFile(captionPath);
        overlays.push({ x: left, y: top });
        input.push('-framerate', '30', '-i', captionPath);
      }
      const base = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
      const motion = scene.motion === 'zoom'
        ? `,zoompan=z='min(1+on*0.0004,1.08)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=30`
        : '';
      const fade = project.transition === 'fade'
        ? `,fade=t=in:st=0:d=0.2,fade=t=out:st=${Math.max(0, scene.duration - 0.2)}:d=0.2`
        : '';
      const filters = [`[0:v]${base}${motion}[picture0]`];
      captions.forEach((cue, cueIndex) => {
        const { x, y } = overlays[cueIndex];
        filters.push(`[picture${cueIndex}][${cueIndex + 1}:v]overlay=${x}:${y}:eof_action=repeat:repeatlast=1:enable='gte(n,${cue.startFrame})*lt(n,${cue.endFrame})'[picture${cueIndex + 1}]`);
      });
      filters.push(`[picture${captions.length}]null${fade},format=yuv420p[v]`);
      await runFfmpeg(binary, [
        ...input, '-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', '[v]', '-an', '-t', String(scene.duration),
        '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-threads', '2', name,
      ], {
        signal: options.signal, cwd: work, duration: scene.duration,
        progress: (fraction) => report((completed + fraction * scene.duration) / total * 85, `渲染分镜 ${index + 1}/${project.scenes.length}`),
      });
      completed += scene.duration;
      report(completed / total * 85, `完成分镜 ${index + 1}/${project.scenes.length}`);
    }
    await writeFile(path.join(work, 'segments.txt'), segmentNames.map((name) => `file '${name}'`).join('\n'));
    let narrationPath = project.narrationPath;
    if (project.narrationMode === 'scenes') {
      const audioNames: string[] = [];
      for (const [index, scene] of project.scenes.entries()) {
        checkAbort(options.signal);
        // 再次读取并校验，之后只使用本任务快照，不让外部文件在合成期间被换入。
        const wave = await sceneWave(scene, index);
        const input: string[] = [];
        if (wave) {
          const source = path.join(work, `speech-source-${index}.wav`);
          await writeFile(source, wave.buffer, { flag: 'wx', mode: 0o600 });
          input.push('-i', source);
        } else input.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
        const name = `speech-${index}.wav`;
        audioNames.push(name);
        await runFfmpeg(binary, [
          ...input, '-af', `aresample=48000,apad,atrim=end_sample=${Math.round(scene.duration * 48000)},asetpts=N/SR/TB`,
          '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', name,
        ], { signal: options.signal, cwd: work, duration: scene.duration, progress: () => undefined });
      }
      await writeFile(path.join(work, 'speech.txt'), audioNames.map((name) => `file '${name}'`).join('\n'));
      await runFfmpeg(binary, ['-f', 'concat', '-safe', '1', '-i', 'speech.txt', '-c:a', 'copy', 'narration.wav'], {
        signal: options.signal, cwd: work, duration: total, progress: () => undefined,
      });
      narrationPath = path.join(work, 'narration.wav');
    }
    const inputs = ['-f', 'concat', '-safe', '1', '-i', 'segments.txt'];
    const audioFilters: string[] = [];
    const tracks: string[] = [];
    let inputIndex = 1;
    if (narrationPath) {
      inputs.push('-i', narrationPath);
      audioFilters.push(`[${inputIndex++}:a]aresample=48000,apad[narration]`);
      tracks.push('[narration]');
    }
    if (project.bgmPath) {
      inputs.push('-stream_loop', '-1', '-i', project.bgmPath);
      audioFilters.push(`[${inputIndex++}:a]aresample=48000,volume=${project.bgmVolume},apad[bgm]`);
      tracks.push('[bgm]');
    }
    if (!tracks.length) {
      inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
      audioFilters.push(`[${inputIndex}:a]anull[audio]`);
    } else if (tracks.length === 1) audioFilters.push(`${tracks[0]}anull[audio]`);
    else audioFilters.push(`${tracks.join('')}amix=inputs=${tracks.length}:duration=longest:normalize=0,alimiter=limit=0.95:level=0[audio]`);
    report(86, '合成音轨与 MP4');
    await runFfmpeg(binary, [
      ...inputs, '-filter_complex', audioFilters.join(';'), '-map', '0:v:0', '-map', '[audio]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', String(total),
      '-movflags', '+faststart', 'final.mp4',
    ], {
      signal: options.signal, cwd: work, duration: total,
      progress: (fraction) => report(86 + fraction * 13, '合成音轨与 MP4'),
    });
    checkAbort(options.signal);
    await rename(path.join(work, 'final.mp4'), options.outputPath);
    report(100, 'MP4 导出完成');
    return options.outputPath;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
