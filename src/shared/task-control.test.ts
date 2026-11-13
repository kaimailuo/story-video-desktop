import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidateItems, PreparedTask } from './task-control';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('准备阶段取消：检查点完成后不提交，不发送无效取消 IPC', async () => {
  const checkpoint = deferred<string>(); const task = new PreparedTask('task');
  let submitted = 0; let cancelled = 0;
  const result = task.run(() => checkpoint.promise, async () => { submitted++; return 'result'; });
  await task.cancel(async () => { cancelled++; });
  checkpoint.resolve('workspace');
  assert.equal(await result, null); assert.equal(submitted, 0); assert.equal(cancelled, 0);
});

test('尚未开始即取消：不执行检查点或生成', async () => {
  const task = new PreparedTask('task');
  await task.cancel(async () => assert.fail('尚未提交，不应发送取消'));
  assert.equal(await task.run(async () => { assert.fail('不应写检查点'); }, async () => assert.fail('不应生成')), null);
});

test('正常提交仅一次，保留工作区与结果；禁止复用任务重发', async () => {
  const task = new PreparedTask('task'); let submitted = 0;
  assert.equal(await task.run(async () => 'workspace', async (id) => { submitted++; assert.equal(id, 'workspace'); return 'candidate'; }), 'candidate');
  await assert.rejects(task.run(async () => 'workspace', async () => 'duplicate'), /不能重复提交/);
  assert.equal(submitted, 1);
});

test('提交后取消转发原任务编号，不丢弃已经成功的结果', async () => {
  const task = new PreparedTask('task'); const pending = deferred<string>(); const entered = deferred<void>();
  const result = task.run(async () => 'workspace', async () => { entered.resolve(); return pending.promise; });
  await entered.promise;
  const ids: string[] = []; await task.cancel(async (id) => { ids.push(id); });
  pending.resolve('completed');
  assert.deepEqual(ids, ['task']); assert.equal(await result, 'completed'); assert.equal(task.isCancelled, true);
});

test('检查点失败不提交；提交或取消失败不自动重试', async () => {
  const task = new PreparedTask('prepare-failed');
  await assert.rejects(task.run(async () => { throw new Error('checkpoint'); }, async () => assert.fail('不应提交')), /checkpoint/);
  const submitted = new PreparedTask('submit-failed'); let calls = 0;
  await assert.rejects(submitted.run(async () => 'workspace', async () => { calls++; throw new Error('request'); }), /request/);
  await assert.rejects(submitted.cancel(async () => { throw new Error('cancel'); }), /cancel/);
  assert.equal(calls, 1);
});

interface Item { sceneId: string; ok: boolean; result: string }
const item = (sceneId: string, ok: boolean, result: string): Item => ({ sceneId, ok, result });

test('同镜后续失败保留成功候选并独立显示错误，重复失败不累积', () => {
  const success = item('s1', true, 'candidate'); const failure = item('s1', false, 'failure');
  const old = [success]; const incoming = [failure];
  const result = mergeCandidateItems(old, incoming);
  assert.deepEqual(result, [success, failure]); assert.deepEqual(old, [success]); assert.deepEqual(incoming, [failure]);
  assert.deepEqual(mergeCandidateItems(result, [item('s1', false, 'latest')]), [success, item('s1', false, 'latest')]);
});

test('新成功替换同镜旧候选与失败，不影响其他镜头或未执行项', () => {
  const untouched = item('s2', true, 'other'); const latest = item('s1', true, 'latest');
  assert.deepEqual(mergeCandidateItems([item('s1', true, 'old'), item('s1', false, 'error'), untouched], [latest]), [untouched, latest]);
  assert.deepEqual(mergeCandidateItems([untouched], []), [untouched]);
});
