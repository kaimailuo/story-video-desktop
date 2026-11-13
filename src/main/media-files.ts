import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

export async function resolveFfmpeg(): Promise<string> {
  const candidates = [ffmpegStatic?.replace(/app\.asar\//, 'app.asar.unpacked/'), '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* 尝试下一个已知路径。 */ }
  }
  throw new Error('未找到可执行的 FFmpeg，请重新安装客户端。');
}

export async function assertMedia(filePath: string, extensions: readonly string[]): Promise<void> {
  if (!path.isAbsolute(filePath) || !extensions.includes(path.extname(filePath).toLowerCase())) throw new Error(`不支持的素材路径：${path.basename(filePath)}`);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new Error(`素材不存在或不是普通文件：${path.basename(filePath)}`);
  await access(filePath, constants.R_OK).catch(() => { throw new Error(`素材不可读取：${path.basename(filePath)}`); });
}

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'];
