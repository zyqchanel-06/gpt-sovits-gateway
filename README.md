# gpt-sovits-gateway

**把 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 包装成标准 TTS 服务。**

一行命令起一个网关，让 GPT-SoVITS 能被 **OpenAI 兼容客户端**、**SillyTavern**、以及任何走 HTTP 的 TTS 前端直接调用。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/zyqchanel-06/gpt-sovits-gateway?color=blue)](https://github.com/zyqchanel-06/gpt-sovits-gateway/releases)
[![Node](https://img.shields.io/badge/node-18%2B-brightgreen.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-zero-brightgreen.svg)](#)

![OpenAI 兼容接口调用与 /health 统计](docs/screenshots/api-call.svg)

---

> **想从零跑通整套流程？看 [保姆级教程](https://github.com/zyqchanel-06/gpt-sovits-trainer/blob/main/docs/tutorial.md)**
> 装环境 → 准备素材 → 训练音色 → 起服务 → 接进你的 AI，附常见报错排查。

## 为什么需要这一层

GPT-SoVITS 自带的 `api_v2` 服务有三个硬伤，导致标准 TTS 客户端接不上：

| 问题 | 现象 | 本网关怎么解决 |
| --- | --- | --- |
| 接口不是标准协议 | 只有 `GET /tts?text=...`，参数全在 query string | 提供 `POST /v1/audio/speech`（OpenAI 协议）和 `POST /`（SillyTavern Adapter 协议） |
| 没有 CORS 头 | 浏览器直连被拦，网页 TTS 前端用不了 | 统一放开 CORS + 处理 OPTIONS 预检 |
| 只回 wav 原始字节 | 前端只认 `audio/mpeg` 时会报 "invalid data format" | 用 ffmpeg 转 mp3，失败自动降级回 wav |

也就是说：**GPT-SoVITS 负责「像谁说」，本网关负责「怎么被调用」。**

## 和社区其他方案的区别

GPT-SoVITS 生态里有几个解决同类问题的项目，做法不同，适合的场景也不同：

| 方案 | 思路 | 适合谁 |
| --- | --- | --- |
| [jianchang512/gptsovits-api](https://github.com/jianchang512/gptsovits-api) | 提供改好的 `api2.py`，**替换**你 GPT-SoVITS 目录里的官方 `api.py` | 只想修好官方接口、不介意改上游文件 |
| [ben0oil1/GPT-SoVITS-Server](https://github.com/ben0oil1/GPT-SoVITS-Server) | 从主项目**提取**出极简推理服务（仅中文） | 想在低配/无 GPU 机器上只跑推理 |
| **本项目** | **独立网关**，不碰上游任何文件，把上游包装成标准协议 | 想把 GPT-SoVITS 接进现成客户端（OpenAI 兼容 / SillyTavern 等） |

三个关键差异：

1. **不改上游**：本网关是独立进程，上游怎么升级都不影响它；那两类方案需要你把文件放进 GPT-SoVITS 目录，升级时要重新处理
2. **协议标准化**：OpenAI 兼容意味着 ChatGPT 生态里的 TTS 客户端、朗读插件、语音助手都能直接连——这是「改好的 api.py」做不到的
3. **保留多语言**：不失聪日语/英语（上游支持什么，这里就支持什么）

> 说句公道话：如果你只是想在本机把官方接口修得好用一点，`gptsovits-api` 更轻；
> 如果你要在手机或纯 CPU 服务器上跑推理，`GPT-SoVITS-Server` 更合适。
> 本项目的定位是**接入层**——只解决「怎么被调用」，不解决「跑在哪」。

---
## 特性

- **两种协议同时支持** —— OpenAI 兼容 + GPT-SoVITS-Adapter 兼容，一套配置两种用法
- **多声线** —— 配多个参考音频，请求里用 `voice` / `target_voice` 切换，必要时自动调 `set_*_weights` 换模型
- **串行合成** —— 一次只跑一个请求，避免多个请求同时抢 GPU 把显存打爆
- **截断自检** —— 用「音频时长 vs 文本长度」估个下限，短了就自动重合成一次
- **零运行时依赖** —— 只用 Node 内置模块，不需要 express / axios

## 安装

```bash
npm install -g gpt-sovits-gateway
# 或者不装，直接用 npx
npx gpt-sovits-gateway serve --config config.json
```

前置条件：

1. **GPT-SoVITS 的 api_v2 在跑**（默认 `http://127.0.0.1:9880`）
2. **Node.js 18+**（用到内置 `fetch`）
3. **ffmpeg**（可选；没有就只输出 wav）

## 快速开始

```bash
cp config.example.json config.json
# 编辑 config.json：把 voices[0].refAudio / promptText 换成你自己的参考音频和对应文本

sovits-gateway serve --config config.json
```

```
[INFO] ffmpeg 可用: ffmpeg
[INFO] 网关已启动 http://127.0.0.1:9881 -> http://127.0.0.1:9880
[INFO] 声线: default | 默认: default
[INFO] 端点: POST /v1/audio/speech · POST / · GET /speakers · GET /health
```

试一下：

```bash
curl -X POST http://127.0.0.1:9881/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"你好，这是一段测试语音","response_format":"mp3"}' \
  --output hello.mp3
```

### 不想起服务？直接合成一段

```bash
sovits-gateway say --config config.json --text "你好" --out hello.mp3
```

## 端点

| 方法 | 路径 | 协议 | 说明 |
| --- | --- | --- | --- |
| POST | `/v1/audio/speech` | OpenAI | `{input, voice, response_format, speed}` |
| POST | `/` | GPT-SoVITS-Adapter | `{text, target_voice, text_lang, media_type, speed_factor}` |
| POST | `/tts` | 同 Adapter | 别名 |
| GET | `/speakers` | Adapter | 音色表，每项含 `name` + `voice_id` |
| GET | `/health` 或 `/` | — | 健康检查（含上游连通性、配置摘要、统计） |
| GET | `/log` | — | 最近 200 条日志 |

两种协议的参数名差异（网关都吃，给哪个都行）：

| 语义 | OpenAI 字段 | Adapter 字段 |
| --- | --- | --- |
| 文本 | `input` | `text` |
| 声线 | `voice` | `target_voice` |
| 格式 | `response_format` | `media_type` |
| 语速 | `speed` | `speed_factor` |
| 语言 | — | `text_lang` |

## 配置

`config.json`（完整示例见 [config.example.json](config.example.json)）：

```json
{
  "host": "127.0.0.1",
  "port": 9881,
  "apiBase": "http://127.0.0.1:9880",
  "maxChars": 500,
  "textLang": "auto",
  "ffmpegPath": null,
  "defaultVoice": "default",
  "voices": [
    {
      "id": "default",
      "name": "Default",
      "lang": "zh",
      "refAudio": "D:/voices/ref/default.wav",
      "promptText": "参考音频里说的那句话，必须逐字一致",
      "promptLang": "zh",
      "gpt": "",
      "sovits": ""
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `apiBase` | GPT-SoVITS api_v2 地址 |
| `maxChars` | 单次文本上限，超出截断（默认 500） |
| `textLang` | `auto` 时按假名判断日/中，也可写死 `zh`/`ja`/`en` |
| `voices[].refAudio` | 参考音频路径 |
| `voices[].promptText` | **参考音频对应的文本**，必须与音频逐字一致，否则音色会跑偏 |
| `voices[].gpt` / `sovits` | 可选：多模型权重路径，切换声线时调 `set_gpt_weights` / `set_sovits_weights` |

### 环境变量（优先级高于配置文件）

| 变量 | 作用 |
| --- | --- |
| `SOVITS_API_BASE` | 上游地址 |
| `SOVITS_GATEWAY_PORT` | 网关端口 |
| `SOVITS_GATEWAY_HOST` | 监听地址 |
| `SOVITS_MAX_CHARS` | 文本上限 |
| `SOVITS_TEXT_LANG` | 语言 |
| `SOVITS_FFMPEG_PATH` | 指定 ffmpeg |
| `SOVITS_DEFAULT_VOICE` | 默认声线 |
| `SOVITS_LOG_FILE` | 日志落盘路径 |

## 接入

### SillyTavern

见 [docs/integrations.md](docs/integrations.md#sillytavern)。两条路：

- **OpenAI Compatible**：TTS 提供商选 OpenAI，Base URL 填 `http://127.0.0.1:9881/v1`
- **GPT-SoVITS-Adapter**：Base URL 填 `http://127.0.0.1:9881`

### 任何 OpenAI 兼容客户端

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:9881/v1", api_key="not-needed")
speech = client.audio.speech.create(
    model="tts-1", voice="default", input="你好世界", response_format="mp3",
)
speech.stream_to_file("out.mp3")
```

> `api_key` 随便填，网关不校验——它是本机服务，别暴露到公网。

### 直接当库用

```javascript
import { createSovits } from 'gpt-sovits-gateway/src/sovits.mjs';

const sovits = createSovits({ apiBase: 'http://127.0.0.1:9880' });
const { wav, seconds } = await sovits.synthesize('你好', {
  voice: { refAudio: 'ref.wav', promptText: '参考文本', promptLang: 'zh' },
});
```

## 安全提醒

- 默认只监听 `127.0.0.1`。改成 `0.0.0.0` 前请确认你的网络环境（网关**没有任何鉴权**）
- CORS 是全开的（`*`），因为它的典型用法是本机网页前端直连

## 测试

```bash
npm test
```

13 个用例，全部用假上游跑，**不需要真的 GPT-SoVITS 和显卡**。

## Roadmap

**已完成**
- OpenAI 兼容 `POST /v1/audio/speech` + Adapter 协议 `POST /`
- CORS 与 OPTIONS 预检
- mp3 输出（编码器三级回退）
- 多声线切换、串行合成防 OOM、截断自检重试

**计划中**
- 流式输出（边合成边返回，降低首字延迟）
- 更多客户端接入示例（Open WebUI、SillyTavern、各类朗读插件）

**暂不考虑**
- 内置训练功能（用 [gpt-sovits-trainer](https://github.com/zyqchanel-06/gpt-sovits-trainer)）
- 云端部署方案（本项目定位是本机内网服务）

---

## 参与与反馈

测试使用假上游，**不需要真的 GPT-SoVITS 在跑**：

```bash
npm test
```

新增端点请同时补：协议文档（README 的「端点」一节）、测试用例、以及一个真实调用示例。

---

## License

MIT —— 见 [LICENSE](LICENSE)。