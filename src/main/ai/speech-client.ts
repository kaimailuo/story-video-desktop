import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { aiSettingsSchema, normalizeBaseUrl, type AISettings } from '../../shared/ai';
import { speechRequestSchema, type SpeechBatch, type SpeechClip, type SpeechProgress, type SpeechRequest, type SpeechItem } from '../../shared/speech';
import { MAX_WAV_BYTES, parsePcmWave } from '../audio/wav';
import { AIRequestError } from './client';

async function readAudio(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > MAX_WAV_BYTES) {
    await response.body?.cancel();
    throw new AIRequestError('invalid_response', '配音响应超过 24 MiB，已停止读取。');
  }
  if (!response.body) throw new AIRequestError('invalid_response', '配音服务返回空响应。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_WAV_BYTES) { await reader.cancel(); throw new AIRequestError('invalid_response', '配音响应超过 24 MiB，已停止读取。'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function generateSpeechClip(options: {
  settings: AISettings; apiKey: string; text: string; voice: string; speed: number;
  directory: string; signal: AbortSignal; timeoutMs?: number;
}): Promise<SpeechClip> {
  const settings = aiSettingsSchema.parse(options.settings);
  if (!options.apiKey || /\s/u.test(options.apiKey)) throw new AIRequestError('config', '配音 Key 无效，请重新配置。');
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? settings.timeoutSeconds * 1000);
  timer.unref();
  const assertActive = () => {
    if (options.signal.aborted) throw new AIRequestError('cancelled', '配音已取消；服务端可能仍处理或计费。');
    if (timedOut) throw new AIRequestError('timeout', '配音超时，未自动重试；服务端可能仍处理或计费。');
  };
  const id = randomUUID();
  const output = path.join(options.directory, `${id}.wav`);
  const temporary = `${output}.tmp`;
  let saved = false;
  try {
    assertActive();
    const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/audio/speech`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: settings.model, input: options.text, voice: options.voice, speed: options.speed, response_format: 'wav' }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new AIRequestError('auth', '配音服务拒绝认证，已停止后续调用。');
      if (response.status === 429) throw new AIRequestError('rate_limit', '配音服务限流或额度不足，已停止后续调用，不自动重试。');
      throw new AIRequestError('provider', `配音服务返回 HTTP ${response.status}，未自动重试。`);
    }
    const bytes = await readAudio(response);
    let wave: ReturnType<typeof parsePcmWave>;
    try { wave = parsePcmWave(bytes); }
    catch { throw new AIRequestError('invalid_response', '配音响应必须是完整 PCM16 WAV，单段大于 0 且不超过 60 秒；未采用任何内容。'); }
    assertActive();
    try {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, wave.buffer, { flag: 'wx', mode: 0o600 });
      assertActive();
      await rename(temporary, output);
      saved = true;
      assertActive();
    } catch (error) {
      if (error instanceof AIRequestError) throw error;
      throw new AIRequestError('config', '配音落盘失败，请检查目录权限或磁盘空间；已停止后续调用。');
    }
    return { id, path: output, text: options.text, voice: options.voice, speed: options.speed, model: settings.model, duration: wave.duration, createdAt: new Date().toISOString() };
  } catch (error) {
    if (saved) await rm(output, { force: true }).catch(() => undefined);
    assertActive();
    if (error instanceof AIRequestError) throw error;
    throw new AIRequestError('network', '配音请求失败，请检查网络与协议；不跟随重定向，不自动重试。');
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', cancel);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function generateSpeechBatch(options: {
  settings: AISettings; apiKey: string; request: SpeechRequest; directory: string; signal: AbortSignal;
  onProgress(progress: SpeechProgress): void;
  onItem?(item: SpeechItem): Promise<void>;
}): Promise<SpeechBatch> {
  const request = speechRequestSchema.parse(options.request);
  const batch: SpeechBatch = { items: [], total: request.scenes.length, state: 'done' };
  for (const scene of request.scenes) {
    if (options.signal.aborted) { batch.state = 'cancelled'; break; }
    options.onProgress({ jobId: request.id, completed: batch.items.length, total: batch.total, message: `正在配音第 ${batch.items.length + 1}/${batch.total} 镜` });
    try {
      const clip = await generateSpeechClip({ ...options, text: scene.text, voice: request.voice, speed: request.speed });
      batch.items.push({ ...scene, ok: true, clip });
    } catch (cause) {
      const error = cause instanceof AIRequestError ? cause : new AIRequestError('provider', '本镜配音失败，未自动重试。');
      batch.items.push({ ...scene, ok: false, error: { code: error.code, message: error.message } });
      if (error.code === 'cancelled') batch.state = 'cancelled';
      else if (['auth', 'rate_limit', 'config'].includes(error.code)) batch.state = 'stopped';
    }
    try { await options.onItem?.(batch.items[batch.items.length - 1]); }
    catch { batch.state = 'stopped'; batch.warning = '任务记录写入失败，后续调用已停止；本次已生成文件仍保留，请勿盲目重复生成。'; }
    options.onProgress({ jobId: request.id, completed: batch.items.length, total: batch.total, message: `配音已处理 ${batch.items.length}/${batch.total} 镜` });
    if (batch.state !== 'done') break;
  }
  return batch;
}
