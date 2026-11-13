import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { _electron, type ElectronApplication } from 'playwright-core';
import { createServer } from 'vite';
import { createDemo } from '../src/main/demo';
import { adoptSceneSpeech, type Project } from '../src/shared/project';
import { projectSrt } from '../src/shared/captions';
import { pcmTone, startMockSpeech } from './helpers/mock-speech';

async function main(): Promise<void> {
  const directory = path.resolve('artifacts'); await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(path.join(directory, 'captions-desktop-profile-'));
  const projectFile = path.join(directory, 'captions-smoke.yingxu.json');
  const outputFile = path.join(directory, 'captions-smoke.mp4');
  const srtFile = path.join(directory, 'captions-smoke.srt');
  const wave = path.join(profile, 'first.wav'); await writeFile(wave, pcmTone(1.101, 440));
  const project = await createDemo(path.join(profile, '素材'));
  project.scenes = project.scenes.slice(0, 2).map((scene, index) => ({ ...scene, text: index === 0 ? 'first' : 'second', duration: 1, motion: 'still' }));
  project.scenes[0] = adoptSceneSpeech(project.scenes[0], { id: randomUUID(), path: wave, text: 'first', duration: 1.101, voice: 'v', speed: 1, model: 'local', createdAt: new Date().toISOString() });
  project.narrationMode = 'scenes'; project.bgmPath = null; project.transition = 'cut';
  await writeFile(projectFile, JSON.stringify(project));
  const mock = await startMockSpeech();
  const server = await createServer({ server: { port: 0, strictPort: false } });
  let desktop: ElectronApplication | undefined; let closing = false;
  try {
    await server.listen();
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    env.VITE_DEV_SERVER_URL = server.resolvedUrls!.local[0]; delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: require('electron') as string, args: [process.cwd(), `--user-data-dir=${profile}`], env, timeout: 40000 });
    await desktop.evaluate(({ app, dialog, safeStorage }, config) => {
      app.setPath('userData', config.profile);
      dialog.showSaveDialog = async (...args: unknown[]) => ({ canceled: false, filePath: (args.at(-1) as { title?: string }).title === '导出 MP4' ? config.outputFile : (args.at(-1) as { title?: string }).title === '导出 SRT 字幕' ? config.srtFile : config.projectFile });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.projectFile] });
      dialog.showMessageBoxSync = () => 1;
      // 只在测试进程替换加密边界，不代表真实 macOS 钥匙串验收。
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (value) => Buffer.from(Array.from(Buffer.from(value), (byte) => byte ^ 0xa5));
      safeStorage.decryptString = (value) => Buffer.from(Array.from(value, (byte) => byte ^ 0xa5)).toString();
    }, { profile, projectFile, outputFile, srtFile });
    const page = await desktop.firstWindow(); const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { void dialog.accept().catch((error: unknown) => { if (!closing) errors.push(String(error)); }); });
    await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor();
    async function open() {
      await page.getByRole('button', { name: '打开本地项目', exact: true }).click();
      await page.getByText('已打开：captions-smoke.yingxu.json', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelectorAll('.scene-card img').length === 2);
    }
    async function save(): Promise<Project> {
      await page.getByRole('button', { name: '保存项目', exact: true }).click();
      await page.getByText('项目已保存：captions-smoke.yingxu.json', { exact: true }).waitFor();
      await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '保存项目')?.disabled);
      return JSON.parse(await readFile(projectFile, 'utf8')) as Project;
    }
    const captions = page.getByRole('region', { name: '字幕时间轴', exact: true });
    const field = (index: number, name: '开始' | '结束') => page.getByRole('spinbutton', { name: `第 ${index} 条字幕${name}`, exact: true });
    async function cursor(frame: number) {
      await page.getByRole('slider', { name: '字幕预览帧' }).fill(String(frame));
    }
    await open();
    await page.getByRole('button', { name: '估算并启用时间轴', exact: true }).click();
    await captions.getByText(/上限 1.101 秒/).waitFor();
    await field(1, '开始').fill('0.1'); await field(1, '结束').fill('0.4');
    await page.getByRole('textbox', { name: '第 1 条字幕文字' }).fill('字幕甲');
    await page.getByRole('button', { name: '添加字幕', exact: true }).click();
    await page.getByRole('textbox', { name: '第 2 条字幕文字' }).fill('字幕乙');
    await field(2, '结束').fill('0.9'); await field(2, '开始').fill('0.6');
    await page.getByRole('button', { name: '检查并确认时间轴', exact: true }).click();
    await captions.getByText(/时间轴检查通过/).waitFor();
    await cursor(3); assert.equal(await page.locator('.preview-caption').innerText(), '字幕甲');
    await cursor(12); assert.equal(await page.locator('.preview-caption').count(), 0);
    await cursor(18); assert.equal(await page.locator('.preview-caption').innerText(), '字幕乙');
    assert.equal((await save()).scenes[0].text, 'first'); // 改字幕不改配音稿。
    await field(2, '开始').fill('0.3'); await captions.getByRole('alert').getByText(/重叠/).waitFor();
    await writeFile(srtFile, '已有字幕');
    await page.getByRole('button', { name: '导出 SRT 字幕', exact: true }).click();
    await page.locator('.error-box').getByText(/重叠/).waitFor();
    assert.equal(await readFile(srtFile, 'utf8'), '已有字幕');
    await save(); await open();
    await captions.getByRole('alert').getByText(/重叠/).waitFor();
    assert.equal(await field(2, '开始').inputValue(), '0.3');
    await field(2, '开始').fill('0.6');
    await page.getByRole('combobox', { name: '导出配音模式' }).selectOption('global');
    await captions.getByRole('alert').getByText(/依据/).waitFor();
    await page.getByRole('button', { name: '检查并确认时间轴', exact: true }).click();
    await page.getByRole('combobox', { name: '导出配音模式' }).selectOption('scenes');
    await captions.getByRole('alert').getByText(/依据/).waitFor();
    await page.getByRole('button', { name: '检查并确认时间轴', exact: true }).click();
    await page.getByRole('button', { name: '删除第 2 条字幕', exact: true }).click();
    await page.getByRole('button', { name: '添加字幕', exact: true }).click();
    await page.getByRole('textbox', { name: '第 2 条字幕文字' }).fill('字幕乙');
    await field(2, '开始').fill('0.6'); await field(2, '结束').fill('0.9');

    // 用本机模拟服务采用更短配音，既检查 id 过期，也检查实际音频边界。
    await page.getByRole('button', { name: '配音模型设置', exact: true }).first().click();
    await page.getByRole('heading', { name: '配音模型设置', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="模型名称"]')?.disabled);
    await page.getByRole('textbox', { name: 'API 基础地址', exact: true }).fill(mock.baseUrl);
    await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('mock-speech');
    await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('sk-local-captions-not-real');
    await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    await page.getByRole('textbox', { name: '配音音色标识', exact: true }).fill('local-voice');
    await page.getByRole('textbox', { name: '当前分镜字幕', exact: true }).fill('last');
    await page.getByRole('button', { name: '生成当前分镜配音', exact: true }).click();
    await page.getByRole('button', { name: '采用此配音', exact: true }).click();
    await captions.getByText(/上限 0.600 秒/).waitFor();
    await captions.getByRole('alert').getByText(/依据/).waitFor();
    await page.getByRole('button', { name: '检查并确认时间轴', exact: true }).click();
    await captions.getByRole('status').getByText(/越界/).waitFor();
    await field(2, '开始').fill('0.4'); await field(2, '结束').fill('0.6');
    await page.getByRole('button', { name: '检查并确认时间轴', exact: true }).click();
    await captions.getByText(/时间轴检查通过/).waitFor();
    assert.equal(await captions.getByRole('alert').count(), 0);
    assert.equal(mock.requests.length, 1);
    // 排序必须随镜头移动时间轴，SRT 按新镜头位置重算全局偏移。
    await page.getByRole('button', { name: '下移分镜', exact: true }).click();
    const saved = await save();
    assert.equal(saved.scenes[1].subtitleTimeline!.cues[0].text, '字幕甲');
    await page.getByRole('button', { name: '导出 SRT 字幕', exact: true }).click();
    await page.getByText('字幕已导出：captions-smoke.srt', { exact: true }).waitFor();
    assert.equal(await readFile(srtFile, 'utf8'), projectSrt(saved));
    assert.match(await readFile(srtFile, 'utf8'), /00:00:01,100 --> 00:00:01,400/);
    await page.getByRole('button', { name: '导出 MP4', exact: true }).click();
    await page.getByText('视频已准备就绪', { exact: true }).waitFor({ timeout: 180000 });
    await cursor(12);
    await page.screenshot({ path: path.join(directory, 'captions-smoke.png'), fullPage: true });
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(layout.scrollWidth <= layout.width);
    await open();
    await page.locator('.scene-card').nth(1).click();
    assert.equal(await page.getByRole('textbox', { name: '第 2 条字幕文字' }).inputValue(), '字幕乙');
    await page.getByRole('button', { name: '恢复整镜字幕', exact: true }).click();
    assert.equal((await save()).scenes[1].subtitleTimeline, undefined);
    await page.getByRole('button', { name: '估算并启用时间轴', exact: true }).click();
    await page.getByRole('button', { name: '删除第 1 条字幕', exact: true }).click();
    assert.equal((await save()).scenes[1].subtitleTimeline!.cues.length, 0);
    assert.deepEqual(errors, []);
    await writeFile(projectFile, JSON.stringify(saved, null, 2));
    console.log('字幕桌面验收通过：估算／编辑／增删、按帧预览、重叠草稿保存重开、模式过期、更短配音采用后过期／越界、检查确认、排序偏移、独立 SRT、真实 MP4、整镜恢复及空时间轴。仅本机模拟，无真实付费调用。');
  } finally {
    closing = true;
    if (desktop) await desktop.close();
    await server.close(); await mock.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
