import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { projectSchema, sceneSchema, type ExportProgress, type ImportedImage, type Project } from '../shared/project';
import { assertMedia, AUDIO_EXTENSIONS, exportVideo, ExportCancelled, IMAGE_EXTENSIONS } from './exporter';
import { createDemo } from './demo';
import { aiRequestSchema, type AIOutcome } from '../shared/ai';
import { AISettingsStore } from './ai/settings-store';
import { AIRequestError, requestAI } from './ai/client';
import { imageRequestSchema, type ImageOutcome } from '../shared/images';
import { generateImageBatch } from './ai/image-client';
import { speechRequestSchema, type SpeechOutcome } from '../shared/speech';
import { generateSpeechBatch } from './ai/speech-client';
import { loadPcmWave } from './audio/wav';
import { exportSubtitles } from './subtitles';
import { projectSrt } from '../shared/captions';
import { RecoveryStore } from './recovery-store';
import { z } from 'zod';
import type { RecoveryTask } from '../shared/recovery';
import { checkProjectMedia } from './media-check';

let window: BrowserWindow | null = null;
let active: { id: string; controller: AbortController } | null = null;
let activeAI: { id: string; controller: AbortController } | null = null;
let exportDialogOpen = false;
let mediaCheckController: AbortController | null = null;
let closeAfterTask = false;
const aiStores = new Map<string, AISettingsStore>();
const knownOutputs = new Set<string>();
const rendererPath = path.join(__dirname, '../../dist/index.html');
const devUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
const MAX_PROJECT_BYTES = 32 * 1024 * 1024;
const recoveryStores = new Map<string, RecoveryStore>();
let closeCheckpoint: { nonce: string; resolve: (ok: boolean) => void } | null = null;
let closeAllowed = false;
let closeSaved = false;

function recoveryStore(): RecoveryStore {
  const directory = app.getPath('userData');
  let store = recoveryStores.get(directory);
  if (!store) { store = new RecoveryStore(directory); recoveryStores.set(directory, store); }
  return store;
}
async function finishRecord(store: RecoveryStore, id: string, state: Exclude<RecoveryTask['state'], 'running' | 'interrupted'>): Promise<void> {
  try { await store.finish(id, state); } catch { store.noteWriteFailure(); }
}

function aiStore(kind: 'text' | 'image' | 'speech' = 'text'): AISettingsStore {
  const directory = app.getPath('userData');
  const key = `${directory}:${kind}`;
  let store = aiStores.get(key);
  if (!store) {
    store = new AISettingsStore(directory, {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    }, kind === 'image' ? 'image-settings.json' : kind === 'speech' ? 'speech-settings.json' : 'ai-settings.json');
    aiStores.set(key, store);
  }
  return store;
}

function finishClosing(): void {
  if (closeAfterTask && !active && !activeAI && !mediaCheckController) { closeAfterTask = false; window?.close(); }
}

function assertSender(event: IpcMainInvokeEvent): BrowserWindow {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的调用来源。');
  const url = event.senderFrame.url;
  if (devUrl ? new URL(url).origin !== new URL(devUrl).origin : url.split('#')[0] !== pathToFileURL(rendererPath).href) throw new Error('不允许的页面来源。');
  return window;
}

