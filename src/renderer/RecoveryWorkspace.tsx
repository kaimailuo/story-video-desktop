import { useState } from 'react';
import type { DraftSummary, RecoveryOverview, RecoveryTask } from '../shared/recovery';
import type { Project } from '../shared/project';
import ArtifactRelink from './ArtifactRelink';

const names: Record<RecoveryTask['kind'], string> = { test: '连接测试', rewrite: '文案改写', storyboard: 'AI 分镜', image: '生图', speech: '配音', mp4: 'MP4 导出', srt: 'SRT 导出' };
const states: Record<RecoveryTask['state'], string> = { running: '执行中／状态待确认', done: '已完成', partial: '部分完成', cancelled: '已取消', failed: '失败', interrupted: '异常中断' };
export default function RecoveryWorkspace({ overview, status, error, disabled, onRefresh, onRestore, onDiscard, project, workspaceId, onBusyChange, onLink }: {
  overview: RecoveryOverview; status: string; error: string; disabled: boolean;
  onRefresh: () => Promise<void>; onRestore: (draft: DraftSummary) => Promise<void>; onDiscard: (draft: DraftSummary) => Promise<void>;
  project: Project; workspaceId: string; onBusyChange(value: boolean): void;
  onLink(taskId: string, artifactId: string, sceneId: string): Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(false);
  return <section className="panel ai-workspace recovery-workspace" aria-label="自动保存与恢复">
    <div className="panel-heading"><h2>自动保存与恢复</h2><button className="text-button" disabled={disabled || checking} onClick={() => void onRefresh()}>刷新恢复记录</button></div>
    <div className="ai-workspace-content"><p className="ai-status" role="status">{status}</p>
      <p className="field-help">编辑后约 0.6 秒保存独立草稿，不覆盖手动项目文件。强制退出可能丢失尚未写入的最后编辑；只恢复本地数据，不自动联网、不自动采用候选，也不是断点续渲染。</p>
      {error && <p className="ai-error" role="alert">{error}</p>}
      {overview.warnings.map((warning) => <p className="ai-error" role="alert" key={warning}>{warning}</p>)}
      {overview.drafts.length > 0 && <div className="recovery-drafts"><h3>发现可恢复草稿</h3>{overview.drafts.map((draft) => <article className="ai-candidate" key={draft.id} aria-label={`草稿 ${draft.title}`}>
        <strong>{draft.title}</strong><p className="field-help">{new Date(draft.updatedAt).toLocaleString()} · {draft.sceneCount} 镜 · 版本 {draft.revision}</p>
        {selected === draft.id && <div><p className="field-help">原手动文件：{draft.sourceFilePath ?? '尚未保存为项目文件'}</p><pre>{draft.excerpt || '无全文文案；恢复后可查看分镜及字幕。'}</pre></div>}
        <div className="ai-actions"><button className="button small" disabled={disabled} onClick={() => setSelected(selected === draft.id ? null : draft.id)}>查看草稿摘要</button><button className="button small" disabled={disabled} onClick={() => void onRestore(draft)}>恢复此草稿</button><button className="text-button" disabled={disabled} onClick={() => { if (window.confirm('放弃此自动草稿？不会删除手动项目或素材文件。')) void onDiscard(draft); }}>放弃此草稿</button></div>
      </article>)}</div>}
      <details className="recovery-tasks"><summary>任务记录（最近 {overview.tasks.length} 条）</summary>
        <p className="field-help">中断仅表示本地状态，不能据此判断服务端是否计费。已完成文件按大小和 SHA-256 核验；图片／WAV 额外检查格式，MP4 不完整解码。图片／有原稿元数据的配音可预览、选择目标并确认关联；旧配音不能安全关联。文本结果为 JSON。不会自动回填或重发。</p>
        {overview.tasks.map((task) => <article className="ai-candidate" key={task.id} aria-label={`任务 ${task.kind}`}>
          <h3>{names[task.kind]} · {states[task.state]}</h3><p className="field-help">{new Date(task.createdAt).toLocaleString()} · 成功 {task.succeeded}，失败 {task.failed}，未登记／未处理 {task.total - task.processed}<br />工作区：{task.workspaceId ?? '未关联项目（如连接测试）'}<br />任务：{task.id}</p>
          {task.artifacts.map((artifact) => <div className="recovery-artifact" key={artifact.id}><p className="field-help">{artifact.kind}{artifact.sceneId ? ` · 分镜 ${artifact.sceneId}` : ''}<br />{artifact.path}</p>
            <button className="button small" disabled={disabled || checking} onClick={() => {
              setChecking(true);
              void window.desktop?.checkArtifact(task.id, artifact.id).then((result) => setChecks((old) => ({ ...old, [artifact.id]: result.message }))).catch(() => setChecks((old) => ({ ...old, [artifact.id]: '记录读取失败，未复用或重发。' }))).finally(() => setChecking(false));
            }}>核验文件</button>{checks[artifact.id] && <p className="ai-status" role="status">{checks[artifact.id]}</p>}
            <ArtifactRelink task={task} artifact={artifact} project={project} workspaceId={workspaceId} disabled={disabled || checking} onBusyChange={onBusyChange} onLink={onLink} />
          </div>)}
        </article>)}
      </details>
    </div>
  </section>;
}
