import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import type { DesktopAPI, Project } from '../src/shared/project';

interface CallRecord { kind: string; started: string; status?: number; contentType?: string; transportFailed?: boolean }
interface LiveState { calls: CallRecord[] }
type LiveGlobal = typeof globalThis & { liveSmoke?: LiveState };

async function main(): Promise<void> {
  assert.ok(process.argv.includes('--paid-authorized=7'), '必须先获得用户真实调用授权；本脚本不接受隐式授权');
  const stage = process.argv[2]; assert.ok(['text', 'images', 'speech-export'].includes(stage));
  const artifacts = path.resolve('artifacts'); await mkdir(artifacts, { recursive: true });
  const runArgument = process.argv.find((argument) => argument.startsWith('--run='))?.slice(6);
  assert.ok(stage === 'text' || runArgument, '后续阶段必须复用原验收目录和调用账本');
  const directory = runArgument ? path.resolve(runArgument) : await mkdtemp(path.join(artifacts, 'live-acceptance-'));
  assert.ok(path.dirname(directory) === artifacts && path.basename(directory).startsWith('live-acceptance-'));
  const profile = path.join(directory, 'profile'); await mkdir(profile, { recursive: true });
  const projectFile = path.join(directory, '真实短片.yingxu.json');
  const outputFile = path.join(directory, '真实短片.mp4');
  const ledgerFile = path.join(directory, '生成调用记录.json');
  const source = path.join(process.env.HOME!, 'Library/Application Support/story-video-desktop');
  const configNames = ['ai-settings.json', 'image-settings.json', 'speech-settings.json'];
  if (stage === 'text') await writeFile(ledgerFile, '[]', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(directory, `${stage}-已启动.txt`), new Date().toISOString(), { flag: 'wx' });
  console.log(`验收目录：${directory}\n阶段：${stage}；已启动标记禁止自动重跑。`);
  const fingerprints: string[] = [];
  const endpoints: Record<string, string> = {};
  let desktop: ElectronApplication | undefined;
  let page: Page | undefined;
  try {
    for (const name of configNames) {
      const bytes = await readFile(path.join(source, name));
      const config = JSON.parse(bytes.toString('utf8')) as { settings: { baseUrl: string }; encryptedKey?: string };
      assert.ok(config.encryptedKey, `${name} 尚未保存 Key`);
      const base = new URL(config.settings.baseUrl);
      assert.equal(base.protocol, 'https:'); assert.ok(!base.username && !base.password && !base.search && !base.hash);
      const kind = name === 'ai-settings.json' ? 'text' : name === 'image-settings.json' ? 'image' : 'speech';
      const suffix = kind === 'text' ? '/chat/completions' : kind === 'image' ? '/images/generations' : '/audio/speech';
      endpoints[kind] = `${config.settings.baseUrl.replace(/\/+$/, '')}${suffix}`;
      fingerprints.push(createHash('sha256').update(bytes).digest('hex'));
      // 只复制已加密文件，明文 Key 由安装应用自身的 safeStorage 在内存中使用。
      await writeFile(path.join(profile, name), bytes, { mode: 0o600 });
    }
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    desktop = await _electron.launch({ executablePath: '/Applications/映序.app/Contents/MacOS/映序', args: [`--user-data-dir=${profile}`], env, timeout: 40000 });
    const runtime = await desktop.evaluate(({ app, dialog }, config) => {
      const fs = process.getBuiltinModule('fs');
      const calls = JSON.parse(fs.readFileSync(config.ledgerFile, 'utf8')) as CallRecord[];
      (globalThis as LiveGlobal).liveSmoke = { calls };
      const originalFetch = globalThis.fetch;
      const allowedKind = config.stage === 'text' ? 'text' : config.stage === 'images' ? 'image' : 'speech';
      const limits: Record<string, number> = { text: 1, image: 3, speech: 3 };
      globalThis.fetch = async (input, init) => {
        const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const kind = Object.keys(config.endpoints).find((name) => config.endpoints[name] === target);
        if (method === 'GET' && new URL(target).origin === new URL(config.endpoints.image).origin) return originalFetch(input, init);
        if (method !== 'POST' || kind !== allowedKind || calls.length >= 7 || calls.filter((call) => call.kind === kind).length >= limits[kind]) {
          throw new Error('真实验收请求超出授权类型或次数，已阻止发送');
        }
        const record: CallRecord = { kind, started: new Date().toISOString() }; calls.push(record);
        const persist = () => fs.writeFileSync(config.ledgerFile, JSON.stringify(calls, null, 2), { mode: 0o600 });
        persist(); // 发送前落盘，崩溃也不能丢失已使用的调用预算。
        try {
          const response = await originalFetch(input, init);
          record.status = response.status; record.contentType = response.headers.get('content-type') ?? ''; persist();
          return response;
        } catch (error) { record.transportFailed = true; persist(); throw error; }
      };
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string }).title;
        return { canceled: false, filePath: title === '导出 MP4' ? config.outputFile : title === '导出 SRT 字幕' ? config.subtitleFile : config.projectFile };
      };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.projectFile] });
      dialog.showMessageBoxSync = () => 1;
      return { userData: app.getPath('userData'), packaged: app.isPackaged, appPath: app.getAppPath() };
    }, { stage, endpoints, ledgerFile, projectFile, outputFile, subtitleFile: path.join(directory, '真实短片.srt') });
    assert.equal(runtime.userData, profile); assert.equal(runtime.packaged, true);
    page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
    page.on('dialog', (dialog) => { void dialog.accept(); });
    await page.getByRole('heading', { name: '让灵感，有画面。' }).waitFor();
    const button = (name: string) => page!.getByRole('button', { name, exact: true });
    async function idle() { await page!.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="作品名称"]')?.disabled === false, undefined, { timeout: 240000 }); }
    async function save() {
      await idle(); await button('保存项目').click();
      await page!.getByText('项目已保存：真实短片.yingxu.json', { exact: true }).waitFor();
      return JSON.parse(await readFile(projectFile, 'utf8')) as Project;
    }
    async function failOnPanelError(label: string) {
      const errors = await page!.getByRole('region', { name: label, exact: true }).locator('.ai-error').allTextContents();
      assert.deepEqual(errors, [], `本阶段失败，必须停止后续收费调用：${errors.join('；')}`);
    }
    if (stage === 'text') {
      for (const getter of ['getAISettings', 'getImageSettings', 'getSpeechSettings'] as const) {
        const view = await page.evaluate((name) => (window as Window & { desktop?: DesktopAPI }).desktop![name](), getter);
        assert.ok(view.hasKey && view.encryptionAvailable, '配置或系统安全存储不可用，停止测试');
      }
      await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('把手机放远，给专注一个开始');
      await page.getByRole('textbox', { name: '视频文案', exact: true }).fill('想专心做事，却总忍不住看手机？\n开始前，把手机调成静音，放到够不着的地方。\n只给自己定一个小目标：先专注十分钟，再休息。');
      await page.getByRole('textbox', { name: 'AI 补充要求', exact: true }).fill('制作约15至20秒、恰好3镜的中文生活建议短片。三句原文各对应一镜，原句保留为text，不扩写、不编造科学结论。duration每镜5至7秒。统一温暖写实摄影风、同一间简洁木色书房、同一位穿米色针织衫的东亚青年；第一镜手机干扰，第二镜把手机放到远处，第三镜专心写笔记。每条prompt完整重述人物和环境特征，强调竖屏构图、主体位于中上区域、底部留字幕安全区、画面无文字和水印。');
      await button('AI 生成分镜').click(); await idle(); await failOnPanelError('AI 文案与分镜');
      await page.getByRole('heading', { name: '分镜候选 · 3 镜', exact: true }).waitFor();
      const candidateText = await page.locator('.generated-scenes').innerText();
      await writeFile(path.join(directory, '分镜候选.txt'), candidateText);
      await page.screenshot({ path: path.join(directory, '分镜候选.png'), fullPage: true });
      await button('采用分镜').click(); await idle();
      const project = await save(); assert.equal(project.scenes.length, 3);
      console.log('真实文本分镜完成并保存，待内容复核。\n'+candidateText);
    } else {
      await button('打开本地项目').click();
      await page.getByText('已打开：真实短片.yingxu.json', { exact: true }).waitFor(); await idle();
      const project = JSON.parse(await readFile(projectFile, 'utf8')) as Project; assert.equal(project.scenes.length, 3);
      if (stage === 'images') {
        await page.getByRole('combobox', { name: '生图尺寸', exact: true }).selectOption('1024x1536');
        for (let index = 0; index < 3; index++) {
          await page.locator('.scene-card').nth(index).click();
          await button('生成当前分镜图片').click(); await idle(); await failOnPanelError('AI 分镜生图');
          const candidate = page.getByRole('article', { name: `分镜 ${index + 1} 图片候选`, exact: true });
          await candidate.getByRole('button', { name: '采用此图片', exact: true }).waitFor();
          await candidate.screenshot({ path: path.join(directory, `图片候选${index + 1}.png`) });
          await candidate.getByRole('button', { name: '采用此图片', exact: true }).click(); await save();
          console.log(`真实分镜 ${index + 1} 图片已生成并保存；尚待人工视觉复核，不代表质量通过。`);
        }
      } else {
        assert.ok(project.scenes.every((scene) => scene.imagePath), '图片阶段未完成，不发送配音请求');
        await page.getByRole('textbox', { name: '配音音色标识', exact: true }).fill('alloy');
        for (let index = 0; index < 3; index++) {
          await page.locator('.scene-card').nth(index).click();
          await button('生成当前分镜配音').click(); await idle(); await failOnPanelError('AI 按镜配音');
          const candidate = page.getByRole('article', { name: `分镜 ${index + 1} 配音候选`, exact: true });
          await candidate.getByRole('button', { name: '采用此配音', exact: true }).waitFor();
          await candidate.getByRole('button', { name: '加载试听', exact: true }).click();
          await candidate.locator('audio').waitFor();
          await candidate.locator('audio').evaluate(async (audio: HTMLAudioElement) => {
            if (audio.readyState < 1) await new Promise<void>((resolve, reject) => { audio.onloadedmetadata = () => resolve(); audio.onerror = () => reject(new Error('WAV浏览器解码失败')); });
            if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new Error('配音时长无效');
          });
          await candidate.getByRole('button', { name: '采用此配音', exact: true }).click(); await save();
          console.log(`真实分镜 ${index + 1} 配音已生成、解码及保存；尚未主观听感验收。`);
        }
        await button('检查项目素材').click(); await idle();
        await page.getByRole('region', { name: '素材统一检查' }).getByText(/素材检查通过：0 项阻塞/).waitFor();
        await button('导出 SRT 字幕').click(); await idle();
        await button('导出 MP4').click();
        await page.getByText('视频已准备就绪', { exact: true }).waitFor({ timeout: 240000 });
        await page.screenshot({ path: path.join(directory, '真实短片导出.png'), fullPage: true });
        console.log(`真实短片已导出，待成片质量复核：${outputFile}`);
      }
    }
    await writeFile(path.join(directory, `${stage}-技术结果.json`), JSON.stringify({ stage, runtime, calls: JSON.parse(await readFile(ledgerFile, 'utf8')) as CallRecord[], qualityAccepted: false }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知测试错误';
    await writeFile(path.join(directory, `${stage}-失败信息.txt`), message);
    await page?.screenshot({ path: path.join(directory, `${stage}-失败截图.png`), fullPage: true }).catch(() => undefined);
    throw new Error(`真实验收已停止，不自动重发。${message}`);
  } finally {
    if (desktop) await desktop.close();
    for (const name of configNames) await unlink(path.join(profile, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    for (let index = 0; index < fingerprints.length; index++) {
      const current = createHash('sha256').update(await readFile(path.join(source, configNames[index]))).digest('hex');
      assert.equal(current, fingerprints[index], '原模型配置发生变化；停止后续阶段，不覆盖用户修改');
    }
    console.log(`生成调用记录：${ledgerFile}；临时加密配置副本已清理。`);
  }
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : '真实验收异常'); process.exitCode = 1; });
