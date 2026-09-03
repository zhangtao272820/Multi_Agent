# ClawHive MCP Servers

对外暴露 **RAG 检索** 与 **DB 只读问数** 的标准 MCP Server（stdio），供 Cursor / Claude Desktop 等 Host 联调。

> 集群内生产主路径仍是 Manager **Envelope**；MCP 是 **对外集成面**。面试叙事见 [`docs/面试备战/面试/03-Eval-MCP可靠性追问.md`](../docs/面试备战/面试/03-Eval-MCP可靠性追问.md)。

## 安装

```bash
cd mcp-servers
npm install
npm run smoke:schema
```

## Server 一览

| 目录 | 启动 | 代理 |
|------|------|------|
| `rag-search/` | `npm run start:rag` | `RAG_Agent` `/api/retrieve` |
| `db-readonly/` | `npm run start:db` | `DB_Agent` `/api/probe`、`/api/ask` |
| `admin-office/` | `npm run start:admin` | `AI_admin_Agent` 邮件只读 + draft（**禁 SMTP 直发**） |

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `RAG_AGENT_URL` | `http://127.0.0.1:13102` | RAG 专家基址 |
| `DB_AGENT_URL` | `http://127.0.0.1:13121` | DB 专家基址（Docker Vanna 13121） |
| `ADMIN_AGENT_URL` | `http://127.0.0.1:13105` | Admin 专家基址 |
| `AGENT_SERVICE_TOKEN` | — | 企业档出站鉴权（同 `shared/agentServiceAuth.ts`） |

## Tools

### rag-search

- `kb_search` — Hybrid 检索，返回 `hits[]`（snippet/source）；无命中 `retrieval_failure: true`
- `kb_health` — `/api/ready`

### db-readonly

- `db_probe` — schema 匹配 + ping（不跑 NL2SQL）
- `db_ask_readonly` — NL2SQL 只读问答（**会调 LLM**，仅受信 Host）
- `db_health` — `/api/ready`

### admin-office

- `admin_list_emails` — 收件箱只读
- `admin_search_emails` — 搜索（REST 未暴露时显式失败，不假发信）
- `admin_create_draft` — 本地装配 `mail_compose`（**不发 SMTP**）
- `admin_get_pending_preview` — pending 预览（不 commit）
- `admin_health` — `/api/ready`

发信必须走 Admin 产品 HITL / Compose Card；MCP **禁止**直发。

## Cursor 配置示例

在项目或用户 MCP 配置中加入（路径按本机仓库修改）：

```json
{
  "mcpServers": {
    "clawhive-rag": {
      "command": "node",
      "args": ["E:/Agent/mcp-servers/rag-search/index.mjs"],
      "env": {
        "RAG_AGENT_URL": "http://127.0.0.1:13102",
        "AGENT_SERVICE_TOKEN": "your-token-if-enterprise"
      }
    },
    "clawhive-db": {
      "command": "node",
      "args": ["E:/Agent/mcp-servers/db-readonly/index.mjs"],
      "env": {
        "DB_AGENT_URL": "http://127.0.0.1:13121",
        "AGENT_SERVICE_TOKEN": "your-token-if-enterprise"
      }
    },
    "clawhive-admin": {
      "command": "node",
      "args": ["E:/Agent/mcp-servers/admin-office/index.mjs"],
      "env": {
        "ADMIN_AGENT_URL": "http://127.0.0.1:13105",
        "AGENT_SERVICE_TOKEN": "your-token-if-enterprise"
      }
    }
  }
}
```

联调前请先启动对应专家：`cd RAG_Agent && npm run dev` / `cd DB_Agent && npm run dev`。

## 验证

```bash
# schema 门禁（CI / eval:interview）
npm run smoke:schema

# 完整面试 eval 打包（Manager 根目录）
cd ../Manager_Agent && npm run eval:interview
```

## 边界

- `db_ask_readonly` 不是绕过 `guardPipeline` 的裸 SQL；仍走 DB 专家 NL2SQL 只读链。
- `kb_search` 只做 retrieve，不替代 RAG `/api/chat` 的 citation 生成门禁。
- LAN 无 token 时可连；`AGENT_SECURITY_PROFILE=enterprise` 时需配置 token。
