import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const mockRewrite = '清晨的街道还很安静，一个新的故事正悄悄开始。';
export const mockScenes = [
  { text: '清晨，城市还未醒来。', description: '晨光中的安静街道，远处楼宇逐渐明亮。', prompt: '清晨的城市街道，柔和晨光，电影感构图，无文字', duration: 3, motion: 'zoom' as const },
  { text: '新的故事，从一个画面开始。', description: '一扇被晨光照亮的窗，窗前放着书本。', prompt: '晨光照亮窗前的书本，温暖色调，中景，无文字', duration: 4, motion: 'still' as const },
];

interface RecordedRequest { url: string; authorization: string | undefined; body: Record<string, unknown> }

/** 仅供自动化测试：本机临时 HTTP 服务，不进入应用运行路径，不访问外部网络。 */
export async function startMockAI() {
  const requests: RecordedRequest[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization, body });
    const model = String(body.model);
    if (model === 'mock-401' || model === 'mock-429' || model === 'mock-503') {
      response.writeHead(Number(model.slice(5)), { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: `敏感服务消息 ${request.headers.authorization}` }));
      return;
    }
    if (model === 'mock-redirect') { response.writeHead(302, { Location: '/redirect-target' }); response.end(); return; }
    if (model === 'mock-html') { response.end('<html>not json</html>'); return; }
    if (model === 'mock-large') { response.end('x'.repeat(2 * 1024 * 1024 + 1)); return; }
    const messages = body.messages as { role: string; content: string }[];
    const isStoryboard = messages.some((message) => message.content.includes('scenes'));
    const isTest = messages.length === 1;
    let content = isTest ? 'OK' : isStoryboard ? JSON.stringify({ scenes: mockScenes }) : mockRewrite;
    if (model.startsWith('mock-mapped')) {
      const user = messages.find((message) => message.role === 'user')?.content ?? '';
      const units = JSON.parse(user.split('原文单元：')[1]) as { id: number; text: string }[];
      if (model === 'mock-mapped-fail-second' && user.includes('第 2/')) { response.writeHead(503); response.end('{}'); return; }
      let ids = units.map((unit) => unit.id);
      if (model === 'mock-mapped-missing') ids = ids.slice(0, -1);
      if (model === 'mock-mapped-duplicate') ids.push(ids[0]);
      if (model === 'mock-mapped-order') ids = ids.reverse();
      if (model === 'mock-mapped-invalid') ids.push(units.length + 1);
      content = isStoryboard ? JSON.stringify({ scenes: [{ ...mockScenes[0], sourceIds: ids }] }) : JSON.stringify({ text: units.map((unit) => unit.text).join('').trim(), sourceIds: ids });
    }
    if (model === 'mock-invalid-json') content = '不是 JSON';
    if (model === 'mock-invalid-scene') content = JSON.stringify({ scenes: [{ ...mockScenes[0], duration: 0 }] });
    if (model === 'mock-extra-field') content = JSON.stringify({ scenes: [{ ...mockScenes[0], imagePath: '/private/secret.png' }] });
    if (model === 'mock-fenced') content = `\`\`\`json\n${content}\n\`\`\``;
    const result = { choices: [{ message: { content }, finish_reason: model === 'mock-truncated' ? 'length' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } };
    const send = () => { if (!response.destroyed) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); } };
    if (model === 'mock-slow' || model === 'mock-slow-body') {
      if (model === 'mock-slow-body') { response.setHeader('Content-Type', 'application/json'); response.flushHeaders(); }
      const timer = setTimeout(() => { timers.delete(timer); send(); }, 2500);
      timers.add(timer);
    } else send();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
