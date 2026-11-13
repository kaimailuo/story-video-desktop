import { spawn } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';
import { projectSchema, type Project } from '../shared/project';
import { compileSceneCaptions } from '../shared/captions';
import { mediaCheckErrors, type MediaCheckItem, type MediaCheckReport } from '../shared/media-check';
import { assertMedia, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, resolveFfmpeg } from './media-files';
import { sceneWave } from './audio/scene-wave';

/** 完整解码到空输出；强制本地音频 demuxer，不接受伪装成音频的播放列表／远程资源。 */
export async function decodeLocalAudio(filePath: string, binary: string, signal?: AbortSignal, timeoutMs = 30000): Promise<void> {
  const formats: Record<string, string> = { '.mp3': 'mp3', '.wav': 'wav', '.m4a': 'mov', '.aac': 'aac', '.flac': 'flac', '.ogg': 'ogg' };
  const format = formats[path.extname(filePath).toLowerCase()];
  if (!path.isAbsolute(filePath) || !format) throw new Error('不支持的本地音频路径。');
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-max_alloc', '268435456', '-progress', 'pipe:1', '-nostats', '-protocol_whitelist', 'file,pipe', '-f', format, '-err_detect', 'explode', '-threads', '1', '-i', filePath, '-map', '0:a:0', '-vn', '-sn', '-dn', '-threads', '1', '-f', 'null', '-'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let progress = ''; let decoded = false;
    child.stdout.on('data', (chunk: Buffer) => {
      progress += chunk.toString();
      const lines = progress.split('\n'); progress = lines.pop()!.slice(-1024);
      if (lines.some((line) => line.startsWith('out_time_us=') && Number(line.slice(12)) > 0)) decoded = true;
    });
    let timedOut = false;
    const stop = () => { child.kill('SIGKILL'); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timer.unref(); signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.once('error', () => { cleanup(); reject(new Error('无法启动 FFmpeg 音频检查，请检查安装。')); });
    child.once('close', (code) => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else if (timedOut) reject(new Error('音频检查超时，未确认可用；请缩短音频或转换后重新导入。'));
      else if (code !== 0 || !decoded) reject(new Error('音频损坏、为空、无音轨或不是支持的格式，请转换后重新导入。'));
      else resolve();
    });
  });
}

export async function checkProjectMedia(raw: Project, options: { signal?: AbortSignal; ffmpegPath?: string; audioTimeoutMs?: number } = {}): Promise<MediaCheckReport> {
  const project = projectSchema.parse(raw);
  const items: MediaCheckItem[] = [];
  // 单次扫描串行、同路径去重，不缓存跨扫描文件；总预算两分钟，超时项明确失败。
  const deadline = Date.now() + 120000;
  const cache = new Map<string, Promise<void>>();
  let binary: Promise<string> | undefined;
  async function inspect(item: MediaCheckItem, check: () => Promise<void>) {
    options.signal?.throwIfAborted();
    try {
      if (Date.now() > deadline) throw new Error('本次素材检查超过两分钟，未确认此项；请减少素材后重新检查。');
      await check(); item.status = 'ok';
    } catch (error) {
      options.signal?.throwIfAborted();
      item.status = item.active ? 'error' : 'warning';
      item.messages.push(error instanceof Error ? error.message : '素材检查未完成，请重新检查。');
    }
    items.push(item);
  }
  function cached(kind: string, file: string, check: () => Promise<void>) {
    const key = `${kind}:${file}`;
    let result = cache.get(key);
    if (!result) { result = check(); cache.set(key, result); }
    return result;
  }
  for (const [index, scene] of project.scenes.entries()) {
    await inspect({ kind: 'image', sceneId: scene.id, sceneIndex: index, path: scene.imagePath, active: true, status: 'ok', messages: [] }, async () => {
      if (!scene.imagePath) throw new Error(`分镜 ${index + 1} 尚未导入图片。`);
      await cached('image', scene.imagePath, async () => {
        await assertMedia(scene.imagePath!, IMAGE_EXTENSIONS);
        try {
          const image = sharp(scene.imagePath!, { limitInputPixels: 80_000_000 });
          const metadata = await image.metadata();
          if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('不是静态图片');
          await image.timeout({ seconds: 10 }).rotate().resize(1, 1).raw().toBuffer();
        }
        catch { throw new Error('图片损坏、解码超时或超过 8000 万像素，请重新导入。'); }
      });
    });
    const active = project.narrationMode === 'scenes';
    const speech: MediaCheckItem = { kind: 'speech', sceneId: scene.id, sceneIndex: index, path: scene.speech?.path ?? null, active, status: 'skipped', messages: [] };
    if (scene.speech) await inspect(speech, async () => { await sceneWave(scene, index); });
    else { speech.status = active ? 'warning' : 'skipped'; speech.messages.push(active ? '未采用按镜配音，本镜将静音。' : '未启用按镜配音。'); items.push(speech); }
    if (project.captions) await inspect({ kind: 'captions', sceneId: scene.id, sceneIndex: index, path: null, active: true, status: 'ok', messages: [] }, async () => { compileSceneCaptions({ ...scene, duration: Math.round(scene.duration * 30) / 30 }, project.narrationMode); });
  }
  for (const [kind, file, active] of [['narration', project.narrationPath, project.narrationMode !== 'scenes'], ['bgm', project.bgmPath, true]] as const) {
    const item: MediaCheckItem = { kind, path: file, active, status: 'skipped', messages: [] };
    if (!file) { item.messages.push('未设置，不要求此音轨。'); items.push(item); continue; }
    await inspect(item, async () => {
      await cached('audio', file, async () => {
        await assertMedia(file, AUDIO_EXTENSIONS);
        binary ??= options.ffmpegPath ? Promise.resolve(options.ffmpegPath) : resolveFfmpeg();
        await decodeLocalAudio(file, await binary, options.signal, Math.max(1, Math.min(options.audioTimeoutMs ?? 30000, deadline - Date.now())));
      });
    });
  }
  options.signal?.throwIfAborted();
  return { checkedAt: new Date().toISOString(), canExport: !items.some((item) => item.status === 'error'), items };
}

export function assertMediaReport(report: MediaCheckReport): void {
  if (!report.canExport) throw new Error(`素材检查未通过：\n${mediaCheckErrors(report)}`);
}
