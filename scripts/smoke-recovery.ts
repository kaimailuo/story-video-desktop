import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { createServer } from 'vite';
import { startMockSpeech } from './helpers/mock-speech';
import type { DesktopAPI, Project } from '../src/shared/project';
import type { RecoveryOverview } from '../src/shared/recovery';

async function main(): Promise<void> {
  const directory = path.resolve('artifacts'); await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(path.join(directory, 'recovery-desktop-profile-'));
  const projectFile = path.join(profile, 'manual.yingxu.json');
  const server = await createServer({ server: { port: 0, strictPort: false } });
  const mock = await startMockSpeech(); const errors: string[] = [];
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  let desktop: ElectronApplication | undefined; let closing = false;
  try {
    await server.listen();
    async function launch(): Promise<Page> {
      const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      env.VITE_DEV_SERVER_URL = server.resolvedUrls!.local[0]; delete env.ELECTRON_RUN_AS_NODE;
      desktop = await _electron.launch({ executablePath: require('electron') as string, args: [process.cwd(), `--user-data-dir=${profile}`], env, timeout: 40000 });
      await desktop.evaluate(({ app, dialog, safeStorage }, config) => {
        app.setPath('userData', config.profile);
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: config.projectFile });
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.projectFile] });
        dialog.showMessageBoxSync = () => 1;
        safeStorage.isEncryptionAvailable = () => true;
        safeStorage.encryptString = (value) => Buffer.from(Array.from(Buffer.from(value), (byte) => byte ^ 0xa5));
        safeStorage.decryptString = (value) => Buffer.from(Array.from(value, (byte) => byte ^ 0xa5)).toString();
      }, { profile, projectFile });
      const page = await desktop.firstWindow();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('dialog', (dialog) => { void dialog.accept().catch((error: unknown) => { if (!closing) errors.push(String(error)); }); });
      await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor();
      await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '新建')?.disabled);
      return page;
    }
    async function overview(page: Page): Promise<RecoveryOverview> { return page.evaluate(() => (window as unknown as { desktop: DesktopAPI }).desktop.getRecovery()); }
    async function kill(): Promise<void> {
      closing = true;
      const child = desktop!.process();
      await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGKILL'); });
      desktop = undefined; closing = false;
    }
    let page = await launch();
    await page.getByRole('button', { name: '载入演示项目', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.scene-card img').length === 3);
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('手动原件');
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await page.getByText('项目已保存：manual.yingxu.json', { exact: true }).waitFor();
    const original = await readFile(projectFile, 'utf8');
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('异常退出待恢复');
    await page.getByRole('textbox', { name: '视频文案', exact: true }).fill('自动保存的文案，不应覆盖手动原件。');
    for (const [index, text] of ['first', 'slow', 'must-not-send'].entries()) {
      await page.locator('.scene-card').nth(index).click();
      await page.getByRole('textbox', { name: '当前分镜字幕', exact: true }).fill(text);
    }
    await page.locator('.scene-card').first().click();
    await page.getByRole('button', { name: '估算并启用时间轴', exact: true }).click();
    await page.getByRole('textbox', { name: '第 1 条字幕文字', exact: true }).fill('单独的字幕草稿');
    await page.getByRole('region', { name: '自动保存与恢复', exact: true }).getByText('最新编辑已自动保存', { exact: true }).waitFor();
    assert.equal(await readFile(projectFile, 'utf8'), original);
    const savedDraft = (await overview(page)).drafts[0];
    assert.equal(savedDraft.title, '异常退出待恢复');
    await page.getByRole('button', { name: '配音模型设置', exact: true }).first().click();
    await page.getByRole('heading', { name: '配音模型设置', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="模型名称"]')?.disabled);
    await page.getByRole('textbox', { name: 'API 基础地址', exact: true }).fill(mock.baseUrl);
    await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('mock-speech');
    await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('sk-local-recovery-not-real');
    await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    await page.getByRole('textbox', { name: '配音音色标识' }).fill('local-voice');
    await page.getByRole('button', { name: '重新生成全部分镜配音', exact: true }).click();
    await page.getByText('正在配音第 2/3 镜', { exact: true }).waitFor();
    const beforeCrash = (await overview(page)).tasks.find((task) => task.kind === 'speech')!;
    assert.equal(beforeCrash.succeeded, 1); assert.equal(beforeCrash.processed, 1); assert.equal(beforeCrash.workspaceId, savedDraft.id);
    assert.equal(mock.requests.length, 2);
    await kill();

    page = await launch();
    const panel = page.getByRole('region', { name: '自动保存与恢复', exact: true });
    const card = panel.getByRole('article', { name: '草稿 异常退出待恢复', exact: true });
    await card.getByText('异常退出待恢复', { exact: true }).waitFor();
    await card.getByRole('button', { name: '查看草稿摘要', exact: true }).click();
    await card.getByText('自动保存的文案，不应覆盖手动原件。', { exact: true }).waitFor();
    const restarted = await overview(page); const task = restarted.tasks.find((item) => item.id === beforeCrash.id)!;
    assert.equal(task.state, 'interrupted'); assert.equal(task.artifacts.length, 1); assert.equal(task.total - task.processed, 2);
    assert.equal(mock.requests.length, 2, '重启不能自动重发第二／第三镜');
    await card.getByRole('button', { name: '恢复此草稿', exact: true }).click();
    await page.getByText('已恢复自动草稿；未重发任何 AI 请求，请核对素材并手动保存项目。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '作品名称', exact: true }).inputValue(), '异常退出待恢复');
    assert.equal(await page.getByRole('textbox', { name: '第 1 条字幕文字', exact: true }).inputValue(), '单独的字幕草稿');
    assert.equal(await page.getByRole('button', { name: '采用此配音', exact: true }).count(), 0);
    await panel.locator('.recovery-tasks summary').click();
    await panel.getByRole('button', { name: '核验文件', exact: true }).click();
    await panel.getByText(/文件存在、SHA-256 与格式检查通过/).waitFor();
    const artifact = task.artifacts[0]; const bytes = await readFile(artifact.path); bytes[100] ^= 1; await writeFile(artifact.path, bytes);
    await panel.getByRole('button', { name: '核验文件', exact: true }).click();
    await panel.getByText(/SHA-256 不匹配/).waitFor();
    assert.equal(await readFile(projectFile, 'utf8'), original);
    assert.equal(mock.requests.length, 2);
    // 正常退出立即刷新未到防抖时限的编辑；关闭握手应等待草稿写入。
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('退出握手保存的最后编辑');
    closing = true; await desktop!.close(); desktop = undefined; closing = false;
    page = await launch();
    await page.getByRole('article', { name: '草稿 退出握手保存的最后编辑', exact: true }).waitFor();
    await page.getByRole('button', { name: '恢复此草稿', exact: true }).click();
    await page.getByText('已恢复自动草稿；未重发任何 AI 请求，请核对素材并手动保存项目。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await page.getByText('项目已保存：manual.yingxu.json', { exact: true }).waitFor();
    assert.equal((JSON.parse(await readFile(projectFile, 'utf8')) as Project).title, '退出握手保存的最后编辑');
    assert.equal((await overview(page)).drafts.length, 0);
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('准备放弃的草稿');
    await page.getByRole('region', { name: '自动保存与恢复', exact: true }).getByText('最新编辑已自动保存', { exact: true }).waitFor();
    await kill(); page = await launch();
    await page.getByRole('article', { name: '草稿 准备放弃的草稿', exact: true }).getByRole('button', { name: '放弃此草稿', exact: true }).click();
    await page.getByRole('button', { name: '刷新恢复记录', exact: true }).click();
    assert.equal((await overview(page)).drafts.length, 0);
    // 仅测试进程延迟已落盘请求的回执，确保手动保存／切工作区会等待在途自动保存。
    await desktop!.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, input: unknown) => Promise<unknown>> })._invokeHandlers;
      const originalSave = handlers.get('recovery:save')!;
      ipcMain.removeHandler('recovery:save');
      ipcMain.handle('recovery:save', async (event, input: unknown) => {
        const result = await originalSave(event, input);
        await new Promise<void>((resolve) => setTimeout(resolve, 900)); return result;
      });
    });
    async function waitForDraftTitle(title: string) {
      await page.evaluate(async (expected) => {
        const api = (window as unknown as { desktop: DesktopAPI }).desktop;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if ((await api.getRecovery()).drafts.some((draft) => draft.title === expected)) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`等待草稿超时：${expected}`);
      }, title);
    }
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('在途自动保存后手动保存');
    await waitForDraftTitle('在途自动保存后手动保存');
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="作品名称"]')?.disabled);
    await page.getByText('项目已保存：manual.yingxu.json', { exact: true }).waitFor();
    assert.equal((await overview(page)).drafts.length, 0, '手动保存等待旧回执后放弃草稿，不能复活');
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('切工作区前在途编辑');
    await waitForDraftTitle('切工作区前在途编辑');
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="作品名称"]')?.value !== '切工作区前在途编辑');
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('新工作区独立草稿');
    await waitForDraftTitle('新工作区独立草稿');
    const switched = (await overview(page)).drafts;
    assert.equal(switched.length, 1); assert.equal(switched[0].title, '新工作区独立草稿');
    assert.notEqual(switched[0].id, savedDraft.id);
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await page.getByRole('region', { name: '自动保存与恢复', exact: true }).getByText('已手动保存项目', { exact: true }).waitFor();
    assert.equal((await overview(page)).drafts.length, 0);
    const taskFiles = await readdir(path.join(profile, 'recovery-v1/tasks'));
    for (const file of taskFiles) {
      const record = await readFile(path.join(profile, 'recovery-v1/tasks', file), 'utf8');
      assert.ok(!record.includes('sk-local-recovery-not-real') && !record.includes(mock.baseUrl) && !record.includes('data:audio'));
    }
    await page.screenshot({ path: path.join(directory, 'recovery-smoke.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('恢复桌面验收通过：独立自动草稿、手动原件保护、主进程 SIGKILL 后真实重启、分镜／字幕恢复、逐镜成功记录保留、中断状态、无自动重发、SHA-256 同长度替换检测、正常关闭刷新最后编辑、手动保存清除提示、显式放弃及在途保存／切工作区竞态。');
    console.log(`本地测试档案：${profile}；仅本机音调服务，safeStorage 为替身。`);
  } finally {
    closing = true; if (desktop) await desktop.close();
    await server.close(); await mock.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
