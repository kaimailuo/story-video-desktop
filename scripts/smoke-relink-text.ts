import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { _electron, type ElectronApplication } from 'playwright-core';
import { createServer } from 'vite';
import { createProject, projectSchema, type DesktopAPI, type Project } from '../src/shared/project';
import { RecoveryStore } from '../src/main/recovery-store';
import { startMockAI } from './helpers/mock-ai';
import { startMockImages } from './helpers/mock-images';
import { pcmTone, startMockSpeech } from './helpers/mock-speech';
import { partComplete } from '../src/shared/text-plan';

interface SaveGate { armed: boolean; entered: Promise<void>; enter(): void; waiting: Promise<void>; release(): void }
type SmokeGlobal = typeof globalThis & { relinkSaveGate?: SaveGate };

async function main(): Promise<void> {
  const config = ts.readConfigFile('tsconfig.main.json', ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const program = ts.createProgram(['src/main/index.ts', 'src/preload/index.ts'], parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (name) => name, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n' }));
  assert.equal(program.emit().emitSkipped, false);
  await mkdir('artifacts', { recursive: true }); const profile = await mkdtemp(path.resolve('artifacts/relink-text-profile-'));
  const projectFile = path.join(profile, 'relink-text.yingxu.json');
  const project = createProject(); project.title = '产物与长文验收';
  project.scenes[0] = { ...project.scenes[0], text: 'first', prompt: 'window' };
  project.scenes.push({ ...project.scenes[0], id: crypto.randomUUID(), text: 'second' });
  await writeFile(projectFile, JSON.stringify(projectSchema.parse(project)));
  const oldWave = path.join(profile, 'legacy.wav'); await writeFile(oldWave, pcmTone());
  const seed = new RecoveryStore(profile); const oldTask = await seed.begin('speech', 1); await seed.item(oldTask, { kind: 'speech', path: oldWave }); await seed.finish(oldTask, 'done');
  const text = await startMockAI(); const images = await startMockImages(); const speech = await startMockSpeech();
  const server = await createServer({ server: { port: 0, strictPort: false } }); let desktop: ElectronApplication | undefined; let closing = false;
  try {
    await server.listen(); const require = createRequire(path.join(process.cwd(), 'package.json'));
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    env.VITE_DEV_SERVER_URL = server.resolvedUrls!.local[0]; delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: require('electron') as string, args: [process.cwd(), `--user-data-dir=${profile}`], env, timeout: 40000 });
    await desktop.evaluate(({ app, dialog, safeStorage, ipcMain }, config) => {
      app.setPath('userData', config.profile);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.projectFile] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: config.projectFile }); dialog.showMessageBoxSync = () => 1;
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (value) => Buffer.from(Array.from(Buffer.from(value), (byte) => byte ^ 0xa5));
      safeStorage.decryptString = (value) => Buffer.from(Array.from(value, (byte) => byte ^ 0xa5)).toString();
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, input: unknown) => Promise<unknown>> })._invokeHandlers;
      const save = handlers.get('recovery:save'); if (!save) throw new Error('没有保存处理器');
      ipcMain.removeHandler('recovery:save'); ipcMain.handle('recovery:save', async (event, raw: unknown) => {
        const gate = (globalThis as SmokeGlobal).relinkSaveGate;
        if (gate?.armed) { gate.armed = false; gate.enter(); await gate.waiting; }
        return save(event, raw);
      });
    }, { profile, projectFile });
    const page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
    const errors: string[] = []; const confirmations: string[] = []; let approve = true;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { confirmations.push(dialog.message()); void (approve ? dialog.accept() : dialog.dismiss()).catch((cause: unknown) => { if (!closing) errors.push(String(cause)); }); });
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    async function idle() { await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="作品名称"]')?.disabled === false); }
    async function open() { await button('打开本地项目').click(); await page.getByText('已打开：relink-text.yingxu.json', { exact: true }).waitFor(); await idle(); }
    async function save(): Promise<Project> { await button('保存项目').click(); await page.getByText('项目已保存：relink-text.yingxu.json', { exact: true }).waitFor(); await idle(); return projectSchema.parse(JSON.parse(await readFile(projectFile, 'utf8'))); }
    async function model(name: string, initial = false) {
      await button('文本模型设置').first().click(); await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="模型名称"]')?.disabled === false);
      await page.getByRole('textbox', { name: '模型名称', exact: true }).fill(name);
      if (initial) { await page.getByRole('textbox', { name: 'API 基础地址', exact: true }).fill(text.baseUrl); await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('local-relink-text-not-real'); }
      await button('保存模型设置').click(); await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor(); await button('关闭模型设置').click(); await idle();
    }
    await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor(); await open();
    const generated = await page.evaluate(async ({ imageUrl, speechUrl, sceneId }) => {
      const api = (window as Window & { desktop?: DesktopAPI }).desktop!;
      await api.saveImageSettings({ settings: { baseUrl: imageUrl, model: 'mock-images', timeoutSeconds: 5 }, apiKey: 'local-only' });
      await api.saveSpeechSettings({ settings: { baseUrl: speechUrl, model: 'mock-speech', timeoutSeconds: 5 }, apiKey: 'local-only' });
      const image = await api.generateImages({ id: crypto.randomUUID(), size: '1024x1024', scenes: [{ sceneId, prompt: 'window' }] });
      const speech = await api.generateSpeech({ id: crypto.randomUUID(), voice: 'local-voice', speed: 1, scenes: [{ sceneId, text: 'first' }] });
      if (!image.ok || !speech.ok) throw new Error('模拟生成失败');
      return api.getRecovery();
    }, { imageUrl: images.baseUrl, speechUrl: speech.baseUrl, sceneId: project.scenes[0].id });
    const imageTask = generated.tasks.find((task) => task.kind === 'image')!; const imageArtifact = imageTask.artifacts[0];
    const speechTask = generated.tasks.find((task) => task.kind === 'speech' && task.id !== oldTask)!; const speechArtifact = speechTask.artifacts[0];
    assert.ok(imageArtifact.image); assert.ok(speechArtifact.speech); assert.deepEqual([images.requests.length, speech.requests.length], [1, 1]);
    await button('刷新恢复记录').click(); await idle(); await page.locator('.recovery-tasks summary').click();
    const artifactUI = (id: string) => page.locator('.recovery-artifact').filter({ has: page.getByRole('combobox', { name: `产物 ${id} 的目标分镜`, exact: true }) });
    const imageUI = artifactUI(imageArtifact.id); await imageUI.getByRole('combobox').selectOption(project.scenes[1].id);
    await imageUI.getByRole('button', { name: '核验并预览关联', exact: true }).click(); await imageUI.getByAltText('待关联图片预览').waitFor(); await idle();
    approve = false; await imageUI.getByRole('button', { name: '确认关联到分镜', exact: true }).click();
    assert.equal((await save()).scenes[1].imagePath, null); assert.match(confirmations.at(-1)!, /其他工作区/);
    approve = true; await imageUI.getByRole('button', { name: '确认关联到分镜', exact: true }).click(); await idle(); assert.equal((await save()).scenes[1].imagePath, imageArtifact.path);
    await imageUI.getByRole('button', { name: '核验并预览关联', exact: true }).click(); await imageUI.getByAltText('待关联图片预览').waitFor(); await idle();
    const bytes = await readFile(imageArtifact.path); await writeFile(imageArtifact.path, 'changed');
    await imageUI.getByRole('button', { name: '确认关联到分镜', exact: true }).click(); await idle(); await page.locator('.error-box').getByText(/文件内容已改变/).waitFor();
    await writeFile(imageArtifact.path, bytes);
    const speechUI = artifactUI(speechArtifact.id); await speechUI.getByRole('button', { name: '核验并预览关联', exact: true }).click(); await speechUI.locator('audio').waitFor(); await idle();
    await page.getByRole('textbox', { name: '当前分镜字幕', exact: true }).fill('changed');
    assert.equal(await speechUI.getByRole('button', { name: '确认关联到分镜', exact: true }).isDisabled(), true);
    await page.getByRole('textbox', { name: '当前分镜字幕', exact: true }).fill('first'); await speechUI.getByRole('button', { name: '核验并预览关联', exact: true }).click(); await idle();
    await speechUI.getByRole('button', { name: '确认关联到分镜', exact: true }).click(); await idle(); const linked = await save();
    assert.equal(linked.scenes[0].speech?.path, speechArtifact.path); assert.equal(linked.narrationMode, 'scenes'); assert.equal(linked.scenes[0].duration, 34 / 30);
    const oldArtifact = generated.tasks.find((task) => task.id === oldTask)!.artifacts[0];
    assert.equal(await artifactUI(oldArtifact.id).getByRole('button', { name: '核验并预览关联', exact: true }).isDisabled(), true);
    assert.deepEqual([images.requests.length, speech.requests.length], [1, 1], '关联不重新调用生成');

    await model('mock-mapped-fail-second', true);
    const longScript = `${'甲'.repeat(79)}。`.repeat(20); await page.getByRole('textbox', { name: '视频文案', exact: true }).fill(longScript);
    const longUI = page.getByRole('region', { name: '长文分段与覆盖检查', exact: true });
    await button('预览分镜分段').click(); assert.equal(text.requests.length, 0); assert.equal(await longUI.locator('.text-part').count(), 3);
    approve = false; await button('确认处理未完成段').click(); assert.equal(text.requests.length, 0);
    approve = true; await button('确认处理未完成段').click(); await idle();
    assert.equal(text.requests.length, 2); assert.match(confirmations.at(-1)!, /最多 3 次请求/);
    const partial = await save(); assert.equal(partial.textWork?.parts.filter(partComplete).length, 1); assert.ok(partial.textWork?.parts[1].error); assert.equal(partial.textWork?.parts[2].result, undefined);
    await open(); assert.equal(text.requests.length, 2, '重开不能自动补跑'); await model('mock-mapped');
    await button('确认处理未完成段').click(); await idle(); assert.equal(text.requests.length, 4);
    assert.match(confirmations.at(-1)!, /所选 2 段/);
    approve = false; await button('整体采用分段结果').click(); assert.equal(await page.locator('.scene-card').count(), 2);
    approve = true; await button('整体采用分段结果').click(); assert.equal(await page.locator('.scene-card').count(), 3); await button('撤销最近一次分镜替换').click();
    assert.deepEqual((await save()).scenes, linked.scenes);

    await button('预览改写分段').click(); await model('mock-mapped-missing');
    await button('确认处理未完成段').click(); await idle(); assert.equal(text.requests.length, 5);
    assert.equal(await button('整体采用分段结果').isDisabled(), true);
    await longUI.locator('.text-part summary').first().click(); await longUI.getByText(/来源映射有遗漏、重复、越界或乱序/).waitFor();
    await page.getByRole('textbox', { name: '视频文案', exact: true }).fill(`${longScript}变动`); assert.equal(await button('确认处理未完成段').isDisabled(), true);
    await button('预览改写分段').click(); await model('mock-mapped');
    await button('确认处理未完成段').click(); await idle(); assert.equal(text.requests.length, 7);
    await button('整体采用分段结果').click(); const rewritten = await save(); assert.equal(rewritten.textWork, undefined); assert.equal(rewritten.rewriteHistory.length, 1);

    await button('预览分镜分段').click();
    await desktop.evaluate(() => {
      let enter!: () => void; let release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; }); const waiting = new Promise<void>((resolve) => { release = resolve; });
      (globalThis as SmokeGlobal).relinkSaveGate = { armed: true, entered, enter, waiting, release };
    });
    await button('确认处理未完成段').click(); await desktop.evaluate(async () => { await (globalThis as SmokeGlobal).relinkSaveGate!.entered; });
    await button('取消分段处理').click(); await desktop.evaluate(() => { (globalThis as SmokeGlobal).relinkSaveGate!.release(); }); await idle(); assert.equal(text.requests.length, 7);
    assert.deepEqual(errors, []);
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth })); assert.ok(layout.scroll <= layout.width);
    await page.screenshot({ path: path.resolve('artifacts/relink-text-smoke.png'), fullPage: true });
    await button('新建').click(); await idle(); assert.equal(await longUI.locator('.text-part').count(), 0);
    console.log('产物与长文桌面验收通过：新元数据落盘、跨工作区选镜／预览／拒绝与确认、旧配音保护、采用前哈希重查／目标过期、配音模式与时长；长文零请求预览、费用确认、首错停止、保存重开／只补未完成段、覆盖遗漏／过期阻止采用、整体采用与撤销、准备期取消零请求、项目隔离。');
    console.log(`独立档案：${profile}；仅本机模拟模型，safeStorage 为测试替身，无真实计费／钥匙串／安装包验收。`);
  } finally {
    closing = true;
    if (desktop) { await desktop.evaluate(() => { (globalThis as SmokeGlobal).relinkSaveGate?.release(); }).catch(() => undefined); await desktop.close(); }
    await server.close(); await text.close(); await images.close(); await speech.close();
  }
}
void main().catch((cause: unknown) => { console.error(cause); process.exitCode = 1; });
