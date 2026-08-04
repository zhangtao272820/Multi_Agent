# AI_Agent 本地对口型服务（遗留）

> **已废弃作为主路径。** 新部署请用 [LiveTalking + FeatherTalk](../../doc/realtime-digital-human.md)。  
> 本目录仅作旧 Ultralight/MuseTalk/Wav2Lip 迁移参考，勿再扩展。

---

Ultralight **流式真对口型**（优先）+ MuseTalk / Wav2Lip **回退**（历史说明如下）。

**Docker 部署**（推荐）：见 [`doc/ultralight-docker-setup.md`](../../doc/ultralight-docker-setup.md)。

## 1. 安装依赖（本地直跑）

```powershell
cd e:\Agent\AI_Agent\services\lipsync
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

需要 **ffmpeg** 在 PATH 中。

## 2. 启动服务

```powershell
.\start.ps1
# 或：copy .env.example → .env 后 python server.py
```

健康检查：`http://127.0.0.1:8091/health`

## 3. Ultralight 数据集

见 [`assets/ultralight_avatar/README.md`](../../assets/ultralight_avatar/README.md)。

## 4. MuseTalk（可选）

1. 克隆 [MuseTalk](https://github.com/TMElyralab/MuseTalk) 到 `AI_Agent/.external/MuseTalk`
2. 下载 `models/` 权重
3. 设置 `MUSETALK_ROOT`、`MUSETALK_PYTHON`（宿主机 Python 3.10 环境）
4. `LIPSYNC_BACKEND=musetalk`

Docker 下挂载 `.external/MuseTalk`，详见 docker 文档 §5。

## 5. Wav2Lip 快速回退（可选）

```powershell
git clone https://github.com/Rudrabha/Wav2Lip e:\Agent\AI_Agent\.external\Wav2Lip
# checkpoints/wav2lip_gan.pth
$env:WAV2LIP_ROOT="e:\Agent\AI_Agent\.external\Wav2Lip"
```

## 6. 配置 AI_Agent 主后端

`AI_Agent/.env`：

```env
LIP_SYNC_MODE=local_ultralight
LIPSYNC_SERVICE_URL=http://127.0.0.1:8091
LIPSYNC_BACKEND=ultralight
LIPSYNC_STREAM_FRAMES=true
```

Docker Compose 内：`LIPSYNC_SERVICE_URL=http://ai_agent_lipsync:8091`（compose 已注入）。

## 7. 协议

- `GET /health` — 后端就绪状态
- `POST /generate` — multipart 上传音频，返回 MP4
- `WS /ws/generate` — Ultralight 逐帧预览 + 最终 MP4

后端：`ultralight` | `musetalk` | `wav2lip` | `auto`（优先级 ultralight → musetalk → wav2lip）。

## 8. Docker 构建

```powershell
cd e:\Agent\AI_Agent\services\lipsync
docker build -t ai_agent_lipsync --build-arg LIPSYNC_GPU=1 .
```

或通过 Compose：`docker compose --profile extended up -d ai_agent_lipsync`
