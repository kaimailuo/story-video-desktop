import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { captionTimeLimit, compileProjectCaptions, compileSceneCaptions, confirmSubtitleTimeline, estimateSubtitleTimeline, projectSrt, srtTimestamp, subtitleTimelineSchema, visibleCaptionText, type CaptionScene, type SubtitleCue } from './captions';
import { createProject, projectSchema } from './project';

function cue(start = 0, end = 1, text = '字幕'): SubtitleCue { return { id: randomUUID(), start, end, text }; }
function fixture(cues = [cue()]): CaptionScene {
  return { text: '原配音稿', duration: 2, subtitleTimeline: { sourceText: '原配音稿', sourceSpeechId: null, sourceMode: 'global', timing: 'manual', cues } };
}

test('旧项目兼容，空时间轴明确无字幕，旧整镜保留整镜时长', () => {
  const project = projectSchema.parse(createProject());
  assert.equal(project.scenes[0].subtitleTimeline, undefined);
  assert.deepEqual(compileSceneCaptions({ text: '旧字幕', duration: 1.01 }), [{ text: '旧字幕', startFrame: 0, endFrame: 30 }]);
  assert.deepEqual(compileSceneCaptions(fixture([])), []);
  assert.throws(() => projectSrt({ scenes: [fixture([])] }), /没有可导出/);
});

test('30 FPS 向内量化与相邻半开边界；顺序按起点编译，不改草稿', () => {
  const scene = fixture([cue(0.8, 1.001, '后'), cue(0.001, 0.8, '前')]);
  assert.deepEqual(compileSceneCaptions(scene), [{ text: '前', startFrame: 1, endFrame: 24 }, { text: '后', startFrame: 24, endFrame: 30 }]);
  assert.equal(scene.subtitleTimeline!.cues[0].text, '后');
  assert.throws(() => compileSceneCaptions(fixture([cue(0.001, 0.033)])), /不足一帧/);
});

test('空文字、倒置、越界、原始时间重叠及重复编号统一拒绝', () => {
  for (const [cues, message] of [[ [cue(0, 1, ' \n\u0001')], /不能为空/ ], [[cue(1, 1)], /晚于开始/], [[cue(0, 2.01)], /越界/], [[cue(0, 1), cue(0.999, 2)], /重叠/]] as const) {
    assert.throws(() => compileSceneCaptions(fixture([...cues])), message);
  }
  const repeated = cue();
  assert.throws(() => compileSceneCaptions(fixture([repeated, { ...repeated, start: 1, end: 2 }])), /编号重复/);
});

test('配音真实时长优先于镜头量化时长；不读取磁盘或声称语音对齐', () => {
  const scene = fixture([cue(0, 1.1)]);
  scene.speech = { id: randomUUID(), text: scene.text, duration: 1.101 };
  scene.subtitleTimeline!.sourceMode = 'scenes'; scene.subtitleTimeline!.sourceSpeechId = scene.speech.id;
  assert.equal(captionTimeLimit(scene, 'scenes'), 1.101);
  assert.equal(compileSceneCaptions(scene, 'scenes')[0].endFrame, 33);
  scene.subtitleTimeline!.cues[0].end = 1.102;
  assert.throws(() => compileSceneCaptions(scene, 'scenes'), /越界/);
  assert.equal(captionTimeLimit({ ...scene, duration: 1 }, 'scenes'), 1);
});

test('改配音稿、换配音版本或切模式会过期，字幕措辞不会', () => {
  const scene = fixture(); scene.subtitleTimeline!.cues[0].text = '单独修订字幕';
  assert.equal(compileSceneCaptions(scene)[0].text, '单独修订字幕');
  scene.text = '修改配音稿';
  assert.throws(() => compileSceneCaptions(scene), /依据/);
  scene.subtitleTimeline = confirmSubtitleTimeline(scene);
  assert.doesNotThrow(() => compileSceneCaptions(scene));
  assert.throws(() => compileSceneCaptions(scene, 'scenes'), /依据/); // 即使无配音也检查模式。
  scene.subtitleTimeline = confirmSubtitleTimeline(scene, 'scenes');
  scene.speech = { id: randomUUID(), text: scene.text, duration: 2 };
  assert.throws(() => compileSceneCaptions(scene, 'scenes'), /依据/);
  scene.subtitleTimeline = confirmSubtitleTimeline(scene, 'scenes');
  scene.speech.id = randomUUID();
  assert.throws(() => compileSceneCaptions(scene, 'scenes'), /依据/);
});

