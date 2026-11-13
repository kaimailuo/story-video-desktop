import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import { artifactSchema, draftInputSchema, draftSchema, taskSchema, type ArtifactCheck, type DraftInput, type PreparedArtifact, type RecoveryDraft, type RecoveryOverview, type RecoveryTask, type TaskArtifact } from '../shared/recovery';
import { loadPcmWave } from './audio/wav';
import { sceneSchema, adoptSceneSpeech, type Scene } from '../shared/project';

const uuid = z.string().uuid();
const MAX_RECORD = 33 * 1024 * 1024;
const MAX_TASK = 1024 * 1024;
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }

/** 同目录原子替换；同步文件内容，失败保留旧版本，不清扫其他进程的临时文件。 */
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function json(file: string, maximum: number): Promise<unknown> {
  const info = await stat(file);
  if (!info.isFile() || info.size > maximum) throw new Error('记录过大或不是文件');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(maximum + 1, info.size + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) throw new Error('记录过大');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally { await handle.close(); }
}

async function fingerprint(file: string): Promise<{ bytes: number; sha256: string }> {
  if (!path.isAbsolute(file)) throw new Error('不是本地绝对路径');
  const before = await stat(file);
  if (!before.isFile() || !before.size) throw new Error('文件不存在或为空');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const part of createReadStream(file)) { const chunk = part as Buffer; bytes += chunk.length; hash.update(chunk); }
  const after = await stat(file);
  if (before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('文件在校验时改变');
  return { bytes, sha256: hash.digest('hex') };
}

