import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectSchema, type Project } from '../shared/project';
import { projectSrt } from '../shared/captions';

export async function exportSubtitles(project: Project, outputPath: string): Promise<string> {
  const srt = projectSrt(projectSchema.parse(project));
  if (!path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.srt') throw new Error('字幕导出目标必须是本地 SRT 文件。');
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, srt, { flag: 'wx', mode: 0o600 });
    await rename(temporary, outputPath);
    return outputPath;
  } finally { await rm(temporary, { force: true }); }
}
