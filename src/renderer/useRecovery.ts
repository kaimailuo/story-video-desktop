import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../shared/project';
import type { DraftInput, RecoveryDraft, RecoveryOverview } from '../shared/recovery';

const empty: RecoveryOverview = { drafts: [], tasks: [], warnings: [] };
export function useRecovery(project: Project, dirty: boolean) {
  const [overview, setOverview] = useState(empty);
  const [ready, setReady] = useState(!window.desktop);
  const [status, setStatus] = useState('尚无自动草稿');
  const [error, setError] = useState('');
  const workspace = useRef<{ id: string; revision: number; sourceFilePath: string | null }>({ id: crypto.randomUUID(), revision: 0, sourceFilePath: null });
  const latest = useRef({ project, dirty }); latest.current = { project, dirty };
  const lastProject = useRef<Project | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const persisted = useRef({ id: '', revision: 0 });
  const inFlight = useRef(new Map<string, Promise<number>>());
  const cancelTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const snapshot = useCallback((): DraftInput => {
    if (lastProject.current !== latest.current.project) { workspace.current.revision++; lastProject.current = latest.current.project; }
    return { ...workspace.current, revision: Math.max(1, workspace.current.revision), project: latest.current.project };
  }, []);
  const refresh = useCallback(async () => {
    if (!window.desktop?.getRecovery) return;
    try { const value = await window.desktop.getRecovery(); if (mounted.current) setOverview(value); }
    catch { if (mounted.current) setError('无法读取恢复记录；原文件保留，请检查磁盘权限。'); }
  }, []);
  const flush = useCallback(async (force = false, checkpoint?: Project): Promise<string> => {
    if (checkpoint) latest.current = { project: checkpoint, dirty: true };
    cancelTimer();
    if (!window.desktop?.saveDraft) {
      if (window.desktop) throw new Error('桌面自动保存接口未更新，请保存项目后重启客户端。');
      return workspace.current.id;
    }
    const draft = snapshot();
    if (!force && !latest.current.dirty) return draft.id;
    if (persisted.current.id === draft.id && persisted.current.revision === draft.revision) return draft.id;
    try {
      const key = `${draft.id}:${draft.revision}`;
      let writing = inFlight.current.get(key);
      if (!writing) {
        writing = window.desktop.saveDraft(draft).finally(() => { inFlight.current.delete(key); });
        inFlight.current.set(key, writing);
      }
      const revision = await writing;
      if (revision !== draft.revision) throw new Error('草稿版本不匹配');
      if (workspace.current.id === draft.id && (persisted.current.id !== draft.id || persisted.current.revision < revision)) persisted.current = { id: draft.id, revision };
      if (mounted.current && workspace.current.id === draft.id && lastProject.current === draft.project) { setStatus('最新编辑已自动保存'); setError(''); }
      return draft.id;
    } catch {
      if (mounted.current && workspace.current.id === draft.id && lastProject.current === draft.project) { setStatus('自动保存失败'); setError('自动草稿保存失败，旧草稿保留；请检查磁盘空间／权限并手动保存项目。'); }
      throw new Error('自动草稿写入失败，未开始新任务；请先手动保存或修复目录权限。');
    }
  }, [cancelTimer, snapshot]);
  useEffect(() => {
    mounted.current = true;
    void refresh().finally(() => { if (mounted.current) setReady(true); });
    return () => { mounted.current = false; cancelTimer(); };
  }, [cancelTimer, refresh]);
  useEffect(() => {
    if (!ready || !dirty || !window.desktop) return;
    snapshot(); setStatus('等待自动保存…');
    timer.current = setTimeout(() => { void flush().catch(() => undefined); }, 600);
    return cancelTimer;
  }, [project, dirty, ready, snapshot, flush, cancelTimer]);
  useEffect(() => window.desktop?.onBeforeClose?.(async () => {
    try { await flush(); return true; } catch { return false; }
  }), [flush]);
  async function leave() {
    cancelTimer(); await flush(); const draft = snapshot();
    // 先等待已发出的同版保存，再标记放弃，防止旧请求把草稿重新变为可恢复。
    if (window.desktop?.dismissDraft && persisted.current.id === draft.id) await window.desktop.dismissDraft(draft.id, persisted.current.revision);
  }
  function switchWorkspace(sourceFilePath: string | null, recovered?: RecoveryDraft) {
    cancelTimer();
    workspace.current = recovered ? { id: recovered.id, revision: recovered.revision, sourceFilePath } : { id: crypto.randomUUID(), revision: 0, sourceFilePath };
    lastProject.current = null; persisted.current = { id: '', revision: 0 };
    setStatus(recovered ? '草稿已恢复，等待自动保存' : '尚无自动草稿'); setError('');
  }
  async function saved(filePath: string) {
    cancelTimer(); const draft = snapshot();
    try {
      await flush(true);
      if (window.desktop?.dismissDraft && persisted.current.id === draft.id) await window.desktop.dismissDraft(draft.id, persisted.current.revision);
      setError('');
    } catch { setError('项目已手动保存，但旧自动草稿的标记更新失败；原草稿保留，请在恢复列表中核对。'); }
    workspace.current.sourceFilePath = filePath; setStatus('已手动保存项目');
  }
  return { overview, workspaceId: workspace.current.id, ready, status, error, refresh, flush, leave, switchWorkspace, saved };
}
