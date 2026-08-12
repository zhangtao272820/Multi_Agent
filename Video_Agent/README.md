# Video Agent

> **说明**：Extended 档媒体能力，**不进** Supervisor 主叙事。面试主链见 [docs/面试备战](../docs/面试备战/00-使用说明与防穿帮.md)。

短视频 **文生视频** Agent：一句话 → 分镜 LLM → 通义万相（Wan）→ 可选 Music BGM → ffmpeg 混流。对应平台 `video_agent`，默认端口 **13111**；总管能力 cap 为 `video`。

## 项目简介

由 Manager **直接**调用（不经 Multimodal 转发执行）。本机开发可用独立 API 端口（见 `.env.example`，常见 **37891**）；LAN/Docker 统一 **13111**。

## 核心能力

| 阶段 | 说明 |
|------|------|
| Director / Camera | LLM 镜头脚本与视频 prompt |
| Wan 合成 | `wan_video.py` 异步任务轮询 `video_url` |
| BGM | `bgm_client.py` → Music `/api/music/generate-bgm` |
| Mux | ffmpeg 合成 `final_with_bgm_*.mp4` |
| QA | 失败可重试（`qa_max_fail_retries`） |
| 流式进度 | `WS /ws/video`，`type: generate` + `prompt` |

## 技术栈

- FastAPI、LangGraph、DashScope Wan、httpx、ffmpeg
- React + Vite 前端
- 关键文件：`backend/app/graph.py`、`wan_video.py`、`llm_video.py`、`bgm_client.py`

## 架构与关键路径

```text
prompt → orchestrate → Wan async → QA?
                    → Music BGM → ffmpeg mux → 静态产物
```

## 快速开始

**本机开发**（前后端分端口，避免与 LAN 冲突）：

```bash
cd Video_Agent/backend
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 37891
```

```bash
cd Video_Agent/frontend
npm install
cp .env.example .env   # VITE_* → 37891，前端常见 56291
npm run dev
```

WebSocket：`ws://127.0.0.1:<API_PORT>/ws/video`。

## 环境变量

见 `.env.example`：`DASHSCOPE_API_KEY`、`MUSIC_AGENT_HTTP_URL` 等。

## 与 Manager 协作

- 总管 cap：`video`；`VIDEO_AGENT_HTTP_URL` / `VIDEO_AGENT_WS_URL`
- 健康：`/api/health`
- 总管媒体代理可同源播放成片；Docker 内 BGM 指向 `http://music_agent:13110`

## 能力边界

- **适合**：短 prompt 文生视频、带 BGM 演示成片、与总管联调
- **不适合**：长片剪辑、实时直播、无 ffmpeg 的音画合成

## Docker / 平台编排

```powershell
cd Manage-platform_Agent
docker compose -f docker-compose.agents-lan.yml up -d --build video_agent
```

## 安全提示

- 保护 DashScope Key；产物目录注意磁盘与清理策略
- 公网暴露加鉴权

## 常见问题

- **Wan 一直排队**：查 DashScope 配额与任务状态 API
- **无 BGM**：确认 Music 服务可达与 `MUSIC_AGENT_HTTP_URL`
- **混流失败**：本机是否安装 ffmpeg
