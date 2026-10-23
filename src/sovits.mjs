// sovits.mjs —— GPT-SoVITS api_v2 客户端。
//
// 上游接口的真实形态（这是本网关存在的理由）：
//   GET /tts?text=...&text_lang=zh&ref_audio_path=...&prompt_text=...&prompt_lang=zh&...
//   - 参数全在 query string 里
//   - 没有 CORS 头
//   - 只回 wav 原始字节
// 所以浏览器/标准 TTS 客户端都接不上，需要这一层。
import { looksTruncated, minExpectedSeconds, wavSeconds } from './wav.mjs';
import { pickTextLang } from './lang.mjs';

/** 合成参数里那些"调音"默认值。集中放这里，方便以后按声线覆盖。 */
export const SYNTH_DEFAULTS = {
  textSplitMethod: 'cut5',
  batchSize: 1,
  topK: 15,
  topP: 1,
  temperature: 1,
  mediaType: 'wav',
  streaming: false,
};

export function createSovits({ apiBase, timeoutMs = 300000, textLang = 'auto', log = () => {} } = {}) {
  const base = String(apiBase).replace(/\/+$/, '');

  // 一次只跑一个合成：GPU 同时接两个请求会互相拖慢，甚至 OOM。
  let chain = Promise.resolve();
  function enqueue(fn) {
    const run = chain.then(() => fn());
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  let currentVoiceId = null;

  /** 切声线权重（幂等）。给了 gpt/sovits 才切，否则跳过。 */
  async function switchVoice(voice) {
    if (!voice) return;
    if (currentVoiceId === voice.id) return;
    const steps = [];
    if (voice.sovits) steps.push([base + '/set_sovits_weights?weights_path=' + encodeURIComponent(voice.sovits), 'sovits']);
    if (voice.gpt) steps.push([base + '/set_gpt_weights?weights_path=' + encodeURIComponent(voice.gpt), 'gpt']);
    for (const [url, label] of steps) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!res.ok) log('WARN', '切换 ' + label + ' 失败 HTTP ' + res.status);
      } catch (err) {
        log('WARN', '切换 ' + label + ' 异常: ' + (err?.message ?? err));
      }
    }
    currentVoiceId = voice.id;
    log('INFO', '声线已切换 -> ' + voice.id);
  }

  /** 单次合成，失败抛异常。 */
  async function synthesizeOnce(text, { speed = 1, lang = null, voice } = {}) {
    const query = new URLSearchParams({
      text,
      text_lang: pickTextLang(text, lang ?? textLang),
      ref_audio_path: voice.refAudio,
      prompt_text: voice.promptText,
      prompt_lang: voice.promptLang,
      text_split_method: SYNTH_DEFAULTS.textSplitMethod,
      batch_size: String(SYNTH_DEFAULTS.batchSize),
      top_k: String(SYNTH_DEFAULTS.topK),
      top_p: String(SYNTH_DEFAULTS.topP),
      temperature: String(SYNTH_DEFAULTS.temperature),
      speed_factor: String(speed),
      media_type: SYNTH_DEFAULTS.mediaType,
      streaming_mode: String(SYNTH_DEFAULTS.streaming),
    });
    const res = await fetch(base + '/tts?' + query.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('GPT-SoVITS HTTP ' + res.status + ': ' + body.slice(0, 200));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) throw new Error('GPT-SoVITS 返回数据过小（' + buf.length + 'B）');
    return buf;
  }

  /**
   * 合成 + 截断自检。
   *
   * GPT-SoVITS 偶尔会把长句提前掐断，但 HTTP 依然 200。这里用"音频时长 vs 文本长度"
   * 估个下限，短了就重合成一次；还是短就照常返回（至少不会卡住调用方）。
   */
  async function synthesize(text, options = {}) {
    let wav = await synthesizeOnce(text, options);
    let seconds = wavSeconds(wav);
    if (looksTruncated(wav, text)) {
      log('WARN', '疑似截断 ' + seconds.toFixed(2) + 's < 下限 ' + minExpectedSeconds(text).toFixed(2) + 's，重合成一次');
      try {
        const again = await synthesizeOnce(text, options);
        const seconds2 = wavSeconds(again);
        if (seconds2 > seconds) {
          wav = again;
          seconds = seconds2;
          log('INFO', '重合成成功 ' + seconds2.toFixed(2) + 's');
        }
      } catch (err) {
        log('WARN', '重合成失败: ' + (err?.message ?? err));
      }
    }
    return { wav, seconds };
  }

  /** 上游是否活着（/health 用）。 */
  async function alive() {
    try {
      const res = await fetch(base + '/', { signal: AbortSignal.timeout(3000) });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  return { base, synthesize, synthesizeOnce, switchVoice, alive, enqueue };
}
