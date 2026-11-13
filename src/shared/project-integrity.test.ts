import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, projectSchema, sceneReplacementWarning, splitScript } from './project';
import { draftInputSchema } from './recovery';
import { randomUUID } from 'node:crypto';

test('项目与自动草稿均拒绝重复分镜 ID，指出冲突镜头且不自动修改', () => {
  const project = createProject(); project.scenes.push({ ...project.scenes[0], text: '另一个分镜' });
  const raw = JSON.stringify(project);
  const result = projectSchema.safeParse(project);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(result.error.issues[0].path, ['scenes', 1, 'id']);
    assert.match(result.error.issues[0].message, /编号重复/);
  }
  assert.equal(draftInputSchema.safeParse({ id: randomUUID(), revision: 1, sourceFilePath: null, project }).success, false);
  assert.equal(JSON.stringify(project), raw);
});

test('兼容旧的非 UUID 唯一分镜编号；规则拆分与默认项目保持有效', () => {
  const project = createProject(); project.scenes[0].id = 'legacy-scene';
  project.scenes.push({ ...project.scenes[0], id: 'legacy-scene-2' });
  assert.equal(projectSchema.safeParse(project).success, true);
  assert.equal(projectSchema.safeParse({ ...project, scenes: splitScript('第一镜。第二镜。') }).success, true);
});

test('无媒体也提示字幕、提示词、时长与排序替换风险，包括空字幕草稿', () => {
  const project = createProject();
  project.scenes[0].subtitleTimeline = { sourceText: project.scenes[0].text, sourceSpeechId: null, sourceMode: 'global', timing: 'manual', cues: [] };
  const warning = sceneReplacementWarning(project.scenes);
  for (const value of ['1 镜独立字幕时间轴', '0 镜图片', '0 镜按镜配音', '绘图提示词', '时长', '排序', '不会删除磁盘素材', '关闭或切换项目后失效']) assert.ok(warning.includes(value));
});
