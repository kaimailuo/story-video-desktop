import { z } from 'zod';
import type { AIErrorCode } from './ai';

export const speechOptionsSchema = z.object({ voice: z.string().trim().max(200), speed: z.number().min(0.25).max(4) });
export const speechRequestSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().optional(),
  voice: z.string().trim().min(1).max(200),
  speed: z.number().min(0.25).max(4),
  scenes: z.array(z.object({ sceneId: z.string().min(1).max(100), text: z.string().trim().min(1).max(180) }).strict()).min(1).max(100),
}).strict().refine((value) => new Set(value.scenes.map((scene) => scene.sceneId)).size === value.scenes.length, '分镜编号不能重复');
export const speechClipSchema = z.object({
  id: z.string().uuid(), path: z.string().min(1).max(4096), text: z.string().trim().min(1).max(180),
  model: z.string().min(1).max(200), voice: z.string().min(1).max(200), speed: z.number().min(0.25).max(4),
  duration: z.number().positive().max(60), createdAt: z.string().datetime(),
});
export type SpeechRequest = z.infer<typeof speechRequestSchema>;
export type SpeechClip = z.infer<typeof speechClipSchema>;
export type SpeechOptions = z.infer<typeof speechOptionsSchema>;
export type SpeechItem = { sceneId: string; text: string } & (
  | { ok: true; clip: SpeechClip }
  | { ok: false; error: { code: AIErrorCode; message: string } }
);
export interface SpeechBatch { items: SpeechItem[]; state: 'done' | 'cancelled' | 'stopped'; total: number; warning?: string }
export type SpeechOutcome = { ok: true; batch: SpeechBatch } | { ok: false; error: { code: AIErrorCode; message: string } };
export interface SpeechProgress { jobId: string; completed: number; total: number; message: string }

/** 向上量化到 30 FPS，至少 1 秒，不截断末尾音频。 */
export function speechSceneDuration(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60) throw new Error('配音时长必须大于 0 且不超过 60 秒。');
  return Math.max(1, Math.ceil(duration * 30 - 1e-8) / 30);
}
