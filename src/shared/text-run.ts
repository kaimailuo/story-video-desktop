import type { AIOutcome, AIRequest } from './ai';
import { PreparedTask } from './task-control';
import { inspectCoverage, partComplete, partResultSchema, sourceUnits, textWorkSchema, type TextWork } from './text-plan';

export class TextRunControl {
  cancelled = false;
  task: PreparedTask | null = null;
  async cancel(forward: (id: string) => Promise<void>): Promise<void> {
    this.cancelled = true;
    await this.task?.cancel(forward);
  }
}

/** 每段先保存，单次提交；停止于首错，成功结果在后续请求前再次落盘。 */
export async function runTextWork(options: {
  work: TextWork; indices: number[]; control: TextRunControl;
  checkpoint(work: TextWork): Promise<string>; onWork(work: TextWork): void;
  request(request: AIRequest): Promise<AIOutcome>;
}): Promise<TextWork> {
  let work = textWorkSchema.parse(structuredClone(options.work));
  const indices = options.indices;
  if (!indices.length || new Set(indices).size !== indices.length || indices.some((i, n) => !Number.isInteger(i) || i < 0 || i >= work.parts.length || (n > 0 && i < indices[n - 1]) || partComplete(work.parts[i]))) throw new Error('只能按原文顺序显式处理未完成段；不会重发成功段。');
  try {
    for (const index of indices) {
      if (options.control.cancelled) break;
      const task = new PreparedTask(crypto.randomUUID()); options.control.task = task;
      const part = work.parts[index];
      const outcome = await task.run(() => options.checkpoint(work), (workspaceId) => options.request({
        id: task.id, kind: work.kind, script: part.text, category: work.category, instructions: work.instructions,
        workspaceId, segment: { index: index + 1, total: work.parts.length },
      }));
      const result = outcome?.ok && outcome.result.kind !== 'test' ? partResultSchema.safeParse(outcome.result) : null;
      let error: string | undefined;
      if (!outcome) error = '已取消，尚未发送本段请求。';
      else if (!outcome.ok) error = outcome.error.message;
      else if (!result?.success || result.data.kind !== work.kind || result.data.coverage.sourceCount !== sourceUnits(part.text).length || (result.data.kind === 'storyboard' && result.data.coverage.groups.length !== result.data.scenes.length)) error = '分段结果缺少有效覆盖映射，未采用；不会自动重发。';
      else if (!inspectCoverage(result.data.coverage).valid) error = '来源映射有遗漏、重复、越界或乱序，请核对后显式补跑。';
      const consistent = result?.success && result.data.kind === work.kind && result.data.coverage.sourceCount === sourceUnits(part.text).length && (result.data.kind !== 'storyboard' || result.data.coverage.groups.length === result.data.scenes.length);
      work = { ...work, parts: work.parts.map((value, i) => i === index ? { ...value, result: consistent ? result.data : undefined, error } : value) };
      options.onWork(work);
      await options.checkpoint(work);
      if (error || options.control.cancelled) break;
    }
    return work;
  } finally { options.control.task = null; }
}
