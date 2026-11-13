import { z } from 'zod';
import type { AIOutcome, AIRequest, AISettingsView, SaveAISettings } from './ai';
import { imageVersionSchema, type ImageVersion, type ImageRequest, type ImageOutcome, type ImageProgress } from './images';
import { speechClipSchema, speechOptionsSchema, speechSceneDuration, type SpeechClip, type SpeechRequest, type SpeechOutcome, type SpeechProgress } from './speech';
import { subtitleTimelineSchema } from './captions';
import type { ArtifactCheck, DraftInput, PreparedArtifact, RecoveryOverview, RecoveryDraft } from './recovery';
import type { ExportStartResult, MediaCheckReport } from './media-check';
import { textWorkSchema } from './text-plan';

export const sceneSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().max(180),
  prompt: z.string().max(2000),
  description: z.string().max(2000).default(''),
  imagePath: z.string().max(4096).nullable(),
  imageVersions: z.array(imageVersionSchema).max(20).optional(),
  speech: speechClipSchema.nullable().optional(),
  subtitleTimeline: subtitleTimelineSchema.optional(),
  duration: z.number().min(1).max(60),
  motion: z.enum(['still', 'zoom']),
});

export const projectSchema = z.object({
  version: z.literal(1),
  title: z.string().trim().min(1).max(100),
  category: z.enum(['story', 'novel', 'knowledge']),
  script: z.string().max(30000),
  aspect: z.enum(['portrait', 'landscape']),
  resolution: z.enum(['720p', '1080p']),
  transition: z.enum(['cut', 'fade']),
  captions: z.boolean(),
  narrationPath: z.string().max(4096).nullable(),
  narrationMode: z.enum(['global', 'scenes']).optional(),
  speechOptions: speechOptionsSchema.optional(),
  bgmPath: z.string().max(4096).nullable(),
  bgmVolume: z.number().min(0).max(1),
  textWork: textWorkSchema.optional(),
  scenes: z.array(sceneSchema).min(1).max(100).superRefine((scenes, context) => {
    const ids = new Set<string>();
    scenes.forEach((scene, index) => {
      if (ids.has(scene.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: `分镜 ${index + 1} 的编号重复，请先修正项目文件；未自动修改素材关联。` });
      ids.add(scene.id);
    });
  }),
  rewriteHistory: z.array(z.object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    original: z.string().max(30000),
    rewritten: z.string().max(30000),
    instructions: z.string().max(2000),
    model: z.string().max(200),
  })).max(100).default([]),
});

export type Project = z.infer<typeof projectSchema>;
export type Scene = z.infer<typeof sceneSchema>;

