import { z } from 'zod';
import { generatedSceneSchema } from './ai';

export interface SourceUnit { id: number; start: number; end: number; text: string }
/** UTF-16 偏移，与 textarea 一致；不切开代理对，不丢空白或标点。 */
export function sourceUnits(text: string): SourceUnit[] {
  const units: SourceUnit[] = []; let start = 0; let length = 0;
  for (const character of text) {
    if (length + character.length > 180) {
      units.push({ id: units.length + 1, start, end: start + length, text: text.slice(start, start + length) });
      start += length; length = 0;
    }
    length += character.length;
    if (/[。！？!?\n]/u.test(character)) {
      units.push({ id: units.length + 1, start, end: start + length, text: text.slice(start, start + length) });
      start += length; length = 0;
    }
  }
  if (length) units.push({ id: units.length + 1, start, end: text.length, text: text.slice(start) });
  return units;
}
export function planText(text: string, kind: 'rewrite' | 'storyboard'): { start: number; end: number; text: string }[] {
  const maximum = kind === 'storyboard' ? 600 : 1200;
  const parts: { start: number; end: number; text: string }[] = [];
  for (const unit of sourceUnits(text)) {
    const last = parts.at(-1);
    if (last && unit.end - last.start <= maximum) { last.end = unit.end; last.text += unit.text; }
    else parts.push({ start: unit.start, end: unit.end, text: unit.text });
  }
  return parts;
}
export const coverageSchema = z.object({
  sourceCount: z.number().int().min(1).max(1200),
  groups: z.array(z.array(z.number().int().min(1).max(1200)).min(1).max(1200)).min(1).max(100).refine((groups) => groups.reduce((sum, group) => sum + group.length, 0) <= 2400, '来源映射过大。'),
});
export type SourceCoverage = z.infer<typeof coverageSchema>;
export function inspectCoverage(coverage: SourceCoverage) {
  const ids = coverage.groups.flat(); const seen = new Set<number>(); const repeated = new Set<number>();
  for (const id of ids) { if (seen.has(id)) repeated.add(id); seen.add(id); }
  const missing = Array.from({ length: coverage.sourceCount }, (_, i) => i + 1).filter((id) => !seen.has(id));
  const duplicate = [...repeated];
  const invalid = ids.some((id) => !Number.isInteger(id) || id < 1 || id > coverage.sourceCount);
  const outOfOrder = ids.some((id, i) => i > 0 && id < ids[i - 1]);
  return { missing, duplicate, invalid, outOfOrder, valid: !missing.length && !duplicate.length && !invalid && !outOfOrder };
}
export const partResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rewrite'), text: z.string().min(1).max(30000), model: z.string().max(200), coverage: coverageSchema }),
  z.object({ kind: z.literal('storyboard'), scenes: z.array(generatedSceneSchema).min(1).max(100), model: z.string().max(200), coverage: coverageSchema }),
]);
export const textWorkSchema = z.object({
  sourceScript: z.string().min(1).max(30000), category: z.enum(['story', 'novel', 'knowledge']),
  instructions: z.string().max(2000), kind: z.enum(['rewrite', 'storyboard']),
  parts: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1).max(1200), result: partResultSchema.optional(), error: z.string().max(1000).optional() })).min(1).max(100),
}).superRefine((work, context) => {
  const expected = planText(work.sourceScript, work.kind);
  if (expected.length !== work.parts.length || expected.some((part, i) => part.start !== work.parts[i]?.start || part.end !== work.parts[i]?.end || part.text !== work.parts[i]?.text)) context.addIssue({ code: z.ZodIssueCode.custom, message: '分段与原文不一致。' });
  work.parts.forEach((part, i) => {
    if (part.result && (part.result.kind !== work.kind || part.result.coverage.sourceCount !== sourceUnits(part.text).length || (part.result.kind === 'storyboard' && part.result.coverage.groups.length !== part.result.scenes.length))) context.addIssue({ code: z.ZodIssueCode.custom, path: ['parts', i], message: '结果类型或来源映射与分段不一致。' });
  });
});
export type TextWork = z.infer<typeof textWorkSchema>;
export function partComplete(part: TextWork['parts'][number]): boolean {
  return Boolean(part.result && !part.error && inspectCoverage(part.result.coverage).valid);
}
export function mergeTextWork(raw: TextWork) {
  const work = textWorkSchema.parse(raw);
  if (!work.parts.every(partComplete)) throw new Error('仍有未处理、失败或覆盖异常的分段，不能整体采用。');
  if (work.kind === 'rewrite') {
    const text = work.parts.map((part) => part.result?.kind === 'rewrite' ? part.result.text : '').join('\n');
    if (text.length > 30000) throw new Error('合并改写超过 30000 字符，不能采用；未截断结果。');
    return { kind: 'rewrite' as const, text };
  }
  const scenes = work.parts.flatMap((part) => part.result?.kind === 'storyboard' ? part.result.scenes : []);
  if (scenes.length > 100) throw new Error(`合并后共 ${scenes.length} 镜，超过当前 100 镜上限；请缩短文案或分项目制作，未静默丢弃。`);
  return { kind: 'storyboard' as const, scenes };
}
