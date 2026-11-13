import { useEffect, useRef, useState } from 'react';
import type { AISettingsView } from '../shared/ai';
import type { Project, Scene } from '../shared/project';
import { speechSceneDuration, type SpeechClip, type SpeechItem, type SpeechProgress } from '../shared/speech';
import { mergeCandidateItems, PreparedTask } from '../shared/task-control';

function LocalSpeechPlayer({ clip, disabled }: { clip: SpeechClip; disabled: boolean }) {
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function load() {
    if (!window.desktop?.previewSpeech || loading) return;
    setLoading(true); setError('');
    try {
      const data = await window.desktop.previewSpeech(clip.path);
      if (mounted.current) setSource(data);
    } catch { if (mounted.current) setError('无法读取配音，请检查本地文件或重新生成。'); }
    finally { if (mounted.current) setLoading(false); }
  }
  return <div className="speech-player">
    {!source ? <button className="button small" disabled={disabled || loading} onClick={() => void load()}>{loading ? '读取中……' : '加载试听'}</button> : <audio aria-label="本地配音试听" controls preload="metadata" src={source} onError={() => setError('音频解码失败，请重新生成支持的 WAV。')} onPlay={(event) => { document.querySelectorAll('audio').forEach((audio) => { if (audio !== event.currentTarget) audio.pause(); }); }} />}
    {error && <p className="ai-error" role="alert">{error}</p>}
  </div>;
}

interface Props {
  project: Project;
  selected: number;
  disabled: boolean;
  settingsRevision: number;
  onOpenSettings(): void;
  onBusyChange(busy: boolean): void;
  onBeforeTask(): Promise<string>;
  onChange(changes: Partial<Project>): void;
  onUse(sceneId: string, clip: SpeechClip): void;
}

