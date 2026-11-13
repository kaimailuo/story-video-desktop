import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Project } from '../shared/project';

export function createDemoWave(seconds = 3): Buffer {
  const sampleRate = 48000;
  const samples = Math.round(seconds * sampleRate);
  const result = Buffer.alloc(44 + samples * 2);
  result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36);
  result.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const time = index / sampleRate;
    const envelope = Math.min(1, time * 5, (seconds - time) * 5);
    const value = (Math.sin(time * Math.PI * 440) + Math.sin(time * Math.PI * 660)) * 0.035 * envelope;
    result.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return result;
}

export async function createDemo(directory: string): Promise<Project> {
  await mkdir(directory, { recursive: true });
  const colors = [['#102b43', '#e9aa6b'], ['#233b39', '#adc7ac'], ['#2a2540', '#d7acde']];
  const texts = ['清晨，城市还未醒来。', '把平凡的片刻，写成自己的故事。', '从一个画面开始，让灵感成为作品。'];
  const scenes: Project['scenes'] = [];
  for (let index = 0; index < colors.length; index++) {
    const [background, accent] = colors[index];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">
      <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${background}"/><stop offset="1" stop-color="#101820"/></linearGradient></defs>
      <rect width="720" height="1280" fill="url(#sky)"/><circle cx="${260 + index * 90}" cy="370" r="135" fill="${accent}" opacity="0.85"/>
      <path d="M0 820L230 490L510 900L720 600V1280H0Z" fill="#101c29"/><path d="M0 1000L300 700L720 1070V1280H0Z" fill="#192f3b"/>
      <path d="M300 1280L390 870L440 1280" fill="${accent}" opacity="0.2"/>
      <text x="58" y="100" font-family="Arial,sans-serif" font-size="22" letter-spacing="6" fill="white" opacity="0.6">STORY STUDY / 0${index + 1}</text>
    </svg>`;
    const imagePath = path.join(directory, `demo-${index + 1}.png`);
    await sharp(Buffer.from(svg)).png().toFile(imagePath);
    scenes.push({ id: `demo-${index + 1}`, text: texts[index], prompt: '本地演示插画，不使用 AI 服务', description: '抽象山峦与圆形光源的本地演示插画', imagePath, duration: 3, motion: 'zoom' });
  }
  const bgmPath = path.join(directory, 'demo-tone.wav');
  await writeFile(bgmPath, createDemoWave());
  return {
    version: 1, title: '从一个画面开始', category: 'story', script: texts.join('\n'),
    aspect: 'portrait', resolution: '720p', transition: 'fade', captions: true,
    narrationPath: null, bgmPath, bgmVolume: 0.3, scenes, rewriteHistory: [],
  };
}
