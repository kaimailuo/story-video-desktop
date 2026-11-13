import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startMockAI } from '../../../scripts/helpers/mock-ai';
import { requestAI } from './client';
import { inspectCoverage, sourceUnits } from '../../shared/text-plan';

test('分段真实 HTTP 模拟：结构化改写／分镜包含来源编号，仅发送本段，保留原始空白', async () => {
  const mock = await startMockAI();
  try {
    const script = '  第一段。\n第二段！  ';
    for (const kind of ['rewrite', 'storyboard'] as const) {
      const result = await requestAI({ settings: { baseUrl: mock.baseUrl, model: 'mock-mapped', timeoutSeconds: 5 }, apiKey: 'local-key', signal: new AbortController().signal,
        request: { id: randomUUID(), kind, script, category: 'story', instructions: '', segment: { index: 1, total: 3 } } });
      assert.notEqual(result.kind, 'test');
      if (result.kind === 'test') throw new Error();
      assert.equal(result.coverage?.sourceCount, sourceUnits(script).length); assert.equal(inspectCoverage(result.coverage!).valid, true);
      const messages = mock.requests.at(-1)!.body.messages as { content: string }[];
      const units = JSON.parse(messages[1].content.split('原文单元：')[1]) as { text: string }[];
      assert.equal(units.map((unit) => unit.text).join(''), script);
      assert.equal(mock.requests.at(-1)!.body.max_tokens, 4096);
    }
    assert.equal(mock.requests.length, 2);
  } finally { await mock.close(); }
});
test('模型声明遗漏／重复／乱序／越界被明确标记，不当作完整覆盖', async () => {
  const mock = await startMockAI();
  try {
    for (const suffix of ['missing', 'duplicate', 'order', 'invalid']) {
      const result = await requestAI({ settings: { baseUrl: mock.baseUrl, model: `mock-mapped-${suffix}`, timeoutSeconds: 5 }, apiKey: 'local-key', signal: new AbortController().signal,
        request: { id: randomUUID(), kind: 'storyboard', script: '第一句。第二句。', category: 'story', instructions: '', segment: { index: 1, total: 2 } } });
      assert.ok(result.kind === 'storyboard' && result.coverage && !inspectCoverage(result.coverage).valid);
    }
    assert.equal(mock.requests.length, 4, '没有自动审查调用或重发');
  } finally { await mock.close(); }
});
test('未规划长文／过大单段／缺映射／截断均不放行，不自动追加调用', async () => {
  const mock = await startMockAI();
  try {
    const base = { settings: { baseUrl: mock.baseUrl, model: 'mock-success', timeoutSeconds: 5 }, apiKey: 'local-key', signal: new AbortController().signal };
    const request = { id: randomUUID(), kind: 'storyboard' as const, script: '长'.repeat(601), category: 'story' as const, instructions: '' };
    await assert.rejects(requestAI({ ...base, request }), /分段/);
    await assert.rejects(requestAI({ ...base, request: { ...request, segment: { index: 1, total: 2 } } }), /预算/);
    assert.equal(mock.requests.length, 0);
    for (const model of ['mock-success', 'mock-truncated']) await assert.rejects(requestAI({ ...base, settings: { ...base.settings, model }, request: { ...request, script: '一句。', segment: { index: 1, total: 2 } } }), /来源编号|长度限制/);
    assert.equal(mock.requests.length, 2);
  } finally { await mock.close(); }
});
