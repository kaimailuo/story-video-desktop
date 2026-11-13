import type { MediaCheckReport } from '../shared/media-check';
import { mediaCheckLabel } from '../shared/media-check';

export default function MediaWorkspace({ report, stale, disabled, onCheck, onSelect }: {
  report: MediaCheckReport | null; stale: boolean; disabled: boolean;
  onCheck(): void; onSelect(sceneId: string): void;
}) {
  const errors = report?.items.filter((item) => item.status === 'error').length ?? 0;
  const warnings = report?.items.filter((item) => item.status === 'warning').length ?? 0;
  return <section className="panel ai-workspace media-workspace" aria-label="素材统一检查">
    <div className="panel-heading"><h2>素材统一检查</h2><button className="button small" disabled={disabled} onClick={onCheck}>检查项目素材</button></div>
    <div className="ai-workspace-content">
      <p className="field-help">只读检查当前分镜图片、已采用配音、全片配音和背景音乐；不检查历史图片版本或未采用候选，不修复、删除或调用模型。未启用配音的问题仅警告；缺少按镜配音的镜头仍按静音导出。启用烧录时同时检查字幕时间轴。</p>
      <p className="field-help">图片解码、按镜 PCM16 WAV 及音频完整解码不等于内容哈希校验。普通音频单文件最多检查 30 秒，扫描预算约两分钟，超时不算通过；无多实例锁或文件不变保证，导出会重新检查。</p>
      {!report ? <p className="ai-status" role="status">尚未检查；导出 MP4 前会自动检查。</p> : <>
        <p className={errors ? 'ai-error' : 'ai-status'} role="status"><span>{stale ? '检查结果已过期，请重新检查。' : errors ? `素材检查未通过：${errors} 项阻塞，${warnings} 项警告。` : `素材检查通过：0 项阻塞，${warnings} 项警告。`}</span><br />检查时间：{new Date(report.checkedAt).toLocaleString()}</p>
        <p className="field-help">项目编辑会使结果过期；磁盘文件外部变化不会自动感知。请在导出前重新核对。</p>
        <details open={errors > 0 || warnings > 0}><summary>检查明细（{report.items.length} 项）</summary>
          {report.items.map((item, index) => <article className="ai-candidate media-check-item" key={`${item.kind}-${item.sceneId ?? 'project'}-${index}`}>
            <h3>{mediaCheckLabel(item)} · {{ ok: '通过', error: '阻塞', warning: '警告', skipped: '未设置／跳过' }[item.status]}{!item.active && '（当前模式未启用）'}</h3>
            {item.path && <p className="field-help media-check-path">{item.path}</p>}
            {item.messages.map((message, messageIndex) => <p className={item.status === 'error' ? 'ai-error' : 'field-help'} key={messageIndex}>{message}</p>)}
            {item.sceneId && <button className="text-button" disabled={disabled || stale} onClick={() => onSelect(item.sceneId!)}>定位分镜</button>}
          </article>)}
        </details>
      </>}
    </div>
  </section>;
}
