import { useEffect, useRef, useState } from 'react';
import type { AIResult, AISettingsView, GeneratedScene } from '../shared/ai';
import { sceneReplacementWarning, type Project } from '../shared/project';
import { PreparedTask } from '../shared/task-control';
import { planText, type TextWork } from '../shared/text-plan';
import LongTextWorkspace from './LongTextWorkspace';

type ContentResult = Exclude<AIResult, { kind: 'test' }>;
interface Draft {
  sourceScript: string;
  category: Project['category'];
  instructions: string;
  result: ContentResult;
}
interface Props {
  project: Project;
  disabled: boolean;
  settingsRevision: number;
  onOpenSettings(): void;
  onBusyChange(busy: boolean): void;
  onBeforeTask(): Promise<string>;
  onRewrite(original: string, rewritten: string, instructions: string, model: string): void;
  onStoryboard(scenes: GeneratedScene[]): void;
  onWork(work: TextWork | undefined): void;
  onCheckpoint(work: TextWork): Promise<string>;
}

export default function AIWorkspace(props: Props) {
  const [settings, setSettings] = useState<AISettingsView | null>(null);
  const [instructions, setInstructions] = useState(props.project.textWork?.instructions ?? '');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [running, setRunning] = useState<'rewrite' | 'storyboard' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const activeTask = useRef<PreparedTask | null>(null);
  const configured = Boolean(settings?.hasKey && settings.encryptionAvailable);
  const stale = draft && (draft.sourceScript !== props.project.script || draft.category !== props.project.category);
  const history = props.project.rewriteHistory ?? [];

  useEffect(() => {
    let disposed = false;
    const api = window.desktop;
    if (!api?.getAISettings) return;
    void api.getAISettings().then((value) => {
      if (!disposed) setSettings(value);
    }).catch(() => { if (!disposed) setError('无法读取模型设置，请打开设置检查。'); });
    return () => { disposed = true; };
  }, [props.settingsRevision]);

  useEffect(() => () => { void activeTask.current?.cancel((id) => window.desktop!.cancelAI(id)).catch(() => undefined); }, []);

  function cancel() {
    void activeTask.current?.cancel((id) => window.desktop!.cancelAI(id)).catch(() => setError('取消请求未确认，请检查任务状态；不要重复生成。'));
  }

  async function run(kind: 'rewrite' | 'storyboard') {
    if (activeTask.current || !window.desktop || !settings || !props.project.script.trim()) return;
    if (planText(props.project.script, kind).length > 1) { setError('文案超过单次本地预算，请使用下方长文分段预览，确认分段数量后处理。'); return; }
    if (!window.confirm(`将向 ${settings.settings.baseUrl} 发送当前文案、视频类型和补充要求，模型为 ${settings.settings.model}。本次发送 1 次请求，可能产生费用，不自动重试。是否继续？`)) return;
    const snapshot = { sourceScript: props.project.script, category: props.project.category, instructions };
    const id = crypto.randomUUID();
    const task = new PreparedTask(id); activeTask.current = task;
    setRunning(kind); props.onBusyChange(true); setError(''); setDraft(null); setMessage('正在保存草稿并准备请求，可随时取消……');
    try {
      const outcome = await task.run(props.onBeforeTask, (workspaceId) => window.desktop!.runAI({ id, kind, workspaceId, script: snapshot.sourceScript, category: snapshot.category, instructions }));
      if (!outcome) { setMessage('AI 请求已取消，尚未发送模型请求。'); return; }
      if (!outcome.ok) {
        setMessage(outcome.error.code === 'cancelled' ? outcome.error.message : '');
        if (outcome.error.code !== 'cancelled') setError(outcome.error.message);
      } else if (outcome.result.kind !== 'test') {
        setDraft({ ...snapshot, result: outcome.result });
        const tokens = outcome.result.usage?.totalTokens;
        setMessage(`已生成候选，尚未修改项目。${tokens === undefined ? '服务未报告 Token 用量。' : `服务报告用量：${tokens} Token（非价格）。`}`);
      }
    } catch {
      if (task.isCancelled) setMessage('AI 请求已取消；请核对草稿状态，未自动重发。');
      else { setError('AI 请求未完成，请检查客户端状态后手动重试。'); setMessage(''); }
    } finally { activeTask.current = null; setRunning(null); props.onBusyChange(false); }
  }

  function adopt() {
    if (!draft || stale) return;
    if (draft.result.kind === 'rewrite') {
      props.onRewrite(draft.sourceScript, draft.result.text, draft.instructions, draft.result.model);
      setMessage('已采用改写，原文保存在改写记录中。现有分镜保持不变，需要时请重新生成分镜。');
    } else {
      if (!window.confirm(sceneReplacementWarning(props.project.scenes))) return;
      props.onStoryboard(draft.result.scenes);
      setMessage('已采用 AI 分镜。可继续编辑画面描述、提示词和时长，再到生图面板生成图片，或手动导入。');
    }
    setDraft(null);
  }

  return <section className="panel ai-workspace" aria-label="AI 文案与分镜">
    <div className="panel-heading"><h2>AI 文案与分镜</h2><button className="text-button" disabled={props.disabled} onClick={props.onOpenSettings}>模型设置</button></div>
    <div className="ai-workspace-content">
      <p className="ai-provider">{configured ? `${settings!.settings.model} · ${settings!.settings.baseUrl}` : '尚未配置可用文本模型。可以先完成本地编辑，稍后在模型设置中填写。'}</p>
      <label>补充要求<textarea aria-label="AI 补充要求" maxLength={2000} rows={2} disabled={props.disabled} placeholder="例如：保持原意，语气自然，适合一分钟讲解。" value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>
      <div className="ai-actions"><button className="button" disabled={props.disabled || !configured || !props.project.script.trim()} onClick={() => void run('rewrite')}>AI 改写文案</button><button className="button" disabled={props.disabled || !configured || !props.project.script.trim()} onClick={() => void run('storyboard')}>AI 生成分镜</button>{running && <button className="button" onClick={cancel}>取消 AI 请求</button>}</div>
      <p className="field-help">上方短文操作仅发送 1 次请求；超过本地预算请使用下方分段处理。可能计费，结果只作候选，确认采用后才修改正文／分镜。图片与配音独立生成。</p>
      <LongTextWorkspace project={props.project} settings={settings} instructions={instructions} disabled={props.disabled} onBusyChange={props.onBusyChange} onWork={props.onWork} onCheckpoint={props.onCheckpoint} onRewrite={props.onRewrite} onStoryboard={props.onStoryboard} />
      {error && <div className="ai-error" role="alert">{error}</div>}
      {message && <p className="ai-status" role="status">{message}</p>}
      {draft && <section className="ai-candidate" aria-label="AI 候选结果"><h3>{draft.result.kind === 'rewrite' ? '文案改写候选' : `分镜候选 · ${draft.result.scenes.length} 镜`}</h3>
        {draft.result.kind === 'rewrite' ? <div className="rewrite-comparison"><div><h4>原文</h4><pre>{draft.sourceScript}</pre></div><div><h4>改写结果</h4><pre>{draft.result.text}</pre></div></div> : <ol className="generated-scenes">{draft.result.scenes.map((scene, index) => <li key={index}><strong>{scene.text}</strong><p>画面：{scene.description}</p><p>提示词：{scene.prompt}</p><small>{scene.duration}s · {scene.motion === 'zoom' ? '缓慢推进' : '静态'}</small></li>)}</ol>}
        {stale && <p className="ai-error">文案或视频类别已改变，此候选不能采用，请重新生成。</p>}
        <div className="ai-actions"><button className="button primary" disabled={props.disabled || Boolean(stale)} onClick={adopt}>采用{draft.result.kind === 'rewrite' ? '改写' : '分镜'}</button><button className="button" disabled={props.disabled} onClick={() => { setDraft(null); setMessage('候选已丢弃，项目未修改。'); }}>丢弃候选</button></div>
      </section>}
      {history.length > 0 && <details className="rewrite-history"><summary>已采用改写记录（{history.length}，最多保留最近 100 条）</summary>{[...history].reverse().map((item) => <article key={item.id}><h4>{new Date(item.createdAt).toLocaleString()} · {item.model}</h4><details><summary>原文与结果</summary><h4>原文</h4><pre>{item.original}</pre><h4>采用结果</h4><pre>{item.rewritten}</pre></details></article>)}</details>}
    </div>
  </section>;
}
