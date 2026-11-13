import { z } from 'zod';
import { projectSchema } from './project';
import { imageVersionSchema, type ImageCandidate } from './images';
import { speechClipSchema, type SpeechClip } from './speech';

export const draftInputSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(),
  sourceFilePath: z.string().max(4096).nullable(), project: projectSchema,
});
export const draftSchema = draftInputSchema.extend({ updatedAt: z.string().datetime(), dismissed: z.boolean() });
export type DraftInput = z.infer<typeof draftInputSchema>;
export type RecoveryDraft = z.infer<typeof draftSchema>;
export type DraftSummary = Omit<RecoveryDraft, 'project'> & { title: string; sceneCount: number; excerpt: string };
export const artifactSchema = z.object({
  id: z.string().uuid(), kind: z.enum(['image', 'speech', 'text', 'mp4', 'srt']),
  path: z.string().min(1).max(4096), sceneId: z.string().max(100).nullable(),
  bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  image: imageVersionSchema.optional(), speech: speechClipSchema.optional(),
});
export type TaskArtifact = z.infer<typeof artifactSchema>;
export const taskSchema = z.object({
  id: z.string().uuid(), sessionId: z.string().uuid(), ownerPid: z.number().int().positive(),
  workspaceId: z.string().uuid().nullable(), kind: z.enum(['test', 'rewrite', 'storyboard', 'image', 'speech', 'mp4', 'srt']),
  state: z.enum(['running', 'done', 'partial', 'cancelled', 'failed', 'interrupted']),
  phase: z.enum(['requesting', 'rendering', 'writing', 'finished', 'interrupted']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  total: z.number().int().min(1).max(100), processed: z.number().int().min(0).max(100),
  succeeded: z.number().int().min(0).max(100), failed: z.number().int().min(0).max(100),
  artifacts: z.array(artifactSchema).max(100),
});
export type RecoveryTask = z.infer<typeof taskSchema>;
export interface RecoveryOverview { drafts: DraftSummary[]; tasks: RecoveryTask[]; warnings: string[] }
export interface ArtifactCheck { valid: boolean; message: string }
export type PreparedArtifact = { kind: 'image'; candidate: ImageCandidate } | { kind: 'speech'; clip: SpeechClip; preview: string };
