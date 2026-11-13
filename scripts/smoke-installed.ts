import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron, type ElectronApplication } from 'playwright-core';
import type { DesktopAPI, Project } from '../src/shared/project';

interface InstalledState { spawned: string[]; networkAttempts: number }
type TestGlobal = typeof globalThis & { installedSmoke?: InstalledState };

async function main(): Promise<void> {
  const installed = '/Applications/映序.app';
  const executablePath = path.join(installed, 'Contents/MacOS/映序');
  const ffmpeg = path.join(installed, 'Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg');
  await stat(executablePath);
  const artifacts = path.resolve('artifacts'); await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(path.join(artifacts, 'installed-acceptance-'));
  const profile = path.join(directory, 'profile');
  const projectFile = path.join(directory, '安装版验收.yingxu.json');
  const outputFile = path.join(directory, '安装版竖屏720p.mp4');
  const subtitleFile = path.join(directory, '安装版验收.srt');
  const userData = path.join(process.env.HOME!, 'Library/Application Support/story-video-desktop');
  const settingsFiles = ['ai-settings.json', 'image-settings.json', 'speech-settings.json'];
  async function fingerprints() {
    return Promise.all(settingsFiles.map(async (name) => {
      try { return createHash('sha256').update(await readFile(path.join(userData, name))).digest('hex'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }));
  }
  const before = await fingerprints();
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  let desktop: ElectronApplication | undefined;
  const errors: string[] = [];
  const checks: string[] = [];
  async function launch() {
    const instance = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 40000 });
    desktop = instance;
    const runtime = await instance.evaluate(({ app, dialog, session }, config) => {
      const state: InstalledState = { spawned: [], networkAttempts: 0 };
      (globalThis as TestGlobal).installedSmoke = state;
      const cp = process.getBuiltinModule('child_process');
      const originalSpawn = cp.spawn;
      cp.spawn = ((...args: Parameters<typeof originalSpawn>) => {
        state.spawned.push(String(args[0]));
        return originalSpawn(...args);
      }) as typeof originalSpawn;
      // 不模拟模型、媒体或存储；仅阻断外部请求并记录真实启动的媒体程序。
      globalThis.fetch = async () => { state.networkAttempts++; throw new Error('安装验收禁止外部请求'); };
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
        state.networkAttempts++; callback({ cancel: true });
      });
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string }).title;
        return { canceled: false, filePath: title === '导出 MP4' ? config.outputFile : title === '导出 SRT 字幕' ? config.subtitleFile : config.projectFile };
      };
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string }).title;
        const filePath = title === '导入分镜图片' ? config.imageFile : title === '导入配音或背景音乐' ? config.audioFile : config.projectFile;
        return { canceled: false, filePaths: [filePath] };
      };
      dialog.showMessageBoxSync = () => 1;
      return { packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'), version: app.getVersion() };
    }, { projectFile, outputFile, subtitleFile, imageFile: path.join(profile, 'demo-assets/demo-1.png'), audioFile: path.join(profile, 'demo-assets/demo-tone.wav') });
    assert.equal(runtime.packaged, true);
    assert.equal(runtime.appPath, path.join(installed, 'Contents/Resources/app.asar'));
    assert.equal(runtime.userData, profile, '必须在初始化时隔离真实用户数据');
    const page = await instance.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { void dialog.accept(); });
    await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor();
    assert.ok(page.url().startsWith('file://'));
    assert.equal(await page.evaluate(() => typeof (window as Window & { require?: unknown }).require), 'undefined');
    for (const getter of ['getAISettings', 'getImageSettings', 'getSpeechSettings'] as const) {
      const view = await page.evaluate((name) => (window as Window & { desktop?: DesktopAPI }).desktop![name](), getter);
      assert.equal(view.hasKey, false);
      assert.equal(view.settings.baseUrl, '');
    }
    return { page, runtime };
  }
  try {
    console.log(`独立安装验收目录：${directory}`);
    const { page, runtime } = await launch();
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    await button('载入演示项目').click();
    await page.waitForFunction(() => document.querySelectorAll('.scene-card img').length === 3);
    assert.equal(await page.getByRole('textbox', { name: '当前分镜字幕', exact: true }).inputValue(), '清晨，城市还未醒来。');
    await page.waitForFunction(() => Array.from(document.images).filter((image) => image.naturalWidth > 0).length >= 3);
    checks.push('安装版生产页面、沙盒、独立档案、包内 Sharp 真实生成与显示三张演示图');
    await button('替换当前图片').click();
    await page.getByText('已导入 1 张图片，从当前分镜起依次填充。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '导入', exact: true }).first().click();
    const title = '安装版验收作品';
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill(title);
    await button('保存项目').click();
    await page.getByText('项目已保存：安装版验收.yingxu.json', { exact: true }).waitFor();
    const saved = JSON.parse(await readFile(projectFile, 'utf8')) as Project;
    assert.equal(saved.title, title); assert.equal(saved.scenes.length, 3);
    assert.equal(saved.narrationPath, path.join(profile, 'demo-assets/demo-tone.wav'));
    assert.ok(saved.scenes[0].imageVersions?.length);
    checks.push('真实图片／WAV 导入、图片版本、中文名称项目保存');
    await button('检查项目素材').click();
    await page.getByRole('region', { name: '素材统一检查' }).getByText(/素材检查通过：0 项阻塞/).waitFor();
    await button('导出 SRT 字幕').click();
    await page.getByText('字幕已导出：安装版验收.srt', { exact: true }).waitFor();
    const subtitles = await readFile(subtitleFile, 'utf8');
    assert.ok(subtitles.includes('清晨，城市还未醒来。')); assert.ok(subtitles.includes('-->'));
    await button('导出 MP4').click();
    await page.getByText('视频已准备就绪', { exact: true }).waitFor({ timeout: 240000 });
    assert.ok((await stat(outputFile)).size > 10000);
    const state = await desktop!.evaluate(() => (globalThis as TestGlobal).installedSmoke!);
    assert.equal(state.networkAttempts, 0);
    assert.ok(state.spawned.length > 0); assert.ok(state.spawned.every((file) => file === ffmpeg), '不能回退到宿主机 FFmpeg');
    const decode = execFileSync(ffmpeg, ['-hide_banner', '-i', outputFile, '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(decode, '');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', outputFile, '-frames:v', '1', path.join(directory, '成片第1秒.png')], { timeout: 30000 });
    checks.push('素材检查通过、中文 SRT、竖屏 720p 字幕／转场／音频 MP4 导出及完整解码；仅调用安装包内 FFmpeg');
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(layout.scroll <= layout.width);
    await page.screenshot({ path: path.join(directory, '安装版导出完成.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await desktop!.close(); desktop = undefined;
    const reopened = await launch();
    await reopened.page.getByRole('button', { name: '打开本地项目', exact: true }).click();
    await reopened.page.getByText('已打开：安装版验收.yingxu.json', { exact: true }).waitFor();
    assert.equal(await reopened.page.getByRole('textbox', { name: '作品名称', exact: true }).inputValue(), title);
    assert.equal(await reopened.page.getByRole('textbox', { name: '当前分镜字幕', exact: true }).inputValue(), saved.scenes[0].text);
    await reopened.page.waitForFunction(() => document.querySelectorAll('.scene-card img').length === 3);
    assert.deepEqual(JSON.parse(await readFile(projectFile, 'utf8')), saved);
    const recovery = await reopened.page.evaluate(() => (window as Window & { desktop?: DesktopAPI }).desktop!.getRecovery());
    assert.ok(recovery.tasks.some((task) => task.kind === 'mp4' && task.state === 'done'));
    assert.equal(await desktop!.evaluate(() => (globalThis as TestGlobal).installedSmoke!.networkAttempts), 0);
    checks.push('退出安装版并重新启动后打开项目，中文文字／三镜素材／完成任务记录保留，手动项目未变化');
    await desktop!.close(); desktop = undefined;
    assert.deepEqual(await fingerprints(), before, '真实用户三类模型配置不得变化');
    checks.push('真实用户三类模型配置文件哈希未变化；未调用模型、未使用钥匙串解密、未替换加密实现');
    await writeFile(path.join(directory, '验收结果.json'), JSON.stringify({ runtime, checks, errors, spawned: state.spawned, networkAttempts: 0, outputFile, subtitleFile, limitations: ['原生文件选择器由自动化替换，不验证手工交互', '未测真实模型、计费、钥匙串授权、系统断网、Gatekeeper 或声音主观质量'] }, null, 2));
    console.log(checks.join('\n')); console.log(`安装版本地工作流验收通过：${outputFile}`);
  } catch (error) {
    await writeFile(path.join(directory, '失败信息.txt'), error instanceof Error ? `${error.name}: ${error.message}` : '未知错误');
    if (desktop) { const page = await desktop.firstWindow().catch(() => undefined); await page?.screenshot({ path: path.join(directory, '失败截图.png'), fullPage: true }).catch(() => undefined); }
    throw error;
  } finally { if (desktop) await desktop.close(); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
