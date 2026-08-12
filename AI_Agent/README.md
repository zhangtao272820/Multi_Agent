# AI_Agent — 实时 AI 虚拟化身

> **说明**：独立 Demo，**不进** Supervisor 主叙事。面试主链见 [docs/面试备战](../docs/面试备战/00-使用说明与防穿帮.md)。  
> 实时数字人落地：[doc/realtime-digital-human.md](doc/realtime-digital-human.md)

**对口型主路径（唯一推荐）**：`LiveTalking`（WebRTC 推流）+ `FeatherTalk`（口型模型）。  
无 GPU：`LIP_SYNC_MODE=client_rhythm` 假口型联调。  
产品介绍：本地 RAG（`assets/products`）。情绪/动作：LLM `DIRECTOR` JSON + LiveTalking audiotype。

## 怎么启动（默认，无 GPU）

1. 复制 `AI_Agent/.env.example` → `.env`，填入百炼 Key；保持 `LIP_SYNC_MODE=client_rhythm`。
2. 后端 + 前端：

```powershell
cd e:\Agent\AI_Agent\backend
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

```powershell
cd e:\Agent\AI_Agent\frontend
npm install
npm run dev
```

## 真口型（LiveTalking + FeatherTalk）

```powershell
cd e:\Agent\AI_Agent\scripts
.\setup_avatar_stack.ps1          # 克隆 .external/FeatherTalk + LiveTalking
# 按 FeatherTalk README 训练权重 → assets/avatar_runtime/feathertalk/
.\start_livetalking.ps1           # 默认 :8010
```

`.env`：

```env
LIP_SYNC_MODE=livetalking
LIVETALKING_URL=http://127.0.0.1:8010
LIVETALKING_WEBRTC_URL=http://127.0.0.1:8010
RAG_ENABLED=true
DIRECTOR_ENABLED=true
```

前端连 AI_Agent `/ws`；画面走 LiveTalking WebRTC。详见 [doc/realtime-digital-human.md](doc/realtime-digital-human.md)。

## Docker

```powershell
# 仅对话（假口型）
docker compose up -d ai_agent

# GPU 服务器：对话 + LiveTalking
docker compose --profile avatar up -d
```

外网 WebRTC 需 HTTPS + TURN（见落地文档 Phase 3）。

## WebSocket（简要）

客户端 `utterance` 可带 `livetalking_sessionid`（前端 WebRTC 握手后自动附带）。  
服务端：`pipeline_started` → `transcript` → `rag_hits?` → `reply_*` → `avatar_director?` → `tts_chunk` → `lip_sync` → `done`。  
`interrupt` 可打断 LiveTalking 播报。

## 目录

- `backend/`：FastAPI `/ws`、RAG、导演、LiveTalking 客户端
- `frontend/`：Vite + React；WebRTC 数字人层
- `services/livetalking/`：GPU sidecar Docker
- `services/lipsync/`：**遗留**（勿新开）
- `assets/products/`：产品 RAG 文档
- `assets/avatar_actions/`：动作 audiotype 映射

## 冒烟（无 Key）

```powershell
python e:\Agent\AI_Agent\scripts\smoke_rag_director.py
```