async function thumbnail(filePath: string): Promise<string> {
  await assertMedia(filePath, IMAGE_EXTENSIONS);
  const buffer = await sharp(filePath, { limitInputPixels: 80_000_000 }).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

function publish(progress: ExportProgress): void {
  if (window && !window.isDestroyed()) window.webContents.send('export:progress', progress);
}

function registerIPC(): void {
  ipcMain.handle('media:check', async (event, raw: unknown) => {
    assertSender(event);
    if (active || activeAI || exportDialogOpen) throw new Error('已有任务正在进行。');
    const project = projectSchema.parse(raw);
    const controller = new AbortController(); mediaCheckController = controller;
    exportDialogOpen = true;
    try { return await checkProjectMedia(project, { signal: controller.signal }); }
    finally { exportDialogOpen = false; mediaCheckController = null; finishClosing(); }
  });
  ipcMain.handle('recovery:get', (event) => { assertSender(event); return recoveryStore().overview(); });
  ipcMain.handle('recovery:save', async (event, raw: unknown) => {
    assertSender(event);
    try { return await recoveryStore().saveDraft(raw as Parameters<RecoveryStore['saveDraft']>[0]); }
    catch { throw new Error('自动草稿保存失败，旧草稿未覆盖。请检查磁盘空间／权限并手动保存项目。'); }
  });
  ipcMain.handle('recovery:dismiss', (event, id: unknown, revision: unknown) => { assertSender(event); return recoveryStore().dismissDraft(z.string().uuid().parse(id), z.number().int().nonnegative().parse(revision)); });
  ipcMain.handle('recovery:load', async (event, id: unknown) => {
    assertSender(event);
    const draft = await recoveryStore().loadDraft(z.string().uuid().parse(id));
    const previews: Record<string, string> = {};
    for (const scene of draft.project.scenes) if (scene.imagePath && !previews[scene.imagePath]) {
      try { previews[scene.imagePath] = await thumbnail(scene.imagePath); } catch { /* 保留缺失引用，允许继续编辑。 */ }
    }
    return { draft, previews };
  });
  ipcMain.handle('recovery:check', (event, taskId: unknown, artifactId: unknown) => { assertSender(event); return recoveryStore().checkArtifact(z.string().uuid().parse(taskId), z.string().uuid().parse(artifactId)); });
  ipcMain.handle('recovery:prepare', async (event, taskId: unknown, artifactId: unknown, rawScene: unknown) => {
    assertSender(event);
    if (active || activeAI || exportDialogOpen) throw new Error('已有任务正在进行。');
    exportDialogOpen = true;
    try { return await recoveryStore().prepareArtifact(z.string().uuid().parse(taskId), z.string().uuid().parse(artifactId), sceneSchema.parse(rawScene)); }
    finally { exportDialogOpen = false; }
  });
  ipcMain.on('recovery:close-ready', (event, nonce: unknown, ok: unknown) => {
    try { assertSender(event); } catch { return; }
    if (closeCheckpoint && closeCheckpoint.nonce === nonce) closeCheckpoint.resolve(ok === true);
  });
  ipcMain.handle('subtitles:export', async (event, raw: unknown, workspaceId: unknown) => {
    const owner = assertSender(event);
    if (active || activeAI || exportDialogOpen) throw new Error('已有任务正在进行。');
    const project = projectSchema.parse(raw);
    projectSrt(project); // 在打开选择器前报告跨字段错误；不要求图片或音频文件存在。
    exportDialogOpen = true;
    try {
      const selection = await dialog.showSaveDialog(owner, { title: '导出 SRT 字幕', defaultPath: `${project.title.replace(/[/:]/g, '-')}.srt`, filters: [{ name: 'SRT 字幕', extensions: ['srt'] }] });
      if (selection.canceled || !selection.filePath) return null;
      const store = recoveryStore(); const record = await store.begin('srt', 1, z.string().uuid().optional().parse(workspaceId));
      try {
        const output = await exportSubtitles(project, selection.filePath);
        try { await store.item(record, { kind: 'srt', path: output }); } catch { store.noteWriteFailure(); }
        await finishRecord(store, record, 'done'); return output;
      } catch (error) { await finishRecord(store, record, 'failed'); throw error; }
    } finally { exportDialogOpen = false; }
  });
  ipcMain.handle('speech:settings:get', (event) => { assertSender(event); return aiStore('speech').getView(); });
  ipcMain.handle('speech:settings:save', (event, raw: unknown) => {
    assertSender(event);
    if (activeAI) throw new Error('AI 请求进行中，请先取消或等待完成。');
    return aiStore('speech').save(raw);
  });
  ipcMain.handle('speech:preview', async (event, filePath: unknown) => {
    assertSender(event);
    if (typeof filePath !== 'string' || filePath.length > 4096) throw new Error('配音路径无效。');
    try {
      const wave = await loadPcmWave(filePath);
      return `data:audio/wav;base64,${wave.buffer.toString('base64')}`;
    } catch { throw new Error('配音文件缺失或不是支持的 PCM16 WAV，请重新生成。'); }
  });
  ipcMain.handle('speech:generate', async (event, raw: unknown): Promise<SpeechOutcome> => {
    assertSender(event);
    if (activeAI || active || exportDialogOpen) return { ok: false, error: { code: 'busy', message: '已有任务正在进行，请先等待完成或取消。' } };
    const parsed = speechRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { code: 'config', message: '配音参数无效，请检查文字、音色、语速及分镜编号。' } };
    const task = { id: parsed.data.id, controller: new AbortController() };
    activeAI = task;
    const store = recoveryStore(); let record: string | undefined;
    try {
      record = await store.begin('speech', parsed.data.scenes.length, parsed.data.workspaceId);
      const credentials = await aiStore('speech').getCredentials();
      const batch = await generateSpeechBatch({ ...credentials, request: parsed.data, signal: task.controller.signal,
        directory: path.join(app.getPath('userData'), 'generated-speech'),
        onProgress: (progress) => { if (window && !window.isDestroyed()) window.webContents.send('speech:progress', progress); },
        onItem: async (item) => { try { await store.item(record!, item.ok ? { kind: 'speech', path: item.clip.path, sceneId: item.sceneId, speech: item.clip } : undefined); } catch (error) { store.noteWriteFailure(); throw error; } },
      });
      await finishRecord(store, record, batch.state === 'cancelled' ? 'cancelled' : batch.state === 'stopped' ? 'partial' : 'done');
      return { ok: true, batch };
    } catch {
      if (record) await finishRecord(store, record, 'failed');
      return { ok: false, error: { code: 'config', message: '无法读取配音配置或写入任务记录；未自动重试，请检查模型设置及磁盘权限。' } };
    } finally {
      if (activeAI?.id === task.id) activeAI = null;
      finishClosing();
    }
  });
  ipcMain.handle('image:settings:get', (event) => { assertSender(event); return aiStore('image').getView(); });
  ipcMain.handle('image:settings:save', (event, raw: unknown) => {
    assertSender(event);
    if (activeAI) throw new Error('AI 请求进行中，请先取消或等待完成。');
    return aiStore('image').save(raw);
  });
  ipcMain.handle('image:preview', (event, filePath: unknown) => {
    assertSender(event);
    if (typeof filePath !== 'string' || filePath.length > 4096) throw new Error('图片路径无效。');
    return thumbnail(filePath);
  });
  ipcMain.handle('image:generate', async (event, raw: unknown): Promise<ImageOutcome> => {
    assertSender(event);
    if (activeAI || active || exportDialogOpen) return { ok: false, error: { code: 'busy', message: '已有任务正在进行，请先等待完成或取消。' } };
    const parsed = imageRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { code: 'config', message: '生图参数无效，请检查提示词、尺寸及分镜编号。' } };
    const task = { id: parsed.data.id, controller: new AbortController() };
    activeAI = task;
    const store = recoveryStore(); let record: string | undefined;
    try {
      record = await store.begin('image', parsed.data.scenes.length, parsed.data.workspaceId);
      const credentials = await aiStore('image').getCredentials();
      const batch = await generateImageBatch({ ...credentials, request: parsed.data, signal: task.controller.signal,
        directory: path.join(app.getPath('userData'), 'generated-images'),
        onProgress: (progress) => { if (window && !window.isDestroyed()) window.webContents.send('image:progress', progress); },
        onItem: async (item) => { try { await store.item(record!, item.ok ? { kind: 'image', path: item.candidate.path, sceneId: item.sceneId, image: item.candidate } : undefined); } catch (error) { store.noteWriteFailure(); throw error; } },
      });
      await finishRecord(store, record, batch.state === 'cancelled' ? 'cancelled' : batch.state === 'stopped' ? 'partial' : 'done');
      return { ok: true, batch };
    } catch {
      if (record) await finishRecord(store, record, 'failed');
      return { ok: false, error: { code: 'config', message: '无法读取图片配置或写入任务记录；未自动重试，请检查模型设置及磁盘权限。' } };
    } finally {
      if (activeAI?.id === task.id) activeAI = null;
      finishClosing();
    }
  });
  ipcMain.handle('ai:settings:get', (event) => { assertSender(event); return aiStore().getView(); });
  ipcMain.handle('ai:settings:save', (event, raw: unknown) => {
    assertSender(event);
    if (activeAI) throw new Error('AI 请求进行中，请先取消或等待完成再修改设置。');
    return aiStore().save(raw);
  });
  ipcMain.handle('ai:run', async (event, raw: unknown): Promise<AIOutcome> => {
    assertSender(event);
    if (activeAI || active || exportDialogOpen) return { ok: false, error: { code: 'busy', message: '已有任务正在进行，请先等待完成或取消。' } };
    const parsed = aiRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { code: 'config', message: '请求参数不符合要求，请检查文案和补充要求。' } };
    const task = { id: parsed.data.id, controller: new AbortController() };
    activeAI = task;
    const store = recoveryStore(); let record: string | undefined;
    try {
      record = await store.begin(parsed.data.kind, 1, parsed.data.workspaceId);
      const credentials = await aiStore().getCredentials();
      const result = await requestAI({ ...credentials, request: parsed.data, signal: task.controller.signal });
      try { await store.textResult(record, result); } catch { store.noteWriteFailure(); }
      await finishRecord(store, record, 'done');
      return { ok: true, result };
    } catch (error) {
      if (record) await finishRecord(store, record, error instanceof AIRequestError && error.code === 'cancelled' ? 'cancelled' : 'failed');
      if (error instanceof AIRequestError) return { ok: false, error: { code: error.code, message: error.message } };
      return { ok: false, error: { code: 'config', message: '无法读取模型配置或写入任务记录；未自动重试，请检查设置及磁盘权限。' } };
    } finally {
      if (activeAI?.id === task.id) activeAI = null;
      finishClosing();
    }
  });
  ipcMain.handle('ai:cancel', (event, id: unknown) => {
    assertSender(event);
    if (typeof id === 'string' && id === activeAI?.id) activeAI.controller.abort();
  });
  ipcMain.handle('project:demo', async (event) => {
    assertSender(event);
    const project = await createDemo(path.join(app.getPath('userData'), 'demo-assets'));
    const previews: Record<string, string> = {};
    for (const scene of project.scenes) if (scene.imagePath) previews[scene.imagePath] = await thumbnail(scene.imagePath);
    return { project, previews, filePath: '' };
  });
  ipcMain.handle('media:images', async (event) => {
    const owner = assertSender(event);
    const selection = await dialog.showOpenDialog(owner, { title: '导入分镜图片', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS.map((ext) => ext.slice(1)) }] });
    if (selection.canceled) return [];
    if (selection.filePaths.length > 100) throw new Error('一次最多导入 100 张图片。');
    const result: ImportedImage[] = [];
    for (const filePath of selection.filePaths) result.push({ path: filePath, preview: await thumbnail(filePath) });
    return result;
  });
  ipcMain.handle('media:audio', async (event) => {
    const owner = assertSender(event);
    const selection = await dialog.showOpenDialog(owner, { title: '导入配音或背景音乐', properties: ['openFile'], filters: [{ name: '音频', extensions: AUDIO_EXTENSIONS.map((ext) => ext.slice(1)) }] });
    if (selection.canceled) return null;
    await assertMedia(selection.filePaths[0], AUDIO_EXTENSIONS);
    return selection.filePaths[0];
  });
  ipcMain.handle('project:save', async (event, raw: unknown) => {
    const owner = assertSender(event);
    const project = projectSchema.parse(raw);
    const serialized = JSON.stringify(project, null, 2);
    if (Buffer.byteLength(serialized) > MAX_PROJECT_BYTES) throw new Error('项目及改写记录超过 32 MiB，请精简内容后再保存。');
    const selection = await dialog.showSaveDialog(owner, { title: '保存项目', defaultPath: `${project.title.replace(/[/:]/g, '-')}.yingxu.json`, filters: [{ name: '映序项目', extensions: ['json'] }] });
    if (selection.canceled || !selection.filePath) return null;
    const temporary = `${selection.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { flag: 'wx' });
      await rename(temporary, selection.filePath);
    } finally { await rm(temporary, { force: true }); }
    return selection.filePath;
  });
  ipcMain.handle('project:open', async (event) => {
    const owner = assertSender(event);
    const selection = await dialog.showOpenDialog(owner, { title: '打开映序项目', properties: ['openFile'], filters: [{ name: '映序项目', extensions: ['json'] }] });
    if (selection.canceled) return null;
    const filePath = selection.filePaths[0];
    if ((await stat(filePath)).size > MAX_PROJECT_BYTES) throw new Error('项目文件超过 32 MiB，不是支持的映序项目。');
    const project: Project = projectSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
    const previews: Record<string, string> = {};
    for (const scene of project.scenes) {
      if (scene.imagePath && !previews[scene.imagePath]) {
        try { previews[scene.imagePath] = await thumbnail(scene.imagePath); } catch { /* 缺失素材在界面中标记，允许重新关联。 */ }
      }
    }
    return { project, previews, filePath };
  });
  ipcMain.handle('export:start', async (event, raw: unknown, workspaceId: unknown) => {
    const owner = assertSender(event);
    if (active || activeAI || exportDialogOpen) throw new Error('已有任务正在进行。');
    const project = projectSchema.parse(raw);
    const context = z.string().uuid().optional().parse(workspaceId);
    const controller = new AbortController(); mediaCheckController = controller;
    exportDialogOpen = true;
    let filePath: string | undefined;
    let report: Awaited<ReturnType<typeof checkProjectMedia>>;
    try {
      report = await checkProjectMedia(project, { signal: controller.signal });
      if (!report.canExport) return { blocked: true as const, report };
      const selection = await dialog.showSaveDialog(owner, { title: '导出 MP4', defaultPath: `${project.title.replace(/[/:]/g, '-')}.mp4`, filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] });
      controller.signal.throwIfAborted();
      if (selection.canceled || !selection.filePath) return null;
      filePath = selection.filePath;
    } finally { exportDialogOpen = false; mediaCheckController = null; finishClosing(); }
    const job = { id: randomUUID(), controller: new AbortController() };
    active = job;
    const store = recoveryStore(); let record: string;
    try { record = await store.begin('mp4', 1, context); }
    catch { active = null; throw new Error('无法写入导出任务记录，未开始渲染；请检查磁盘空间／权限。'); }
    // 延至下个事件循环，让渲染进程先收到任务 ID。
    setImmediate(() => {
      void exportVideo({
        project, outputPath: filePath!, signal: job.controller.signal,
        onProgress: (percent, message) => publish({ jobId: job.id, percent, message, state: 'running' }),
      }).then(async (outputPath) => {
        try { await store.item(record, { kind: 'mp4', path: outputPath }); } catch { store.noteWriteFailure(); }
        await finishRecord(store, record, 'done');
        knownOutputs.add(outputPath);
        publish({ jobId: job.id, percent: 100, message: 'MP4 导出完成', state: 'done', outputPath });
      }).catch(async (error: unknown) => {
        const cancelled = error instanceof ExportCancelled;
        await finishRecord(store, record, cancelled ? 'cancelled' : 'failed');
        publish({ jobId: job.id, percent: 0, message: error instanceof Error ? error.message : '导出失败', state: cancelled ? 'cancelled' : 'error' });
      }).finally(() => {
        if (active?.id === job.id) active = null;
        finishClosing();
      });
    });
    return { jobId: job.id, report };
  });
  ipcMain.handle('export:cancel', (event) => { assertSender(event); active?.controller.abort(); });
  ipcMain.handle('export:reveal', (event, filePath: unknown) => {
    assertSender(event);
    if (typeof filePath !== 'string' || !knownOutputs.has(filePath)) throw new Error('只能定位本次导出的文件。');
    shell.showItemInFolder(filePath);
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1120, minHeight: 740, backgroundColor: '#0d1017',
    title: '映序 · 本地视频工作台',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => { event.preventDefault(); });
  window.webContents.on('will-prevent-unload', (event) => {
    if (!window) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', buttons: ['返回保存', '退出（保留已写草稿）'], defaultId: 0, cancelId: 0,
      message: '当前项目有未手动保存的更改。', detail: closeSaved ? '最新编辑已写入独立自动草稿；退出后可恢复。手动项目文件及原始素材不会被改写。' : '自动草稿写入未确认，退出可能丢失最新编辑。建议返回手动保存；原始素材不会被删除。',
    });
    // Electron 中 preventDefault 表示忽略页面的阻止卸载请求。
    if (choice === 1) event.preventDefault();
  });
  window.on('close', (event) => {
    if (closeAllowed) { closeAllowed = false; return; }
    if (active || activeAI || mediaCheckController) {
      const result = dialog.showMessageBoxSync(window!, { type: 'question', buttons: ['继续任务', '取消并退出'], defaultId: 0, cancelId: 0, message: mediaCheckController ? '素材正在检查，确定取消并关闭吗？' : active ? '视频正在导出，确定取消并关闭吗？' : 'AI 请求进行中，确定取消并关闭吗？', detail: activeAI ? '取消本地请求不保证服务端停止处理或计费。' : undefined });
      if (result === 0) event.preventDefault();
      else {
        event.preventDefault();
        closeAfterTask = true;
        active?.controller.abort();
        activeAI?.controller.abort();
        mediaCheckController?.abort();
      }
      return;
    }
    event.preventDefault();
    if (closeCheckpoint) return;
    const owner = window!; const nonce = randomUUID();
    void new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      closeCheckpoint = { nonce, resolve: (ok) => { clearTimeout(timer); resolve(ok); } };
      owner.webContents.send('recovery:before-close', nonce);
    }).then((ok) => {
      closeCheckpoint = null; closeSaved = ok;
      if (!owner.isDestroyed()) { closeAllowed = true; owner.close(); }
    });
  });
  window.on('closed', () => { activeAI?.controller.abort(); mediaCheckController?.abort(); window = null; });
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(rendererPath);
}

void app.whenReady().then(() => { registerIPC(); createWindow(); });
app.on('window-all-closed', () => { active?.controller.abort(); activeAI?.controller.abort(); mediaCheckController?.abort(); app.quit(); });
