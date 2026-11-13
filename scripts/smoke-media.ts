import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import sharp from 'sharp';
import { _electron, type ElectronApplication } from 'playwright-core';
import { createServer } from 'vite';
import { createProject, projectSchema, type DesktopAPI } from '../src/shared/project';
import { pcmTone } from './helpers/mock-speech';

interface DialogGate { entered: Promise<void>; enter(): void; waiting: Promise<void>; release(): void }
type SmokeGlobal = typeof globalThis & { mediaSmoke?: { saves: number; gate?: DialogGate } };

async function main(): Promise<void> {
  const config = ts.readConfigFile('tsconfig.main.json', ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const program = ts.createProgram(['src/main/index.ts', 'src/preload/index.ts'], parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (name) => name, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n' }));
  assert.equal(program.emit().emitSkipped, false);
  const directory = path.resolve('artifacts'); await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(path.join(directory, 'media-desktop-profile-'));
  const projectFile = path.join(profile, 'media.yingxu.json'); const output = path.join(profile, 'media.mp4');
  const image = path.join(profile, '图片 含空格.png'); const wave = path.join(profile, '音频.wav'); const bad = path.join(profile, '坏音频.wav');
  async function fixImage() { await sharp({ create: { width: 48, height: 64, channels: 3, background: '#9875bf' } }).png().toFile(image); }
  await fixImage(); await writeFile(wave, pcmTone()); await writeFile(bad, 'bad'); await writeFile(output, 'existing');
  const project = createProject(); project.title = '素材检查桌面验收'; project.captions = false; project.transition = 'cut'; project.narrationMode = 'scenes';
  project.scenes[0] = { ...project.scenes[0], duration: 34 / 30, imagePath: path.join(profile, 'missing.png'), text: 'first', speech: { id: crypto.randomUUID(), path: wave, text: 'stale', duration: 1.101, voice: 'local', speed: 1, model: 'mock', createdAt: new Date().toISOString() } };
  project.scenes.push({ ...project.scenes[0], id: crypto.randomUUID(), imagePath: image, text: 'second', speech: null, duration: 1 });
  project.narrationPath = path.join(profile, 'missing.wav'); project.bgmPath = bad;
  projectSchema.parse(project); await writeFile(projectFile, JSON.stringify(project));
  const original = await readFile(projectFile, 'utf8'); const audioBefore = await readFile(wave);
  const server = await createServer({ server: { port: 0, strictPort: false } });
  let desktop: ElectronApplication | undefined; let closing = false;
  try {
    await server.listen();
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    env.VITE_DEV_SERVER_URL = server.resolvedUrls!.local[0]; delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: require('electron') as string, args: [process.cwd(), `--user-data-dir=${profile}`], env, timeout: 40000 });
    await desktop.evaluate(({ app, dialog }, config) => {
      app.setPath('userData', config.profile);
      (globalThis as SmokeGlobal).mediaSmoke = { saves: 0 };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.projectFile] });
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const state = (globalThis as SmokeGlobal).mediaSmoke!; state.saves++;
        if (state.gate) { state.gate.enter(); await state.gate.waiting; return { canceled: true, filePath: '' }; }
        const title = (args.at(-1) as { title?: string }).title;
        return { canceled: false, filePath: title === '导出 MP4' ? config.output : title === '导出 SRT 字幕' ? `${config.output}.srt` : config.projectFile };
      };
      dialog.showMessageBoxSync = () => 1;
    }, { profile, projectFile, output });
    const page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
    const errors: string[] = []; const requests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (/chat\/completions|images\/generations|audio\/speech/.test(request.url())) requests.push(request.url()); });
    page.on('dialog', (dialog) => { void dialog.accept().catch((error: unknown) => { if (!closing) errors.push(String(error)); }); });
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const panel = page.getByRole('region', { name: '素材统一检查', exact: true });
    async function idle() { await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="作品名称"]')?.disabled === false); }
    async function open() { await button('打开本地项目').click(); await page.getByText('已打开：media.yingxu.json', { exact: true }).waitFor(); await idle(); }
    async function scan() { await button('检查项目素材').click(); await idle(); }
    await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor(); await open();
    await page.locator('.scene-card').nth(1).click(); await scan();
    await panel.getByText('素材检查未通过：3 项阻塞，2 项警告。', { exact: true }).waitFor();
    await panel.getByRole('heading', { name: '分镜 1 · 图片 · 阻塞', exact: true }).waitFor();
    await panel.getByRole('heading', { name: '全片配音 · 警告（当前模式未启用）', exact: true }).waitFor();
    await panel.locator('.media-check-item').filter({ has: page.getByRole('heading', { name: '分镜 1 · 图片 · 阻塞', exact: true }) }).getByRole('button', { name: '定位分镜', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '当前分镜字幕', exact: true }).inputValue(), 'first');
    assert.equal(await readFile(projectFile, 'utf8'), original); assert.deepEqual(await readFile(wave), audioBefore);
    await button('导出 MP4').click(); await idle();
    await page.getByText('导出失败', { exact: true }).waitFor();
    assert.equal(await desktop.evaluate(() => (globalThis as SmokeGlobal).mediaSmoke!.saves), 0, '阻塞时不能打开目标选择器');
    assert.equal(await readFile(output, 'utf8'), 'existing');
    const tasks = await page.evaluate(() => (window as Window & { desktop?: DesktopAPI }).desktop!.getRecovery());
    assert.equal(tasks.tasks.length, 0, '检查／阻止导出不登记渲染任务');
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('修改后');
    await panel.getByText('检查结果已过期，请重新检查。', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: '定位分镜', exact: true }).first().isDisabled(), true);
    await page.getByRole('combobox', { name: '导出配音模式', exact: true }).selectOption('global');
    await scan(); await panel.getByRole('heading', { name: '分镜 1 · 按镜配音 · 警告（当前模式未启用）', exact: true }).waitFor();
    await panel.getByRole('heading', { name: '全片配音 · 阻塞', exact: true }).waitFor();

    project.scenes[0].imagePath = image; project.scenes[0].speech!.text = 'first'; project.bgmPath = wave;
    await writeFile(projectFile, JSON.stringify(project)); await open();
    await panel.getByText('尚未检查；导出 MP4 前会自动检查。', { exact: true }).waitFor();
    await scan(); await panel.getByText('素材检查通过：0 项阻塞，2 项警告。', { exact: true }).waitFor();
    // 通过后磁盘被外部改坏，主进程仍需重新检查，不能凭旧报告放行。
    await writeFile(image, 'external corruption'); await button('导出 MP4').click(); await idle();
    await panel.getByRole('heading', { name: '分镜 1 · 图片 · 阻塞', exact: true }).waitFor();
    assert.equal(await desktop.evaluate(() => (globalThis as SmokeGlobal).mediaSmoke!.saves), 0);
    assert.equal(await readFile(output, 'utf8'), 'existing'); await fixImage();

    await desktop.evaluate(() => {
      let enter!: () => void; let release!: () => void;
      const entered = new Promise<void>((done) => { enter = done; }); const waiting = new Promise<void>((done) => { release = done; });
      (globalThis as SmokeGlobal).mediaSmoke!.gate = { entered, enter, waiting, release };
    });
    await button('导出 MP4').click();
    await desktop.evaluate(async () => { await (globalThis as SmokeGlobal).mediaSmoke!.gate!.entered; });
    const protection = await page.evaluate(async (project) => {
      const api = (window as Window & { desktop?: DesktopAPI }).desktop!;
      let checkBlocked = false; let exportBlocked = false;
      try { await api.checkProjectMedia(project); } catch { checkBlocked = true; }
      try { await api.startExport(project); } catch { exportBlocked = true; }
      return { checkBlocked, exportBlocked, ai: await api.runAI({ id: crypto.randomUUID(), kind: 'test' }) };
    }, project);
    assert.equal(protection.checkBlocked, true); assert.equal(protection.exportBlocked, true); assert.ok(!protection.ai.ok && protection.ai.error.code === 'busy');
    await desktop.evaluate(() => { (globalThis as SmokeGlobal).mediaSmoke!.gate!.release(); }); await idle();
    await desktop.evaluate(() => { delete (globalThis as SmokeGlobal).mediaSmoke!.gate; });
    assert.equal(await readFile(output, 'utf8'), 'existing', '取消保存位置不覆盖目标');
    await button('导出 MP4').click();
    await page.getByText('视频已准备就绪', { exact: true }).waitFor({ timeout: 180000 }); await idle();
    assert.notEqual((await readFile(output)).subarray(0, 8).toString(), 'existing');
    await scan(); await panel.getByText('素材检查通过：0 项阻塞，2 项警告。', { exact: true }).waitFor();
    assert.deepEqual(await readFile(wave), audioBefore);
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(layout.scroll <= layout.width);
    await page.screenshot({ path: path.join(directory, 'media-smoke.png'), fullPage: true });
    await button('新建').click(); await idle(); await panel.getByText('尚未检查；导出 MP4 前会自动检查。', { exact: true }).waitFor();
    await open();
    const completedOutput = await readFile(output);
    await desktop.evaluate(() => {
      let enter!: () => void; let release!: () => void;
      const entered = new Promise<void>((done) => { enter = done; }); const waiting = new Promise<void>((done) => { release = done; });
      (globalThis as SmokeGlobal).mediaSmoke!.gate = { entered, enter, waiting, release };
    });
    await button('导出 MP4').click();
    await desktop.evaluate(async () => { await (globalThis as SmokeGlobal).mediaSmoke!.gate!.entered; });
    closing = true;
    const closed = desktop.waitForEvent('close', { timeout: 15000 });
    await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); (globalThis as SmokeGlobal).mediaSmoke!.gate!.release(); });
    await closed; desktop = undefined;
    assert.deepEqual(await readFile(output), completedOutput, '预检／选择器期间取消并退出不能启动渲染或覆盖成片');
    console.log('素材桌面验收通过：聚合阻塞／警告、分镜定位、过期／切项目隔离、模式切换、导出前重查磁盘、阻塞不打开选择器／不登记任务／不覆盖、互斥与取消选择器／退出、修复后真实 MP4。');
    console.log(`独立档案：${profile}；无模型调用、凭据或钥匙串访问，不构建安装包。`);
  } finally {
    closing = true;
    if (desktop) { await desktop.evaluate(() => { (globalThis as SmokeGlobal).mediaSmoke?.gate?.release(); }).catch(() => undefined); await desktop.close(); }
    await server.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
