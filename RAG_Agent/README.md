# RAG Agent

> **面试讲义**：[备战入口](../docs/面试备战/README.md) · [03 RAG](../docs/面试备战/技术/03-RAG-Agent.md)

私有文档 **检索增强生成** 服务：上传解析 → 切分入库 → Hybrid 检索 → 有据问答。对应平台 `rag_agent`，默认端口 **13102**；总管能力 cap 为 `rag`。

## 项目简介

面向小中规模知识库，强调 **先检索后生成、弱证据澄清或拒答、引用可核验**。查询侧会区分列表型检索与深度问答，避免「简单问题答复杂 / 复杂问题无出处」。

## 核心能力

| 能力 | 说明 |
|------|------|
| 多格式入库 | PDF / Word / Excel / PPTX / HTML / 图片 / TXT；**MinerU 重解析优先**（扫描 PDF/版面），失败回落本地解析 |
| 幂等与版本 | content hash / `source_version` / `ingest_at`（H1） |
| 父子块 | Parent-Child 切分，检索 child、展开 parent 上下文（H2） |
| Hybrid 检索 | 向量 + keyword + BM25，RRF 融合（默认开） |
| 重排 | Cross-Encoder / LLM 梯子；MMR 去冗余（H3） |
| Corrective | 弱证据触发 rewrite / clarify / 拒答（H4） |
| **Agentic（J）** | 复杂问句：`kb_catalog` → `retrieve` / `retrieve_scoped` 有界多跳；简单问句仍走 pipeline |
| Citation | 引用片段可核验门禁（H5） |
| 离线重建 | reindex 脚本与流程（H6） |
| 向量后端 | 内存向量（开发）或 `pgvector`（持久化） |
| **L 波（已落地）** | 门控 HyDE + Query 门控 + 企业制度 Graph 双车道（见升级文档） |

企业化细节见 [doc/企业化升级方案.md](doc/企业化升级方案.md)；L 波见 [doc/L波-普通RAG与GraphRAG升级方案.md](doc/L波-普通RAG与GraphRAG升级方案.md)。守门 `npm run smoke:enterprise-h` / `npm run smoke:agentic-jk` / `npm run smoke:l-wave`。

## 技术栈

- Nuxt 4、Vue 3、Tailwind
- LangGraph、`@langchain/openai`、Zod
- 解析：`pdf-parse`、`mammoth`、`word-extractor`、`sharp`；**MinerU 侧车**（`heavy_parse_client`）
- 向量：`server/utils/vectorStore.ts`

## 架构与关键路径

```text
upload → MinerU重解析(可选) → parse → chunk → embed → store
                              └─（L/M）制度图抽取（content_hash 变则 purge 再写）
chat ← generate ← tools⇄agent(多跳) ← intent(pipeline|agentic)
         │              │
    citation/clarify   Hybrid ± 门控HyDE ± Graph（简单问句 retrieve-first）
```

**边界**：Manager 一次派发 `cap=rag` ≠ Agentic RAG ≠ GraphRAG；后两者闭环在专家内。  
**L 波**：门控 HyDE（默认关）+ 企业制度图双车道（PG/文件边表，非 Neo4j）。**明确不做**：完整 RAGAS、开放域百科图、无限探索。

## 目录结构速览

- `server/api/chat.post.ts` — 对话
- `server/api/upload.post.ts` — 上传入库
- `server/api/list.get.ts` / `delete.post.ts` — 文档管理
- `server/api/probe.post.ts` — 总管探针
- `server/utils/agent.ts` — 编排主逻辑
- `server/utils/vectorStore.ts` — 向量存储
- `server/utils/doc_scope_judge.ts` — 范围与列表/问答分流
- `skills/` — 能力说明
- `data/` — 本地元数据与向量

## 快速开始

```bash
cd RAG_Agent
npm install
cp .env.example .env
npm run dev
```

常用：上传文档 → 确认解析 → 提问 → 检查是否引用正确片段。

## 环境变量

必改：`OPENAI_API_KEY`（及可选 `OPENAI_BASE_URL` / 模型名）。向量库相关见 `.env.example` 与 `nuxt.config.ts` runtimeConfig。

## 与 Manager 协作

- 总管 cap：`rag`
- 协议：`POST /api/ask`、`/api/probe`、健康 `/api/health`
- 可选 MCP：`RAG_MCP_SERVER=1` 时暴露 `/api/mcp`
- 证据新鲜度等字段由总管消费侧（`agent_result` / evidenceFreshness）使用

## 能力边界

- **适合**：内部文档问答、带出处的解释、资料列表检索、跨文档对比（Agentic）
- **不适合**：实时公网搜索、大规模爬虫、无文档依据的开放闲聊
- **明确不做**：完整 RAGAS 流水线、Neo4j 强依赖、多租户物理隔离、无限 Agent 探索
- **L 波已落地**：门控 HyDE、Query 门控、制度 GraphRAG（勿面试说「完全没做图」或「默认全开 HyDE」）

## 环境变量（J/K / L 波）

```bash
# K：MinerU 重解析（Compose 默认 http://mineru_api:8080）
RAG_HEAVY_PARSE=1
MINERU_API_URL=http://127.0.0.1:8798
RAG_HEAVY_PARSE_TIMEOUT_MS=120000

# J：专家内 Agentic 工具多跳
RAG_ENABLE_AGENTIC_TOOL_LOOP=1
RAG_AGENTIC_TOOL_MAX_ROUNDS=4

# L：门控 HyDE（默认关）/ 制度图
# RAG_ENABLE_HYDE=off
# RAG_ENABLE_POLICY_GRAPH=on
# RAG_RRF_GRAPH_WEIGHT=1.15
# RAG_RRF_HYDE_WEIGHT=0.9
```

## Docker / 平台编排

`Manage-platform_Agent` 默认 **`13102:13102`**。

## 安全提示

- 上传内容可能含隐私；生产加鉴权与文件类型白名单
- 勿提交真实密钥与生产向量库凭据

## 常见问题

- **上传后搜不到**：检查解析、分块与向量维度
- **答偏**：查 `doc_scope_judge.ts` 与检索路径
- **无来源**：检查 citation 门禁与 prompt 约束

## 相关文档

- [企业化升级方案](doc/企业化升级方案.md)
- Skills：`skills/*/skill.md`
- 矩阵总表：[docs/Agent矩阵升级总路线图.md](../docs/Agent矩阵升级总路线图.md)
