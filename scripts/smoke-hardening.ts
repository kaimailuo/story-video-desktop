import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { _electron, type ElectronApplication } from 'playwright-core';
import { createServer } from 'vite';
import { createProject, projectSchema, type DesktopAPI, type Project } from '../src/shared/project';
import { startMockAI } from './helpers/mock-ai';
import { startMockImages } from './helpers/mock-images';
import { startMockSpeech } from './helpers/mock-speech';

// 仅编译桌面入口及其依赖，不运行全量构建，也不把测试文件编入应用。
function compileDesktop() {
  const config = ts.readConfigFile('tsconfig.main.json', ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const program = ts.createProgram(['src/main/index.ts', 'src/preload/index.ts'], parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (name) => name, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n' }));
  assert.equal(program.emit().emitSkipped, false);
}

interface SaveGate { armed: boolean; entered: Promise<void>; enter(): void; waiting: Promise<void>; release(): void }
type GateGlobal = typeof globalThis & { hardeningSaveGate?: SaveGate };

async function main(): Promise<void> {
  compileDesktop();
  const directory = path.resolve('artifacts'); await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(path.join(directory, 'hardening-profile-'));
  const projectFile = path.join(profile, 'hardening.yingxu.json');
  const fixture = createProject();
  fixture.title = '可靠性回归'; fixture.script = '第一句。第二句。';
  fixture.speechOptions = { voice: 'local-voice', speed: 1 };
  fixture.scenes[0] = { ...fixture.scenes[0], id: 'legacy-scene', text: 'first', prompt: 'window', description: '手工描述', duration: 7, motion: 'still', subtitleTimeline: { sourceText: 'first', sourceSpeechId: null, sourceMode: 'global', timing: 'manual', cues: [{ id: crypto.randomUUID(), text: '独立手工字幕', start: 0.5, end: 2 }] } };
  projectSchema.parse(fixture);
  await writeFile(projectFile, JSON.stringify(fixture));
  const text = await startMockAI(); const images = await startMockImages(); const speech = await startMockSpeech();
  const server = await createServer({ server: { port: 0, strictPort: false } });
  let desktop: ElectronApplication | undefined; let closing = false;
  try {
    await server.listen();
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    env.VITE_DEV_SERVER_URL = server.resolvedUrls!.local[0]; delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: require('electron') as string, args: [process.cwd(), `--user-data-dir=${profile}`], env, timeout: 40000 });
    await desktop.evaluate(({ app, dialog, safeStorage, ipcMain }, config) => {
      app.setPath('userData', config.profile);
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: config.projectFile });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.projectFile] });
      dialog.showMessageBoxSync = () => 1;
      // 仅测试进程替身，不读取真实凭据，不验收系统钥匙串。
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (value) => Buffer.from(Array.from(Buffer.from(value), (byte) => byte ^ 0xa5));
      safeStorage.decryptString = (value) => Buffer.from(Array.from(value, (byte) => byte ^ 0xa5)).toString();
      // 测试专属可释放门闩；复用真实保存处理器，不靠固定睡眠制造竞态。
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, input: unknown) => Promise<unknown>> })._invokeHandlers;
      const save = handlers.get('recovery:save');
      if (!save) throw new Error('未找到草稿保存处理器');
      ipcMain.removeHandler('recovery:save');
      ipcMain.handle('recovery:save', async (event, input: unknown) => {
        const gate = (globalThis as GateGlobal).hardeningSaveGate;
        if (gate?.armed) { gate.armed = false; gate.enter(); await gate.waiting; }
        return save(event, input);
      });
    }, { profile, projectFile });
    const page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
    const errors: string[] = []; const confirmations: string[] = []; let approve = true;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => {
      confirmations.push(dialog.message());
      void (approve ? dialog.accept() : dialog.dismiss()).catch((error: unknown) => { if (!closing) errors.push(String(error)); });
    });
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const undo = button('撤销最近一次分镜替换');
    async function idle() { await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="作品名称"]')?.disabled); }
    async function save(): Promise<Project> {
      await button('保存项目').click();
      await page.getByText('项目已保存：hardening.yingxu.json', { exact: true }).waitFor(); await idle();
      return JSON.parse(await readFile(projectFile, 'utf8')) as Project;
    }
    async function settings(kind: '文本' | '图片' | '配音', model: string, baseUrl?: string) {
      await button(`${kind}模型设置`).first().click();
      const field = page.getByRole('textbox', { name: '模型名称', exact: true });
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="模型名称"]')?.disabled === false);
      await field.fill(model);
      if (baseUrl) {
        await page.getByRole('textbox', { name: 'API 基础地址', exact: true }).fill(baseUrl);
        await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('sk-local-hardening-not-a-real-key');
      }
      await button('保存模型设置').click();
      await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor();
      await button('关闭模型设置').click(); await idle();
    }
    await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor();
    await button('打开本地项目').click();
    await page.getByText('已打开：hardening.yingxu.json', { exact: true }).waitFor(); await idle();
    await settings('文本', 'mock-success', text.baseUrl);
    await settings('图片', 'mock-images', images.baseUrl);
    await settings('配音', 'mock-speech', speech.baseUrl);
    assert.deepEqual([text.requests.length, images.requests.length, speech.requests.length], [0, 0, 0]);

    for (const [index, [generate, cancel, message]] of [
      ['AI 改写文案', '取消 AI 请求', 'AI 请求已取消，尚未发送模型请求。'],
      ['AI 生成分镜', '取消 AI 请求', 'AI 请求已取消，尚未发送模型请求。'],
      ['生成当前分镜图片', '取消生图任务', '生图任务已取消，尚未发送生成请求。'],
      ['生成当前分镜配音', '取消配音任务', '配音任务已取消，尚未发送生成请求。'],
    ].entries()) {
      await desktop.evaluate(() => {
        let enter!: () => void; let release!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const waiting = new Promise<void>((resolve) => { release = resolve; });
        (globalThis as GateGlobal).hardeningSaveGate = { armed: true, entered, enter, waiting, release };
      });
      await page.getByRole('textbox', { name: '作品名称', exact: true }).fill(`保存期间取消 ${index}`);
      await button(generate).click();
      await desktop.evaluate(async () => { await (globalThis as GateGlobal).hardeningSaveGate!.entered; });
      await button(cancel).click();
      await desktop.evaluate(() => { (globalThis as GateGlobal).hardeningSaveGate!.release(); });
      await page.getByText(message, { exact: true }).waitFor(); await idle();
      assert.deepEqual([text.requests.length, images.requests.length, speech.requests.length], [0, 0, 0], `${generate}准备期取消不得发送请求`);
    }

    approve = false; await button('拆分分镜').click();
    assert.match(confirmations.at(-1)!, /1 镜独立字幕时间轴、0 镜图片/);
    assert.deepEqual((await save()).scenes, fixture.scenes, '拒绝替换保留手工字幕和设置');
    approve = true; await button('拆分分镜').click(); assert.equal(await page.locator('.scene-card').count(), 2);
    await undo.click(); assert.deepEqual((await save()).scenes, fixture.scenes, '撤销恢复全部分镜字段与旧编号');
    assert.equal(await undo.count(), 0);
    await button('AI 生成分镜').click();
    await page.getByRole('heading', { name: '分镜候选 · 2 镜', exact: true }).waitFor(); await idle();
    approve = false; await button('采用分镜').click();
    assert.match(confirmations.at(-1)!, /1 镜独立字幕时间轴、0 镜图片/);
    assert.equal(await page.locator('.scene-card').count(), 1);
    approve = true; await button('采用分镜').click(); assert.equal(await page.locator('.scene-card').count(), 2);
    await undo.click(); assert.deepEqual((await save()).scenes, fixture.scenes);

    await button('生成当前分镜图片').click(); await button('采用此图片').waitFor(); await idle();
    const preview = await page.locator('.image-candidate img').getAttribute('src');
    await settings('图片', 'fail');
    for (let i = 0; i < 2; i++) {
      await button('生成当前分镜图片').click();
      await page.getByRole('heading', { name: '分镜 1 · 生成失败', exact: true }).waitFor(); await idle();
      assert.equal(await page.locator('.image-candidate').count(), 2);
      assert.equal(await page.locator('.image-candidate img').getAttribute('src'), preview);
      assert.equal(await button('采用此图片').isEnabled(), true);
    }
    await button('采用此图片').click(); assert.ok((await save()).scenes[0].imagePath);
    await settings('图片', 'mock-images');
    await button('生成当前分镜图片').click(); await button('采用此图片').waitFor(); await idle();
    assert.equal(await page.locator('.image-candidate').count(), 1, '新成功清除旧失败');

    await button('生成当前分镜配音').click(); await button('采用此配音').waitFor(); await idle();
    await page.locator('.speech-candidates').getByRole('button', { name: '加载试听', exact: true }).click();
    await page.waitForFunction(() => { const audio = document.querySelector('audio'); return audio && audio.readyState >= 2; });
    const audio = await page.locator('.speech-candidates audio').getAttribute('src');
    await settings('配音', 'fail');
    for (let i = 0; i < 2; i++) {
      await button('生成当前分镜配音').click();
      await page.getByRole('heading', { name: '分镜 1 · 配音失败', exact: true }).waitFor(); await idle();
      assert.equal(await page.locator('.speech-candidates .ai-candidate').count(), 2);
      assert.equal(await page.locator('.speech-candidates audio').getAttribute('src'), audio);
      assert.equal(await button('采用此配音').isEnabled(), true);
    }
    await button('采用此配音').click(); assert.ok((await save()).scenes[0].speech);
    await settings('配音', 'mock-speech');
    await button('生成当前分镜配音').click(); await button('采用此配音').waitFor(); await idle();
    assert.equal(await page.locator('.speech-candidates .ai-candidate').count(), 1);

    const current = await save(); const duplicate = { ...current, scenes: [current.scenes[0], { ...current.scenes[0], text: '重复编号' }] };
    const originalFile = await readFile(projectFile, 'utf8');
    const rejected = await page.evaluate(async (project) => {
      const api = (window as Window & { desktop?: DesktopAPI }).desktop!;
      const failures: string[] = [];
      for (const action of [() => api.saveProject(project), () => api.saveDraft({ id: crypto.randomUUID(), revision: 1, sourceFilePath: null, project }), () => api.startExport(project), () => api.exportSubtitles(project)]) {
        try { await action(); failures.push('未拦截'); } catch (error) { failures.push(String(error)); }
      }
      return failures;
    }, duplicate);
    assert.ok(rejected.every((error) => error !== '未拦截'));
    assert.equal(await readFile(projectFile, 'utf8'), originalFile, '非法保存不能覆盖原文件');
    await writeFile(projectFile, JSON.stringify(duplicate));
    await button('打开本地项目').click(); await page.locator('.error-box').getByText(/分镜 2 的编号重复/).waitFor(); await idle();
    assert.equal(await page.locator('.scene-card').count(), 1, '非法打开不能替换当前项目');
    await writeFile(projectFile, originalFile);

    await button('拆分分镜').click(); await undo.waitFor();
    await button('新建').click(); await idle();
    assert.equal(await undo.count(), 0, '撤销不能跨项目');
    await button('打开本地项目').click(); await page.getByText('已打开：hardening.yingxu.json', { exact: true }).waitFor(); await idle();
    assert.equal(await undo.count(), 0, '重新打开不能恢复会话撤销快照');
    assert.equal(await page.locator('.image-candidate').count(), 0);
    assert.equal(await page.locator('.speech-candidates .ai-candidate').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual([text.requests.length, images.requests.length, speech.requests.length], [1, 4, 4], '仅显式生成请求，无取消后补发或自动重试');
    await page.screenshot({ path: path.join(directory, 'hardening-smoke.png'), fullPage: true });
    console.log('可靠性桌面验收通过：四个入口准备期取消零请求、无媒体替换确认与撤销、跨项目隔离、图片／配音失败保留成功、重复 ID 的打开／保存／草稿／导出拦截。');
    console.log('仅本机模拟服务与独立测试档案，safeStorage 为替身；无真实模型、计费、钥匙串或安装包验收。');
  } finally {
    closing = true;
    if (desktop) {
      await desktop.evaluate(() => { (globalThis as GateGlobal).hardeningSaveGate?.release(); }).catch(() => undefined);
      await desktop.close();
    }
    await server.close(); await Promise.all([text.close(), images.close(), speech.close()]);
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
