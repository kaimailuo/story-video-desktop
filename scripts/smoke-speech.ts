import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron, type ElectronApplication } from 'playwright-core';
import { createServer } from 'vite';
import { pcmTone, startMockSpeech } from './helpers/mock-speech';
import { assertSpeechTimeline, decodeAudio } from './helpers/check-speech-audio';
import { resolveFfmpeg } from '../src/main/exporter';
import type { DesktopAPI, Project } from '../src/shared/project';

async function main(): Promise<void> {
  const directory = path.resolve('artifacts'); await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(path.join(directory, 'speech-desktop-profile-'));
  const projectFile = path.join(directory, 'speech-smoke.yingxu.json');
  const outputFile = path.join(directory, 'speech-smoke.mp4');
  const globalFile = path.join(profile, 'global.wav'); await writeFile(globalFile, pcmTone(2, 220));
  const fakeKey = 'sk-local-speech-not-a-real-key';
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
      dialog.showSaveDialog = async (...args: unknown[]) => ({ canceled: false, filePath: (args.at(-1) as { title?: string }).title === '导出 MP4' ? config.outputFile : config.projectFile });
      dialog.showOpenDialog = async (...args: unknown[]) => ({ canceled: false, filePaths: [(args.at(-1) as { title?: string }).title === '导入配音或背景音乐' ? config.globalFile : config.projectFile] });
      dialog.showMessageBoxSync = () => 1;
      // 仅替换本测试进程的系统加密边界，不是 macOS 钥匙串验收。
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (value) => Buffer.from(Array.from(Buffer.from(value), (byte) => byte ^ 0xa5));
      safeStorage.decryptString = (value) => Buffer.from(Array.from(value, (byte) => byte ^ 0xa5)).toString();
    }, { profile, projectFile, outputFile, globalFile });
    const page = await desktop.firstWindow(); const errors: string[] = []; let approve = true;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { void (approve ? dialog.accept() : dialog.dismiss()).catch((error: unknown) => { if (!closing) errors.push(error instanceof Error ? error.message : '对话框处理失败'); }); });
    await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor();
    await page.getByRole('button', { name: '载入演示项目' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.scene-card img').length === 3);
    // 保留一条有效全片音轨，后面通过静音区验证没有重复混音。
    await page.locator('.audio-field').first().getByRole('button', { name: '导入', exact: true }).click();
    await page.getByRole('button', { name: '移除背景音乐', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'AI 按镜配音', exact: true });
    async function textAt(index: number, text: string) {
      await page.locator('.scene-card').nth(index).click();
      await page.getByRole('textbox', { name: '当前分镜字幕', exact: true }).fill(text);
    }
    async function save(): Promise<Project> {
      await page.getByRole('button', { name: '保存项目', exact: true }).click();
      await page.getByText('项目已保存：speech-smoke.yingxu.json', { exact: true }).waitFor();
      await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '保存项目')?.disabled);
      return JSON.parse(await readFile(projectFile, 'utf8')) as Project;
    }
    async function openSettings() {
      await page.getByRole('button', { name: '配音模型设置', exact: true }).first().click();
      await page.getByRole('heading', { name: '配音模型设置', exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="模型名称"]')?.disabled);
    }
    await openSettings();
    await page.getByRole('textbox', { name: 'API 基础地址', exact: true }).fill(mock.baseUrl);
    await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('mock-speech');
    await page.getByRole('textbox', { name: 'API Key', exact: true }).fill(fakeKey);
    await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'API Key', exact: true }).inputValue(), '');
    assert.equal(mock.requests.length, 0);
    assert.ok(!(await readFile(path.join(profile, 'speech-settings.json'), 'utf8')).includes(fakeKey));
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    const independent = await page.evaluate(async () => { const api = (window as Window & { desktop?: DesktopAPI }).desktop!; return [await api.getAISettings(), await api.getImageSettings()]; });
    assert.ok(independent.every((view) => !view.hasKey));
    await page.getByRole('textbox', { name: '配音音色标识' }).fill('local-voice');
    await page.getByRole('spinbutton', { name: '配音语速' }).fill('1.15');
    await textAt(0, 'first');
    approve = false;
    await page.getByRole('button', { name: '生成当前分镜配音', exact: true }).click();
    assert.equal(mock.requests.length, 0); approve = true;
    await page.getByRole('button', { name: '生成当前分镜配音', exact: true }).click();
    await page.getByRole('button', { name: '采用此配音', exact: true }).waitFor();
    let saved = await save();
    assert.equal(saved.scenes[0].speech, undefined); assert.equal(saved.scenes[0].duration, 3);
    await workspace.getByRole('button', { name: '加载试听', exact: true }).click();
    await page.waitForFunction(() => { const audio = document.querySelector('audio'); return audio && audio.readyState >= 2 && Math.abs(audio.duration - 1.101) < 0.001; });
    await page.locator('audio').evaluate(async (element) => { await (element as HTMLAudioElement).play(); });
    await page.waitForFunction(() => document.querySelector('audio')!.currentTime > 0.05);
    await page.locator('audio').evaluate((element) => (element as HTMLAudioElement).pause());
    await page.getByRole('textbox', { name: '当前分镜字幕', exact: true }).fill('改变文字');
    assert.equal(await page.getByRole('button', { name: '采用此配音', exact: true }).isDisabled(), true);
    await page.getByRole('textbox', { name: '当前分镜字幕', exact: true }).fill('first');
    await page.getByRole('button', { name: '采用此配音', exact: true }).click();
    saved = await save();
    assert.equal(saved.scenes[0].duration, 34 / 30); assert.equal(saved.scenes[0].speech!.duration, 1.101);
    assert.equal(saved.narrationMode, 'scenes'); assert.equal(saved.narrationPath, globalFile);
    assert.deepEqual(saved.speechOptions, { voice: 'local-voice', speed: 1.15 });
    await page.getByRole('combobox', { name: '导出配音模式' }).selectOption('global');
    assert.equal((await save()).narrationPath, globalFile);
    await page.getByRole('combobox', { name: '导出配音模式' }).selectOption('scenes');
    await page.getByRole('button', { name: '生成当前分镜配音', exact: true }).click();
    await page.getByRole('button', { name: '丢弃配音候选', exact: true }).click();
    assert.equal(await workspace.getByRole('button', { name: '采用此配音' }).count(), 0);

    await textAt(1, 'fail'); await textAt(2, 'last');
    const beforeMissing = mock.requests.length;
    await page.getByRole('button', { name: '批量生成缺失或过期配音', exact: true }).click();
    await page.getByText(/配音已完成：成功 1，失败 1，未执行 0/).waitFor();
    assert.equal(mock.requests.length - beforeMissing, 2);
    await page.getByRole('button', { name: '采用此配音', exact: true }).click();
    saved = await save();
    assert.equal(saved.scenes[2].duration, 1); assert.equal(saved.scenes[1].speech, undefined);
    assert.ok(!JSON.stringify(saved).includes(fakeKey) && !JSON.stringify(saved).includes(mock.baseUrl) && !JSON.stringify(saved).includes('data:audio'));
    await page.getByRole('button', { name: '打开本地项目', exact: true }).click();
    await page.getByText('已打开：speech-smoke.yingxu.json', { exact: true }).waitFor();
    assert.equal(await workspace.locator('.speech-candidates .ai-candidate').count(), 0);
    await workspace.getByRole('button', { name: '加载试听', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 2);
    await page.getByRole('button', { name: '导出 MP4', exact: true }).click();
    await page.getByText('视频已准备就绪', { exact: true }).waitFor({ timeout: 180000 });
    const exportedProject = saved;
    assertSpeechTimeline(await decodeAudio(await resolveFfmpeg(), outputFile), 34 / 30, 3);
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(layout.scrollWidth <= layout.width);
    await page.screenshot({ path: path.join(directory, 'speech-smoke.png'), fullPage: true });

    // 采用后改变文字：导出应失败；恢复文字、恢复时长后可继续。
    await textAt(0, '文字过期');
    await page.getByRole('button', { name: '导出 MP4', exact: true }).click();
    await page.getByText('导出失败', { exact: true }).waitFor();
    await page.getByText(/分镜 1 的配音文字已过期/).first().waitFor();
    await textAt(0, 'first');
    await page.getByRole('spinbutton', { name: '时长（秒）', exact: true }).fill('1');
    await page.getByRole('button', { name: '导出 MP4', exact: true }).click();
    await page.getByText(/分镜 1 时长短于实际配音/).first().waitFor();
    await page.getByRole('button', { name: '恢复配音时长', exact: true }).click();
    assert.equal((await save()).scenes[0].duration, 34 / 30);
    await textAt(0, 'first'); await textAt(1, 'slow'); await textAt(2, 'must-not-send');
    const beforeCancel = mock.requests.length;
    await page.getByRole('button', { name: '重新生成全部分镜配音', exact: true }).click();
    await page.getByText('正在配音第 2/3 镜', { exact: true }).waitFor();
    const protection = await page.evaluate(async () => {
      const api = (window as Window & { desktop?: DesktopAPI }).desktop!;
      const speech = await api.generateSpeech({ id: crypto.randomUUID(), voice: 'v', speed: 1, scenes: [{ sceneId: 's', text: 'no' }] });
      const image = await api.generateImages({ id: crypto.randomUUID(), size: '1024x1024', scenes: [{ sceneId: 's', prompt: 'no' }] });
      const text = await api.runAI({ id: crypto.randomUUID(), kind: 'test' });
      let exportBlocked = false; try { await api.startExport({} as Project); } catch { exportBlocked = true; }
      return { speech, image, text, exportBlocked };
    });
    for (const result of [protection.speech, protection.image, protection.text]) assert.ok(!result.ok && result.error.code === 'busy');
    assert.equal(protection.exportBlocked, true);
    await page.getByRole('button', { name: '取消配音任务', exact: true }).click();
    await page.getByText(/配音已取消：成功 1，失败 1，未执行 1/).waitFor();
    assert.equal(mock.requests.length - beforeCancel, 2);
    assert.equal(await page.getByRole('button', { name: '采用此配音', exact: true }).count(), 1);
    await page.getByRole('button', { name: '移除当前分镜配音', exact: true }).click();
    assert.equal((await save()).scenes[2].speech, null);
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="作品名称"]')?.value === '未命名作品' && document.querySelectorAll('.scene-card').length === 1);
    assert.equal(await workspace.locator('.speech-candidates .ai-candidate').count(), 0);
    await openSettings();
    await page.getByRole('checkbox', { name: '删除已保存的 Key' }).check();
    await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '生成当前分镜配音', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    await writeFile(projectFile, JSON.stringify(exportedProject, null, 2));
    console.log('配音桌面验收通过：独立配置、确认才联网、真实试听解码／播放、候选采用／丢弃／过期、时长同步、模式互斥、批量部分失败、保存重开、MP4 解码验证时间轴、截断保护、取消保留成功、任务互斥、移除、新项目隔离和删除 Key。');
    console.log(`模拟成片：${outputFile}`);
    console.log('仅本机音调模拟服务，safeStorage 为替身；未验收真实人声模型、计费或 macOS 钥匙串。');
  } finally {
    closing = true;
    if (desktop) await desktop.close();
    await server.close(); await mock.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
