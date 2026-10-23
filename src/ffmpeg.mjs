// ffmpeg.mjs —— 找 ffmpeg、把 wav 转成 mp3。
//
// 为什么要有回退链：不同 ffmpeg 构建带的 mp3 编码器不一样。标准构建有 libmp3lame，
// 某些精简构建（例如剪映随包附带的）只有 Windows 的 mp3_mf。按顺序试，成功就记住。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MP3_ENCODERS = ['libmp3lame', 'mp3_mf', 'mp3'];

/** 依次尝试：环境变量 → 配置 → PATH。 */
export function findFfmpeg(configuredPath = null) {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  if (configuredPath) candidates.push(configuredPath);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 忽略无权限等异常 */
    }
  }
  return 'ffmpeg'; // 交给 PATH
}

export function runFfmpeg(ffmpegPath, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('ffmpeg 超时'));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-400)));
    });
  });
}

export async function checkFfmpeg(ffmpegPath) {
  try {
    await runFfmpeg(ffmpegPath, ['-version'], 15000);
    return true;
  } catch {
    return false;
  }
}

/**
 * 建一个 wav→mp3 转换器。转换失败返回 null，调用方降级成直接回 wav。
 */
export function createMp3Converter(ffmpegPath, log = () => {}) {
  let chosenEncoder = null;
  let seq = 0;

  return async function toMp3(wavBuf) {
    if (!ffmpegPath) return null;
    const base = path.join(os.tmpdir(), 'sovits-gateway-' + process.pid + '-' + Date.now() + '-' + ++seq);
    const inFile = base + '.wav';
    const outFile = base + '.mp3';
    const candidates = chosenEncoder ? [chosenEncoder] : MP3_ENCODERS;
    let lastError = null;

    try {
      fs.writeFileSync(inFile, wavBuf);
      for (const encoder of candidates) {
        try {
          await runFfmpeg(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', inFile, '-codec:a', encoder, '-b:a', '128k', '-ac', '1', outFile,
          ]);
          const buf = fs.readFileSync(outFile);
          if (buf.length < 1000) throw new Error('输出过小 ' + buf.length + 'B');
          if (chosenEncoder !== encoder) {
            chosenEncoder = encoder;
            log('INFO', 'mp3 编码器选定: ' + encoder);
          }
          return buf;
        } catch (err) {
          lastError = err;
          try {
            fs.unlinkSync(outFile);
          } catch {
            /* ignore */
          }
        }
      }
      log('WARN', 'mp3 转码失败，降级返回 wav: ' + (lastError?.message ?? lastError));
      return null;
    } finally {
      for (const file of [inFile, outFile]) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
      }
    }
  };
}
