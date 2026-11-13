import { useState } from 'react';
import type { Project, Scene } from '../shared/project';
import type { PreparedArtifact, RecoveryTask, TaskArtifact } from '../shared/recovery';

export default function ArtifactRelink({ task, artifact, project, workspaceId, disabled, onBusyChange, onLink }: {
  task: RecoveryTask; artifact: TaskArtifact; project: Project; workspaceId: string; disabled: boolean;
  onBusyChange(value: boolean): void; onLink(taskId: string, artifactId: string, sceneId: string): Promise<void>;
}) {
  const [targetId, setTargetId] = useState(project.scenes.some((scene) => scene.id === artifact.sceneId) ? artifact.sceneId! : project.scenes[0].id);
  const [preview, setPreview] = useState<{ scene: Scene; value: PreparedArtifact } | null>(null);
  const [error, setError] = useState('');
  if (artifact.kind !== 'image' && artifact.kind !== 'speech') return null;
  const target = project.scenes.find((scene) => scene.id === targetId);
  const stale = !target || preview?.scene !== target;
  async function prepare() {
    if (!target || !window.desktop) return;
    setError(''); setPreview(null); onBusyChange(true);
    try { setPreview({ scene: target, value: await window.desktop.prepareArtifact(task.id, artifact.id, target) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '核验失败，未关联。'); }
    finally { onBusyChange(false); }
  }
  return <div className="artifact-relink">
    <label>关联目标<select aria-label={`产物 ${artifact.id} 的目标分镜`} value={targetId} disabled={disabled} onChange={(event) => { setTargetId(event.target.value); setPreview(null); setError(''); }}>
      {!target && <option value={targetId}>目标分镜已删除，请重新选择</option>}
      {project.scenes.map((scene, index) => <option value={scene.id} key={scene.id}>分镜 {index + 1} · {scene.text.slice(0, 24) || '无文字'}</option>)}
    </select></label>
    {task.workspaceId !== workspaceId && <p className="field-help">来自其他工作区；不会按同名或同编号自动关联，请核对目标。</p>}
    {artifact.kind === 'speech' && !artifact.speech && <p className="field-help">旧配音缺少生成原稿／音色记录，无法安全关联。</p>}
    <button className="button small" disabled={disabled || !target || (artifact.kind === 'speech' && !artifact.speech)} onClick={() => void prepare()}>核验并预览关联</button>
    {preview && <div>
      {preview.value.kind === 'image' ? <img className="artifact-preview" src={preview.value.candidate.preview} alt="待关联图片预览" /> : <><p className="field-help">原稿：{preview.value.clip.text}<br />音色：{preview.value.clip.voice} · 语速：{preview.value.clip.speed} · {preview.value.clip.duration.toFixed(3)} 秒</p><audio controls src={preview.value.preview} /></>}
      {stale && <p className="ai-error">目标分镜已改变，请重新核验。</p>}
      <button className="button small" disabled={disabled || stale} onClick={() => {
        if (!window.confirm(`确认将此${artifact.kind === 'image' ? '图片' : '配音'}关联到分镜 ${project.scenes.findIndex((scene) => scene.id === targetId) + 1}？${task.workspaceId !== workspaceId ? '产物来自其他工作区，请确认内容适合当前项目。' : ''}将替换目标已有的对应素材引用；配音会切为按镜模式并同步时长。不会删除旧文件或调用模型。`)) return;
        void onLink(task.id, artifact.id, targetId).then(() => setPreview(null)).catch(() => setError('关联未完成，请查看操作提示。'));
      }}>确认关联到分镜</button>
    </div>}
    {error && <p className="ai-error" role="alert">{error}</p>}
  </div>;
}
