# Tavern Agent（Agent 酒馆）

> **说明**：独立 Demo，**不进** Supervisor 主叙事。面试主链见 [docs/面试备战](../docs/面试备战/README.md)。

基于 **FastAPI + React (Vite)** 的角色扮演对话 Demo：用户选择「酒品 × 角色」，系统用 **行为参数矩阵** 动态生成醉酒人格提示词，并支持角色/酒类插画生成。

本目录对应平台编排里的 `tavern_agent` 服务，默认端口 **13109**。

## 简历摘要（可直接写入项目经历）

- **项目**：可配置的互动酒馆场景，展示「规则引擎 + LLM 人格」而非纯 Prompt 堆砌。
- **技术栈**：Python、FastAPI、OpenAI 兼容对话 API、图像生成（可配置 Provider）、React + TypeScript、Docker 单容器前后端一体。
- **职责亮点**：酒品/角色目录与属性矩阵（`matrix.py`）；五维行为向量（话痨、情绪、攻击性、文艺、糊涂）驱动 `chat_service`；插画缓存 API；与管理平台 LAN 编排一键部署。

## 核心功能

| 模块 | 说明 |
|------|------|
| 目录 | `catalog.py`：角色、酒类与展示属性 |
| 矩阵 | `matrix.py`：酒品基准向量 × 角色修正 → `BehaviorParams` |
| 对话 | `chat_service.py` + `prompts.py`：按参数注入系统提示 |
| 图像 | `image_service.py`：角色/酒类立绘生成与缓存 |
| API | `GET /api/catalog`、`GET /api/matrix/{character}/{wine}`、`POST /api/chat` |

## 快速开始

```bash
cd Tavern_Agent/backend
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 13109
```

```bash
cd Tavern_Agent/frontend
npm install
npm run dev   # Vite 默认 http://localhost:5173，/api 代理到后端 13109
```

本地需**先启动后端**（上一步 `uvicorn … --port 13109`），再开前端 dev。  
生产构建后由 FastAPI 托管 `frontend/dist`（见 `Dockerfile`），对外仅 **13109** 单端口。

环境变量见 `.env.example`。

## 能力边界

- **适合**：人格化对话 Demo、规则+LLM 混合、平台展示型 Agent  
- **不适合**：通用办公助理、大规模多用户会话（当前为演示架构）  

## Docker / 平台

```powershell
cd Manage-platform_Agent
docker compose -f docker-compose.agents-lan.yml up -d --build tavern_agent
```

访问：`http://<LAN_HOST>:13109/`
