import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export const MAX_WAV_BYTES = 24 * 1024 * 1024;
export interface PcmWave { buffer: Buffer; duration: number; sampleRate: number; channels: number; frames: number }

/** 严格接受有完整长度的 RIFF/WAVE PCM16，丢弃额外元数据，重新封装标准头。 */
export function parsePcmWave(bytes: Buffer): PcmWave {
  const invalid = () => new Error('配音不是支持的完整 PCM16 WAV，或时长／大小超限。');
  if (bytes.length < 44 || bytes.length > MAX_WAV_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) !== bytes.length - 8) throw invalid();
  let format: { channels: number; sampleRate: number; blockAlign: number } | undefined;
  let data: Buffer | undefined;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw invalid();
    const tag = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const begin = offset + 8;
    const end = begin + size;
    if (end > bytes.length || end + (size % 2) > bytes.length) throw invalid();
    if (tag === 'fmt ') {
      if (format || size < 16 || bytes.readUInt16LE(begin) !== 1 || bytes.readUInt16LE(begin + 14) !== 16) throw invalid();
      const channels = bytes.readUInt16LE(begin + 2);
      const sampleRate = bytes.readUInt32LE(begin + 4);
      const byteRate = bytes.readUInt32LE(begin + 8);
      const blockAlign = bytes.readUInt16LE(begin + 12);
      if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 96000 || blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign) throw invalid();
      format = { channels, sampleRate, blockAlign };
    } else if (tag === 'data') {
      if (data || !format || size === 0) throw invalid();
      data = bytes.subarray(begin, end);
    }
    offset = end + (size % 2);
  }
  if (!format || !data || data.length % format.blockAlign !== 0) throw invalid();
  const frames = data.length / format.blockAlign;
  const duration = frames / format.sampleRate;
  if (duration <= 0 || duration > 60) throw invalid();
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(data.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24); header.writeUInt32LE(format.sampleRate * format.blockAlign, 28);
  header.writeUInt16LE(format.blockAlign, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return { buffer: Buffer.concat([header, data]), duration, sampleRate: format.sampleRate, channels: format.channels, frames };
}

export async function loadPcmWave(filePath: string): Promise<PcmWave> {
  if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.wav') throw new Error('配音必须是本地 WAV 文件。');
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_WAV_BYTES) throw new Error('配音素材缺失、不是普通文件或超过 24 MiB。');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.from(chunk as Buffer);
    size += bytes.length;
    if (size > MAX_WAV_BYTES) throw new Error('配音文件超过 24 MiB。');
    chunks.push(bytes);
  }
  return parsePcmWave(Buffer.concat(chunks));
}
