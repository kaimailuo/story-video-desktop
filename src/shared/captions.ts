import { z } from 'zod';

export const CAPTION_FPS = 30;
export const MAX_SCENE_CAPTIONS = 20;
export const subtitleCueSchema = z.object({
  id: z.string().uuid(), text: z.string().max(180),
  start: z.number().min(0).max(60), end: z.number().min(0).max(60),
});
/** 允许保存尚未修好的编辑草稿；跨字段错误在预览／导出时统一检查。 */
export const subtitleTimelineSchema = z.object({
  sourceText: z.string().max(180), sourceSpeechId: z.string().uuid().nullable(),
  sourceMode: z.enum(['global', 'scenes']).default('global'),
  timing: z.enum(['estimated', 'manual']), cues: z.array(subtitleCueSchema).max(MAX_SCENE_CAPTIONS),
});
export type SubtitleCue = z.infer<typeof subtitleCueSchema>;
export type SubtitleTimeline = z.infer<typeof subtitleTimelineSchema>;
export interface CaptionScene {
  text: string; duration: number;
  speech?: { id: string; text: string; duration: number } | null;
  subtitleTimeline?: SubtitleTimeline;
}
export interface CaptionProject { scenes: CaptionScene[]; narrationMode?: 'global' | 'scenes' }
export interface CompiledCaption { text: string; startFrame: number; endFrame: number }

export function sceneFrameCount(duration: number): number { return Math.round(duration * CAPTION_FPS); }
export function captionSpeechId(scene: CaptionScene, mode?: CaptionProject['narrationMode']): string | null {
  return mode === 'scenes' ? scene.speech?.id ?? null : null;
}
export function captionTimeLimit(scene: CaptionScene, mode?: CaptionProject['narrationMode']): number {
  const renderDuration = sceneFrameCount(scene.duration) / CAPTION_FPS;
  return mode === 'scenes' && scene.speech ? Math.min(renderDuration, scene.speech.duration) : renderDuration;
}

