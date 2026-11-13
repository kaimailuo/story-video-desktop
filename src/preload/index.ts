import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, ExportProgress } from '../shared/project';
import type { ImageProgress } from '../shared/images';
import type { SpeechProgress } from '../shared/speech';

const api: DesktopAPI = {
  checkProjectMedia: (project) => ipcRenderer.invoke('media:check', project),
  getRecovery: () => ipcRenderer.invoke('recovery:get'),
  saveDraft: (draft) => ipcRenderer.invoke('recovery:save', draft),
  loadDraft: (id) => ipcRenderer.invoke('recovery:load', id),
  dismissDraft: (id, revision) => ipcRenderer.invoke('recovery:dismiss', id, revision),
  checkArtifact: (taskId, artifactId) => ipcRenderer.invoke('recovery:check', taskId, artifactId),
  prepareArtifact: (taskId, artifactId, scene) => ipcRenderer.invoke('recovery:prepare', taskId, artifactId, scene),
  onBeforeClose: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, nonce: string) => { void callback().then((ok) => ipcRenderer.send('recovery:close-ready', nonce, ok)).catch(() => ipcRenderer.send('recovery:close-ready', nonce, false)); };
    ipcRenderer.on('recovery:before-close', listener);
    return () => ipcRenderer.removeListener('recovery:before-close', listener);
  },
  exportSubtitles: (project, workspaceId) => ipcRenderer.invoke('subtitles:export', project, workspaceId),
  getSpeechSettings: () => ipcRenderer.invoke('speech:settings:get'),
  saveSpeechSettings: (input) => ipcRenderer.invoke('speech:settings:save', input),
  generateSpeech: (request) => ipcRenderer.invoke('speech:generate', request),
  previewSpeech: (path) => ipcRenderer.invoke('speech:preview', path),
  onSpeechProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SpeechProgress) => callback(progress);
    ipcRenderer.on('speech:progress', listener);
    return () => ipcRenderer.removeListener('speech:progress', listener);
  },
  getImageSettings: () => ipcRenderer.invoke('image:settings:get'),
  saveImageSettings: (input) => ipcRenderer.invoke('image:settings:save', input),
  generateImages: (request) => ipcRenderer.invoke('image:generate', request),
  previewImage: (path) => ipcRenderer.invoke('image:preview', path),
  onImageProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ImageProgress) => callback(progress);
    ipcRenderer.on('image:progress', listener);
    return () => ipcRenderer.removeListener('image:progress', listener);
  },
  getAISettings: () => ipcRenderer.invoke('ai:settings:get'),
  saveAISettings: (input) => ipcRenderer.invoke('ai:settings:save', input),
  runAI: (request) => ipcRenderer.invoke('ai:run', request),
  cancelAI: (id) => ipcRenderer.invoke('ai:cancel', id),
  loadDemo: () => ipcRenderer.invoke('project:demo'),
  importImages: () => ipcRenderer.invoke('media:images'),
  importAudio: () => ipcRenderer.invoke('media:audio'),
  saveProject: (project) => ipcRenderer.invoke('project:save', project),
  openProject: () => ipcRenderer.invoke('project:open'),
  startExport: (project, workspaceId) => ipcRenderer.invoke('export:start', project, workspaceId),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  revealOutput: (path) => ipcRenderer.invoke('export:reveal', path),
  onProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ExportProgress) => callback(progress);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },
};
contextBridge.exposeInMainWorld('desktop', api);
