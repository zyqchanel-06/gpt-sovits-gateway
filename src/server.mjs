// server.mjs —— HTTP 网关：把 GPT-SoVITS 包装成两种标准 TTS 协议。
//
//   POST /v1/audio/speech   OpenAI 兼容协议（任何支持 OpenAI TTS 的客户端都能接）
//   GET  /speakers          GPT-SoVITS-Adapter 取音色表
//   POST /                  同上，合成端点（Adapter 的历史写法）
//   GET  /  |  /health      健康检查（含上游连通性）
//   GET  /log               最近日志（内存环形缓冲）
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';

import { createMp3Converter, checkFfmpeg, findFfmpeg } from './ffmpeg.mjs';
import { createSovits } from './sovits.mjs';
import { describeConfig } from './config.mjs';

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大（上限 ' + limit + ' 字节）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

export function createServer(config, { log = () => {} } = {}) {
  const sovits = createSovits({
    apiBase: config.apiBase,
    timeoutMs: config.timeoutMs,
    textLang: config.textLang,
    log,
  });

  const voiceMap = new Map();
  for (const voice of config.voices) {
    voiceMap.set(voice.id, voice);
    voiceMap.set(voice.id.toLowerCase(), voice);
  }
  const defaultVoice = voiceMap.get(config.defaultVoice) ?? config.voices[0];

  function resolveVoice(label) {
    const want = String(label ?? defaultVoice.id).trim();
    return voiceMap.get(want) ?? voiceMap.get(want.toLowerCase()) ?? defaultVoice;
  }

  // GPT-SoVITS-Adapter 的 getVoice 依赖 name + voice_id 两个字段，缺一个就整条 TTS 报错
  function speakerList() {
    return config.voices.map((voice) => ({
      name: voice.name,
      voice_id: voice.name,
      lang: voice.lang,
    }));
  }

  const stats = { requests: 0, ok: 0, failed: 0, lastMs: 0, lastSeconds: 0, lastChars: 0 };

  async function handleSpeech(req, res) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      return sendJson(res, 400, { error: '非法 JSON: ' + (err?.message ?? err) });
    }

    // 两种协议字段名不同：OpenAI 用 input，Adapter 用 text
    const raw = String(body.input ?? body.text ?? '').replace(/\s+/g, ' ').trim();
    if (!raw) return sendJson(res, 400, { error: 'input / text 为空' });

    const text = raw.length > config.maxChars ? raw.slice(0, config.maxChars) : raw;
    if (raw.length > config.maxChars) {
      log('WARN', '文本 ' + raw.length + ' 字超上限，截到 ' + config.maxChars);
    }

    const speed = Number(body.speed ?? body.speed_factor ?? 1) || 1;
    // OpenAI 用 response_format，Adapter 用 media_type
    const format = String(body.response_format ?? body.media_type ?? '').toLowerCase();
    const wantWav = format === 'wav';
    // Adapter 通常会带 text_lang，优先于配置文件
    const langOverride = String(body.text_lang ?? body.lang ?? '').trim() || null;
    const voice = resolveVoice(body.target_voice ?? body.voice);

    stats.requests += 1;
    const started = Date.now();
    try {
      const { wav, seconds } = await sovits.enqueue(async () => {
        await sovits.switchVoice(voice);
        return sovits.synthesize(text, { speed, lang: langOverride, voice });
      });
      const mp3 = wantWav ? null : await sovits.enqueue(() => toMp3(wav));
      const out = mp3 ?? wav;
      const mime = mp3 ? 'audio/mpeg' : 'audio/wav';

      stats.ok += 1;
      stats.lastMs = Date.now() - started;
      stats.lastSeconds = Number(seconds.toFixed(2));
      stats.lastChars = text.length;
      log('INFO', 'ok ' + (out.length / 1024).toFixed(1) + 'KB ' + seconds.toFixed(2) + 's ' + mime +
        ' voice=' + voice.id + ' ' + (Date.now() - started) + 'ms chars=' + text.length);

      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': out.length,
        'Cache-Control': 'no-store',
      });
      res.end(out);
    } catch (err) {
      stats.failed += 1;
      log('ERROR', '合成失败: ' + (err?.message ?? err));
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));

    // 浏览器直连 GPT-SoVITS 会被 CORS 拦，这里统一放开
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const upstreamUp = await sovits.alive();
      return sendJson(res, 200, {
        service: 'gpt-sovits-gateway',
        ok: upstreamUp,
        upstream: config.apiBase,
        upstreamUp,
        config: describeConfig(config),
        speakers: speakerList().map((v) => v.name),
        ffmpeg: ffmpegPath,
        stats,
      });
    }

    if (req.method === 'GET' && url.pathname === '/speakers') {
      return sendJson(res, 200, speakerList());
    }

    if (req.method === 'GET' && url.pathname === '/log') {
      const body = Buffer.from(recent.join(os.EOL), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
      });
      return res.end(body);
    }

    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/v1/audio/speech' || url.pathname === '/tts')) {
      return handleSpeech(req, res);
    }

    return sendJson(res, 404, {
      error: 'not found',
      routes: ['POST /v1/audio/speech', 'POST /', 'GET /speakers', 'GET /health', 'GET /log'],
    });
  });

  // 日志：内存环形缓冲 + 可选落盘
  const recent = [];
  let ffmpegPath = null;
  let toMp3 = async () => null;

  async function prepare() {
    ffmpegPath = findFfmpeg(config.ffmpegPath);
    if (await checkFfmpeg(ffmpegPath)) {
      toMp3 = createMp3Converter(ffmpegPath, log);
      log('INFO', 'ffmpeg 可用: ' + ffmpegPath);
    } else {
      log('WARN', 'ffmpeg 不可用（只会输出 wav）: ' + ffmpegPath);
      ffmpegPath = null;
    }
  }

  function pushLog(line) {
    recent.push(line);
    if (recent.length > 200) recent.shift();
    if (!config.logFile) return;
    try {
      const dir = config.logFile.replace(/[\\/][^\\/]+$/, '');
      if (dir) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(config.logFile, line + os.EOL);
    } catch {
      /* 落盘失败不影响服务 */
    }
  }

  return { server, prepare, pushLog, speakerList, resolveVoice };
}
