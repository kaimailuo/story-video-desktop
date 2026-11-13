import { useEffect, useRef, useState } from 'react';
import type { AISettingsView } from '../shared/ai';
import { imageSizes, type ImageItem, type ImageProgress, type ImageRequest, type ImageVersion } from '../shared/images';
import type { Project, Scene } from '../shared/project';
import { mergeCandidateItems, PreparedTask } from '../shared/task-control';

interface Props {
  project: Project;
  selected: number;
  disabled: boolean;
  settingsRevision: number;
  onOpenSettings(): void;
  onBusyChange(busy: boolean): void;
  onBeforeTask(): Promise<string>;
  onUse(sceneId: string, version: ImageVersion, preview: string): void;
}

export default function ImageWorkspace(props: Props) {
  const [settings, setSettings] = useState<AISettingsView | null>(null);
  const [size, setSize] = useState<ImageRequest['size']>('1024x1024');
  const [items, setItems] = useState<ImageItem[]>([]);
  const [progress, setProgress] = useState<ImageProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const activeTask = useRef<PreparedTask | null>(null);
  const configured = Boolean(settings?.hasKey && settings.encryptionAvailable);
  const scene = props.project.scenes[props.selected] ?? props.project.scenes[0];

  useEffect(() => {
    let disposed = false;
    const api = window.desktop;
    if (!api?.getImageSettings) return;
    void api.getImageSettings().then((view) => { if (!disposed) setSettings(view); }).catch(() => { if (!disposed) setError('无法读取图片模型设置，请重启客户端或检查配置。'); });
    return () => { disposed = true; };
  }, [props.settingsRevision]);

  useEffect(() => {
    const unsubscribe = window.desktop?.onImageProgress?.((event) => { if (event.jobId === activeTask.current?.id) setProgress(event); });
    return () => { unsubscribe?.(); void activeTask.current?.cancel((id) => window.desktop!.cancelAI(id)).catch(() => undefined); };
  }, []);

  function cancel() {
    void activeTask.current?.cancel((id) => window.desktop!.cancelAI(id)).catch(() => setError('取消请求未确认，请检查任务状态；不要重复生成。'));
  }

  async function generate(scenes: Scene[]) {
    if (activeTask.current || !window.desktop?.generateImages || !settings || !scenes.length) return;
    if (scenes.some((item) => !item.prompt.trim())) { setError('本次范围内有空提示词，请先逐镜填写绘图提示词。'); return; }
    if (!window.confirm(`将向 ${settings.settings.baseUrl} 使用模型 ${settings.settings.model}，逐镜发送最多 ${scenes.length} 次生图请求，每次 1 张，尺寸 ${size}。仅发送绘图提示词，不上传已有图片；可能计费，不自动重试。结果需逐张确认采用，是否继续？`)) return;
    const id = crypto.randomUUID();
    const task = new PreparedTask(id); activeTask.current = task;
    setRunning(true); props.onBusyChange(true); setError(''); setMessage('正在生成候选，不会自动替换图片……');
    setProgress({ jobId: id, completed: 0, total: scenes.length, message: '准备生图' });
    try {
      const outcome = await task.run(props.onBeforeTask, (workspaceId) => window.desktop!.generateImages({ id, workspaceId, size, scenes: scenes.map((item) => ({ sceneId: item.id, prompt: item.prompt.trim() })) }));
      if (!outcome) { setMessage('生图任务已取消，尚未发送生成请求。'); return; }
      if (!outcome.ok) { setError(outcome.error.message); setMessage(''); return; }
      const batch = outcome.batch;
      if (batch.warning) setError(batch.warning);
      setItems((old) => mergeCandidateItems(old, batch.items));
      const success = batch.items.filter((item) => item.ok).length;
      setMessage(`${batch.state === 'cancelled' ? '生图已取消' : batch.state === 'stopped' ? '生图已停止' : '生图已完成'}：成功 ${success}，失败 ${batch.items.length - success}，未执行 ${batch.total - batch.items.length}。成功候选已保留，请逐张确认。取消／超时不保证服务端停止计费。`);
    } catch {
      if (task.isCancelled) setMessage('生图任务已取消；请核对草稿状态，未自动重发。');
      else { setError('生图任务未完成，请检查客户端状态；不要盲目重复调用。'); setMessage(''); }
    } finally { activeTask.current = null; setRunning(false); props.onBusyChange(false); }
  }

  function adopt(item: ImageItem & { ok: true }) {
    const current = props.project.scenes.find((entry) => entry.id === item.sceneId);
    if (!current || current.prompt.trim() !== item.prompt) return;
    props.onUse(item.sceneId, item.candidate, item.candidate.preview);
    setItems((old) => old.filter((entry) => entry !== item));
    setMessage('已采用图片并保留旧图版本引用；请保存项目。');
  }

  async function restore(version: ImageVersion) {
    if (!window.desktop || props.disabled) return;
    props.onBusyChange(true); setError('');
    try {
      const preview = await window.desktop.previewImage(version.path);
      props.onUse(scene.id, version, preview);
      setMessage('已切换图片版本，未发起生图请求；请保存项目。');
    } catch { setError('该版本素材已缺失或无法读取，当前图片保持不变。'); }
    finally { props.onBusyChange(false); }
  }

  return <section className="panel ai-workspace" aria-label="AI 分镜生图">
    <div className="panel-heading"><h2>AI 分镜生图</h2><button className="text-button" disabled={props.disabled} onClick={props.onOpenSettings}>图片模型设置</button></div>
    <div className="ai-workspace-content">
      <p className="ai-provider">{configured ? `${settings!.settings.model} · ${settings!.settings.baseUrl}` : '尚未配置图片模型；与文本模型独立保存，不会自动复用文本 Key。'}</p>
      <label>生成尺寸<select aria-label="生图尺寸" disabled={props.disabled} value={size} onChange={(event) => setSize(event.target.value as ImageRequest['size'])}>{imageSizes.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <div className="ai-actions"><button className="button" disabled={props.disabled || !configured || !scene.prompt.trim()} onClick={() => void generate([scene])}>生成当前分镜图片</button><button className="button" disabled={props.disabled || !configured || !props.project.scenes.some((item) => !item.imagePath)} onClick={() => void generate(props.project.scenes.filter((item) => !item.imagePath))}>批量生成缺图分镜</button><button className="button" disabled={props.disabled || !configured} onClick={() => void generate(props.project.scenes)}>重新生成全部分镜图片</button>{running && <button className="button" onClick={cancel}>取消生图任务</button>}</div>
      <p className="field-help">先编辑右侧绘图提示词。每镜一次请求、串行执行；尺寸需模型支持，导出时再按画布裁切。认证失败、限流或落盘失败停止后续调用。每镜保留最新成功候选，后续失败单独显示，不覆盖成功候选。版本只保存最近 20 个引用；丢弃候选不会删除本机文件，未采用候选不随项目恢复。</p>
      {running && progress && <div className="image-progress" role="status"><span>{progress.message}</span><progress max={progress.total} value={progress.completed} /></div>}
      {message && <p className="ai-status" role="status">{message}</p>}
      {error && <div className="ai-error" role="alert">{error}</div>}
      <div className="image-candidates">{items.map((item) => {
        const index = props.project.scenes.findIndex((entry) => entry.id === item.sceneId);
        const stale = index < 0 || props.project.scenes[index].prompt.trim() !== item.prompt;
        return <article className="ai-candidate image-candidate" key={`${item.sceneId}-${item.ok ? 'success' : 'error'}`} aria-label={`分镜 ${index < 0 ? '已移除' : index + 1} 图片候选`}>
          <h3>分镜 {index < 0 ? '已移除' : index + 1} · {item.ok ? '图片候选' : '生成失败'}</h3>
          {item.ok ? <><img src={item.candidate.preview} alt={`分镜 ${index + 1} 生图候选`} /><p className="field-help">{item.prompt}</p>{stale && <p className="ai-error">提示词已改变或分镜已删除，不能采用此候选。</p>}<div className="ai-actions"><button className="button primary" disabled={props.disabled || stale} onClick={() => adopt(item)}>采用此图片</button><button className="button" disabled={props.disabled} onClick={() => setItems((old) => old.filter((entry) => entry !== item))}>丢弃此候选</button></div></> : <p className="ai-error">{item.error.message}</p>}
        </article>;
      })}</div>
      {(scene.imageVersions?.length ?? 0) > 0 && <details className="image-versions"><summary>当前分镜图片版本（{scene.imageVersions!.length}）</summary>{[...scene.imageVersions!].reverse().map((version) => <div key={version.id}><span>{version.source === 'generated' ? version.model : '本地素材'} · {new Date(version.createdAt).toLocaleString()}</span><button className="button small" disabled={props.disabled || scene.imagePath === version.path} onClick={() => void restore(version)}>{scene.imagePath === version.path ? '当前图片' : '使用此版本'}</button></div>)}</details>}
    </div>
  </section>;
}
