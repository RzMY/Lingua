# Lingua

Lingua 是一个面向语言学习的播放器。它把音视频、字幕、逐词时间轴、注音、转写、词性、译文和词汇讲解放在同一条学习流程。支持日语、英语、西班牙语、法语、德语和韩语。
## 功能概览

- 本地导入音频或视频：WAV、MP3、M4A、FLAC、OGG、OPUS，以及 MP4、WebM、MOV 等；
- 导入词级 JSON、带内联时间戳的 WebVTT、普通 SRT / VTT。
- 有词级时间戳时逐词高亮；只有句级时间戳时按整句高亮。
- 日语假名与罗马音、韩语发音与罗马字、英语/西班牙语/法语/德语音标与原形。
- 词性着色、点击单词查看释义、查看句子逐词拆解。
- 浏览器直连 OpenAI 兼容接口，按需生成翻译、词卡和句子讲解。
- 变速播放、单句/整曲重复、自动跟随、和长音频虚拟滚动。
- IndexedDB 本地保存音视频、分析结果与大模型产物；支持用户数据导出、导入。

## 界面预览

![界面预览](imgs/preview.jpg)

## 安装

### Docker 部署

首次部署先复制配置文件：

```bash
cp .env.docker.example .env.docker
```

Windows PowerShell 使用：

```powershell
Copy-Item .env.docker.example .env.docker
```
编辑 `.env.docker`，设置 `LINGUA_API_TOKEN`。

#### 拉取远程镜像

拉取已发布的镜像并启动：

```bash
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d --no-build --wait
```
更新时重新执行这两条命令。

#### 本地构建

在 `.env.docker` 中设置 `LINGUA_IMAGE=lingua:local`，然后构建并启动：

```bash
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d --no-build --wait
```

#### 原生访问

- Android：在浏览器中打开页面，添加到主屏幕。
- IOS：在 [WebClip](https://webclip-vue-app.vercel.app) 添加WebClip

#### Docker管理

```bash
# 查看服务状态
docker compose --env-file .env.docker ps
# 查看日志
docker compose --env-file .env.docker logs --tail 100
# 停止并移除容器
docker compose --env-file .env.docker down
```
修改令牌或端口后，重新执行 `docker compose --env-file .env.docker up -d --no-build --wait` 使配置生效，并同步修改浏览器设置。

### 本地 Python 安装

```bash
conda create -n Lingua python=3.11
conda activate Lingua
pip install -r requirements.txt
```

检查语言依赖：

```bash
python -m pipeline langs
```

英语注音需要额外的 NLTK 数据：

```bash
python -c "import nltk; nltk.download('cmudict'); nltk.download('averaged_perceptron_tagger_eng')"
```

如果要使用自定义 MeCab 词典，可在 `.env` 中设置 `LINGUA_DICDIR`，或运行命令时传入 `--dicdir`。复制示例配置：

```bash
cp .env.example .env
```

Windows PowerShell 可使用：

```powershell
Copy-Item .env.example .env
```
同时启动网站和分析 API：

```bash
python -m pipeline serve --root web --open
```

默认地址为 `http://127.0.0.1:5173`

只启动 API：

```bash
python -m pipeline serve --no-static --host 0.0.0.0 --port 8765
```

## 工作台

在「设置 → 系统」开启「实验性功能」后，底部导航的首页与设置之间显示工作台。

#### 提取聆听音频：
  - 普通 MP4 的 AAC/ALAC 原音轨直接分离为 M4A；
  - 已有无损 WAV 直接复用，其他支持的格式解码为浮点 WAV，保留原采样率与声道。
  - 提取后可直接导入该音频。
#### 生成ASR音频：
  - 下采样聆听音频生成 16 kHz MP3 用于转录；
#### 转录：
  - 点击「转录接口配置」，设置 OpenAI 兼容接口地址、API Key、模型与结果格式。可选词级时间戳与自定义参数。
  - 输入音频可直接引用第一步的聆听原音频，也可引用第二步的 ASR 音频；
  - 转录后可直接导入字幕。

## 字幕格式

### 词级 JSON

兼容 Whisper、WhisperX 和 faster-whisper 常见结构。示例：

```json
{
  "language": "ja",
  "segments": [
    {
      "start": 0.0,
      "end": 2.4,
      "text": "今日はいい天気ですね。",
      "words": [
        {"word": "今日", "start": 0.0, "end": 0.6},
        {"word": "は", "start": 0.6, "end": 0.8}
      ]
    }
  ]
}
```

### SRT / 普通 WebVTT

支持句级时间戳。没有词级时间戳时，默认按整句高亮；可在播放页开启“估算词级时间戳”，按字符分配时间。

### 带内联时间戳的 WebVTT

支持卡拉 OK 风格的 `<00:00:01.400>` 标记，后端会将其转换为词级时间片段。

## 支持的语言

| 代码 | 语言 | 分词引擎 | 上层文字 | 下层文字 |
| --- | --- | --- | --- | --- |
| `ja` | 日语 | MeCab + UniDic | 假名 | 罗马音 |
| `en` | 英语 | spaCy | 音标 | 原形 |
| `es` | 西班牙语 | spaCy | 音标 | 原形 |
| `fr` | 法语 | spaCy | 音标 | 原形 |
| `de` | 德语 | spaCy | 音标 | 原形 |
| `ko` | 韩语 | spaCy | 发音 | 罗马字 |

## 设置说明

设置按作用范围分为三类：

- **连接与模型**：分析后端地址、访问令牌、大模型地址、API Key、模型名、提示词和调用参数。
- **学习偏好**：目标语言、各源语言默认显示层、字幕字号和主题。
- **数据管理**：导入/导出数据、补充缺失文件、查看存储明细和清理模型缓存。

## HTTP API

### `GET /api/health`

返回版本、`schemaVersion`、支持的字幕格式和语言依赖状态。`?probe=1` 会实际检查语言分析器依赖。

### `POST /api/analyze`

请求体为字幕原文，参数包括：

- `lang`：源语言代码。
- `id`、`title`：音频标识和标题。
- `split`：是否按停顿拆分长句。
- `merge`：是否合并形态素。
- `estimate`：无词级时间戳时是否估算词时间。
- `duration`：音频时长。
- `name`：字幕文件名。

响应结构：

```json
{"ok": true, "log": ["..."], "track": {"schemaVersion": 2, "sentences": []}}
```
## 开源致谢
本项目依赖并使用了以下开源组件：

* **lamejs**：用于音频 MP3 编码，基于 LGPL 许可证发布。项目主页及源码请参考 [LAME 官方网站](http://lame.sourceforge.net)。

## 许可

本项目使用 MIT License，详见 [LICENSE](LICENSE)。
