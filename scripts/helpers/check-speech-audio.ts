import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function decodeAudio(binary: string, file: string): Promise<Buffer> {
  const { stdout } = await exec(binary, ['-v', 'error', '-i', file, '-vn', '-f', 's16le', '-ar', '8000', '-ac', '1', 'pipe:1'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export function audioWindow(bytes: Buffer, start: number, end: number, frequency = 440): { rms: number; amplitude: number } {
  const begin = Math.round(start * 8000); const finish = Math.min(bytes.length / 2, Math.round(end * 8000));
  assert.ok(finish > begin, '解码音频应覆盖检查窗口');
  let power = 0; let real = 0; let imaginary = 0;
  for (let index = begin; index < finish; index++) {
    const value = bytes.readInt16LE(index * 2) / 32768;
    power += value * value;
    real += value * Math.cos(2 * Math.PI * frequency * index / 8000);
    imaginary += value * Math.sin(2 * Math.PI * frequency * index / 8000);
  }
  const count = finish - begin;
  return { rms: Math.sqrt(power / count), amplitude: 2 * Math.hypot(real, imaginary) / count };
}

/** 验证的是最终 AAC 解码后的音轨，非仅检查 FFmpeg 参数。 */
export function assertSpeechTimeline(bytes: Buffer, firstDuration: number, gapDuration: number): void {
  assert.ok(audioWindow(bytes, 0.2, 0.5, 440).amplitude > 0.1, '首镜应为 440 Hz 配音');
  assert.ok(audioWindow(bytes, firstDuration + 0.15, firstDuration + gapDuration - 0.15).rms < 0.001, '缺配音镜头应为静音，不混入全片配音');
  const lastStart = firstDuration + gapDuration;
  assert.ok(audioWindow(bytes, lastStart + 0.15, lastStart + 0.45, 880).amplitude > 0.1, '末镜 880 Hz 应按时间轴顺序开始');
  assert.ok(audioWindow(bytes, lastStart + 0.75, lastStart + 0.95).rms < 0.001, '短配音镜头尾部补静音');
}
