# GPT-SoVITS 官方 api 接不上标准客户端？三个坑和三种解法

音色训好了，想接进一个现成的语音客户端当朗读后端。结果一晚上没接上。

记录下来，省得别人再踩。

---

## 先说我想要什么

我用的那个客户端有语音朗读功能，走的是 TTS 扩展。它支持连几种后端，其中一种是 OpenAI 兼容的语音接口。

想法很简单：本地跑着 GPT-SoVITS，模型是我自己训的游戏角色音色，让客户端直接调它。

听起来像是把两个现成的东西接起来。实际上卡在了协议这一层。

---

## 坑一：官方接口不是「标准接口」

GPT-SoVITS 自带 `api_v2.py`，启动后监听 9880。它的接口长这样：

```text
GET /tts?text=你好&text_lang=zh&ref_audio_path=...&prompt_text=...&prompt_lang=zh
```

能用，但它是**非标准**的：

- 所有参数塞在 query string 里，文本长了会撞 URL 长度限制
- 没有请求体，客户端没法传结构化 JSON

而现代 TTS 客户端普遍期望的是：

```http
POST /v1/audio/speech
Content-Type: application/json

{"input": "你好", "voice": "nahida", "response_format": "mp3"}
```

一边是 GET + query，一边是 POST + JSON。协议对不上，客户端扫描服务时根本发现不了它。

## 坑二：没有 CORS 头

如果你用的是网页版前端，会看到这样的报错：

```text
Access to fetch at 'http://127.0.0.1:9880/tts' from origin 'http://localhost:8000'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present.
```

`api_v2` 是给本机脚本调的，没考虑浏览器直连，一个 CORS 头都没返回。

## 坑三：只回 wav 原始字节

这个坑最隐蔽。请求发出去了，也返回 200，但前端报：

```text
invalid data format
```

原因：`api_v2` 默认返回 wav 的原始字节流，而很多前端只认 `audio/mpeg`（mp3）。返回头里的 `Content-Type` 也对不上。

我遇到的问题就是这三条同时卡住。GPT-SoVITS 本身跑得好好的，标准客户端还是连不上。

---

## 三种解法，适合不同的人

我在 GitHub 上把相关项目翻了一遍，加上自己试的，大致是三条路。

### 1. 改官方接口（替换文件）

有个项目提供了一个改好的 `api2.py`，你把它复制进 GPT-SoVITS 目录，替换掉官方的 `api.py`，启动方式不变。

改动很小，启动命令只差一个文件名。麻烦的地方在后面：要动上游目录的文件，升级 GPT-SoVITS 时要重新处理；它修的主要是「官方接口的易用性」（中英混合、标点切分），协议还是原来那套 GET + query，OpenAI 客户端依然连不上。

### 2. 提取一个极简推理服务

另一个思路是把推理那部分从主项目里抽出来，不装完整环境也能跑，有人甚至在手机上跑起来了。

确实轻，适合低配机器或者只想跑推理的场景。代价是砍了东西：为了轻量删掉了日语和英语（纯中文），还要手工改配置里的模型路径。

### 3. 加一层独立的网关（我选的路）

不动上游任何文件，另起一个进程做协议转换：

```text
TTS 客户端 ──POST /v1/audio/speech──> 网关 ──GET /tts?text=...──> api_v2
                                        (9881)                    (9880)
```

网关负责三件事：把标准协议的请求翻译成 `api_v2` 认识的 query、补上 CORS 头、把 wav 转成 mp3。

好处有三个：不碰上游，GPT-SoVITS 怎么升级都不影响；对外是标准协议，各类客户端都能直接连；上游支持的语言这里都支持（不用为了轻量牺牲日英）。

代价是多一个进程要管。

---

## 具体怎么做

我用的是第三条路，自己写了个网关（文末有地址）。

它零运行时依赖（只用 Node 内置模块），配置就一个 JSON：

```bash
# 1. 确保 GPT-SoVITS 的 api_v2 在跑（默认 9880）
python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml

# 2. 起网关
npx gpt-sovits-gateway serve --config config.json
```

`config.json` 里主要是你的声线：

```json
{
  "apiBase": "http://127.0.0.1:9880",
  "defaultVoice": "nahida",
  "voices": [
    {
      "id": "nahida",
      "refAudio": "E:/tts/ref/nahida.wav",
      "promptText": "参考音频里说的那句话",
      "promptLang": "zh"
    }
  ]
}
```

然后按标准协议调：

```bash
curl -X POST http://127.0.0.1:9881/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"你好，我是纳西妲。","voice":"nahida","response_format":"mp3"}' \
  --output hello.mp3
```

实测：19 个字的文本，57.4 KB 的 mp3，3.4 秒出结果（本机 RTX 5060）。

---

## 中途踩的几个坑

**mp3 编码器不一定叫 libmp3lame。** 我一开始写死了 `-c:a libmp3lame`，在别人的机器上直接报错——不是每个 ffmpeg 构建都带这个编码器。现在的做法是三级回退：`libmp3lame` → `mp3_mf`（Windows 媒体基金会）→ `mp3`，都不行就退回 wav。

**并发会打爆显存。** 客户端朗读长文本时会切成很多段并发请求，几个请求同时进 GPU 直接 OOM。网关改成串行处理，代价是吞吐低一点，但不会崩。

**偶尔合成出来的音频被截断。** 没有特别好的判断方法，我用了个土办法：按「文本字数 vs 音频时长」估一个下限，明显短了就重合成一次。不完美，但能捞回大部分。

---

## 选哪个

如果你只是想在本机把官方接口修得好用点，前面提到的替换文件方案更轻，不用多起一个进程。

如果你要在手机或者纯 CPU 服务器上跑推理，提取服务那个方案更合适。

我做的这层只管「让 GPT-SoVITS 能被标准客户端调用」，不解决跑在哪，也不解决训练。

---

## 项目地址

网关（Node，零依赖）：

https://github.com/zyqchanel-06/gpt-sovits-gateway

配套的训练编排器（从录音到音色权重的六步流水线）也在同一个账号下，需要的话点进主页能看到。

