# 接入指南

## SillyTavern

### 方式 A：OpenAI Compatible 提供商

1. 打开 **扩展设置 → TTS**
2. 启用 TTS，Provider 选 **OpenAI Compatible**
3. 填：
   - Base URL：`http://127.0.0.1:9881/v1`
   - API Key：随便填（网关不校验）
   - Model：`tts-1`
4. Voice 填你的声线 id（配置里 `voices[].id`），或留空用默认

> 这条路的好处：走 ST 服务端中转，不受浏览器跨域限制。

### 方式 B：GPT-SoVITS-Adapter 提供商

1. Provider 选 **GPT-SoVITS-Adapter**
2. Base URL：`http://127.0.0.1:9881`
3. 点「获取声音列表」，应该能看到配置里的所有声线

> ST 的 `getVoice()` 依赖接口返回的 `name` 和 `voice_id` **两个字段**，缺一个整条 TTS 会报错。本网关两个都返回（值相同）。

## OpenAI 兼容客户端

任何支持自定义 base_url 的客户端都能接：

```bash
# curl
curl -X POST http://127.0.0.1:9881/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"你好","voice":"default","response_format":"mp3"}' \
  --output out.mp3
```

```python
# openai sdk
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:9881/v1", api_key="x")
client.audio.speech.create(model="tts-1", voice="default", input="你好").stream_to_file("out.mp3")
```

```javascript
// 浏览器 / Node
const res = await fetch('http://127.0.0.1:9881/v1/audio/speech', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: '你好', voice: 'default', response_format: 'mp3' }),
});
const blob = await res.blob();
```

## 自建前端（CORS）

网关对 `OPTIONS` 预检直接返回 204，并带 `Access-Control-Allow-Origin: *`，
所以浏览器里可以直接 `fetch`，不需要额外的反向代理。

## 多声线

配置里放多个 voice，请求时指定：

```json
{
  "voices": [
    { "id": "narrator", "refAudio": "narrator.wav", "promptText": "旁白参考文本" },
    { "id": "heroine", "refAudio": "heroine.wav", "promptText": "女主参考文本",
      "gpt": "D:/models/heroine-gpt.ckpt", "sovits": "D:/models/heroine-sovits.pth" }
  ],
  "defaultVoice": "narrator"
}
```

- 只开 `refAudio`：换参考音频就能换音色（同一套权重）
- 同时给 `gpt` / `sovits`：切换声线时会调 `set_gpt_weights` / `set_sovits_weights` 换模型（更干净，但每次切换有加载开销）

请求时：

```bash
curl ... -d '{"input":"...","voice":"heroine"}'
```

## 排错

| 现象 | 检查 |
| --- | --- |
| `/health` 里 `upstreamUp: false` | GPT-SoVITS 的 api_v2 起了吗？`apiBase` 对吗？ |
| 回的是 wav 不是 mp3 | ffmpeg 没找到。设 `SOVITS_FFMPEG_PATH` 或装 ffmpeg |
| 声音像"机器人"或音色不像 | `promptText` 和参考音频对不上——必须逐字一致 |
| 中文读成日语音 | 把 `textLang` 写死成 `zh`（自动判定的兜底是中文，但如果你给了 `ja` 就会用日语） |
| 长句被截断 | 网关会自检一次并重试；仍失败就把文本按标点拆短再请求 |
