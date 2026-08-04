# LiveTalking sidecar（AI_Agent）

本目录提供与 [lipku/LiveTalking](https://github.com/lipku/LiveTalking) 的对接约定；真实引擎代码在 `AI_Agent/.external/LiveTalking`。

## 职责划分

| 组件 | 职责 |
|------|------|
| AI_Agent backend | ASR / LLM / TTS / RAG / emotion·action 导演 |
| LiveTalking | idle、对口型推理（FeatherTalk 权重）、打断、WebRTC 推流、动作片插入 |
| Frontend | `/ws` 会话事件 + LiveTalking WebRTC 画面 |

## FeatherTalk 接入

1. 用 [FeatherTalk](https://github.com/anliyuan/FeatherTalk) 训练个性化模型（去掉 SyncNet；建议 mouth ROI + temporal）。
2. 将 checkpoint / 数据集路径配置到 LiveTalking 的 ultralight/avatar 数据目录，或通过环境变量：

```env
FEATHERTALK_ROOT=e:/Agent/AI_Agent/.external/FeatherTalk
FEATHERTALK_CHECKPOINT=e:/Agent/AI_Agent/assets/avatar_runtime/feathertalk
LIVETALKING_AVATAR_DATA=e:/Agent/AI_Agent/assets/avatar_runtime
```

3. 不要并行维护旧 Ultralight 训练流。

## HTTP 约定（AI_Agent → LiveTalking）

LiveTalking 原生接口（版本差异以官方为准）：

- `GET /` 或健康页
- `POST /human` — `{ "text", "type": "echo", "interrupt": true, "sessionid" }`
- `POST /humanaudio` — multipart 音频驱动口型
- WebRTC 信令 — 浏览器直连 LiveTalking

AI_Agent 客户端：`backend/app/livetalking_client.py`。

## Docker

见仓库根 `docker-compose.yml` 中的 `livetalking` 服务（需 GPU）。

FeatherTalk 权重对接：[doc/feathertalk-livetalking-bridge.md](../../doc/feathertalk-livetalking-bridge.md)。

### TURN（公网）

在 LiveTalking / 前端 ICE 配置中增加类似：

```text
stun:stun.l.google.com:19302
turn:your-turn-host:3478?transport=udp
```

并将 `LIVETALKING_WEBRTC_URL` 设为浏览器可达的 HTTPS 地址。
