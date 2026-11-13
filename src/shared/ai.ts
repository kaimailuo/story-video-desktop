import { z } from 'zod';
import type { SourceCoverage } from './text-plan';

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('API 地址必须使用 HTTPS；仅本机测试服务允许 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址不能包含账号、密码、查询参数或片段。');
  }
  if (/\/(?:chat\/completions|images\/generations|audio\/speech)\/*$/.test(url.pathname)) throw new Error('请填写 API 基础地址，不包含具体接口路径。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\/+$/, '');
}

export const aiSettingsSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048).refine((value) => {
    try { normalizeBaseUrl(value); return true; } catch { return false; }
  }, '请输入不含凭据或查询参数的 HTTPS 基础地址；本机测试可使用 HTTP。'),
  model: z.string().trim().min(1, '请输入模型名称。').max(200),
  timeoutSeconds: z.number().int().min(5).max(180),
});

export type AISettings = z.infer<typeof aiSettingsSchema>;
export interface AISettingsView {
  settings: AISettings;
  hasKey: boolean;
  encryptionAvailable: boolean;
}

export const saveAISettingsSchema = z.object({
  settings: aiSettingsSchema,
  apiKey: z.string().trim().max(8192).refine((value) => !value || !/\s/u.test(value), 'API Key 不能包含空白字符。').optional(),
  clearKey: z.boolean().default(false),
}).refine((value) => !(value.clearKey && value.apiKey), '不能同时替换和删除 Key。');
export type SaveAISettings = z.input<typeof saveAISettingsSchema>;

const contentRequest = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().optional(),
  kind: z.enum(['rewrite', 'storyboard']),
   script: z.string().min(1).max(30000).refine((value) => Boolean(value.trim()), '文案不能为空白'),
  category: z.enum(['story', 'novel', 'knowledge']),
  instructions: z.string().trim().max(2000),
  segment: z.object({ index: z.number().int().min(1).max(100), total: z.number().int().min(1).max(100) }).strict().refine((segment) => segment.index <= segment.total, '分段序号无效').optional(),
});
export const aiRequestSchema = z.union([
  z.object({ id: z.string().uuid(), kind: z.literal('test'), workspaceId: z.string().uuid().optional() }),
  contentRequest,
]);
export type AIRequest = z.infer<typeof aiRequestSchema>;

export const generatedSceneSchema = z.object({
  text: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(2000),
  prompt: z.string().trim().min(1).max(2000),
  duration: z.number().min(1).max(60),
  motion: z.enum(['still', 'zoom']),
}).strict();
export const storyboardSchema = z.object({ scenes: z.array(generatedSceneSchema).min(1).max(100) }).strict();
export type GeneratedScene = z.infer<typeof generatedSceneSchema>;
export interface AIUsage { promptTokens?: number; completionTokens?: number; totalTokens?: number }
export type AIResult =
  | { kind: 'test'; message: string; model: string; usage?: AIUsage }
  | { kind: 'rewrite'; text: string; model: string; usage?: AIUsage; coverage?: SourceCoverage }
  | { kind: 'storyboard'; scenes: GeneratedScene[]; model: string; usage?: AIUsage; coverage?: SourceCoverage };
export type AIErrorCode = 'cancelled' | 'timeout' | 'network' | 'auth' | 'rate_limit' | 'provider' | 'invalid_response' | 'config' | 'busy';
export type AIOutcome = { ok: true; result: AIResult } | { ok: false; error: { code: AIErrorCode; message: string } };

export const defaultAISettings: AISettings = { baseUrl: '', model: '', timeoutSeconds: 60 };
