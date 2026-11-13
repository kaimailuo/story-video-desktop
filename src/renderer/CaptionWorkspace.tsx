import { useState } from 'react';
import { captionTimeLimit, compileSceneCaptions, confirmSubtitleTimeline, estimateSubtitleTimeline, MAX_SCENE_CAPTIONS, type SubtitleCue, type SubtitleTimeline } from '../shared/captions';
import type { Project, Scene } from '../shared/project';

export default function CaptionWorkspace({ scene, mode, disabled, onChange }: {
  scene: Scene; mode: Project['narrationMode']; disabled: boolean;
  onChange: (timeline: SubtitleTimeline | undefined) => void;
}) {
  const [notice, setNotice] = useState('');
  const timeline = scene.subtitleTimeline;
  let problem = '';
  try { compileSceneCaptions(scene, mode); } catch (error) { problem = error instanceof Error ? error.message : '时间轴无效'; }
  function action(run: () => void) {
    setNotice('');
    try { run(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); }
  }
  function changeCue(id: string, changes: Partial<SubtitleCue>) {
    if (timeline) { onChange({ ...timeline, timing: 'manual', cues: timeline.cues.map((cue) => cue.id === id ? { ...cue, ...changes } : cue) }); setNotice(''); }
  }
  return <section className="panel ai-workspace caption-workspace" aria-label="字幕时间轴">
    <div className="panel-heading"><h2>字幕时间轴</h2><span className="tag">{timeline ? `${timeline.cues.length} / ${MAX_SCENE_CAPTIONS} 条` : '整镜模式'}</span></div>
    <div className="ai-workspace-content"><p className="field-help">镜头内时间，上限 {captionTimeLimit(scene, mode).toFixed(3)} 秒{mode === 'scenes' && scene.speech ? '（受已采用配音实际时长限制）' : ''}。30 FPS 向内量化；起止按半开区间处理。预览游标只检查静态字幕，不播放音频。</p>
      <p className="field-help">按文字长度分配仅为初始时间估算，不是 ASR 或真实语音对齐。请试听配音、手动核对；修改下方字幕不会修改配音稿。</p>
      <fieldset disabled={disabled}>
        <div className="ai-actions"><button className="button small" onClick={() => action(() => {
          if (timeline && !window.confirm('重新估算将替换当前字幕草稿，是否继续？')) return;
          onChange(estimateSubtitleTimeline(scene, mode)); setNotice('已生成初始时间估算，请试听后手动核对。');
        })}>{timeline ? '重新估算字幕' : '估算并启用时间轴'}</button>
          {timeline && <button className="text-button" onClick={() => { if (window.confirm('恢复为整镜显示配音稿，将删除当前多条字幕草稿，是否继续？')) { onChange(undefined); setNotice('已恢复整镜字幕。'); } }}>恢复整镜字幕</button>}</div>
        {timeline && <>
          <p className="field-help">当前标记：{timeline.timing === 'estimated' ? '初始时间估算' : '手动编辑（不代表语音已对齐）'}。无效草稿仍可保存；烧录 MP4 和 SRT 导出会阻止无效时间轴。删除全部条目表示本镜无字幕。</p>
          <div className="caption-cues">{timeline.cues.map((cue, index) => <div className="caption-cue" key={cue.id}>
            <label>字幕 {index + 1}<textarea aria-label={`第 ${index + 1} 条字幕文字`} maxLength={180} value={cue.text} onChange={(event) => changeCue(cue.id, { text: event.target.value })} /></label>
            <div className="form-row">{(['start', 'end'] as const).map((field) => <label key={field}>{field === 'start' ? '开始' : '结束'}（秒）<input aria-label={`第 ${index + 1} 条字幕${field === 'start' ? '开始' : '结束'}`} type="number" min={0} max={60} step="any" value={cue[field]} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) changeCue(cue.id, { [field]: Math.max(0, Math.min(60, value)) }); }} /></label>)}</div>
            <button className="text-button" aria-label={`删除第 ${index + 1} 条字幕`} onClick={() => { onChange({ ...timeline, timing: 'manual', cues: timeline.cues.filter((item) => item.id !== cue.id) }); setNotice(''); }}>删除此条</button>
          </div>)}</div>
          <div className="ai-actions"><button className="button small" disabled={timeline.cues.length >= MAX_SCENE_CAPTIONS} onClick={() => {
            const start = Math.max(0, ...timeline.cues.map((cue) => cue.end));
            onChange({ ...timeline, timing: 'manual', cues: [...timeline.cues, { id: crypto.randomUUID(), text: '', start, end: Math.min(60, Math.max(start, captionTimeLimit(scene, mode))) }] }); setNotice('');
          }}>添加字幕</button><button className="button small" onClick={() => action(() => { onChange(confirmSubtitleTimeline(scene, mode)); setNotice('时间轴检查通过，已确认当前配音稿、配音版本和模式；不代表真实语音对齐。'); })}>检查并确认时间轴</button></div>
        </>}
      </fieldset>
      {problem && <p className="ai-error" role="alert">{problem}</p>}
      {notice && <p className="ai-status" role="status">{notice}</p>}
    </div>
  </section>;
}
