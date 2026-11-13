import { useEffect, useRef, useState } from 'react';
import { adoptSceneSpeech, createProject, splitScript, selectSceneImage, sceneReplacementWarning, type DesktopAPI, type ExportProgress, type Project, type Scene } from '../shared/project';
import AIWorkspace from './AIWorkspace';
import ModelSettings from './ModelSettings';
import ImageWorkspace from './ImageWorkspace';
import SpeechWorkspace from './SpeechWorkspace';
import CaptionWorkspace from './CaptionWorkspace';
import { compileSceneCaptions, sceneFrameCount } from '../shared/captions';
import { useRecovery } from './useRecovery';
import RecoveryWorkspace from './RecoveryWorkspace';
import MediaWorkspace from './MediaWorkspace';
import { mediaCheckErrors, type MediaCheckReport } from '../shared/media-check';

const categories = { story: '故事解说', novel: '小说推文', knowledge: '知识解说' };
const examples: Record<Project['category'], string> = {
  story: '清晨，城市还未醒来。\n他推开那扇熟悉的门，发现桌上多了一封没有署名的信。\n有些故事，就从一个意外开始。',
  novel: '她在旧书里，找到一张十年前的车票。\n背面只有一句话：如果重来一次，你还会赴约吗？\n窗外，最后一班列车缓缓进站。',
  knowledge: '为什么日落时，天空常常变成红色？\n阳光穿过更厚的大气层，短波长的蓝光更容易被散射。\n到达我们眼中的光，便以红色和橙色为主。',
};

