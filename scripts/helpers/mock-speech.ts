import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 本机测试音调，不是模型生成的人声。 */
export function pcmTone(duration = 1.101, frequency = 440, sampleRate = 24000, channels = 1): Buffer {
  const frames = Math.round(duration * sampleRate);
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) {
    const value = Math.round(Math.sin(2 * Math.PI * frequency * frame / sampleRate) * 8000);
    for (let channel = 0; channel < channels; channel++) bytes.writeInt16LE(value, 44 + (frame * channels + channel) * 2);
  }
  return bytes;
}

export async function startMockSpeech() {
  const requests: { url: string; authorization?: string; body: Record<string, unknown> }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization, body });
    const mode = String(body.model === 'mock-speech' ? body.input : body.model);
    if (['auth', 'limit', 'fail'].includes(mode)) { response.writeHead(mode === 'auth' ? 401 : mode === 'limit' ? 429 : 503); response.end(`私密错误 ${request.headers.authorization}`); return; }
    if (mode === 'redirect') { response.writeHead(302, { Location: '/redirected' }); response.end(); return; }
    if (mode === 'large') { response.writeHead(200, { 'Content-Length': 25 * 1024 * 1024 }); response.end('x'); return; }
    let wave = pcmTone(mode === 'last' ? 0.6 : 1.101, mode === 'last' ? 880 : 440);
    if (mode === 'corrupt') wave = Buffer.from('not a WAV');
    if (mode === 'float') wave.writeUInt16LE(3, 20);
    const send = () => { if (!response.destroyed) { if (!response.headersSent) response.setHeader('Content-Type', 'audio/wav'); response.end(wave); } };
    if (mode === 'slow' || mode === 'slow-body') {
      if (mode === 'slow-body') { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.flushHeaders(); }
      const timer = setTimeout(() => { timers.delete(timer); send(); }, 2500); timers.add(timer);
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
