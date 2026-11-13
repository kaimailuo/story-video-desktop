import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { aiSettingsSchema, defaultAISettings, normalizeBaseUrl, saveAISettingsSchema, type AISettings, type AISettingsView } from '../../shared/ai';

export interface SecretCodec {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const storedSchema = z.object({
  version: z.literal(1),
  settings: aiSettingsSchema,
  encryptedKey: z.string().max(65536).nullable(),
});
type Stored = z.infer<typeof storedSchema>;

export class AISettingsStore {
  private readonly filePath: string;
  private writing = false;

  constructor(private readonly directory: string, private readonly codec: SecretCodec, fileName: 'ai-settings.json' | 'image-settings.json' | 'speech-settings.json' = 'ai-settings.json') {
    this.filePath = path.join(directory, fileName);
  }

  private async read(): Promise<Stored | null> {
    let bytes: Buffer;
    try { bytes = await readFile(this.filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('无法读取 AI 配置，请检查文件权限。');
    }
    if (bytes.length > 100_000) throw new Error('AI 配置文件异常，未自动覆盖。');
    const parsed = storedSchema.safeParse((() => {
      try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { return null; }
    })());
    if (!parsed.success) throw new Error('AI 配置文件损坏或版本不支持，未自动覆盖。');
    return parsed.data;
  }

  private view(stored: Stored | null): AISettingsView {
    return {
      settings: stored?.settings ?? { ...defaultAISettings },
      hasKey: Boolean(stored?.encryptedKey),
      encryptionAvailable: this.codec.isEncryptionAvailable(),
    };
  }

  async getView(): Promise<AISettingsView> { return this.view(await this.read()); }

  async save(raw: unknown): Promise<AISettingsView> {
    if (this.writing) throw new Error('正在保存模型设置，请稍后重试。');
    this.writing = true;
    try {
      const parsed = saveAISettingsSchema.safeParse(raw);
      if (!parsed.success) throw new Error('模型设置无效，请检查地址、模型、超时和 Key 格式。');
      const input = parsed.data;
      const settings = { ...input.settings, baseUrl: normalizeBaseUrl(input.settings.baseUrl) };
      const previous = await this.read();
      let encryptedKey = previous?.encryptedKey ?? null;
      if (encryptedKey && previous?.settings.baseUrl !== settings.baseUrl && !input.apiKey && !input.clearKey) {
        throw new Error('更换 API 地址时，请重新输入 Key 或删除已保存的 Key，避免向新服务误发凭据。');
      }
      if (input.clearKey) encryptedKey = null;
      if (input.apiKey) {
        if (!this.codec.isEncryptionAvailable()) throw new Error('系统安全存储不可用，未保存 Key；不会回退到明文。');
        try { encryptedKey = this.codec.encryptString(input.apiKey).toString('base64'); }
        catch { throw new Error('系统密钥加密失败，原配置未修改。'); }
      }
      const stored: Stored = { version: 1, settings, encryptedKey };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(stored, null, 2), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.filePath);
      } catch { throw new Error('保存 AI 配置失败，请检查目录权限或磁盘空间。'); }
      finally { await rm(temporary, { force: true }); }
      return this.view(stored);
    } finally { this.writing = false; }
  }

  async getCredentials(): Promise<{ settings: AISettings; apiKey: string }> {
    const stored = await this.read();
    if (!stored?.encryptedKey) throw new Error('请先在模型设置中保存 API 地址、模型和 Key。');
    if (!this.codec.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法解密 Key。');
    let apiKey: string;
    try { apiKey = this.codec.decryptString(Buffer.from(stored.encryptedKey, 'base64')); }
    catch { throw new Error('无法解密已保存的 Key，请在模型设置中重新输入。'); }
    if (!apiKey || /\s/u.test(apiKey)) throw new Error('已保存的 Key 无效，请重新输入。');
    return { settings: stored.settings, apiKey };
  }
}
