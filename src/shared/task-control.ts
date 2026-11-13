/** 将取消覆盖到保存检查点与 IPC 提交之间；不缓存、不重发生成请求。 */
export class PreparedTask {
  private cancelled = false;
  private submitted = false;
  private started = false;

  constructor(readonly id: string) {}

  get isCancelled(): boolean { return this.cancelled; }

  async cancel(send: (id: string) => Promise<void>): Promise<void> {
    this.cancelled = true;
    if (this.submitted) await send(this.id);
  }

  async run<T>(checkpoint: () => Promise<string>, submit: (workspaceId: string) => Promise<T>): Promise<T | null> {
    if (this.started) throw new Error('同一任务不能重复提交。');
    this.started = true;
    if (this.cancelled) return null;
    const workspaceId = await checkpoint();
    if (this.cancelled) return null;
    // 此处到 submit 调用之间没有 await，取消事件不会插入二者之间。
    this.submitted = true;
    return submit(workspaceId);
  }
}

/** 每镜保留最新成功候选；失败独立展示，不挤掉此前的成功结果。 */
export function mergeCandidateItems<T extends { sceneId: string; ok: boolean }>(previous: T[], incoming: T[]): T[] {
  const next = new Map(incoming.map((item) => [item.sceneId, item]));
  return [...previous.filter((item) => {
    const replacement = next.get(item.sceneId);
    return !replacement || (!replacement.ok && item.ok);
  }), ...incoming];
}
