#!/usr/bin/env node
// cli.mjs —— 两个命令：serve（起网关）和 say（不经过 HTTP，直接合成一段语音文件）。
//
//   sovits-gateway serve --config config.json
//   sovits-gateway say --config config.json --text "你好" --out hello.mp3
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, describeConfig } from './config.mjs';
import { createMp3Converter, checkFfmpeg, findFfmpeg } from './ffmpeg.mjs';
import { createSovits } from './sovits.mjs';
import { createServer } from './server.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function makeLogger(logFile) {
  const write = (line) => {
    // eslint-disable-next-line no-console
    console.log(line);
    if (!logFile) return;
    try {
      const dir = path.dirname(logFile);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(logFile, line + os.EOL);
    } catch {
      /* ignore */
    }
  };
  return (level, msg) => write('[' + new Date().toISOString() + '] ' + level + ' ' + msg);
}

async function cmdServe(args) {
  const config = loadConfig({ path: args.config ?? null });
  if (args.port) config.port = Number(args.port);
  if (args.host) config.host = String(args.host);
  if (args['api-base']) config.apiBase = String(args['api-base']);

  const log = makeLogger(config.logFile);
  const { server, prepare, pushLog } = createServer(config, { log });
  await prepare();

  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      const summary = describeConfig(config);
      pushLog('[' + new Date().toISOString() + '] INFO 网关已启动 http://' +
        config.host + ':' + config.port + ' -> ' + config.apiBase);
      log('INFO', '网关已启动 http://' + config.host + ':' + config.port + ' -> ' + config.apiBase);
      log('INFO', '声线: ' + summary.voices.map((v) => v.id).join(', ') + ' | 默认: ' + summary.defaultVoice);
      log('INFO', '端点: POST /v1/audio/speech · POST / · GET /speakers · GET /health');
    });
    server.on('error', (err) => {
      log('ERROR', '监听失败: ' + (err?.message ?? err));
      resolve(1);
    });
  });
}

async function cmdSay(args) {
  const config = loadConfig({ path: args.config ?? null });
  if (args['api-base']) config.apiBase = String(args['api-base']);
  const text = args.text ?? (args._[0] || '');
  if (!text) throw new Error('缺少 --text');

  const log = makeLogger(null);
  const sovits = createSovits({
    apiBase: config.apiBase,
    timeoutMs: config.timeoutMs,
    textLang: config.textLang,
    log,
  });
  const voiceId = args.voice ?? config.defaultVoice;
  const voice = config.voices.find((v) => v.id === voiceId) ?? config.voices[0];

  await sovits.switchVoice(voice);
  const { wav, seconds } = await sovits.synthesize(text, {
    speed: Number(args.speed ?? 1),
    voice,
  });

  const wantMp3 = !String(args.format ?? '').toLowerCase().startsWith('wav');
  let out = wav;
  let ext = '.wav';
  if (wantMp3) {
    const ffmpegPath = findFfmpeg(config.ffmpegPath);
    if (await checkFfmpeg(ffmpegPath)) {
      const converted = await createMp3Converter(ffmpegPath, log)(wav);
      if (converted) {
        out = converted;
        ext = '.mp3';
      }
    }
  }

  const outPath = args.out ?? path.join(process.cwd(), 'tts-' + Date.now() + ext);
  fs.writeFileSync(outPath, out);
  log('INFO', '已保存 ' + outPath + ' (' + (out.length / 1024).toFixed(1) + 'KB, ' + seconds.toFixed(2) + 's)');
  console.log(outPath);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'serve';

  if (command === 'help' || args.help) {
    console.log([
      'gpt-sovits-gateway —— 把 GPT-SoVITS 包装成 OpenAI / Adapter 兼容的 TTS 服务',
      '',
      '用法：',
      '  sovits-gateway serve [--config config.json] [--port 9881]',
      '  sovits-gateway say   [--config config.json] --text "你好" [--out a.mp3] [--voice id] [--speed 1] [--format wav]',
      '',
      '环境变量（优先级高于配置文件）：',
      '  SOVITS_API_BASE       上游 GPT-SoVITS 地址，默认 http://127.0.0.1:9880',
      '  SOVITS_GATEWAY_PORT   本网关端口，默认 9881',
      '  SOVITS_MAX_CHARS      单次文本上限，默认 500',
      '  SOVITS_TEXT_LANG      auto / zh / ja / en ...',
      '  SOVITS_FFMPEG_PATH    指定 ffmpeg（不指定就找 PATH）',
      '  SOVITS_DEFAULT_VOICE  默认声线 id',
    ].join(os.EOL));
    return 0;
  }

  if (command === 'say') return cmdSay(args);
  if (command === 'serve') return cmdServe(args);
  console.error('未知命令: ' + command + '（可用：serve / say / help）');
  return 2;
}

main().then((code) => {
  if (typeof code === 'number' && code !== 0) process.exit(code);
}).catch((err) => {
  console.error('启动失败:', err?.message ?? err);
  process.exit(1);
});
