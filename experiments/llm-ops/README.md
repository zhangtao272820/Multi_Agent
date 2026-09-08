# experiments/llm-ops · 生产推理 / 微调示例

> **非本仓运行时依赖** · 教学与预发对照用。  
> 文档：[docs/面试备战/技术/13-生产Linux与Agent全链路.md](../../docs/面试备战/技术/13-生产Linux与Agent全链路.md)  
> 弱显卡本机：[12-LoRA与本地推理学习手册.md](../../docs/面试备战/技术/12-LoRA与本地推理学习手册.md)

## 目录

| 路径 | 说明 |
|------|------|
| `scripts/bootstrap-gpu-ubuntu.sh.example` | Ubuntu GPU 机：驱动验收 + Container Toolkit 提示 |
| `deploy/docker-compose.vllm.example.yml` | vLLM OpenAI 兼容 API |
| `deploy/.env.vllm.example` | 模型名 / 端口 / 鉴权 |
| `deploy/vllm.service.example` | systemd 常驻模板 |
| `deploy/nginx-llm.conf.example` | 内网反代 + 简易限流思路 |
| `infer/openai_client_smoke.py` | 对任意 OpenAI 兼容端冒烟 |
| `train/qlora_sft.py` | QLoRA SFT 最小脚本 |
| `train/data/sample.jsonl` | 拒答/格式纪律样例数据 |
| `train/eval_prompts.jsonl` | 训后人工/脚本对比题 |
| `train/requirements.txt` | 训练依赖 |

## 快速开始

### A. 推理冒烟（任意已有 API）

```bash
cd experiments/llm-ops
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install openai httpx
export OPENAI_BASE_URL=http://127.0.0.1:8000/v1
export OPENAI_API_KEY=sk-local
export OPENAI_MODEL=qwen2.5-7b
python infer/openai_client_smoke.py
```

### B. GPU 云主机起 vLLM

```bash
# 先完成 NVIDIA 驱动 + Container Toolkit
cd deploy
cp .env.vllm.example .env.vllm
# 编辑 MODEL / HF_TOKEN / API_KEY
docker compose -f docker-compose.vllm.example.yml --env-file .env.vllm up -d
```

### C. QLoRA（需 ≥16GB 显存训练卡）

```bash
cd train
pip install -r requirements.txt
python qlora_sft.py --base_model Qwen/Qwen2.5-1.5B-Instruct --max_steps 60
```

## 接到 ClawHive / Agent

在 `Manage-platform_Agent/.env.agents-lan`：

```bash
OPENAI_BASE_URL=http://<gpu-host>:8000/v1
OPENAI_API_KEY=<与 vLLM 一致>
```

然后 `up -d --force-recreate` 相关服务。**禁止** `docker compose down -v`。

## 硬件提醒

| 机器 | 用途 |
|------|------|
| GTX 1050 2GB 开发机 | 只跑 Agent + 云 API / Ollama 小模型；**不要**跑本目录 vLLM 7B |
| 云 GPU ≥16/24GB | vLLM + QLoRA |
| 无 GPU Linux | 只部署 Agent 矩阵，模型走云 API（见公网演示部署） |
