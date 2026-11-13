import type { Scene } from '../../shared/project';
import { loadPcmWave } from './wav';

/** 检查与渲染共用；始终重新读取文件，不缓存跨任务结果。 */
export async function sceneWave(scene: Scene, index: number) {
  if (!scene.speech) return null;
  if (scene.speech.text !== scene.text.trim()) throw new Error(`分镜 ${index + 1} 的配音文字已过期，请重新生成或移除配音。`);
  let wave: Awaited<ReturnType<typeof loadPcmWave>>;
  try { wave = await loadPcmWave(scene.speech.path); }
  catch { throw new Error(`分镜 ${index + 1} 的配音缺失或不是支持的 PCM16 WAV，请重新生成或移除。`); }
  if (Math.abs(wave.duration - scene.speech.duration) > 1e-6) throw new Error(`分镜 ${index + 1} 的配音文件时长已改变，请重新生成或移除。`);
  if (Math.round(scene.duration * 30) / 30 + 1e-8 < wave.duration) throw new Error(`分镜 ${index + 1} 时长短于实际配音，请恢复配音时长或延长镜头，避免截断。`);
  return wave;
}
