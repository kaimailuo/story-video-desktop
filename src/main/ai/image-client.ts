import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { aiSettingsSchema, normalizeBaseUrl, type AISettings } from '../../shared/ai';
import { imageRequestSchema, type ImageBatch, type ImageCandidate, type ImageProgress, type ImageRequest, type ImageItem } from '../../shared/images';
import { AIRequestError } from './client';

const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_JSON = 28 * 1024 * 1024;
const responseSchema = z.object({ data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().max(8192).optional() })).length(1) });

async function readBytes(response: Response, maximum: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new AIRequestError('invalid_response', '图片响应超过大小限制，已停止读取。');
  }
  if (!response.body) throw new AIRequestError('invalid_response', '图片服务返回空响应。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new AIRequestError('invalid_response', '图片响应超过大小限制，已停止读取。'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** URL 图片仅允许已配置 API 的同源地址；不携带 Key，不跟随重定向。 */
export function safeImageUrl(value: string, baseUrl: string): string {
  try {
    const url = new URL(value);
    const base = new URL(normalizeBaseUrl(baseUrl));
    if (url.origin !== base.origin || url.username || url.password || url.hash) throw new Error();
    return url.href;
  } catch { throw new AIRequestError('invalid_response', '图片下载地址必须与 API 同源且不含账号密码；跨域 CDN 暂不支持，请使用返回 b64_json 的服务。'); }
}

function checkStatus(response: Response): void {
  if (response.ok) return;
  if ([401, 403].includes(response.status)) throw new AIRequestError('auth', '图片服务拒绝认证，请检查 Key 和模型权限；已停止后续生图。');
  if (response.status === 429) throw new AIRequestError('rate_limit', '图片服务限流或额度不足；已停止后续生图，不自动重试。');
  throw new AIRequestError('provider', `图片服务返回 HTTP ${response.status}，未自动重试。`);
}

export async function generateImage(options: {
  settings: AISettings; apiKey: string; prompt: string; size: ImageRequest['size'];
  directory: string; signal: AbortSignal; timeoutMs?: number;
}): Promise<ImageCandidate> {
  const settings = aiSettingsSchema.parse(options.settings);
  if (!options.apiKey || /\s/u.test(options.apiKey)) throw new AIRequestError('config', '图片 Key 格式无效，请重新配置。');
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? settings.timeoutSeconds * 1000);
  timer.unref();
  const assertActive = () => {
    if (options.signal.aborted) throw new AIRequestError('cancelled', '生图已取消；服务端可能仍处理或计费。');
    if (timedOut) throw new AIRequestError('timeout', '生图超时，未自动重试；服务端可能仍处理或计费。');
  };
  const id = randomUUID();
  const output = path.join(options.directory, `${id}.png`);
  const temporary = `${output}.tmp`;
  let saved = false;
  try {
    assertActive();
    const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/images/generations`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: settings.model, prompt: options.prompt, n: 1, size: options.size, response_format: 'b64_json' }),
    });
    if (!response.ok) { await response.body?.cancel(); checkStatus(response); }
    const bytes = await readBytes(response, MAX_JSON);
    let json: unknown;
    try { json = JSON.parse(bytes.toString('utf8')) as unknown; }
    catch { throw new AIRequestError('invalid_response', '图片服务未返回有效 JSON，未采用任何图片。'); }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new AIRequestError('invalid_response', '图片响应结构不兼容；每镜必须返回一张图片。');
    const item = parsed.data.data[0];
    let image: Buffer;
    if (item.b64_json) {
      if (item.b64_json.length > Math.ceil(MAX_IMAGE / 3) * 4 || item.b64_json.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(item.b64_json) || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.b64_json)) {
        throw new AIRequestError('invalid_response', '图片 Base64 无效或超过 20 MiB 限制。');
      }
      image = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      const download = await fetch(safeImageUrl(item.url, settings.baseUrl), { redirect: 'error', signal: controller.signal, credentials: 'omit' });
      if (!download.ok) {
        await download.body?.cancel();
        if ([401, 403].includes(download.status)) throw new AIRequestError('auth', '图片下载服务拒绝访问，已停止后续生图；不会向下载地址补发 Key。');
        if (download.status === 429) throw new AIRequestError('rate_limit', '图片下载服务限流，已停止后续生图，不自动重新生成。');
        throw new AIRequestError('provider', `图片下载失败（HTTP ${download.status}），未自动重新生图。`);
      }
      image = await readBytes(download, MAX_IMAGE);
    } else throw new AIRequestError('invalid_response', '服务未返回图片内容。');
    if (!image.length || image.length > MAX_IMAGE) throw new AIRequestError('invalid_response', '图片为空或超过 20 MiB 限制。');
    assertActive();
    let png: Buffer;
    let preview: Buffer;
    try {
      const input = sharp(image, { limitInputPixels: 40_000_000, failOn: 'warning' });
      const metadata = await input.metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error();
      png = await input.rotate().png().toBuffer();
      if (png.length > MAX_IMAGE) throw new Error();
      preview = await sharp(png).resize(640, 640, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    } catch { throw new AIRequestError('invalid_response', '图片损坏、格式不支持或超出解码限制；仅接受静态 PNG／JPEG／WebP。'); }
    assertActive();
    try {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, png, { flag: 'wx', mode: 0o600 });
      assertActive();
      await rename(temporary, output);
      saved = true;
      assertActive();
    } catch (error) {
      if (error instanceof AIRequestError) throw error;
      throw new AIRequestError('config', '图片落盘失败，请检查目录权限或磁盘空间；已停止后续生图。');
    }
    return { id, path: output, prompt: options.prompt, model: settings.model, source: 'generated', createdAt: new Date().toISOString(), preview: `data:image/jpeg;base64,${preview.toString('base64')}` };
  } catch (error) {
    if (saved) await rm(output, { force: true }).catch(() => undefined);
    assertActive();
    if (error instanceof AIRequestError) throw error;
    throw new AIRequestError('network', '图片请求或下载失败，请检查网络与协议兼容性；不跟随重定向，不自动重试。');
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', cancel);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function generateImageBatch(options: {
  settings: AISettings; apiKey: string; request: ImageRequest; directory: string; signal: AbortSignal;
  onProgress(progress: ImageProgress): void;
  onItem?(item: ImageItem): Promise<void>;
}): Promise<ImageBatch> {
  const request = imageRequestSchema.parse(options.request);
  const batch: ImageBatch = { items: [], total: request.scenes.length, state: 'done' };
  for (const scene of request.scenes) {
    if (options.signal.aborted) { batch.state = 'cancelled'; break; }
    options.onProgress({ jobId: request.id, completed: batch.items.length, total: batch.total, message: `正在生成第 ${batch.items.length + 1}/${batch.total} 镜` });
    try {
      const candidate = await generateImage({ ...options, prompt: scene.prompt, size: request.size });
      batch.items.push({ ...scene, ok: true, candidate });
    } catch (cause) {
      const error = cause instanceof AIRequestError ? cause : new AIRequestError('provider', '本镜生成失败，未自动重试。');
      batch.items.push({ ...scene, ok: false, error: { code: error.code, message: error.message } });
      if (error.code === 'cancelled') batch.state = 'cancelled';
      else if (['auth', 'rate_limit', 'config'].includes(error.code)) batch.state = 'stopped';
    }
    try { await options.onItem?.(batch.items[batch.items.length - 1]); }
    catch { batch.state = 'stopped'; batch.warning = '任务记录写入失败，后续调用已停止；本次已生成文件仍保留，请勿盲目重复生成。'; }
    options.onProgress({ jobId: request.id, completed: batch.items.length, total: batch.total, message: `已处理 ${batch.items.length}/${batch.total} 镜` });
    if (batch.state !== 'done') break;
  }
  return batch;
}
