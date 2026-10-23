// gateway.test.mjs —— 用假上游测网关行为，不需要真的 GPT-SoVITS。
//
// 覆盖：健康检查、音色表、两种协议的合成端点、参数兜底、跨域头、截断自检。
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { pickTextLang } from '../src/lang.mjs';
import { looksTruncated, minExpectedSeconds, wavSeconds } from '../src/wav.mjs';
import { loadConfig, normalizeVoice } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

/** 造一段合法 PCM wav。 */
function makeWav(seconds = 2, sampleRate = 16000) {
  const channels = 1;
  const bits = 16;
  const byteRate = (sampleRate * channels * bits) / 8;
  const dataSize = Math.floor(byteRate * seconds);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE((channels * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/** 起一个假 GPT-SoVITS，记录收到的 query。 */
function startFakeUpstream({ wav, delayMs = 0 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200);
      return res.end('ok');
    }
    calls.push(Object.fromEntries(url.searchParams));
    const respond = () => {
      const body = wav ?? makeWav(2);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': body.length });
      res.end(body);
    };
    if (delayMs) setTimeout(respond, delayMs);
    else respond();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        calls,
        // keep-alive 连接会让 close() 一直等待，必须先把连接掐掉
        close: () => new Promise((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
      });
    });
  });
}

function baseConfig(upstreamPort) {
  return {
    host: '127.0.0.1',
    port: 0,
    apiBase: 'http://127.0.0.1:' + upstreamPort,
    timeoutMs: 30000,
    maxChars: 500,
    textLang: 'auto',
    ffmpegPath: null,
    logFile: null,
    defaultVoice: 'alice',
    voices: [
      {
        id: 'alice', name: 'Alice', lang: 'zh',
        refAudio: '/voices/alice.wav', promptText: '参考文本', promptLang: 'zh',
        gpt: '', sovits: '',
      },
      {
        id: 'bob', name: 'Bob', lang: 'zh',
        refAudio: '/voices/bob.wav', promptText: '参考文本二', promptLang: 'zh',
        gpt: '', sovits: '',
      },
    ],
  };
}

async function startGateway(config) {
  const { server } = createServer(config, { log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    port,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}


test('wavSeconds 读得出标准 wav 时长', () => {
  assert.equal(Math.round(wavSeconds(makeWav(3))), 3);
  assert.equal(wavSeconds(Buffer.alloc(10)), 0);
});

test('minExpectedSeconds 随字数增长，有下限', () => {
  assert.equal(minExpectedSeconds(''), 0.5);
  assert.ok(minExpectedSeconds('这是一句比较长的中文测试文本') > 0.5);
});

test('looksTruncated 能发现明显被掐断的音频', () => {
  const short = makeWav(0.3);
  assert.equal(looksTruncated(short, '这是一段很长很长很长的文本，应该有五六秒'), true);
  assert.equal(looksTruncated(makeWav(8), '短句'), false);
});

test('pickTextLang：有假名走日语，否则中文', () => {
  assert.equal(pickTextLang('こんにちは'), 'ja');
  assert.equal(pickTextLang('你好世界'), 'zh');
  assert.equal(pickTextLang('hello', 'en'), 'en');
  assert.equal(pickTextLang('hello', 'auto'), 'zh');
});

test('normalizeVoice 拒绝缺字段的声线', () => {
  assert.throws(() => normalizeVoice({ id: 'x' }, 0), /refAudio/);
  assert.throws(() => normalizeVoice({ id: 'x', refAudio: 'a.wav' }, 0), /promptText/);
  assert.throws(() => normalizeVoice({ refAudio: 'a.wav', promptText: 't' }, 0), /缺少 id/);
  const voice = normalizeVoice({ id: 'x', refAudio: 'a.wav', promptText: 't' }, 0);
  assert.equal(voice.id, 'x');
  assert.equal(voice.lang, 'zh');
});


test('GET /health 报告上游状态', async () => {
  const upstream = await startFakeUpstream();
  const gw = await startGateway(baseConfig(upstream.port));
  try {
    const res = await fetch('http://127.0.0.1:' + gw.port + '/health');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.service, 'gpt-sovits-gateway');
    assert.equal(body.upstreamUp, true);
    assert.equal(body.config.defaultVoice, 'alice');
  } finally {
    await gw.close();
    await upstream.close();
  }
});

test('GET /speakers 返回 Adapter 需要的 name + voice_id', async () => {
  const upstream = await startFakeUpstream();
  const gw = await startGateway(baseConfig(upstream.port));
  try {
    const res = await fetch('http://127.0.0.1:' + gw.port + '/speakers');
    const list = await res.json();
    assert.equal(list.length, 2);
    for (const item of list) {
      assert.ok(item.name);
      assert.equal(item.voice_id, item.name);
      assert.ok(item.lang);
    }
  } finally {
    await gw.close();
    await upstream.close();
  }
});

test('POST /v1/audio/speech 返回音频，并带上正确参数', async () => {
  const upstream = await startFakeUpstream();
  const gw = await startGateway(baseConfig(upstream.port));
  try {
    const res = await fetch('http://127.0.0.1:' + gw.port + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '你好，这是一段测试语音', voice: 'bob', response_format: 'wav' }),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.ok(buf.length > 2000);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].ref_audio_path, '/voices/bob.wav');
    assert.equal(upstream.calls[0].text_lang, 'zh');
  } finally {
    await gw.close();
    await upstream.close();
  }
});

test('Adapter 协议：POST / 用 text 字段也能合成', async () => {
  const upstream = await startFakeUpstream();
  const gw = await startGateway(baseConfig(upstream.port));
  try {
    const res = await fetch('http://127.0.0.1:' + gw.port + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '适配器协议测试', target_voice: 'Alice', media_type: 'wav' }),
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls[0].ref_audio_path, '/voices/alice.wav');
  } finally {
    await gw.close();
    await upstream.close();
  }
});

test('空 input 返回 400', async () => {
  const upstream = await startFakeUpstream();
  const gw = await startGateway(baseConfig(upstream.port));
  try {
    const res = await fetch('http://127.0.0.1:' + gw.port + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '   ' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await gw.close();
    await upstream.close();
  }
});

test('超长文本按 maxChars 截断', async () => {
  const upstream = await startFakeUpstream();
  const config = baseConfig(upstream.port);
  config.maxChars = 10;
  const gw = await startGateway(config);
  try {
    await fetch('http://127.0.0.1:' + gw.port + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '一二三四五六七八九十一二三四五', response_format: 'wav' }),
    });
    assert.equal(upstream.calls[0].text.length, 10);
  } finally {
    await gw.close();
    await upstream.close();
  }
});

test('响应带 CORS 头，OPTIONS 预检返回 204', async () => {
  const upstream = await startFakeUpstream();
  const gw = await startGateway(baseConfig(upstream.port));
  try {
    const preflight = await fetch('http://127.0.0.1:' + gw.port + '/v1/audio/speech', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  } finally {
    await gw.close();
    await upstream.close();
  }
});

test('上游不可用时 /health 报 ok:false', async () => {
  const gw = await startGateway(baseConfig(1)); // 端口 1 必然连不上
  try {
    const res = await fetch('http://127.0.0.1:' + gw.port + '/health');
    const body = await res.json();
    assert.equal(body.upstreamUp, false);
    assert.equal(body.ok, false);
  } finally {
    await gw.close();
  }
});