export default function SpeechWorkspace(props: Props) {
  const [settings, setSettings] = useState<AISettingsView | null>(null);
  const [items, setItems] = useState<SpeechItem[]>([]);
  const [progress, setProgress] = useState<SpeechProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const activeTask = useRef<PreparedTask | null>(null);
  const scene = props.project.scenes[props.selected] ?? props.project.scenes[0];
  const options = props.project.speechOptions ?? { voice: '', speed: 1 };
  const configured = Boolean(settings?.hasKey && settings.encryptionAvailable && options.voice.trim());
  const missing = props.project.scenes.filter((item) => !item.speech || item.speech.text !== item.text.trim());

  useEffect(() => {
    let disposed = false;
    void window.desktop?.getSpeechSettings?.().then((view) => { if (!disposed) setSettings(view); }).catch(() => { if (!disposed) setError('无法读取配音配置，请重启新版客户端或检查设置。'); });
    return () => { disposed = true; };
  }, [props.settingsRevision]);
  useEffect(() => {
    const unsubscribe = window.desktop?.onSpeechProgress?.((event) => { if (event.jobId === activeTask.current?.id) setProgress(event); });
    return () => { unsubscribe?.(); void activeTask.current?.cancel((id) => window.desktop!.cancelAI(id)).catch(() => undefined); };
  }, []);

  function cancel() {
    void activeTask.current?.cancel((id) => window.desktop!.cancelAI(id)).catch(() => setError('取消请求未确认，请检查任务状态；不要重复生成。'));
  }

  async function generate(scenes: Scene[]) {
    if (activeTask.current || !settings || !window.desktop?.generateSpeech || !scenes.length) return;
    if (scenes.some((item) => !item.text.trim())) { setError('本次范围内有空配音稿，请先填写每镜配音文字。'); return; }
    if (!window.confirm(`将向 ${settings.settings.baseUrl} 使用模型 ${settings.settings.model}，逐镜发送最多 ${scenes.length} 次配音请求。音色 ${options.voice.trim()}，语速 ${options.speed}。仅发送各镜配音稿，不发送独立字幕时间轴、图片或音频；可能计费，不自动重试。结果需试听并确认采用，采用后将调整镜头时长并切为按镜配音模式，已有字幕时间轴需要检查确认，是否继续？`)) return;
    const id = crypto.randomUUID(); const task = new PreparedTask(id); activeTask.current = task;
    setRunning(true); props.onBusyChange(true); setError(''); setMessage('正在生成配音候选，不会自动修改镜头……');
    setProgress({ jobId: id, total: scenes.length, completed: 0, message: '准备配音' });
    try {
      const outcome = await task.run(props.onBeforeTask, (workspaceId) => window.desktop!.generateSpeech({ id, workspaceId, ...options, voice: options.voice.trim(), scenes: scenes.map((item) => ({ sceneId: item.id, text: item.text.trim() })) }));
      if (!outcome) { setMessage('配音任务已取消，尚未发送生成请求。'); return; }
      if (!outcome.ok) { setError(outcome.error.message); setMessage(''); return; }
      const batch = outcome.batch;
      if (batch.warning) setError(batch.warning);
      setItems((old) => mergeCandidateItems(old, batch.items));
      const success = batch.items.filter((item) => item.ok).length;
      setMessage(`${batch.state === 'cancelled' ? '配音已取消' : batch.state === 'stopped' ? '配音已停止' : '配音已完成'}：成功 ${success}，失败 ${batch.items.length - success}，未执行 ${batch.total - batch.items.length}。成功候选已保留，需确认采用；取消／超时不保证服务端停止计费。`);
    } catch {
      if (task.isCancelled) setMessage('配音任务已取消；请核对草稿状态，未自动重发。');
      else { setError('配音任务未完成，请检查客户端状态，不要盲目重复调用。'); setMessage(''); }
    } finally { activeTask.current = null; setRunning(false); props.onBusyChange(false); }
  }

  return <section className="panel ai-workspace" aria-label="AI 按镜配音">
    <div className="panel-heading"><h2>AI 按镜配音</h2><button className="text-button" disabled={props.disabled} onClick={props.onOpenSettings}>配音模型设置</button></div>
    <div className="ai-workspace-content">
      <p className="ai-provider">{settings?.hasKey ? `${settings.settings.model} · ${settings.settings.baseUrl}` : '尚未配置配音模型；与文本、图片模型独立，不复用 Key。'}</p>
      <label>导出配音模式<select aria-label="导出配音模式" disabled={props.disabled} value={props.project.narrationMode ?? 'global'} onChange={(event) => props.onChange({ narrationMode: event.target.value as 'global' | 'scenes' })}><option value="global">全片配音（导入音频）</option><option value="scenes">按镜配音（缺配音镜头静音）</option></select></label>
      <div className="form-row"><label>音色标识<input aria-label="配音音色标识" maxLength={200} disabled={props.disabled} placeholder="填写服务商提供的 voice 标识" value={options.voice} onChange={(event) => props.onChange({ speechOptions: { ...options, voice: event.target.value } })} /></label><label>语速<input aria-label="配音语速" type="number" min={0.25} max={4} step={0.05} disabled={props.disabled} value={options.speed} onChange={(event) => { const speed = event.target.valueAsNumber; if (Number.isFinite(speed)) props.onChange({ speechOptions: { ...options, speed: Math.max(0.25, Math.min(4, speed)) } }); }} /></label></div>
      <div className="ai-actions"><button className="button" disabled={props.disabled || !configured || !scene.text.trim()} onClick={() => void generate([scene])}>生成当前分镜配音</button><button className="button" disabled={props.disabled || !configured || !missing.length} onClick={() => void generate(missing)}>批量生成缺失或过期配音</button><button className="button" disabled={props.disabled || !configured} onClick={() => void generate(props.project.scenes)}>重新生成全部分镜配音</button>{running && <button className="button" onClick={cancel}>取消配音任务</button>}</div>
      <p className="field-help">配音使用各镜「配音稿／旧模式整镜字幕」，不使用独立字幕时间轴，也不自动拼接全文。仅支持完整 PCM16 WAV，单镜最长 60 秒；采用后镜头时长按音频向上取整到 30 FPS（至少 1 秒），已有字幕时间轴需检查确认。两种配音模式不叠加，全片引用仍保留；缺失／过期批量只按文字与引用判断，不检测磁盘文件或音色变化。每镜保留最新成功候选，后续失败单独显示。未采用候选不随项目恢复，替换／移除不会删除文件，暂无配音版本切回。</p>
      {running && progress && <div className="image-progress" role="status"><span>{progress.message}</span><progress max={progress.total} value={progress.completed} /></div>}
      {message && <p className="ai-status" role="status">{message}</p>}{error && <p className="ai-error" role="alert">{error}</p>}
      <div className="speech-candidates">{items.map((item) => {
        const index = props.project.scenes.findIndex((entry) => entry.id === item.sceneId);
        const stale = index < 0 || props.project.scenes[index].text.trim() !== item.text;
        return <article className="ai-candidate" key={`${item.sceneId}-${item.ok ? 'success' : 'error'}`} aria-label={`分镜 ${index < 0 ? '已移除' : index + 1} 配音候选`}><h3>分镜 {index < 0 ? '已移除' : index + 1} · {item.ok ? '配音候选' : '配音失败'}</h3>
          {item.ok ? <><p>{item.text}</p><p className="field-help">{item.clip.model} · {item.clip.voice} · {item.clip.speed} 倍速 · 音频 {item.clip.duration.toFixed(3)} 秒 → 镜头 {speechSceneDuration(item.clip.duration).toFixed(3)} 秒</p><LocalSpeechPlayer key={item.clip.id} clip={item.clip} disabled={props.disabled} />{stale && <p className="ai-error">字幕已改变或分镜已删除，不能采用此配音。</p>}<div className="ai-actions"><button className="button primary" disabled={props.disabled || stale} onClick={() => { props.onUse(item.sceneId, item.clip); setItems((old) => old.filter((entry) => entry !== item)); setMessage('已采用配音并同步镜头时长，已切到按镜配音；请保存项目。'); }}>采用此配音</button><button className="button" disabled={props.disabled} onClick={() => setItems((old) => old.filter((entry) => entry !== item))}>丢弃配音候选</button></div></> : <p className="ai-error">{item.error.message}</p>}
        </article>;
      })}</div>
      {scene.speech && <article className="ai-candidate" aria-label="当前分镜已采用配音"><h3>当前分镜已采用配音</h3><p className="field-help">{scene.speech.voice} · {scene.speech.speed} 倍速 · {scene.speech.duration.toFixed(3)} 秒{props.project.narrationMode !== 'scenes' ? ' · 全片模式下不参与导出' : ''}</p>{scene.speech.text !== scene.text.trim() && <p className="ai-error">配音文字已过期；按镜模式导出将被阻止，请重新生成或移除。</p>}<LocalSpeechPlayer key={scene.speech.id} clip={scene.speech} disabled={props.disabled} /><div className="ai-actions"><button className="button" disabled={props.disabled || scene.speech.text !== scene.text.trim()} onClick={() => props.onUse(scene.id, scene.speech!)}>恢复配音时长</button><button className="button" disabled={props.disabled} onClick={() => props.onChange({ scenes: props.project.scenes.map((item) => item.id === scene.id ? { ...item, speech: null } : item) })}>移除当前分镜配音</button></div></article>}
    </div>
  </section>;
}
