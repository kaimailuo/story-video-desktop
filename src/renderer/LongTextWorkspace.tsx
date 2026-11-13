import { useEffect, useRef, useState } from 'react';
import type { AISettingsView, GeneratedScene } from '../shared/ai';
import type { Project } from '../shared/project';
import { sceneReplacementWarning } from '../shared/project';
import { inspectCoverage, mergeTextWork, partComplete, planText, sourceUnits, type TextWork } from '../shared/text-plan';
import { runTextWork, TextRunControl } from '../shared/text-run';

export default function LongTextWorkspace({ project, settings, instructions, disabled, onBusyChange, onWork, onCheckpoint, onRewrite, onStoryboard }: {
  project: Project; settings: AISettingsView | null; instructions: string; disabled: boolean;
  onBusyChange(value: boolean): void; onWork(work: TextWork | undefined): void; onCheckpoint(work: TextWork): Promise<string>;
  onRewrite(original: string, rewritten: string, instructions: string, model: string): void;
  onStoryboard(scenes: GeneratedScene[]): void;
}) {
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const active = useRef<TextRunControl | null>(null);
  const work = project.textWork;
  const stale = work && (work.sourceScript !== project.script || work.category !== project.category || work.instructions !== instructions);
  const configured = Boolean(settings?.hasKey && settings.encryptionAvailable);
  useEffect(() => () => { void active.current?.cancel((id) => window.desktop!.cancelAI(id)).catch(() => undefined); }, []);
  function plan(kind: TextWork['kind']) {
    if (!project.script.trim()) return;
    if (work?.parts.some((part) => part.result) && !window.confirm('重新规划会替换当前保存的分段候选；任务产物文件不会删除。是否继续？')) return;
    onWork({ sourceScript: project.script, category: project.category, instructions, kind, parts: planText(project.script, kind) });
    setMessage('已生成本地分段预览，尚未发送请求。可展开每段核对原文范围。');
  }
  async function run(indices: number[]) {
    if (!work || stale || active.current || !settings || !window.desktop || !indices.length) return;
    if (!window.confirm(`将向 ${settings.settings.baseUrl} 使用模型 ${settings.settings.model}，按序处理所选 ${indices.length} 段，最多 ${indices.length} 次请求，每次输出上限 4096 Token（不是精确用量或价格）。只发送各段原文、类别、补充要求与来源编号；跨段一致性不保证。可能计费，遇错停止，不自动重试；成功段不重发。是否继续？`)) return;
    const control = new TextRunControl(); active.current = control; setRunning(true); onBusyChange(true); setMessage('正在保存并串行处理分段，可取消后续提交……');
    try {
      const latest = await runTextWork({ work, indices, control, checkpoint: onCheckpoint, onWork, request: (request) => window.desktop!.runAI(request) });
      setMessage(`已保存 ${latest.parts.filter(partComplete).length}/${latest.parts.length} 段有效候选。${control.cancelled ? '已取消后续提交；在途请求可能已计费。' : '遇错停止，未自动补跑；请查看覆盖明细。'}`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '处理未完成，成功候选保留；请核对任务与草稿，不要盲目重发。'); }
    finally { active.current = null; setRunning(false); onBusyChange(false); }
  }
  let merged: ReturnType<typeof mergeTextWork> | undefined; let mergeError = '';
  if (work) { try { merged = mergeTextWork(work); } catch (cause) { mergeError = cause instanceof Error ? cause.message : '不能合并'; } }
  const remaining = work?.parts.flatMap((part, i) => partComplete(part) ? [] : [i]) ?? [];
  return <section className="long-text-workspace" aria-label="长文分段与覆盖检查">
    <h3>长文分段与覆盖检查</h3>
    <p className="field-help">本地按句子／段落边界分段：分镜每段最多 600 字符，改写最多 1200 字符（UTF-16 计数）。先预览，再确认调用；保留逐段候选，可保存／重开后显式补跑。来源映射只检查处理范围，不证明语义忠实、事实正确或跨段人物一致。</p>
    <div className="ai-actions"><button className="button small" disabled={disabled || !project.script.trim()} onClick={() => plan('rewrite')}>预览改写分段</button><button className="button small" disabled={disabled || !project.script.trim()} onClick={() => plan('storyboard')}>预览分镜分段</button></div>
    {work && <>
      <p className="ai-status" role="status">{work.kind === 'rewrite' ? '改写' : '分镜'}计划 · {work.parts.length} 段 · 有效候选 {work.parts.filter(partComplete).length} 段 · 尚需处理／核对 {remaining.length} 段</p>
      {stale && <p className="ai-error">原文、类别或补充要求已改变，此分段计划已过期，不能补跑或采用；请重新规划。</p>}
      <div className="ai-actions"><button className="button small" disabled={disabled || !configured || Boolean(stale) || !remaining.length} onClick={() => void run(remaining)}>确认处理未完成段</button>{running && <button className="button small" onClick={() => { void active.current?.cancel((id) => window.desktop!.cancelAI(id)).catch(() => setMessage('取消未确认，请核对任务状态，勿重复生成。')); }}>取消分段处理</button>}</div>
      {work.parts.map((part, index) => {
        const coverage = part.result ? inspectCoverage(part.result.coverage) : null;
        return <details key={`${part.start}-${part.end}`} className="text-part"><summary>第 {index + 1} 段 · 原文 [{part.start}, {part.end}) · {partComplete(part) ? '映射完整／待人工审阅' : part.error ? '失败／待核对' : '未处理'}</summary>
          <pre>{part.text}</pre><p className="field-help">{sourceUnits(part.text).length} 个原文单元；起止偏移从 0 开始，包含空白与标点。</p>
          {part.error && <p className="ai-error">{part.error}</p>}
          {coverage && <p className="field-help">遗漏编号：{coverage.missing.join('、') || '无'}；重复编号：{coverage.duplicate.join('、') || '无'}；越界：{coverage.invalid ? '有' : '无'}；顺序异常：{coverage.outOfOrder ? '有' : '无'}。此为模型声明的来源映射，不是语义覆盖证明。</p>}
          {part.result?.kind === 'rewrite' && <pre>{part.result.text}</pre>}
          {part.result?.kind === 'storyboard' && <ol>{part.result.scenes.map((scene, i) => <li key={i}>{scene.text}<p className="field-help">来源单元：{part.result?.coverage.groups[i]?.join('、')}</p></li>)}</ol>}
          <button className="button small" disabled={disabled || !configured || Boolean(stale) || partComplete(part)} onClick={() => void run([index])}>仅处理此段</button>
        </details>;
      })}
      {mergeError && <p className="field-help">{mergeError}</p>}
      <div className="ai-actions"><button className="button primary" disabled={disabled || Boolean(stale) || !merged} onClick={() => {
        if (!merged) return;
        if (!window.confirm(merged.kind === 'storyboard' ? sceneReplacementWarning(project.scenes) : '确认采用全部分段改写？将替换当前文案并保留原文改写记录，现有分镜不变。来源映射完整不保证内容忠实，请先人工审阅。')) return;
        if (merged.kind === 'rewrite') onRewrite(work.sourceScript, merged.text, work.instructions, [...new Set(work.parts.map((part) => part.result?.model ?? ''))].join('、').slice(0, 200));
        else onStoryboard(merged.scenes);
        onWork(undefined); setMessage('已整体采用分段结果，请保存项目。');
      }}>整体采用分段结果</button><button className="text-button" disabled={disabled} onClick={() => { if (window.confirm('丢弃当前分段计划与候选引用？不会删除任务产物或调用模型。')) onWork(undefined); }}>丢弃分段计划</button></div>
    </>}
    {message && <p className="ai-status" role="status">{message}</p>}
  </section>;
}
