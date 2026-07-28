# Music Agent

> **学习文档**：[入门](../docs/Agent学习指南-入门版.md) · [进阶](../docs/Agent学习指南-进阶版.md) · [Music 专篇](学习指南.md)  
> **路线图**：[doc/瘦身与能力路线图.md](doc/瘦身与能力路线图.md) · [MCP 分阶段接入](doc/MCP音乐能力-分阶段接入.md)

AI **作曲与 MIDI** 服务：自然语言 → 作曲意图 → MIDI 编排校验 → SoundFont 试听/导出。对应平台 `music_agent`，默认端口 **13110**；总管能力 cap 为 `music`。

## 项目简介

由 Manager **直接** HTTP/WS 调用（不再经 Multimodal 转发）。也可为 `Video_Agent` 提供 BGM（`/api/music/generate-bgm`）。Phase 1 以 rule/CPU 路径为主；神经 BGM 需 GPU，默认不下发。

## 核心能力

| 能力 | 说明 |
|------|------|
| AI 作曲 | 文本/结构化意图 → `compose_midi` → music21 校验 → FluidSynth WAV |
| BGM | 按时长、调性、情绪生成（供视频混流） |
| MIDI 换音色 | 上传 `.mid`，保留音符换 GM 乐器 |
| 上传分析 | 试听、Whisper 歌词、听感可视化 |
| 乐理分析 | `POST /api/music/analyze` |
| 自动配和声 | `POST /api/music/harmonize` |
| 乐谱导出 | `POST /api/music/export-score`（MusicXML / PDF / ABC） |
| Demucs 分轨 | `POST /api/music/stems`（CPU，Docker 默认） |
| 神经 BGM | 延后：GPU + `INSTALL_NEURAL_DEPS=1` |
| 实时交互 | WebSocket 阶段事件；前端节奏/歌词舞台 |

### 已下线（Phase 1 瘦身）

音频翻唱 / 算法重演绎（Spleeter + Basic Pitch）默认关闭。调试：`ENABLE_AUDIO_REMIX=true` + Docker `INSTALL_REMIX_DEPS=1`。

## 技术栈

- 后端：`main.py`、`midi_engine.py`、`llm.py`、`music21_validate.py`
- 前端：`frontend/src/App.tsx`
- 部署：`Dockerfile`；LAN 见 Manage-platform compose

## 快速开始

```bash
cd Music_Agent/backend
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 13110
```

```bash
cd Music_Agent/frontend
npm install
npm run dev
```

环境变量见 `.env.example`。

## 与 Manager 协作

- 总管 cap：`music`；`MUSIC_AGENT_HTTP_URL` / `MUSIC_AGENT_WS_URL`
- 健康：`/api/health`
- 总管可代理媒体文件做同源播放
- Skills 见本仓 `skills/music_*` 与 Manager `planner_playbook`

## 能力边界

- **适合**：旋律/伴奏、BGM、MIDI 换音色、与总管/视频联动
- **不适合**：音频翻唱重混、实时低延迟演奏、无版权商用发行（需自行合规）

## Docker / 平台编排

```powershell
cd Manage-platform_Agent
docker compose -f docker-compose.agents-lan.yml up -d --build music_agent
```

默认镜像不装 Spleeter / Basic Pitch。遗留 remix：

```powershell
docker build --build-arg INSTALL_REMIX_DEPS=1 -t music_agent:remix ../Music_Agent
```

## 安全提示

- 勿提交 API Key；对外暴露时加鉴权
- 用户上传音频注意隐私与存储清理

## 常见问题

- **无声 / 渲染失败**：检查 FluidSynth / SoundFont 依赖
- **总管播不了**：查 Manager 媒体代理与 `MUSIC_AGENT_HTTP_URL`
