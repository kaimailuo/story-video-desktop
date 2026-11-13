import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createDemo } from '../src/main/demo';
import { exportVideo } from '../src/main/exporter';

async function main(): Promise<void> {
  const directory = path.resolve('artifacts');
  const project = await createDemo(path.join(directory, 'demo-assets'));
  const outputPath = path.join(directory, 'demo-intel.mp4');
  await writeFile(path.join(directory, 'demo.yingxu.json'), JSON.stringify(project, null, 2));
  await exportVideo({
    project, outputPath, signal: new AbortController().signal,
    onProgress: (percent, message) => console.log(`${percent}% ${message}`),
  });
  console.log(`演示成片：${outputPath}`);
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
