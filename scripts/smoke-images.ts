import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron, type ElectronApplication } from 'playwright-core';
import { createServer } from 'vite';
import { startMockImages } from './helpers/mock-images';
import type { DesktopAPI, Project } from '../src/shared/project';

async function main(): Promise<void> {
  const directory = path.resolve('artifacts');
  await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(path.join(directory, 'images-desktop-profile-'));
  const projectFile = path.join(directory, 'images-smoke.yingxu.json');
  const outputFile = path.join(directory, 'images-smoke.mp4');
  const fakeKey = 'sk-local-images-not-a-real-key';
  const mock = await startMockImages();
  const server = await createServer({ server: { port: 0, strictPort: false } });
  let desktop: ElectronApplication | undefined;
  let closing = false;
  try {
    await server.listen();
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    env.VITE_DEV_SERVER_URL = server.resolvedUrls!.local[0];
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: require('electron') as string, args: [process.cwd(), `--user-data-dir=${profile}`], env, timeout: 40000 });
    await desktop.evaluate(({ app, dialog, safeStorage }, config) => {
      app.setPath('userData', config.profile);
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string };
        return { canceled: false, filePath: options.title === '导出 MP4' ? config.outputFile : config.projectFile };
      };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.projectFile] });
      dialog.showMessageBoxSync = () => 1;
      // 只替换本测试进程的系统密钥边界，不是 macOS 钥匙串真实验收。
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (value) => Buffer.from(Array.from(Buffer.from(value), (byte) => byte ^ 0xa5));
      safeStorage.decryptString = (value) => Buffer.from(Array.from(value, (byte) => byte ^ 0xa5)).toString();
    }, { profile, projectFile, outputFile });
    const page = await desktop.firstWindow();
    const errors: string[] = [];
    let approve = true;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { void (approve ? dialog.accept() : dialog.dismiss()).catch((error: unknown) => { if (!closing) errors.push(error instanceof Error ? error.message : '对话框处理失败'); }); });
    await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor();
    await page.getByRole('button', { name: '载入演示项目' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.scene-card img').length === 3);

    async function openSettings() {
      await page.getByRole('button', { name: '图片模型设置', exact: true }).first().click();
      await page.getByRole('heading', { name: '图片模型设置', exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="模型名称"]')?.disabled);
    }
    async function promptAt(index: number, prompt: string) {
      await page.locator('.scene-card').nth(index).click();
      await page.getByRole('textbox', { name: '当前分镜绘图提示词' }).fill(prompt);
    }
    async function saveProject(): Promise<Project> {
      await page.getByRole('button', { name: '保存项目', exact: true }).click();
      await page.getByText('项目已保存：images-smoke.yingxu.json', { exact: true }).waitFor();
      return JSON.parse(await readFile(projectFile, 'utf8')) as Project;
    }

    await openSettings();
    await page.getByRole('textbox', { name: 'API 基础地址', exact: true }).fill(mock.baseUrl);
    await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('mock-images');
    await page.getByRole('textbox', { name: 'API Key', exact: true }).fill(fakeKey);
    await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'API Key', exact: true }).inputValue(), '');
    assert.equal(mock.requests.length, 0);
    assert.ok(!(await readFile(path.join(profile, 'image-settings.json'), 'utf8')).includes(fakeKey));
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    const textView = await page.evaluate(() => (window as Window & { desktop?: DesktopAPI }).desktop!.getAISettings());
    assert.equal(textView.hasKey, false, '图片配置不能写入文本配置');

    await promptAt(0, '画一扇窗');
    const originalPreview = await page.locator('.scene-card img').first().getAttribute('src');
    approve = false;
    await page.getByRole('button', { name: '生成当前分镜图片', exact: true }).click();
    assert.equal(mock.requests.length, 0, '不确认不应联网');
    approve = true;
    await page.getByRole('button', { name: '生成当前分镜图片', exact: true }).click();
    await page.getByRole('button', { name: '采用此图片', exact: true }).waitFor();
    assert.equal(await page.locator('.scene-card img').first().getAttribute('src'), originalPreview, '生成不能自动替换');
    await page.getByRole('textbox', { name: '当前分镜绘图提示词' }).fill('已改动');
    assert.equal(await page.getByRole('button', { name: '采用此图片', exact: true }).isDisabled(), true);
    await page.getByRole('textbox', { name: '当前分镜绘图提示词' }).fill('画一扇窗');
    await page.getByRole('button', { name: '采用此图片', exact: true }).click();
    assert.notEqual(await page.locator('.scene-card img').first().getAttribute('src'), originalPreview);
    await page.getByText('当前分镜图片版本（2）', { exact: true }).click();
    const beforeRestore = mock.requests.length;
    await page.getByRole('button', { name: '使用此版本', exact: true }).click();
    await page.getByText('已切换图片版本，未发起生图请求；请保存项目。', { exact: true }).waitFor();
    assert.equal(await page.locator('.scene-card img').first().getAttribute('src'), originalPreview);
    await page.getByRole('button', { name: '使用此版本', exact: true }).click();
    await page.waitForFunction((original) => document.querySelector('.scene-card img')?.getAttribute('src') !== original, originalPreview);
    assert.equal(mock.requests.length, beforeRestore);

    await page.getByRole('button', { name: '生成当前分镜图片', exact: true }).click();
    await page.getByRole('button', { name: '丢弃此候选', exact: true }).click();
    assert.equal(await page.locator('.image-candidate img').count(), 0);
    await promptAt(0, 'first'); await promptAt(1, 'fail'); await promptAt(2, 'last');
    await page.getByRole('button', { name: '重新生成全部分镜图片', exact: true }).click();
    await page.getByText(/生图已完成：成功 2，失败 1，未执行 0/).waitFor();
    assert.equal(await page.locator('.image-candidate img').count(), 2);
    await page.getByRole('button', { name: '采用此图片', exact: true }).first().click();
    await page.getByRole('button', { name: '采用此图片', exact: true }).first().click();
    const saved = await saveProject();
    assert.ok(saved.scenes[0].imagePath?.includes('generated-images'));
    assert.ok(saved.scenes[2].imagePath?.includes('generated-images'));
    assert.ok(saved.scenes[1].imagePath?.includes('demo-assets'), '失败镜头必须保留旧图');
    assert.ok(saved.scenes[0].imageVersions?.some((item) => item.source === 'imported'));
    assert.ok(!JSON.stringify(saved).includes(fakeKey) && !JSON.stringify(saved).includes(mock.baseUrl) && !JSON.stringify(saved).includes('data:image'));
    await page.getByRole('button', { name: '打开本地项目', exact: true }).click();
    await page.getByText('已打开：images-smoke.yingxu.json', { exact: true }).waitFor();
    assert.equal(await page.locator('.image-candidate').count(), 0);
    assert.equal(await page.locator('.scene-card img').count(), 3);
    await page.getByRole('button', { name: '导出 MP4', exact: true }).click();
    await page.getByText('视频已准备就绪', { exact: true }).waitFor({ timeout: 180000 });
    assert.ok((await stat(outputFile)).size > 10000);

    await promptAt(0, 'first'); await promptAt(1, 'slow'); await promptAt(2, 'must-not-send');
    const beforeCancel = mock.requests.length;
    await page.getByRole('button', { name: '重新生成全部分镜图片', exact: true }).click();
    await page.getByText('正在生成第 2/3 镜', { exact: true }).waitFor();
    const protection = await page.evaluate(async () => {
      const api = (window as Window & { desktop?: DesktopAPI }).desktop!;
      const duplicate = await api.generateImages({ id: crypto.randomUUID(), size: '1024x1024', scenes: [{ sceneId: 'duplicate', prompt: 'no' }] });
      const text = await api.runAI({ id: crypto.randomUUID(), kind: 'test' });
      let exportBlocked = false;
      try { await api.startExport({} as Project); } catch { exportBlocked = true; }
      return { duplicate, text, exportBlocked };
    });
    assert.ok(!protection.duplicate.ok && protection.duplicate.error.code === 'busy');
    assert.ok(!protection.text.ok && protection.text.error.code === 'busy');
    assert.equal(protection.exportBlocked, true);
    await page.getByRole('button', { name: '取消生图任务', exact: true }).click();
    await page.getByText(/生图已取消：成功 1，失败 1，未执行 1/).waitFor();
    assert.equal(mock.requests.length - beforeCancel, 2);
    assert.equal(await page.locator('.image-candidate img').count(), 1, '取消仍保留已成功候选');
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(layout.scrollWidth <= layout.width);
    await page.screenshot({ path: path.join(directory, 'images-smoke.png'), fullPage: true });

    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="作品名称"]')?.value === '未命名作品' && document.querySelectorAll('.scene-card').length === 1);
    assert.equal(await page.locator('.image-candidate').count(), 0, '新项目不能残留旧候选');
    await page.getByRole('textbox', { name: '视频文案', exact: true }).fill('第一镜。第二镜。');
    await page.getByRole('button', { name: '拆分分镜', exact: true }).click();
    await promptAt(0, 'first'); await promptAt(1, 'second');
    const beforeMissing = mock.requests.length;
    await page.getByRole('button', { name: '批量生成缺图分镜', exact: true }).click();
    await page.getByText(/生图已完成：成功 2，失败 0，未执行 0/).waitFor();
    await page.getByRole('button', { name: '采用此图片', exact: true }).first().click();
    await page.getByRole('button', { name: '批量生成缺图分镜', exact: true }).click();
    await page.getByText(/生图已完成：成功 1，失败 0，未执行 0/).waitFor();
    assert.equal(mock.requests.length - beforeMissing, 3, '缺图批量不能重新请求已有图镜头');
    await page.getByRole('button', { name: '采用此图片', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '批量生成缺图分镜', exact: true }).isDisabled(), true);
    await openSettings();
    await page.getByRole('checkbox', { name: '删除已保存的 Key' }).check();
    await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '生成当前分镜图片', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log('图片桌面模拟验收通过：独立配置、确认才联网、候选／采用／丢弃／过期保护、旧图切换、批量部分失败、保存重开、真实 MP4 导出、取消保留成功、任务互斥、缺图批量及新项目隔离。');
    console.log(`模拟成片：${outputFile}`);
    console.log('仅调用本机模拟服务，测试密钥存储为替身；未验收真实模型、计费或 macOS 钥匙串。');
  } finally {
    closing = true;
    if (desktop) await desktop.close();
    await server.close();
    await mock.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
