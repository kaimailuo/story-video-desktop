import { useEffect, useRef, useState } from 'react';
import { defaultAISettings, type AISettings, type AISettingsView } from '../shared/ai';

interface Props {
  kind?: 'text' | 'image' | 'speech';
  onClose(): void;
  onSaved(): void;
  onBusyChange(busy: boolean): void;
}

export default function ModelSettings({ kind = 'text', onClose, onSaved, onBusyChange }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requestId = useRef<string | null>(null);
  const [view, setView] = useState<AISettingsView | null>(null);
  const [settings, setSettings] = useState<AISettings>({ ...defaultAISettings });
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [testMessage, setTestMessage] = useState('');
  const changed = !view || JSON.stringify(settings) !== JSON.stringify(view.settings) || Boolean(apiKey) || clearKey;

  useEffect(() => {
    dialog.current?.showModal();
    let disposed = false;
    void (async () => {
      try {
        if (!window.desktop?.getAISettings) throw new Error('模型设置需要新版桌面接口；请保存项目后关闭旧客户端，重新运行 npm run dev。');
        if (kind === 'image' && !window.desktop.getImageSettings) throw new Error('图片模型设置需要重启新版客户端。');
        if (kind === 'speech' && !window.desktop.getSpeechSettings) throw new Error('配音模型设置需要重启新版客户端。');
        const saved = await (kind === 'speech' ? window.desktop.getSpeechSettings() : kind === 'image' ? window.desktop.getImageSettings() : window.desktop.getAISettings());
        if (!disposed) { setView(saved); setSettings(saved.settings); }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : '读取设置失败。');
      } finally { if (!disposed) setLoading(false); }
    })();
    return () => {
      disposed = true;
      if (requestId.current) void window.desktop?.cancelAI(requestId.current);
    };
  }, [kind]);

  async function save() {
    if (!window.desktop) return;
    setWorking(true); setError(''); setTestMessage('');
    try {
      const input = { settings, apiKey: apiKey || undefined, clearKey };
      const saved = await (kind === 'speech' ? window.desktop.saveSpeechSettings(input) : kind === 'image' ? window.desktop.saveImageSettings(input) : window.desktop.saveAISettings(input));
      setView(saved); setSettings(saved.settings); setApiKey(''); setClearKey(false);
      setTestMessage('配置已保存。Key 不会回显，也不会写入视频项目文件。');
      onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。'); }
    finally { setWorking(false); }
  }

  async function testConnection() {
    if (!window.desktop || !view) return;
    if (!window.confirm(`将向 ${view.settings.baseUrl} 发送 1 次极短测试请求，模型为 ${view.settings.model}。可能产生费用，是否继续？`)) return;
    const id = crypto.randomUUID();
    requestId.current = id;
    setWorking(true); onBusyChange(true); setError(''); setTestMessage('正在测试连接……');
    try {
      const outcome = await window.desktop.runAI({ id, kind: 'test' });
      if (outcome.ok && outcome.result.kind === 'test') setTestMessage(outcome.result.message);
      else if (!outcome.ok && outcome.error.code === 'cancelled') setTestMessage(outcome.error.message);
      else if (!outcome.ok) { setTestMessage(''); setError(outcome.error.message); }
    } catch { setError('连接测试失败，请检查客户端状态。'); setTestMessage(''); }
    finally { requestId.current = null; setWorking(false); onBusyChange(false); }
  }

  return <dialog ref={dialog} className="model-dialog" aria-labelledby="model-settings-title" onCancel={(event) => { event.preventDefault(); if (!working) onClose(); }}>
    <div className="panel-heading"><h2 id="model-settings-title">{kind === 'speech' ? '配音模型设置' : kind === 'image' ? '图片模型设置' : '文本模型设置'}</h2><button className="dialog-close" aria-label="关闭模型设置" disabled={working} onClick={onClose}>×</button></div>
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p className="model-description">{kind === 'speech' ? 'OpenAI 兼容 /audio/speech 接口，配置与文本／图片独立。需返回完整 PCM16 WAV，单镜最长 60 秒；暂不支持 MP3、未知长度流式 WAV 或异步协议。音色和语速在配音面板设置，保存不联网，主动生成可能计费。' : kind === 'image' ? 'OpenAI 兼容 /images/generations 接口，独立于文本模型。需支持 n=1 和 response_format=b64_json；也接受同源图片 URL，暂不下载跨域 CDN。保存不联网，请在生图面板主动生成一张图片验证，可能计费。' : 'OpenAI 兼容聊天接口。仅在你主动点击测试或生成后发送请求，不自动获取模型列表。'}</p>
      <fieldset disabled={working || loading}>
        <label>API 基础地址<input aria-label="API 基础地址" type="url" required maxLength={2048} placeholder="https://api.example.com/v1" value={settings.baseUrl} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} /></label>
        <p className="field-help">填写基础地址，不含具体接口路径、Key 或查询参数。公网地址必须使用 HTTPS。</p>
        <div className="form-row"><label>模型名称<input aria-label="模型名称" required maxLength={200} placeholder="填写服务商提供的模型标识" value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} /></label><label>超时（秒）<input aria-label="AI 超时秒数" type="number" min={5} max={180} required value={settings.timeoutSeconds} onChange={(event) => setSettings({ ...settings, timeoutSeconds: event.target.valueAsNumber })} /></label></div>
        <label>API Key<input aria-label="API Key" type="password" autoComplete="new-password" maxLength={8192} disabled={clearKey || view?.encryptionAvailable === false} placeholder={view?.hasKey ? '已保存，不回显；留空表示保持不变' : '仅在本机输入，不会写入项目 JSON'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
        <p className="field-help">macOS 使用 Electron safeStorage 加密，密钥由系统钥匙串保护；配置文件只保存密文。更换 API 地址时需重新输入或删除 Key。</p>
        <label className="ai-clear-key"><input type="checkbox" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); if (event.target.checked) setApiKey(''); }} />删除已保存的 Key</label>
      </fieldset>
      <div className={`key-storage-status ${view?.encryptionAvailable === false ? 'unavailable' : ''}`}>
        {loading ? '读取配置中……' : view?.encryptionAvailable ? `系统安全加密可用 · ${view.hasKey ? 'Key 已保存（不回显）' : '尚未保存 Key'}` : '系统安全存储不可用；禁止保存或解密 Key，不回退到明文。'}
      </div>
      <p className="model-description">测试和生成均可能计费。只向此地址发送当前操作所需的文字，不发送项目图片／音频；不自动重试或跟随重定向。取消不保证服务端停止计费。</p>
      {error && <div className="ai-error" role="alert">{error}</div>}
      {testMessage && <p className="ai-status" role="status">{testMessage}</p>}
      <div className="model-dialog-actions">{kind === 'text' && <button type="button" className="button" disabled={working || changed || !view?.hasKey || !view.encryptionAvailable} onClick={() => void testConnection()}>测试已保存配置</button>}{working && requestId.current && <button type="button" className="button" onClick={() => void window.desktop?.cancelAI(requestId.current!)}>取消连接测试</button>}<button type="submit" className="button primary" disabled={working || loading}>{working ? '处理中……' : '保存模型设置'}</button></div>
    </form>
  </dialog>;
}
