import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron, type ElectronApplication } from 'playwright-core';
import { createServer } from 'vite';
import { startMockAI, mockRewrite, mockScenes } from './helpers/mock-ai';
import type { DesktopAPI, Project } from '../src/shared/project';

async function main(): Promise<void> {
  const directory = path.resolve('artifacts');
  const profile = path.join(directory, 'ai-test-profile');
  const projectFile = path.join(directory, 'ai-smoke.yingxu.json');
  const fakeKey = 'sk-local-mock-only-not-a-real-key';
  await mkdir(profile, { recursive: true });
  const mock = await startMockAI();
  const server = await createServer({ server: { port: 0, strictPort: false } });
  let desktop: ElectronApplication | undefined;
  try {
    await server.listen();
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    env.VITE_DEV_SERVER_URL = server.resolvedUrls!.local[0];
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: require('electron') as string, args: [process.cwd(), `--user-data-dir=${profile}`], env, timeout: 40000 });
    await desktop.evaluate(({ app, dialog, safeStorage }, config) => {
      app.setPath('userData', config.profile);
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: config.projectFile });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.projectFile] });
      dialog.showMessageBoxSync = () => 1;
      // 仅替换测试进程中的系统加密边界，避免无人值守测试触发真实钥匙串授权弹窗。
      // 不验证 macOS 钥匙串实际可用性；应用正常运行时没有此替换。
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (value) => Buffer.from(Array.from(Buffer.from(value, 'utf8'), (byte) => byte ^ 0xa5));
      safeStorage.decryptString = (value) => Buffer.from(Array.from(value, (byte) => byte ^ 0xa5)).toString('utf8');
    }, { profile, projectFile });
    const page = await desktop.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { void dialog.accept(); });
    await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor();
    await page.getByRole('button', { name: '载入演示项目' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.scene-card img').length === 3);
    const original = await page.getByRole('textbox', { name: '视频文案', exact: true }).inputValue();
    assert.equal(mock.requests.length, 0);

    async function openSettings() {
      await page.getByRole('button', { name: '文本模型设置', exact: true }).click();
      await page.getByRole('textbox', { name: '模型名称', exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="模型名称"]')?.disabled);
    }
    async function saveModel(model: string) {
      await openSettings();
      await page.getByRole('textbox', { name: '模型名称', exact: true }).fill(model);
      await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
      await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    }

    await openSettings();
    await page.getByRole('textbox', { name: 'API 基础地址', exact: true }).fill(mock.baseUrl);
    await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('mock-success');
    await page.getByRole('textbox', { name: 'API Key', exact: true }).fill(fakeKey);
    await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'API Key', exact: true }).inputValue(), '');
    assert.ok(!(await readFile(path.join(profile, 'ai-settings.json'), 'utf8')).includes(fakeKey));
    assert.equal(mock.requests.length, 0, '保存设置不应自动联网');
    await page.getByRole('button', { name: '测试已保存配置', exact: true }).click();
    await page.getByText('接口已返回有效的聊天响应。测试不代表其他模型或功能均可用。', { exact: true }).waitFor();
    assert.equal(mock.requests.length, 1);
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();

    await page.getByRole('textbox', { name: 'AI 补充要求' }).fill('保留原意，句子自然');
    await page.getByRole('button', { name: 'AI 改写文案', exact: true }).click();
    await page.getByRole('heading', { name: '文案改写候选', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '视频文案', exact: true }).inputValue(), original);
    const adoptRewrite = page.getByRole('button', { name: '采用改写', exact: true });
    await page.getByRole('textbox', { name: '视频文案', exact: true }).fill(`${original}\n已修改`);
    assert.equal(await adoptRewrite.isDisabled(), true, '过期候选必须阻止采用');
    await page.getByRole('textbox', { name: '视频文案', exact: true }).fill(original);
    await adoptRewrite.click();
    assert.equal(await page.getByRole('textbox', { name: '视频文案', exact: true }).inputValue(), mockRewrite);
    await page.getByText('已采用改写记录（1，最多保留最近 100 条）', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'AI 生成分镜', exact: true }).click();
    await page.getByRole('heading', { name: '分镜候选 · 2 镜', exact: true }).waitFor();
    assert.equal(await page.locator('.scene-card').count(), 3, '候选不能自动替换已有分镜');
    await page.getByRole('button', { name: '采用分镜', exact: true }).click();
    assert.equal(await page.locator('.scene-card').count(), 2);
    assert.equal(await page.getByRole('textbox', { name: '当前分镜绘图提示词' }).inputValue(), mockScenes[0].prompt);
    await page.getByRole('textbox', { name: '当前分镜画面描述' }).fill('手动编辑后的画面描述');
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await page.getByText('项目已保存：ai-smoke.yingxu.json', { exact: true }).waitFor();
    const savedText = await readFile(projectFile, 'utf8');
    const saved = JSON.parse(savedText) as Project;
    assert.equal(saved.rewriteHistory[0].original, original);
    assert.equal(saved.rewriteHistory[0].rewritten, mockRewrite);
    assert.equal(saved.scenes[0].description, '手动编辑后的画面描述');
    assert.ok(saved.scenes.every((scene) => scene.imagePath === null));
    assert.ok(!savedText.includes(fakeKey) && !savedText.includes(mock.baseUrl));
    assert.equal(mock.requests.length, 3);
    await page.getByRole('button', { name: '打开本地项目', exact: true }).click();
    await page.getByText('已打开：ai-smoke.yingxu.json', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '当前分镜画面描述' }).inputValue(), '手动编辑后的画面描述');
    await page.getByText('已采用改写记录（1，最多保留最近 100 条）', { exact: true }).waitFor();

    await saveModel('mock-invalid-json');
    await page.getByRole('button', { name: 'AI 生成分镜', exact: true }).click();
    await page.getByText('模型未返回有效的分镜 JSON；请手动重试或调整模型，不会自动重发。', { exact: true }).waitFor();
    assert.equal(await page.locator('.scene-card').count(), 2);
    await saveModel('mock-slow');
    await page.getByRole('button', { name: 'AI 改写文案', exact: true }).click();
    await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor();
    const duplicate = await page.evaluate(() => (window as Window & { desktop?: DesktopAPI }).desktop!.runAI({ id: crypto.randomUUID(), kind: 'test' }));
    assert.ok(!duplicate.ok && duplicate.error.code === 'busy', '主进程应拒绝重复任务');
    await page.getByRole('button', { name: '取消 AI 请求', exact: true }).click();
    await page.getByText(/AI 请求已取消/).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '视频文案', exact: true }).inputValue(), mockRewrite);
    await openSettings();
    await page.getByRole('checkbox', { name: '删除已保存的 Key' }).check();
    await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await page.getByText('配置已保存。Key 不会回显，也不会写入视频项目文件。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'AI 改写文案', exact: true }).isDisabled(), true);
    const view = await page.evaluate(() => (window as Window & { desktop?: DesktopAPI }).desktop!.getAISettings());
    assert.equal(view.hasKey, false);
    assert.ok(!JSON.stringify(view).includes(fakeKey));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(directory, 'ai-smoke.png'), fullPage: true });
    console.log('AI 桌面模拟验收通过：配置不自动联网／Key 不回显、连接测试、候选与采用、历史、过期保护、分镜编辑、格式错误、取消与删除 Key。');
    console.log('仅调用本机模拟 HTTP 服务；系统加密边界为测试替身，不代表真实服务或 macOS 钥匙串已联调。');
  } finally {
    if (desktop) await desktop.close();
    await server.close();
    await mock.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
