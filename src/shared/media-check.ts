export interface MediaCheckItem {
  kind: 'image' | 'speech' | 'narration' | 'bgm' | 'captions';
  sceneId?: string;
  sceneIndex?: number;
  path: string | null;
  active: boolean;
  status: 'ok' | 'error' | 'warning' | 'skipped';
  messages: string[];
}

export interface MediaCheckReport {
  checkedAt: string;
  canExport: boolean;
  items: MediaCheckItem[];
}

export type ExportStartResult = { jobId: string; report: MediaCheckReport } | { blocked: true; report: MediaCheckReport };

export function mediaCheckLabel(item: MediaCheckItem): string {
  const names = { image: '图片', speech: '按镜配音', narration: '全片配音', bgm: '背景音乐', captions: '字幕时间轴' };
  return `${item.sceneIndex === undefined ? '' : `分镜 ${item.sceneIndex + 1} · `}${names[item.kind]}`;
}

export function mediaCheckErrors(report: MediaCheckReport): string {
  return report.items.filter((item) => item.status === 'error').map((item) => `${mediaCheckLabel(item)}：${item.messages.join('；')}`).join('\n');
}
