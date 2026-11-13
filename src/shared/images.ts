import { z } from 'zod';
import type { AIErrorCode } from './ai';

export const imageSizes = ['1024x1024', '1024x1536', '1536x1024', '1024x1792', '1792x1024'] as const;
export const imageRequestSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().optional(),
  size: z.enum(imageSizes),
  scenes: z.array(z.object({ sceneId: z.string().min(1).max(100), prompt: z.string().trim().min(1).max(2000) }).strict()).min(1).max(100),
}).strict().refine((value) => new Set(value.scenes.map((scene) => scene.sceneId)).size === value.scenes.length, '分镜编号不能重复');
export type ImageRequest = z.infer<typeof imageRequestSchema>;
export const imageVersionSchema = z.object({
  id: z.string().uuid(),
  path: z.string().min(1).max(4096),
  prompt: z.string().max(2000),
  model: z.string().max(200),
  createdAt: z.string().datetime(),
  source: z.enum(['generated', 'imported']),
});
export type ImageVersion = z.infer<typeof imageVersionSchema>;
export interface ImageCandidate extends ImageVersion { preview: string }
export type ImageItem = { sceneId: string; prompt: string } & (
  | { ok: true; candidate: ImageCandidate }
  | { ok: false; error: { code: AIErrorCode; message: string } }
);
export interface ImageBatch { items: ImageItem[]; state: 'done' | 'cancelled' | 'stopped'; total: number; warning?: string }
export type ImageOutcome = { ok: true; batch: ImageBatch } | { ok: false; error: { code: AIErrorCode; message: string } };
export interface ImageProgress { jobId: string; completed: number; total: number; message: string }
