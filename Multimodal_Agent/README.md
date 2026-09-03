# Multimodal Agent

> **说明**：边界能力；面试主链见 [docs/面试备战](../docs/面试备战/README.md)。

矩阵的「眼睛 / 耳朵」：**图像 / 视频理解、语音转写、图文问答**。对应平台 `multimodal_agent`，默认端口 **13107**；总管能力 cap 为 `multimodal`。

## 项目简介

为 Manager 提供统一多模态理解入口（`POST /api/multimodal/unified`）。**作曲与文生视频不在本服务内生成**：总管直连 `Music_Agent` / `Video_Agent`；本服务前端若收到生成类请求，仅 redirect 到对应 UI。

## 核心能力

| 能力 | API | 说明 |
|------|-----|------|
| 图像理解 | `POST /api/multimodal/analyze` | VL 描述、OCR、情绪 |
| 视频摘要 | 同上 `media_type=video` | 关键帧 + VL 摘要 |
| 语音转写 | `POST /api/multimodal/describe` / WS | ASR |
| 图文问答 | `POST /api/multimodal/qa` | 基于理解结果问答 |
| 总管入口 | `POST /api/multimodal/unified` | Manager 一次调用 |
| 生成引导 | WS `generate_music` / `generate_video` | 跳转 Music/Video UI，不内嵌生成 |
| 实时流 | `WS /ws/multimodal` | 转写与理解进度 |

## 技术栈

- 后端：Python、FastAPI、Qwen-VL / ASR（DashScope 兼容）
- 前端：React + Vite
- 目录：`backend/app/main.py`、`agent.py`；`backend/app/processors/`（image / video / audio）；`frontend/`

## 架构与关键路径

```text
Manager ──HTTP──► /api/multimodal/unified
                     ├─ image / video / audio processors
                     └─ 结构化理解结果回总管

本机 UI ──WS──► 理解进度；生成类 → redirect Music/Video
```

## 快速开始

```bash
cd Multimodal_Agent/backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 13107
```

```bash
cd Multimodal_Agent/frontend
npm install
npm run dev
```

## 环境变量

见 `.env.example`。Docker 内示例：

- `MUSIC_AGENT_UI_URL=http://music_agent:13110`
- `VIDEO_AGENT_UI_URL=http://video_agent:13111`

## 与 Manager 协作

- 总管 **核心子 Agent**（标准 Docker 默认启动）；cap：`multimodal`；HTTP 基址 `MULTIMODAL_AGENT_HTTP_URL`
- 健康 / 探针：`/api/health`、`/api/probe`
- 有附件且还需查库/文档/日程等时：Planner 将 multimodal 放前序，下游 `dependsOn`，理解文本由执行层注入
- Manager 聊天支持粘贴 / 拖拽 / 附件按钮上传（经 `/api/multimodal-upload`）
- 音乐 / 视频生成由总管 **直连** music/video（extended），不经本服务转发执行

## 能力边界

- **适合**：识图 OCR、短视频理解、ASR、总管多模态理解步骤、辅助复杂问题描述
- **不适合**：替代 Music/Video 的深度作曲与成片生产

## Docker / 平台编排

标准版（无需 `--profile extended`）：

```bash
cd Manage-platform_Agent
docker compose -f docker-compose.agents-lan.yml up -d --build multimodal_agent
```

访问：`http://localhost:13107/`

音乐 / 视频 / Lobster 仍需 `docker compose --profile extended ...`。
## 安全提示

- 上传媒体可能含隐私；生产加鉴权与体积限制
- 勿提交真实 API Key

## 常见问题

- **VL/ASR 失败**：检查 DashScope / 兼容 Base URL 与模型名
- **总管调不通**：确认 `13107` 与 `/api/multimodal/unified` 可达
