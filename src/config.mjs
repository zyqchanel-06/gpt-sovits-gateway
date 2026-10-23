// config.mjs —— 配置加载：默认值 < 配置文件 < 环境变量。
//
// 设计取向：不强制用某种格式。给一个 JSON 文件就能跑；
// 容器里更适合用环境变量，两者都支持，且环境变量总是赢。
import fs from 'node:fs';

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 9881,
  // 上游 GPT-SoVITS 的 api_v2 地址
  apiBase: 'http://127.0.0.1:9880',
  timeoutMs: 300000,
  maxChars: 500,
  textLang: 'auto',
  ffmpegPath: null,
  logFile: null,
  // 声线表：至少一项。每项描述"用哪段参考音频、什么提示文本"
  voices: [],
  defaultVoice: null,
};

/** 环境变量 → 配置字段的映射（环境变量优先于文件）。 */
const ENV_MAP = {
  SOVITS_API_BASE: 'apiBase',
  SOVITS_GATEWAY_HOST: 'host',
  SOVITS_GATEWAY_PORT: 'port',
  SOVITS_TIMEOUT_MS: 'timeoutMs',
  SOVITS_MAX_CHARS: 'maxChars',
  SOVITS_TEXT_LANG: 'textLang',
  SOVITS_FFMPEG_PATH: 'ffmpegPath',
  SOVITS_LOG_FILE: 'logFile',
  SOVITS_DEFAULT_VOICE: 'defaultVoice',
};

const NUMERIC_KEYS = new Set(['port', 'timeoutMs', 'maxChars']);

function coerce(key, value) {
  if (NUMERIC_KEYS.has(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

/** 校验声线项；不合法的直接抛错（出错要早，不要等到第一次合成）。 */
export function normalizeVoice(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('voices[' + index + '] 必须是对象');
  }
  const id = String(raw.id ?? raw.name ?? '').trim();
  if (!id) throw new Error('voices[' + index + '] 缺少 id');
  const refAudio = String(raw.refAudio ?? '').trim();
  const promptText = String(raw.promptText ?? '').trim();
  if (!refAudio) throw new Error('voices[' + index + '] 缺少 refAudio（参考音频路径）');
  if (!promptText) throw new Error('voices[' + index + '] 缺少 promptText（参考音频对应的文本）');
  return {
    id,
    name: String(raw.name ?? id),
    lang: String(raw.lang ?? raw.promptLang ?? 'zh'),
    refAudio,
    promptText,
    promptLang: String(raw.promptLang ?? raw.lang ?? 'zh'),
    // 多模型权重：给了就在合成前切换（GPT-SoVITS 的 set_*_weights）
    gpt: raw.gpt ? String(raw.gpt) : '',
    sovits: raw.sovits ? String(raw.sovits) : '',
  };
}

/**
 * 读取配置。
 * @param {object} opts
 * @param {string} [opts.path]  配置文件路径（.json）
 * @param {object} [opts.env]   环境变量对象（默认 process.env）
 */
export function loadConfig({ path = null, env = process.env } = {}) {
  let fromFile = {};
  if (path) {
    if (!fs.existsSync(path)) throw new Error('配置文件不存在: ' + path);
    const text = fs.readFileSync(path, 'utf8');
    try {
      fromFile = JSON.parse(text);
    } catch (err) {
      throw new Error('配置文件不是合法 JSON（' + path + '）: ' + err.message);
    }
  }

  const merged = { ...DEFAULTS, ...fromFile };
  for (const [envKey, field] of Object.entries(ENV_MAP)) {
    const value = env[envKey];
    if (value !== undefined && value !== '') merged[field] = coerce(field, value);
  }

  if (!Array.isArray(merged.voices)) throw new Error('config.voices 必须是数组');
  merged.voices = merged.voices.map((v, i) => normalizeVoice(v, i));
  if (merged.voices.length === 0) {
    throw new Error('config.voices 不能为空：至少给一个声线（refAudio + promptText）');
  }
  if (!merged.defaultVoice) merged.defaultVoice = merged.voices[0].id;

  return merged;
}

/** 脱敏摘要（日志 / /health 用）：不暴露完整路径。 */
export function describeConfig(config) {
  return {
    apiBase: config.apiBase,
    listen: config.host + ':' + config.port,
    maxChars: config.maxChars,
    textLang: config.textLang,
    defaultVoice: config.defaultVoice,
    voices: config.voices.map((v) => ({
      id: v.id,
      name: v.name,
      refAudio: v.refAudio.split(/[\\/]/).pop(), // 只留文件名
      hasWeights: Boolean(v.gpt || v.sovits),
    })),
  };
}