function fileName(value: string | null): string { return value?.split(/[\\/]/).pop() ?? '尚未导入'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function Icon({ name, size = 18 }: { name: 'film' | 'plus' | 'folder' | 'save' | 'export' | 'image' | 'play' | 'check' | 'arrow' | 'music'; size?: number }) {
  const paths = {
    film: 'M4 3h16v18H4zM4 8h16M4 16h16M8 3v18M16 3v18',
    plus: 'M12 5v14M5 12h14', folder: 'M3 7V5h6l2 2h10v13H3z',
    save: 'M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8',
    export: 'M12 15V3M7 8l5-5 5 5M4 14v6h16v-6',
    image: 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M8 7h.01',
    play: 'M8 4l12 8-12 8z', check: 'M5 12l4 4L19 6',
    arrow: 'M5 12h14M14 7l5 5-5 5', music: 'M9 18V5l12-2v13M9 9l12-2M9 18c0 3-6 4-6 1s6-4 6-1M21 16c0 3-6 4-6 1s6-4 6-1',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export default function App() {
  const [project, setProject] = useState<Project>(createProject);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState(0);
  const [captionCursor, setCaptionCursor] = useState({ sceneId: '', frame: 0 });
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState('先试试演示项目，或导入文案开始创作。');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<'text' | 'image' | 'speech' | null>(null);
  const [projectEpoch, setProjectEpoch] = useState(0);
  const [sceneBackup, setSceneBackup] = useState<{ epoch: number; scenes: Scene[] } | null>(null);
  const [mediaCheck, setMediaCheck] = useState<{ project: Project; epoch: number; report: MediaCheckReport } | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const currentJob = useRef<string | null>(null);
  const total = project.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const scene = project.scenes[selected] ?? project.scenes[0];
  const ready = project.scenes.filter((item) => item.imagePath && previews[item.imagePath]).length;
  const exporting = progress?.state === 'running';
  const recovery = useRecovery(project, dirty);
  const busy = pending || exporting || aiBusy || !recovery.ready;

  useEffect(() => window.desktop?.onProgress((event) => {
    if (currentJob.current && event.jobId !== currentJob.current) return;
    setProgress(event);
    if (event.state === 'error') setError(event.message);
    if (event.state === 'done') setNotice('导出完成，视频已保存到你选择的位置。');
  }), []);

  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [dirty]);

  function update(changes: Partial<Project>) {
    setProject((old) => ({ ...old, ...changes })); setDirty(true);
  }
  function updateScene(changes: Partial<Scene>) {
    update({ scenes: project.scenes.map((item, index) => index === selected ? { ...item, ...changes } : item) });
  }
  async function desktopAction(action: (api: DesktopAPI) => Promise<void>) {
    setError('');
    if (!window.desktop) { setError('当前是浏览器预览。请通过 npm run dev 启动桌面客户端，以使用文件和导出功能。'); return; }
    setPending(true);
    try { await action(window.desktop); } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  function canReplace(): boolean { return !dirty || window.confirm('当前项目尚未保存，确定替换吗？'); }
  async function checkMedia() {
    await desktopAction(async (api) => {
      setNotice('正在只读检查素材，请等待；不会调用模型。');
      const report = await api.checkProjectMedia(project);
      setMediaCheck({ project, epoch: projectEpoch, report });
      setNotice(report.canExport ? '素材检查通过，请核对警告；导出前仍会重新检查。' : '素材检查发现阻塞问题，请在素材面板查看。');
    });
  }
  async function startExport() {
    await desktopAction(async (api) => {
      setNotice('正在执行导出前素材检查，请等待……');
      const workspaceId = await recovery.flush(true);
      const job = await api.startExport(project, workspaceId);
      if (!job) { setNotice('已取消选择导出位置，未开始渲染。'); return; }
      setMediaCheck({ project, epoch: projectEpoch, report: job.report });
      if (!('jobId' in job)) {
        currentJob.current = null;
        const message = mediaCheckErrors(job.report);
        setProgress({ jobId: '', percent: 0, message, state: 'error' });
        setError(`素材检查未通过，尚未开始渲染。\n${message}`);
        setNotice('导出已阻止，请查看素材统一检查面板。'); return;
      }
      currentJob.current = job.jobId;
      setProgress((old) => old?.jobId === job.jobId ? old : { jobId: job.jobId, percent: 0, message: '准备导出', state: 'running' });
    });
  }
  async function loadProject(demo: boolean) {
    if (!canReplace()) return;
    await desktopAction(async (api) => {
      const opened = demo ? await api.loadDemo() : await api.openProject();
      if (!opened) return;
      await recovery.leave(); recovery.switchWorkspace(demo ? null : opened.filePath);
      setProject(opened.project); setPreviews(opened.previews); setSelected(0); setDirty(demo); setProgress(null);
      setProjectEpoch((value) => value + 1);
      setNotice(demo ? '已载入 9 秒本地演示：3 张插画、字幕和合成音调，可直接导出。' : `已打开：${fileName(opened.filePath)}`);
    });
  }
  async function importImages() {
    await desktopAction(async (api) => {
      const images = await api.importImages();
      if (!images.length) return;
      const next = [...project.scenes];
      images.forEach((image, offset) => {
        const index = selected + offset;
        if (index < next.length) next[index] = selectSceneImage(next[index], { id: crypto.randomUUID(), path: image.path, prompt: '', model: '', createdAt: new Date().toISOString(), source: 'imported' });
        else if (next.length < 100) next.push({ id: crypto.randomUUID(), text: '', prompt: '', description: '', imagePath: image.path, duration: 5, motion: 'zoom' });
      });
      setPreviews((old) => ({ ...old, ...Object.fromEntries(images.map((image) => [image.path, image.preview])) }));
      update({ scenes: next });
      setNotice(`已导入 ${images.length} 张图片，从当前分镜起依次填充。`);
    });
  }
  function generateScenes() {
    try {
      const scenes = splitScript(project.script);
      if (!scenes.length) { setError('请先输入文案。'); return; }
      if (!window.confirm(sceneReplacementWarning(project.scenes))) return;
      replaceScenes(scenes); setError(''); setNotice(`已按句子拆成 ${scenes.length} 个分镜。这是本地规则拆分，尚未调用 AI。`);
    } catch (cause) { setError(errorMessage(cause)); }
  }
  function replaceScenes(scenes: Scene[]) {
    setSceneBackup({ epoch: projectEpoch, scenes: structuredClone(project.scenes) });
    update({ scenes }); setSelected(0); setProgress(null);
  }
  function undoSceneReplacement() {
    if (!sceneBackup || sceneBackup.epoch !== projectEpoch) return;
    if (!window.confirm('将恢复最近一次替换前的分镜、字幕和素材关联，替换后对分镜的编辑将被放弃；不会删除磁盘文件。是否继续？')) return;
    update({ scenes: sceneBackup.scenes }); setSelected(0); setSceneBackup(null); setProgress(null);
    setNotice('已撤销最近一次分镜替换，请保存项目；未发起生成请求。');
  }
  function addScene() {
    if (project.scenes.length >= 100) return;
    update({ scenes: [...project.scenes, { id: crypto.randomUUID(), text: '', prompt: '', description: '', imagePath: null, duration: 5, motion: 'zoom' }] });
    setSelected(project.scenes.length);
  }
  function moveScene(direction: number) {
    const target = selected + direction;
    if (target < 0 || target >= project.scenes.length) return;
    const scenes = [...project.scenes];
    [scenes[selected], scenes[target]] = [scenes[target], scenes[selected]];
    update({ scenes }); setSelected(target);
  }
  const preview = scene.imagePath ? previews[scene.imagePath] : undefined;
  const previewFrame = captionCursor.sceneId === scene.id ? Math.min(captionCursor.frame, sceneFrameCount(scene.duration) - 1) : 0;
  let previewCaption = '';
  try { previewCaption = compileSceneCaptions(scene, project.narrationMode).find((cue) => cue.startFrame <= previewFrame && previewFrame < cue.endFrame)?.text ?? ''; }
  catch { /* 无效草稿不展示可能误导的字幕，详情在时间轴面板提示。 */ }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Icon name="film" size={23} /></span><strong>映序<span>STORY STUDIO</span></strong></div>
      <div className="workspace-label">创作空间</div>
      <button className="nav-item active"><Icon name="film" />视频工作台<span className="nav-dot" /></button>
      <button className="nav-item" disabled={busy} onClick={() => void loadProject(false)}><Icon name="folder" />打开本地项目</button>
      <button className="nav-item" disabled={busy} onClick={() => setSettingsOpen('text')}><Icon name="save" />文本模型设置</button>
      <button className="nav-item" disabled={busy} onClick={() => setSettingsOpen('image')}><Icon name="image" />图片模型设置</button>
      <button className="nav-item" disabled={busy} onClick={() => setSettingsOpen('speech')}><Icon name="music" />配音模型设置</button>
      <div className="sidebar-section">工作流模板</div>
      {(Object.entries(categories) as [Project['category'], string][]).map(([key, label]) => <button key={key} disabled={busy} className={`template-link ${project.category === key ? 'selected' : ''}`} onClick={() => update({ category: key })}><span className="template-dot" />{label}</button>)}
      <div className="coming-soon"><span>后续工作流</span><p>音乐 MV <small>规划中</small></p><p>HTML 动画 <small>规划中</small></p></div>
      <div className="local-badge"><span className="status-dot" /><div>本地优先<span>Intel Mac · MP4 工作流</span></div></div>
      <div className="sidebar-version">开发版 v0.6.0 · 自动保存／恢复</div>
    </aside>

    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">创作空间 <span>/</span> 视频工作台</div><div className="topbar-right"><span className="privacy-tag"><span className="status-dot" />AI 仅在确认后发送文字</span><span className="avatar">映</span></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">MAKE YOUR STORY VISIBLE</div><h1>让灵感，有画面。</h1><p>从文案到分镜，把故事变成一支视频。</p></div><div className="heading-actions"><button className="button ghost" disabled={busy} onClick={() => { if (canReplace()) void desktopAction(async () => { await recovery.leave(); recovery.switchWorkspace(null); setProject(createProject()); setProjectEpoch((value) => value + 1); setPreviews({}); setSelected(0); setDirty(false); setProgress(null); setError(''); }); }}><Icon name="plus" />新建</button><button className="button" disabled={busy} onClick={() => void desktopAction(async (api) => { const saved = await api.saveProject(project); if (saved) { await recovery.saved(saved); setDirty(false); setNotice(`项目已保存：${fileName(saved)}`); await recovery.refresh(); } })}><Icon name="save" />保存项目</button><button className="button primary" disabled={busy} onClick={() => void startExport()}><Icon name="export" />导出 MP4</button></div></div>

        {!window.desktop && <div className="browser-banner">浏览器仅预览界面；文件导入及视频导出需要桌面客户端。</div>}
        {window.desktop && <RecoveryWorkspace key={`recovery-${projectEpoch}`} project={project} workspaceId={recovery.workspaceId} onBusyChange={setAiBusy} onLink={async (taskId, artifactId, sceneId) => {
          await desktopAction(async (api) => {
            const target = project.scenes.find((item) => item.id === sceneId);
            if (!target) throw new Error('目标分镜已删除，未关联。');
            const prepared = await api.prepareArtifact(taskId, artifactId, target);
            if (prepared.kind === 'image') {
              update({ scenes: project.scenes.map((item) => item.id === sceneId ? selectSceneImage(item, prepared.candidate) : item) });
              setPreviews((old) => ({ ...old, [prepared.candidate.path]: prepared.candidate.preview }));
            } else update({ narrationMode: 'scenes', scenes: project.scenes.map((item) => item.id === sceneId ? adoptSceneSpeech(item, prepared.clip) : item) });
            setProgress(null); setNotice('已显式关联任务产物，请保存项目；未调用模型或删除旧文件。');
          });
        }} overview={{ ...recovery.overview, drafts: recovery.overview.drafts.filter((draft) => draft.id !== recovery.workspaceId) }} status={recovery.status} error={recovery.error} disabled={busy} onRefresh={recovery.refresh}
          onRestore={async (draft) => {
            if (!canReplace()) return;
            await desktopAction(async (api) => {
              const restored = await api.loadDraft(draft.id);
              await recovery.leave(); recovery.switchWorkspace(restored.draft.sourceFilePath, restored.draft);
              setProject(restored.draft.project); setPreviews(restored.previews); setSelected(0); setDirty(true); setProgress(null); setProjectEpoch((value) => value + 1);
              setNotice('已恢复自动草稿；未重发任何 AI 请求，请核对素材并手动保存项目。');
            });
          }}
          onDiscard={async (draft) => { await desktopAction(async (api) => { await api.dismissDraft(draft.id, draft.revision); await recovery.refresh(); }); }} />}
        <div className="pipeline"><div className="pipeline-step current"><b>01</b><span>文案与分镜</span></div><Icon name="arrow" size={15} /><div className={`pipeline-step ${ready ? 'current' : ''}`}><b>02</b><span>画面与声音</span></div><Icon name="arrow" size={15} /><div className={`pipeline-step ${progress?.state === 'done' ? 'current' : ''}`}><b>03</b><span>合成与导出</span></div><span className="pipeline-note">本地编辑 · 无需登录</span></div>

        <div className="editor-grid">
          <section className="editor-column">
            <section className="panel script-panel"><div className="panel-heading"><h2><span className="section-number">01</span>文案创作</h2><span className="tag">{categories[project.category]}</span></div><div className="project-title-row"><input aria-label="作品名称" className="title-input" maxLength={100} value={project.title} disabled={busy} onChange={(event) => update({ title: event.target.value })} /><span className="save-state">{dirty ? '有未保存更改' : '本地项目'}</span></div><textarea className="script-input" aria-label="视频文案" placeholder="粘贴你的故事或解说文案，每一句都可以成为一个画面……" maxLength={30000} disabled={busy} value={project.script} onChange={(event) => update({ script: event.target.value })} /><div className="script-footer"><span>{project.script.length} 字 <i>·</i> 当前为本地规则拆分</span><div><button className="text-button" disabled={busy} onClick={() => update({ script: examples[project.category] })}>填入示例文案</button><button className="button small" disabled={busy} onClick={generateScenes}>拆分分镜<Icon name="arrow" size={15} /></button></div></div></section>

            <AIWorkspace key={`text-${projectEpoch}`} project={project} disabled={busy} settingsRevision={settingsRevision} onOpenSettings={() => setSettingsOpen('text')} onBusyChange={setAiBusy} onBeforeTask={() => recovery.flush(true)}
              onWork={(textWork) => update({ textWork })} onCheckpoint={async (textWork) => { update({ textWork }); return recovery.flush(true, { ...project, textWork }); }}
              onRewrite={(original, rewritten, instructions, model) => {
                update({ script: rewritten, rewriteHistory: [...(project.rewriteHistory ?? []).slice(-99), { id: crypto.randomUUID(), createdAt: new Date().toISOString(), original, rewritten, instructions, model }] });
              }}
              onStoryboard={(scenes) => {
                replaceScenes(scenes.map((item) => ({ ...item, id: crypto.randomUUID(), imagePath: null })));
              }} />
            <SpeechWorkspace key={`speech-${projectEpoch}`} project={project} selected={selected} disabled={busy} settingsRevision={settingsRevision} onOpenSettings={() => setSettingsOpen('speech')} onBusyChange={setAiBusy} onChange={update} onBeforeTask={() => recovery.flush(true)}
              onUse={(sceneId, clip) => {
                update({ narrationMode: 'scenes', scenes: project.scenes.map((item) => item.id === sceneId ? adoptSceneSpeech(item, clip) : item) });
                setProgress(null);
              }} />
            <ImageWorkspace key={`image-${projectEpoch}`} project={project} selected={selected} disabled={busy} settingsRevision={settingsRevision} onOpenSettings={() => setSettingsOpen('image')} onBusyChange={setAiBusy} onBeforeTask={() => recovery.flush(true)}
              onUse={(sceneId, version, imagePreview) => {
                update({ scenes: project.scenes.map((item) => item.id === sceneId ? selectSceneImage(item, version) : item) });
                setPreviews((old) => ({ ...old, [version.path]: imagePreview }));
                setProgress(null);
              }} />
            {sceneBackup?.epoch === projectEpoch && <div className="ai-actions"><button className="button small" disabled={busy} onClick={undoSceneReplacement}>撤销最近一次分镜替换</button><span className="field-help">仅保留本次会话的上一次替换快照，不随项目保存。</span></div>}
            <section className="panel storyboard-panel"><div className="panel-heading"><h2><span className="section-number">02</span>分镜工作台 <span className="count">{project.scenes.length}</span></h2><button className="text-button" disabled={busy} onClick={() => void importImages()}><Icon name="image" size={15} />批量导入图片</button></div><div className="storyboard-help">选择分镜编辑内容。批量导入时，从当前分镜起按选择顺序填充图片。</div><div className="scene-list">{project.scenes.map((item, index) => <button key={item.id} disabled={busy} className={`scene-card ${selected === index ? 'is-selected' : ''}`} onClick={() => setSelected(index)}><div className="scene-thumbnail">{item.imagePath && previews[item.imagePath] ? <img src={previews[item.imagePath]} alt={`分镜 ${index + 1}`} /> : <Icon name="image" size={22} />}<span>{String(index + 1).padStart(2, '0')}</span></div><div className="scene-summary"><div><strong>分镜 {String(index + 1).padStart(2, '0')}</strong><span>{Number(item.duration.toFixed(3))}s</span></div><p>{item.text || '添加这个画面的字幕或解说'}</p><small>{item.imagePath ? previews[item.imagePath] ? fileName(item.imagePath) : '素材缺失，请重新导入' : '等待导入画面'}</small></div><span className={`scene-status ${item.imagePath && previews[item.imagePath] ? 'complete' : ''}`}>{item.imagePath && previews[item.imagePath] ? <Icon name="check" size={14} /> : '待补充'}</span></button>)}</div><button className="add-scene" disabled={busy || project.scenes.length >= 100} onClick={addScene}><Icon name="plus" size={16} />添加分镜</button></section>
          </section>

          <aside className="preview-column"><section className="panel preview-panel"><div className="panel-heading"><h2>画面预览</h2><span className="tag">{project.aspect === 'portrait' ? '9:16' : '16:9'}</span></div><div className={`preview-stage ${project.aspect}`}><div className="preview-frame">{preview ? <img src={preview} alt="当前分镜预览" /> : <div className="empty-preview"><span><Icon name="image" size={32} /></span><strong>故事的第一帧</strong><p>导入图片，让画面在这里出现</p><button className="button small" disabled={busy} onClick={() => void importImages()}>选择图片</button></div>}{project.captions && preview && previewCaption && <div className="preview-caption">{previewCaption}</div>}<span className="preview-label">分镜预览 · 非成片</span></div></div><div className="preview-footer"><span><Icon name="film" size={14} />分镜 {selected + 1} / {project.scenes.length}</span><span>{scene.duration.toFixed(1)}s</span></div><label className="caption-preview-control">字幕预览游标 · 第 {previewFrame} 帧 · {(previewFrame / 30).toFixed(3)} 秒<input aria-label="字幕预览帧" type="range" min={0} max={sceneFrameCount(scene.duration) - 1} step={1} value={previewFrame} onChange={(event) => setCaptionCursor({ sceneId: scene.id, frame: Number(event.target.value) })} /></label></section>

          <CaptionWorkspace key={`${projectEpoch}-${scene.id}`} scene={scene} mode={project.narrationMode} disabled={busy} onChange={(subtitleTimeline) => updateScene({ subtitleTimeline })} />
          <section className="panel detail-panel"><div className="panel-heading"><h2>分镜设置</h2><div className="mini-actions"><button disabled={busy || selected === 0} onClick={() => moveScene(-1)} aria-label="上移分镜">↑</button><button disabled={busy || selected === project.scenes.length - 1} onClick={() => moveScene(1)} aria-label="下移分镜">↓</button><button className="delete-button" disabled={busy || project.scenes.length === 1} onClick={() => { update({ scenes: project.scenes.filter((_, index) => index !== selected) }); setSelected(Math.max(0, selected - 1)); }}>删除</button></div></div><fieldset disabled={busy}><label>配音稿／旧模式整镜字幕<textarea aria-label="当前分镜字幕" maxLength={180} value={scene.text} onChange={(event) => updateScene({ text: event.target.value })} /></label>
            <div className="scene-prompt-fields"><label>画面描述<textarea aria-label="当前分镜画面描述" maxLength={2000} value={scene.description ?? ''} onChange={(event) => updateScene({ description: event.target.value })} /></label><label>绘图提示词<textarea aria-label="当前分镜绘图提示词" maxLength={2000} value={scene.prompt} onChange={(event) => updateScene({ prompt: event.target.value })} /></label></div>
            <div className="form-row"><label>时长（秒）<input type="number" min={1} max={60} step={0.001} value={Number(scene.duration.toFixed(3))} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) updateScene({ duration: Math.min(60, Math.max(1, value)) }); }} /></label><label>画面运镜<select value={scene.motion} onChange={(event) => updateScene({ motion: event.target.value as Scene['motion'] })}><option value="zoom">缓慢推进</option><option value="still">静态画面</option></select></label></div><button className="button full-width" onClick={() => void importImages()}><Icon name="image" size={15} />{scene.imagePath ? '替换当前图片' : '导入分镜图片'}</button></fieldset></section></aside>
        </div>

        <MediaWorkspace report={mediaCheck?.epoch === projectEpoch ? mediaCheck.report : null} stale={mediaCheck?.epoch === projectEpoch && mediaCheck.project !== project} disabled={busy || !window.desktop} onCheck={() => void checkMedia()} onSelect={(sceneId) => { const index = project.scenes.findIndex((item) => item.id === sceneId); if (index >= 0) { setSelected(index); document.querySelector('.detail-panel')?.scrollIntoView({ block: 'center' }); } }} />
        <section className="panel production-panel">
          <div className="panel-heading"><h2><span className="section-number">03</span>声音与输出</h2><span className="muted">H.264 / AAC · 30 FPS</span></div>
          <fieldset className="production-controls" disabled={busy}>
            <div className="audio-settings">
              <div className="audio-field"><span className="audio-icon"><Icon name="music" /></span><div><strong>全片配音{project.narrationMode === 'scenes' ? '（当前不启用）' : ''}</strong><span title={project.narrationPath ?? ''}>{fileName(project.narrationPath)}</span></div><button className="text-button" onClick={() => void desktopAction(async (api) => { const audio = await api.importAudio(); if (audio) update({ narrationPath: audio }); })}>导入</button>{project.narrationPath && <button className="clear-button" aria-label="移除配音" onClick={() => update({ narrationPath: null })}>×</button>}</div>
              <div className="audio-field"><span className="audio-icon"><Icon name="music" /></span><div><strong>背景音乐</strong><span title={project.bgmPath ?? ''}>{fileName(project.bgmPath)}</span></div><button className="text-button" onClick={() => void desktopAction(async (api) => { const audio = await api.importAudio(); if (audio) update({ bgmPath: audio }); })}>导入</button>{project.bgmPath && <button className="clear-button" aria-label="移除背景音乐" onClick={() => update({ bgmPath: null })}>×</button>}</div>
              <label className="volume-control">音乐音量<input aria-label="背景音乐音量" type="range" min="0" max="1" step="0.01" value={project.bgmVolume} onChange={(event) => update({ bgmVolume: Number(event.target.value) })} /><span>{Math.round(project.bgmVolume * 100)}%</span></label>
            </div>
            <div className="output-settings"><div className="form-row"><label>画面比例<select value={project.aspect} onChange={(event) => update({ aspect: event.target.value as Project['aspect'] })}><option value="portrait">9:16 竖屏</option><option value="landscape">16:9 横屏</option></select></label><label>输出分辨率<select value={project.resolution} onChange={(event) => update({ resolution: event.target.value as Project['resolution'] })}><option value="720p">720p · 更快</option><option value="1080p">1080p · 高清</option></select></label></div><div className="form-row"><label>转场<select value={project.transition} onChange={(event) => update({ transition: event.target.value as Project['transition'] })}><option value="fade">淡入淡出</option><option value="cut">直接切换</option></select></label><label className="checkbox-label"><input type="checkbox" checked={project.captions} onChange={(event) => update({ captions: event.target.checked })} />烧录字幕</label></div></div>
          </fieldset>
          <div className="ai-actions"><button className="button small" disabled={busy} onClick={() => void desktopAction(async (api) => { const workspaceId = await recovery.flush(true); const saved = await api.exportSubtitles(project, workspaceId); if (saved) setNotice(`字幕已导出：${fileName(saved)}`); })}>导出 SRT 字幕</button></div>
          <p className="audio-note">{project.narrationMode === 'scenes' ? '当前按镜配音：不使用全片配音引用，缺配音镜头静音；镜头短于配音或配音文字过期将阻止导出。' : '当前全片配音：从片头播放，过短补静音，过长截断；已采用按镜配音不参与导出。'}可在「AI 按镜配音」面板切换模式。背景音乐循环。字幕支持手动时间轴；估算不是语音对齐。关闭烧录不影响独立 SRT 导出，SRT 始终校验时间轴。</p>
        </section>

        {error && <div className="error-box" role="alert"><strong>操作未完成</strong><pre>{error}</pre><button className="text-button" onClick={() => setError('')}>关闭提示</button></div>}
        {progress && <section className={`export-status ${progress.state}`} aria-live="polite"><div><strong>{progress.state === 'running' ? `正在导出 ${progress.percent}%` : progress.state === 'done' ? '视频已准备就绪' : progress.state === 'cancelled' ? '导出已取消' : '导出失败'}</strong><span>{progress.message.split('\n')[0]}</span></div><progress value={progress.percent} max={100} />{exporting && <button className="button small" onClick={() => void desktopAction(async (api) => api.cancelExport())}>取消导出</button>}{progress.state === 'done' && progress.outputPath && <button className="button small" onClick={() => void desktopAction(async (api) => api.revealOutput(progress.outputPath!))}>在 Finder 中查看</button>}</section>}
        <div className="bottom-bar"><span className="notice" role="status">{notice}</span><button className="text-button" disabled={busy} onClick={() => void loadProject(true)}>载入演示项目<Icon name="arrow" size={14} /></button></div>
      </main>
      <footer className="statusbar"><span><span className="status-dot" />本地渲染引擎</span><span>{ready}/{project.scenes.length} 个画面就绪 <i>·</i> 总时长 {total.toFixed(1)}s <i>·</i> {project.resolution}</span></footer>
    </div>
    {settingsOpen && <ModelSettings kind={settingsOpen} onClose={() => setSettingsOpen(null)} onSaved={() => setSettingsRevision((value) => value + 1)} onBusyChange={setAiBusy} />}
  </div>;
}