export function visibleCaptionText(text: string): string {
  return Array.from(text.replace(/\r\n?/g, '\n')).filter((char) => {
    const code = char.codePointAt(0)!;
    return code === 9 || code === 10 || (code >= 32 && code !== 127);
  }).join('').split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

/** 半开帧区间 [start,end)，向内量化，永不越出填写时间或音频边界。 */
export function compileSceneCaptions(scene: CaptionScene, mode?: CaptionProject['narrationMode']): CompiledCaption[] {
  if (!scene.subtitleTimeline) {
    const text = visibleCaptionText(scene.text);
    return text ? [{ text, startFrame: 0, endFrame: sceneFrameCount(scene.duration) }] : [];
  }
  const timeline = subtitleTimelineSchema.parse(scene.subtitleTimeline);
  if (timeline.sourceText !== scene.text.trim() || timeline.sourceSpeechId !== captionSpeechId(scene, mode) || timeline.sourceMode !== (mode ?? 'global')) throw new Error('字幕依据的配音稿、配音版本或模式已改变，请检查并确认时间轴。');
  if (mode === 'scenes' && scene.speech && scene.speech.text !== scene.text.trim()) throw new Error('按镜配音文字已过期，请重新生成或移除配音后确认字幕。');
  const limit = captionTimeLimit(scene, mode);
  const ordered = [...timeline.cues].sort((a, b) => a.start - b.start);
  const ids = new Set<string>();
  let previousEnd = 0;
  return ordered.map((cue, index) => {
    if (ids.has(cue.id)) throw new Error('字幕编号重复，请删除重复条目后重新添加。');
    ids.add(cue.id);
    const text = visibleCaptionText(cue.text);
    if (!text) throw new Error(`第 ${index + 1} 条字幕文字不能为空。`);
    if (cue.end <= cue.start) throw new Error(`第 ${index + 1} 条字幕结束时间必须晚于开始。`);
    if (cue.end > limit + 1e-8) throw new Error(`第 ${index + 1} 条字幕越界，当前上限为 ${limit.toFixed(3)} 秒。`);
    if (index > 0 && cue.start < previousEnd - 1e-8) throw new Error(`第 ${index + 1} 条字幕与上一条重叠。`);
    previousEnd = cue.end;
    const startFrame = Math.ceil(cue.start * CAPTION_FPS - 1e-8);
    const endFrame = Math.floor(cue.end * CAPTION_FPS + 1e-8);
    if (endFrame <= startFrame) throw new Error(`第 ${index + 1} 条字幕量化后不足一帧，请延长时间。`);
    return { text, startFrame, endFrame };
  });
}

export function compileProjectCaptions(project: CaptionProject): CompiledCaption[] {
  let offset = 0;
  return project.scenes.flatMap((scene, index) => {
    let cues: CompiledCaption[];
    try { cues = compileSceneCaptions(scene, project.narrationMode); }
    catch (error) { throw new Error(`分镜 ${index + 1}：${error instanceof Error ? error.message : '字幕时间轴无效。'}`); }
    const result = cues.map((cue) => ({ ...cue, startFrame: offset + cue.startFrame, endFrame: offset + cue.endFrame }));
    offset += sceneFrameCount(scene.duration);
    return result;
  });
}

/** 仅按文字长度分配整数帧，不分析音频，也不声称语音对齐。 */
export function estimateSubtitleTimeline(scene: CaptionScene, mode?: CaptionProject['narrationMode']): SubtitleTimeline {
  const text = visibleCaptionText(scene.text);
  if (!text) throw new Error('请先填写当前分镜配音稿。');
  const sentences = text.split(/(?<=[。！？!?；;\n])/u).filter(Boolean);
  const chunks = sentences.flatMap((part) => {
    const chars = Array.from(part);
    return Array.from({ length: Math.ceil(chars.length / 24) }, (_, index) => chars.slice(index * 24, (index + 1) * 24).join(''));
  });
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (!visibleCaptionText(chunk) && parts.length) parts[parts.length - 1] += chunk;
    else parts.push(chunk);
  }
  const frames = Math.floor(captionTimeLimit(scene, mode) * CAPTION_FPS + 1e-8);
  const count = Math.min(MAX_SCENE_CAPTIONS, parts.length, frames);
  if (count < 1) throw new Error('当前配音不足一帧，无法建立字幕时间轴。');
  const groups = Array.from({ length: count }, (_, index) => parts.slice(Math.floor(index * parts.length / count), Math.floor((index + 1) * parts.length / count)).join(''));
  const totalWeight = groups.reduce((sum, part) => sum + Array.from(part).length, 0);
  let startFrame = 0; let weight = 0;
  const cues = groups.map((part, index) => {
    weight += Array.from(part).length;
    const endFrame = Math.max(startFrame + 1, Math.min(frames - (count - index - 1), Math.round(frames * weight / totalWeight)));
    const cue = { id: crypto.randomUUID(), text: part, start: startFrame / CAPTION_FPS, end: endFrame / CAPTION_FPS };
    startFrame = endFrame;
    return cue;
  });
  return { sourceText: scene.text.trim(), sourceSpeechId: captionSpeechId(scene, mode), sourceMode: mode ?? 'global', timing: 'estimated', cues };
}

/** 只更新依据；必须先通过完整检查，不能借确认静默裁切／重排草稿。 */
export function confirmSubtitleTimeline(scene: CaptionScene, mode?: CaptionProject['narrationMode']): SubtitleTimeline {
  if (!scene.subtitleTimeline) throw new Error('请先建立字幕时间轴。');
  const timeline: SubtitleTimeline = { ...scene.subtitleTimeline, sourceText: scene.text.trim(), sourceSpeechId: captionSpeechId(scene, mode), sourceMode: mode ?? 'global' };
  compileSceneCaptions({ ...scene, subtitleTimeline: timeline }, mode);
  return timeline;
}

export function srtTimestamp(frame: number): string {
  const milliseconds = Math.round(frame * 1000 / CAPTION_FPS);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds % 1000).padStart(3, '0')}`;
}

/** 空行被规范化，HTML 字符转义，避免字幕正文被播放器当成样式标签。 */
export function projectSrt(project: CaptionProject): string {
  const cues = compileProjectCaptions(project);
  if (!cues.length) throw new Error('当前项目没有可导出的字幕。');
  return cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startFrame)} --> ${srtTimestamp(cue.endFrame)}\n${cue.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n`).join('\n');
}