test('检查确认不裁掉越界，也不能掩盖过期配音；草稿可保存重开', () => {
  const scene = fixture([cue(0, 3)]);
  assert.throws(() => confirmSubtitleTimeline(scene), /越界/);
  const project = createProject(); project.scenes[0].subtitleTimeline = scene.subtitleTimeline; project.scenes[0].text = scene.text;
  assert.deepEqual(projectSchema.parse(JSON.parse(JSON.stringify(project))).scenes[0].subtitleTimeline, scene.subtitleTimeline);
  scene.speech = { id: randomUUID(), text: '过期音频', duration: 2 };
  assert.throws(() => confirmSubtitleTimeline(scene, 'scenes'), /配音文字已过期/);
});

test('估算不丢正文（含空格／换行／Unicode），无空条且只标 estimated', () => {
  for (const text of ['Hello! world。\n下一句😀；结束', '字'.repeat(180), '😀'.repeat(80), 'a!\n b', `开头${' '.repeat(70)}结尾`, '字。'.repeat(90)]) {
    const timeline = estimateSubtitleTimeline({ text, duration: 2 });
    assert.equal(timeline.timing, 'estimated');
    assert.equal(timeline.cues.map((item) => item.text).join(''), visibleCaptionText(text));
    assert.ok(timeline.cues.length <= 20);
    assert.ok(timeline.cues.every((item) => visibleCaptionText(item.text)));
    assert.doesNotThrow(() => compileSceneCaptions({ text, duration: 2, subtitleTimeline: timeline }));
  }
});

test('最多 20 条且极短音频每条至少一帧，无法容纳一帧时报错', () => {
  const scene = { text: '句。'.repeat(30), duration: 1, speech: { id: randomUUID(), text: '句。'.repeat(30), duration: 0.07 } };
  const timeline = estimateSubtitleTimeline(scene, 'scenes');
  assert.equal(timeline.cues.length, 2);
  assert.deepEqual(compileSceneCaptions({ ...scene, subtitleTimeline: timeline }, 'scenes').map((item) => item.endFrame), [1, 2]);
  scene.speech.duration = 0.03;
  assert.throws(() => estimateSubtitleTimeline(scene, 'scenes'), /不足一帧/);
  assert.throws(() => subtitleTimelineSchema.parse({ ...timeline, cues: Array.from({ length: 21 }, () => cue()) }));
  assert.throws(() => estimateSubtitleTimeline({ text: ' \n ', duration: 1 }), /先填写/);
});

test('全局偏移按每镜实际帧数累计，排序后重算，无跨镜时间漂移', () => {
  const first = { ...fixture([cue(0, 0.5, '一')]), duration: 1.019 };
  const second = fixture([cue(0.1, 0.2, '二')]);
  assert.equal(compileProjectCaptions({ scenes: [first, second] })[1].startFrame, 34);
  assert.equal(compileProjectCaptions({ scenes: [second, first] })[1].startFrame, 60);
  assert.throws(() => compileProjectCaptions({ scenes: [first, fixture([cue(0, 3)])] }), /分镜 2/);
});

test('SRT 毫秒时间戳、连续编号、空行和标签转义', () => {
  const srt = projectSrt({ scenes: [fixture([cue(1 / 30, 1, ' <b>A&B</b>\r\n\r\n第二行\u0000 ')])] });
  assert.equal(srt, '1\n00:00:00,033 --> 00:00:01,000\n&lt;b&gt;A&amp;B&lt;/b&gt;\n第二行\n');
  assert.equal(srtTimestamp(108000), '01:00:00,000');
  assert.equal(srtTimestamp(107999), '00:59:59,967');
});
