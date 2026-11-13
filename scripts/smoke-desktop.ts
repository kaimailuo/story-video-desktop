import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron, type ElectronApplication } from 'playwright-core';
import { createServer } from 'vite';
import type { DesktopAPI } from '../src/shared/project';

async function main(): Promise<void> {
  const directory = path.resolve('artifacts');
  const profile = path.join(directory, 'desktop-test-profile');
  const projectFile = path.join(directory, 'desktop-smoke.yingxu.json');
  const outputFile = path.join(directory, 'desktop-smoke.mp4');
  await mkdir(profile, { recursive: true });
  const server = await createServer({ server: { port: 0, strictPort: false } });
  let desktop: ElectronApplication | undefined;
  try {
    await server.listen();
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const executablePath = require('electron') as string;
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    env.VITE_DEV_SERVER_URL = server.resolvedUrls!.local[0];
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath, args: [process.cwd(), `--user-data-dir=${profile}`], env, timeout: 40000 });
    await desktop.evaluate(({ app, dialog }, config) => {
      app.setPath('userData', config.profile);
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string };
        return { canceled: false, filePath: options.title === '导出 MP4' ? config.outputFile : config.projectFile };
      };
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string };
        const filePath = options.title === '导入分镜图片' ? config.imageFile
          : options.title === '导入配音或背景音乐' ? config.audioFile : config.projectFile;
        return { canceled: false, filePaths: [filePath] };
      };
      dialog.showMessageBoxSync = () => 1;
    }, { profile, projectFile, outputFile, imageFile: path.join(profile, 'demo-assets/demo-1.png'), audioFile: path.join(profile, 'demo-assets/demo-tone.wav') });
    const page = await desktop.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('dialog', (dialog) => { void dialog.accept(); });
    await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor();
    assert.equal(await page.evaluate(() => typeof (window as Window & { desktop?: DesktopAPI }).desktop?.startExport), 'function');
    assert.equal(await page.evaluate(() => typeof (window as Window & { require?: unknown }).require), 'undefined');
    await page.getByRole('button', { name: '载入演示项目' }).click();
    const exportButton = page.getByRole('button', { name: '导出 MP4', exact: true });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((button) => button.textContent === '导出 MP4' && !button.disabled));
    assert.equal(await page.locator('.scene-card').count(), 3);
    await page.getByRole('button', { name: '替换当前图片', exact: true }).click();
    await page.getByText('已导入 1 张图片，从当前分镜起依次填充。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '导入', exact: true }).first().click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.heading-actions .primary')?.disabled);
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await page.getByText('项目已保存：desktop-smoke.yingxu.json', { exact: true }).waitFor();
    const saved = JSON.parse(await readFile(projectFile, 'utf8')) as { scenes: unknown[] };
    assert.equal(saved.scenes.length, 3);
    await page.getByRole('textbox', { name: '当前分镜字幕' }).fill('这是一条未保存的编辑。');
    await page.getByRole('button', { name: '打开本地项目', exact: true }).click();
    await page.getByText('已打开：desktop-smoke.yingxu.json', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '当前分镜字幕' }).inputValue(), '清晨，城市还未醒来。');
    await exportButton.click();
    await page.getByText('视频已准备就绪', { exact: true }).waitFor({ timeout: 180000 });
    assert.ok((await stat(outputFile)).size > 10000);
    const layout = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(layout.scrollWidth <= layout.width, '桌面布局不应横向溢出');
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(directory, 'desktop-smoke.png'), fullPage: true });
    console.log('桌面验收通过：真实 Electron 沙盒与预加载、演示项目、项目保存/重开、IPC 导出、界面布局。');
    console.log(`成片：${outputFile}`);
    console.log(`截图：${path.join(directory, 'desktop-smoke.png')}`);
  } finally {
    if (desktop) await desktop.close();
    await server.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