export class RecoveryStore {
  readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sessionId = randomUUID();
  private initialized = false;
  private warnings = new Set<string>();
  constructor(directory: string) { this.directory = path.join(directory, 'recovery-v1'); }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run); this.queue = result.catch(() => undefined); return result;
  }
  private draftFile(id: string) { return path.join(this.directory, 'drafts', `${uuid.parse(id)}.json`); }
  private taskFile(id: string) { return path.join(this.directory, 'tasks', `${uuid.parse(id)}.json`); }
  private async files(kind: 'drafts' | 'tasks'): Promise<string[]> {
    try { return (await readdir(path.join(this.directory, kind))).filter((name) => name.endsWith('.json') && uuid.safeParse(name.slice(0, -5)).success); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private async readDraft(id: string) { return draftSchema.parse(await json(this.draftFile(id), MAX_RECORD)); }
  private async readTask(id: string) { return taskSchema.parse(await json(this.taskFile(id), MAX_TASK)); }
  async saveDraft(raw: DraftInput): Promise<number> {
    const input = draftInputSchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(input)) > 32 * 1024 * 1024) throw new Error('草稿超过 32 MiB，请精简历史。');
    return this.serial(async () => {
      let previous: RecoveryDraft | undefined;
      try { previous = await this.readDraft(input.id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('原草稿损坏或无法读取；已保留原文件，未覆盖。'); }
      if (previous && previous.revision >= input.revision) return previous.revision;
      await atomicJson(this.draftFile(input.id), { ...input, updatedAt: new Date().toISOString(), dismissed: false });
      return input.revision;
    });
  }
  async loadDraft(id: string): Promise<RecoveryDraft> {
    return this.serial(async () => { const draft = await this.readDraft(id); if (draft.dismissed) throw new Error('草稿已经放弃或已手动保存。'); return draft; });
  }
  async dismissDraft(id: string, revision: number): Promise<void> {
    uuid.parse(id); z.number().int().nonnegative().parse(revision);
    return this.serial(async () => {
      let draft: RecoveryDraft;
      try { draft = await this.readDraft(id); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (draft.revision !== revision) throw new Error('草稿已更新，请刷新后重试，避免放弃较新的内容。');
      await atomicJson(this.draftFile(id), { ...draft, dismissed: true });
    });
  }
  async overview(): Promise<RecoveryOverview> {
    return this.serial(async () => {
      const drafts: RecoveryOverview['drafts'] = []; const tasks: RecoveryTask[] = [];
      for (const file of await this.files('drafts')) {
        try {
          const draft = await this.readDraft(file.slice(0, -5));
          if (!draft.dismissed) { const { project, ...summary } = draft; drafts.push({ ...summary, title: project.title, sceneCount: project.scenes.length, excerpt: project.script.slice(0, 200) }); }
        } catch { this.warnings.add('有草稿损坏、过大或无法读取，原文件已保留；未自动覆盖或删除。'); }
      }
      for (const file of await this.files('tasks')) {
        try {
          let task = await this.readTask(file.slice(0, -5));
          // 只将确认退出的旧进程任务标为中断，不把其他仍活跃的实例误报为失败。
          if (!this.initialized && task.state === 'running' && task.sessionId !== this.sessionId && !alive(task.ownerPid)) {
            task = { ...task, state: 'interrupted', phase: 'interrupted', updatedAt: new Date().toISOString() };
            await atomicJson(this.taskFile(task.id), task);
          }
          tasks.push(task);
        } catch { this.warnings.add('有任务记录损坏或无法读取，原文件已保留；任务状态可能不完整。'); }
      }
      this.initialized = true;
      return { drafts: drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), tasks: tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100), warnings: [...this.warnings] };
    });
  }
  async begin(kind: RecoveryTask['kind'], total: number, workspaceId?: string): Promise<string> {
    return this.serial(async () => {
      const id = randomUUID(); const now = new Date().toISOString();
      const task = taskSchema.parse({ id, sessionId: this.sessionId, ownerPid: process.pid, workspaceId: workspaceId ?? null, kind, state: 'running', phase: kind === 'mp4' ? 'rendering' : kind === 'srt' ? 'writing' : 'requesting', createdAt: now, updatedAt: now, total, processed: 0, succeeded: 0, failed: 0, artifacts: [] });
      await atomicJson(this.taskFile(id), task); return id;
    });
  }
  async item(id: string, artifact?: { kind: TaskArtifact['kind']; path: string; sceneId?: string; image?: TaskArtifact['image']; speech?: TaskArtifact['speech'] }): Promise<void> {
    return this.serial(async () => {
      const task = await this.readTask(id);
      if (task.state !== 'running' || task.processed >= task.total) throw new Error('任务记录状态无效');
      const saved = artifact ? artifactSchema.parse({ id: randomUUID(), ...artifact, sceneId: artifact.sceneId ?? null, ...await fingerprint(artifact.path) }) : null;
      await atomicJson(this.taskFile(id), { ...task, processed: task.processed + 1, succeeded: task.succeeded + (saved ? 1 : 0), failed: task.failed + (saved ? 0 : 1), updatedAt: new Date().toISOString(), artifacts: saved ? [...task.artifacts, saved] : task.artifacts });
    });
  }
  async textResult(id: string, value: unknown): Promise<void> {
    // 只由主进程传入已校验的 AI 结果，不保存请求、配置、Key、URL 或服务错误体。
    const file = path.join(this.directory, 'results', `${uuid.parse(id)}.json`);
    await atomicJson(file, value); await this.item(id, { kind: 'text', path: file });
  }
  async finish(id: string, state: Exclude<RecoveryTask['state'], 'running' | 'interrupted'>): Promise<void> {
    return this.serial(async () => {
      const task = await this.readTask(id);
      if (task.state !== 'running') return;
      const actual = (state === 'done' && (task.processed < task.total || task.failed > 0)) || state === 'partial' ? (task.succeeded ? 'partial' : 'failed') : state;
      await atomicJson(this.taskFile(id), { ...task, state: actual, phase: 'finished', updatedAt: new Date().toISOString() });
    });
  }
  noteWriteFailure(): void { this.warnings.add('任务记录写入失败：已有产物可能未登记或状态不完整。成功文件与候选不会因此删除，请勿盲目重发付费请求；重启后未完成记录会标为中断。'); }
  async prepareArtifact(taskId: string, artifactId: string, rawScene: Scene): Promise<PreparedArtifact> {
    const scene = sceneSchema.parse(rawScene);
    const check = await this.checkArtifact(taskId, artifactId);
    if (!check.valid) throw new Error(check.message);
    const task = await this.readTask(taskId);
    const artifact = task.artifacts.find((item) => item.id === uuid.parse(artifactId));
    if (!artifact) throw new Error('找不到该任务的产物。');
    if (artifact.kind === 'image') {
      const image = sharp(artifact.path, { limitInputPixels: 40_000_000, failOn: 'warning' });
      const metadata = await image.metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('不是支持的静态图片。');
      const buffer = await image.timeout({ seconds: 10 }).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer();
      // 旧图片允许作为本地导入使用，不伪造生成参数。
      const version = artifact.image ?? { id: artifact.id, path: artifact.path, source: 'imported' as const, prompt: '', model: '', createdAt: task.createdAt };
      if (version.path !== artifact.path) throw new Error('图片元数据与文件路径不一致。');
      const current = await fingerprint(artifact.path);
      if (current.sha256 !== artifact.sha256 || current.bytes !== artifact.bytes) throw new Error('文件在预览期间改变，请重新核验。');
      return { kind: 'image', candidate: { ...version, preview: `data:image/jpeg;base64,${buffer.toString('base64')}` } };
    }
    if (artifact.kind === 'speech') {
      const clip = artifact.speech;
      if (!clip) throw new Error('旧配音记录缺少生成原稿／音色元数据，不能安全关联；不会用当前字幕冒充原稿。');
      if (clip.path !== artifact.path) throw new Error('配音元数据与文件路径不一致。');
      adoptSceneSpeech(scene, clip);
      const wave = await loadPcmWave(artifact.path);
      if (Math.abs(wave.duration - clip.duration) > 1e-6) throw new Error('实际配音时长与记录不一致。');
      const current = await fingerprint(artifact.path);
      if (current.sha256 !== artifact.sha256 || current.bytes !== artifact.bytes) throw new Error('文件在预览期间改变，请重新核验。');
      return { kind: 'speech', clip, preview: `data:audio/wav;base64,${wave.buffer.toString('base64')}` };
    }
    throw new Error('此类产物仅供核验，不支持关联到分镜。');
  }
  async checkArtifact(taskId: string, artifactId: string): Promise<ArtifactCheck> {
    await this.queue;
    const task = await this.readTask(taskId); const artifact = task.artifacts.find((item) => item.id === uuid.parse(artifactId));
    if (!artifact) throw new Error('找不到该任务的产物');
    try {
      const current = await fingerprint(artifact.path);
      if (current.bytes !== artifact.bytes || current.sha256 !== artifact.sha256) return { valid: false, message: '文件内容已改变（大小或 SHA-256 不匹配），不会自动复用。' };
      if (artifact.kind === 'image') await sharp(artifact.path, { limitInputPixels: 40_000_000, failOn: 'warning' }).stats();
      if (artifact.kind === 'speech') await loadPcmWave(artifact.path);
      if (artifact.kind === 'text') await json(artifact.path, 1024 * 1024);
      if (artifact.kind === 'srt' && !(await readFile(artifact.path, 'utf8')).includes(' --> ')) throw new Error('SRT 格式无效');
      return { valid: true, message: artifact.kind === 'mp4' ? '文件存在且 SHA-256 一致（未完整解码播放，不等于断点续渲染）。' : '文件存在、SHA-256 与格式检查通过；不会自动采用或重发请求。' };
    } catch { return { valid: false, message: '文件缺失、不可读或格式无效；原引用保留，不会自动重生成。' }; }
  }
}