/** 无媒体的字幕、提示词与手工时长也属于应保护的编辑，替换一律确认。 */
export function sceneReplacementWarning(scenes: readonly Scene[]): string {
  const timelines = scenes.filter((scene) => scene.subtitleTimeline).length;
  const images = scenes.filter((scene) => scene.imagePath || scene.imageVersions?.length).length;
  const speech = scenes.filter((scene) => scene.speech).length;
  return `将替换现有 ${scenes.length} 个分镜及其文字、描述、绘图提示词、时长、排序和运镜设置，其中有 ${timelines} 镜独立字幕时间轴、${images} 镜图片／版本关联、${speech} 镜按镜配音。不会删除磁盘素材；本次会话可撤销最近一次分镜替换，关闭或切换项目后失效。是否继续？`;
}
export interface ExportProgress {
  jobId: string;
  percent: number;
  message: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  outputPath?: string;
}
export interface ImportedImage { path: string; preview: string }
export interface OpenedProject { project: Project; previews: Record<string, string>; filePath: string }
export interface DesktopAPI {
  checkProjectMedia(project: Project): Promise<MediaCheckReport>;
  getRecovery(): Promise<RecoveryOverview>;
  saveDraft(draft: DraftInput): Promise<number>;
  loadDraft(id: string): Promise<{ draft: RecoveryDraft; previews: Record<string, string> }>;
  dismissDraft(id: string, revision: number): Promise<void>;
  checkArtifact(taskId: string, artifactId: string): Promise<ArtifactCheck>;
  prepareArtifact(taskId: string, artifactId: string, scene: Scene): Promise<PreparedArtifact>;
  onBeforeClose(callback: () => Promise<boolean>): () => void;
  getSpeechSettings(): Promise<AISettingsView>;
  saveSpeechSettings(input: SaveAISettings): Promise<AISettingsView>;
  generateSpeech(request: SpeechRequest): Promise<SpeechOutcome>;
  onSpeechProgress(callback: (event: SpeechProgress) => void): () => void;
  previewSpeech(path: string): Promise<string>;
  getImageSettings(): Promise<AISettingsView>;
  saveImageSettings(input: SaveAISettings): Promise<AISettingsView>;
  generateImages(request: ImageRequest): Promise<ImageOutcome>;
  onImageProgress(callback: (event: ImageProgress) => void): () => void;
  previewImage(path: string): Promise<string>;
  getAISettings(): Promise<AISettingsView>;
  saveAISettings(input: SaveAISettings): Promise<AISettingsView>;
  runAI(request: AIRequest): Promise<AIOutcome>;
  cancelAI(id: string): Promise<void>;
  loadDemo(): Promise<OpenedProject>;
  importImages(): Promise<ImportedImage[]>;
  importAudio(): Promise<string | null>;
  saveProject(project: Project): Promise<string | null>;
  openProject(): Promise<OpenedProject | null>;
  startExport(project: Project, workspaceId?: string): Promise<ExportStartResult | null>;
  exportSubtitles(project: Project, workspaceId?: string): Promise<string | null>;
  cancelExport(): Promise<void>;
  revealOutput(path: string): Promise<void>;
  onProgress(callback: (event: ExportProgress) => void): () => void;
}

export function adoptSceneSpeech(scene: Scene, candidate: SpeechClip): Scene {
  const clip = speechClipSchema.parse(candidate);
  if (clip.text !== scene.text.trim()) throw new Error('分镜文字已改变，不能采用此配音。');
  return { ...scene, speech: clip, duration: speechSceneDuration(clip.duration) };
}

/** 只保留最近 20 个版本引用；不删除磁盘文件，也不修改当前提示词。 */
export function selectSceneImage(scene: Scene, version: ImageVersion): Scene {
  const versions = [...(scene.imageVersions ?? [])];
  if (scene.imagePath && !versions.some((item) => item.path === scene.imagePath)) {
    versions.push({ id: crypto.randomUUID(), path: scene.imagePath, prompt: '', model: '', source: 'imported', createdAt: new Date().toISOString() });
  }
  const existing = versions.find((item) => item.path === version.path) ?? imageVersionSchema.parse(version);
  return { ...scene, imagePath: version.path, imageVersions: [...versions.filter((item) => item.path !== version.path), existing].slice(-20) };
}

export function createProject(): Project {
  return {
    version: 1, title: '未命名作品', category: 'story', script: '',
    aspect: 'portrait', resolution: '720p', transition: 'fade', captions: true,
    narrationPath: null, bgmPath: null, bgmVolume: 0.15,
    scenes: [{ id: crypto.randomUUID(), text: '每一个故事，都从一个画面开始。', prompt: '', description: '', imagePath: null, duration: 5, motion: 'zoom' }],
    rewriteHistory: [],
  };
}

export function splitScript(script: string): Scene[] {
  const paragraphs = script.trim().split(/\n+|(?<=[。！？!?])/u).map((text) => text.trim()).filter(Boolean);
  const chunks = paragraphs.flatMap((text) => Array.from({ length: Math.ceil(text.length / 60) }, (_, index) => text.slice(index * 60, (index + 1) * 60)));
  if (chunks.length > 100) throw new Error('分镜超过 100 个，请缩短文案或分批制作。');
  return chunks.map((text) => ({ id: crypto.randomUUID(), text, prompt: '', description: '', imagePath: null, duration: Math.min(30, Math.max(3, Math.ceil(text.length / 4))), motion: 'zoom' }));
}
