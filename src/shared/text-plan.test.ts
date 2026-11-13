import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProject, projectSchema } from './project';
import { inspectCoverage, mergeTextWork, partComplete, planText, sourceUnits, textWorkSchema, type TextWork } from './text-plan';
import { runTextWork, TextRunControl } from './text-run';
import type { AIRequest, AIOutcome } from './ai';

function work(kind: TextWork['kind'] = 'rewrite'): TextWork {
  const sourceScript = '第一段内容😀。\n'.repeat(190);
  return { kind, sourceScript, category: 'story', instructions: '保持原意', parts: planText(sourceScript, kind) };
}
function success(request: AIRequest): AIOutcome {
  assert.notEqual(request.kind, 'test');
  if (request.kind === 'test') throw new Error('unexpected');
  const coverage = { sourceCount: sourceUnits(request.script).length, groups: [sourceUnits(request.script).map((unit) => unit.id)] };
  return { ok: true, result: request.kind === 'rewrite' ? { kind: 'rewrite', text: request.script, model: 'mock', coverage } : { kind: 'storyboard', scenes: [{ text: '片段', prompt: '画面提示', description: '画面描述', duration: 3, motion: 'still' }], model: 'mock', coverage } };
}
test('分段逐字保留 30000 字符原文、空白／标点与 Unicode，预算及偏移可重建', () => {
  for (const script of ['  开始。\n\n😀结束！  ', '😀'.repeat(15000), '一\n'.repeat(15000), '长'.repeat(30000)]) {
    for (const kind of ['rewrite', 'storyboard'] as const) {
      const parts = planText(script, kind);
      assert.equal(parts.map((part) => part.text).join(''), script);
      assert.ok(parts.every((part) => part.text === script.slice(part.start, part.end) && part.text.length <= (kind === 'rewrite' ? 1200 : 600)));
      assert.ok(parts.every((part) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part.text)));
    }
  }
});
test('覆盖检查明确检出缺号、重复、乱序和越界，完整映射才通过', () => {
  assert.equal(inspectCoverage({ sourceCount: 3, groups: [[1, 2], [3]] }).valid, true);
  assert.deepEqual(inspectCoverage({ sourceCount: 3, groups: [[1]] }).missing, [2, 3]);
  assert.deepEqual(inspectCoverage({ sourceCount: 2, groups: [[1, 1, 2]] }).duplicate, [1]);
  assert.equal(inspectCoverage({ sourceCount: 2, groups: [[2, 1]] }).outOfOrder, true);
  assert.equal(inspectCoverage({ sourceCount: 2, groups: [[1, 2, 3]] }).invalid, true);
});
test('分段快照拒绝缺段、重排、原文篡改及来源数量不一致', () => {
  const value = work();
  assert.equal(textWorkSchema.safeParse(value).success, true);
  assert.equal(textWorkSchema.safeParse({ ...value, parts: value.parts.slice(1) }).success, false);
  assert.equal(textWorkSchema.safeParse({ ...value, parts: [...value.parts].reverse() }).success, false);
  const bad = structuredClone(value); bad.parts[0].text = '篡改';
  assert.equal(textWorkSchema.safeParse(bad).success, false);
  const mismatch = structuredClone(value); mismatch.parts[0].result = { kind: 'rewrite', model: 'mock', text: '文本', coverage: { sourceCount: 1, groups: [[1]] } };
  assert.equal(textWorkSchema.safeParse(mismatch).success, false);
  assert.throws(() => mergeTextWork(value), /未处理/);
});
test('串行逐段提交，结果保存后再处理下一段；保存／重开保留候选并可整体合并', async () => {
  const value = work(); const events: string[] = [];
  const done = await runTextWork({ work: value, indices: value.parts.map((_, i) => i), control: new TextRunControl(),
    async checkpoint(current) { events.push(`save:${current.parts.filter(partComplete).length}`); return randomUUID(); }, onWork() {},
    async request(request) { events.push('request'); return success(request); },
  });
  assert.deepEqual(events.slice(0, 4), ['save:0', 'request', 'save:1', 'save:1']);
  const project = projectSchema.parse(JSON.parse(JSON.stringify({ ...createProject(), textWork: done })));
  assert.equal(project.textWork?.parts.filter(partComplete).length, value.parts.length);
  assert.equal(mergeTextWork(project.textWork!).kind, 'rewrite');
});
test('失败停止、不重发成功段，显式补跑仅处理未完成段', async () => {
  const value = work('storyboard'); const calls: number[] = [];
  const first = await runTextWork({ work: value, indices: value.parts.map((_, i) => i), control: new TextRunControl(), async checkpoint() { return randomUUID(); }, onWork() {},
    async request(request) { if (request.kind === 'test') throw new Error(); calls.push(request.segment!.index); return request.segment!.index === 2 ? { ok: false, error: { code: 'provider', message: '模拟失败' } } : success(request); },
  });
  assert.deepEqual(calls, [1, 2]); assert.equal(partComplete(first.parts[0]), true); assert.match(first.parts[1].error!, /失败/);
  const done = await runTextWork({ work: first, indices: first.parts.flatMap((part, i) => partComplete(part) ? [] : [i]), control: new TextRunControl(), async checkpoint() { return randomUUID(); }, onWork() {}, async request(request) { assert.notEqual(request.kind === 'test' ? 0 : request.segment!.index, 1); return success(request); } });
  assert.equal(done.parts.every(partComplete), true);
  await assert.rejects(runTextWork({ work: done, indices: [0], control: new TextRunControl(), async checkpoint() { throw new Error(); }, onWork() {}, async request() { throw new Error(); } }), /不会重发成功段/);
});
test('准备期取消零请求，在途取消保留已完成段且不提交下一段', async () => {
  const value = work(); const control = new TextRunControl(); let calls = 0;
  const cancelled = await runTextWork({ work: value, indices: [0], control, async checkpoint() { await control.cancel(async () => { throw new Error('尚未提交'); }); return randomUUID(); }, onWork() {}, async request() { calls++; throw new Error(); } });
  assert.equal(calls, 0); assert.match(cancelled.parts[0].error!, /尚未发送/);
  const running = new TextRunControl(); let forwarded = 0;
  const done = await runTextWork({ work: value, indices: value.parts.map((_, i) => i), control: running, async checkpoint() { return randomUUID(); }, onWork() {}, async request(request) { calls++; await running.cancel(async () => { forwarded++; }); return success(request); } });
  assert.equal(calls, 1); assert.equal(forwarded, 1); assert.equal(partComplete(done.parts[0]), true); assert.equal(done.parts[1].result, undefined);
});
test('保存失败不开始新请求，后置保存失败仍向界面保留成功候选', async () => {
  const value = work(); let calls = 0; let retained: TextWork | undefined;
  const options = { work: value, indices: [0], control: new TextRunControl(), async checkpoint(): Promise<string> { throw new Error('disk'); }, onWork(current: TextWork) { retained = current; }, async request(request: AIRequest) { calls++; return success(request); } };
  await assert.rejects(runTextWork(options), /disk/); assert.equal(calls, 0);
  let saves = 0;
  await assert.rejects(runTextWork({ ...options, control: new TextRunControl(), async checkpoint() { if (++saves > 1) throw new Error('disk'); return randomUUID(); } }), /disk/);
  assert.equal(calls, 1); assert.equal(partComplete(retained!.parts[0]), true);
});
test('覆盖异常保留可审阅结果但不继续，来源数量不一致不能伪装成功', async () => {
  const value = work('storyboard'); let calls = 0;
  for (const mismatch of [false, true]) {
    const done = await runTextWork({ work: value, indices: value.parts.map((_, i) => i), control: new TextRunControl(), async checkpoint() { return randomUUID(); }, onWork() {}, async request(request) {
      calls++; const outcome = success(request);
      if (outcome.ok && outcome.result.kind !== 'test' && outcome.result.coverage) {
        if (mismatch) outcome.result.coverage = { sourceCount: 1, groups: [[1]] };
        else outcome.result.coverage.groups[0].pop();
      }
      return outcome;
    } });
    assert.equal(partComplete(done.parts[0]), false); assert.ok(done.parts[0].error); assert.equal(done.parts[1].result, undefined);
    assert.equal(Boolean(done.parts[0].result), !mismatch);
  }
  assert.equal(calls, 2);
});
test('合并超过 100 镜或 30000 字符明确拒绝，不截断／丢弃', async () => {
  for (const kind of ['rewrite', 'storyboard'] as const) {
    const value = work(kind);
    const done = await runTextWork({ work: value, indices: value.parts.map((_, i) => i), control: new TextRunControl(), async checkpoint() { return randomUUID(); }, onWork() {}, async request(request) { return success(request); } });
    for (const part of done.parts) {
      if (part.result?.kind === 'rewrite') part.result.text = '长'.repeat(30000);
      if (part.result?.kind === 'storyboard') {
        const count = 100; const unitCount = sourceUnits(part.text).length;
        part.result.scenes = Array.from({ length: count }, () => ({ text: '字幕', description: '描述', prompt: '提示', duration: 1, motion: 'still' }));
        part.result.coverage = { sourceCount: unitCount, groups: Array.from({ length: count }, (_, i) => [i + 1]) };
      }
    }
    if (kind === 'storyboard') {
      // 用单元足够多的原文构造合法覆盖：每段 100 句、每句 2 字。
      const script = '甲。'.repeat(700); const parts = planText(script, kind);
      const valid: TextWork = { ...done, sourceScript: script, parts: parts.map((part) => ({ ...part, result: { kind: 'storyboard', model: 'mock', scenes: Array.from({ length: sourceUnits(part.text).length }, () => ({ text: '甲', description: '描述', prompt: '提示', duration: 1, motion: 'still' })), coverage: { sourceCount: sourceUnits(part.text).length, groups: sourceUnits(part.text).map((unit) => [unit.id]) } } })) };
      // 调整为每段 100 镜，每镜覆盖连续多个单元。
      valid.parts.forEach((part) => { if (part.result?.kind === 'storyboard') { const units = sourceUnits(part.text); part.result.scenes = part.result.scenes.slice(0, 100); part.result.coverage.groups = Array.from({ length: 100 }, (_, i) => units.filter((_, j) => Math.floor(j * 100 / units.length) === i).map((unit) => unit.id)); } });
      assert.throws(() => mergeTextWork(valid), /超过当前 100 镜/);
    } else assert.throws(() => mergeTextWork(done), /超过 30000/);
  }
});
