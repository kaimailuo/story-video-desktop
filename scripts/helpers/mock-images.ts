import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

/** 仅用于测试，图片由本机生成，不调用真实模型或系统密钥存储。 */
export async function startMockImages() {
  const png = await sharp({ create: { width: 48, height: 64, channels: 3, background: '#9875bf' } }).png().toBuffer();
  const requests: { url: string; authorization?: string; body?: Record<string, unknown> }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : undefined;
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization, body });
    if (request.url?.startsWith('/picture')) {
      if (request.url === '/picture-auth' || request.url === '/picture-limit') { response.writeHead(request.url === '/picture-auth' ? 403 : 429); response.end('download failed'); return; }
      if (request.url === '/picture-redirect') { response.writeHead(302, { Location: '/picture' }); response.end(); return; }
      response.setHeader('Content-Type', 'image/png'); response.end(png); return;
    }
    const mode = String(body?.model === 'mock-images' ? body?.prompt : body?.model);
    if (['auth', 'limit', 'fail'].includes(mode)) {
      response.writeHead(mode === 'auth' ? 401 : mode === 'limit' ? 429 : 503);
      response.end(`私密消息 ${request.headers.authorization}`); return;
    }
    if (mode === 'redirect') { response.writeHead(302, { Location: '/redirected' }); response.end(); return; }
    if (mode === 'large') { response.writeHead(200, { 'Content-Length': 30 * 1024 * 1024 }); response.end('x'); return; }
    let item: Record<string, unknown> = { b64_json: png.toString('base64') };
    if (mode === 'url' || mode === 'url-redirect') item = { url: `http://${request.headers.host}/picture${mode === 'url-redirect' ? '-redirect' : ''}` };
    if (mode === 'url-auth' || mode === 'url-limit') item = { url: `http://${request.headers.host}/picture-${mode.slice(4)}` };
    if (mode === 'cross-url') item = { url: 'http://127.0.0.2:12345/private' };
    if (mode === 'bad-base64') item = { b64_json: 'not-a-valid-base64' };
    if (mode === 'svg') item = { b64_json: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>').toString('base64') };
    if (mode === 'corrupt') item = { b64_json: Buffer.from('not an image').toString('base64') };
    const payload = mode === 'bad-json' ? 'not json' : JSON.stringify({ data: mode === 'multi' ? [item, item] : [item] });
    const send = () => { if (!response.destroyed) { if (!response.headersSent) response.setHeader('Content-Type', 'application/json'); response.end(payload); } };
    if (mode === 'slow' || mode === 'slow-body') {
      if (mode === 'slow-body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); }
      const timer = setTimeout(() => { timers.delete(timer); send(); }, 2500);
      timers.add(timer);
    } else send();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
