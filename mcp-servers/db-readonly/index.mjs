#!/usr/bin/env node
/**
 * ClawHive DB 只读 MCP Server（stdio）
 * 代理 DB_Agent /api/probe 与 /api/ask（ask 走 NL2SQL 只读闸）。
 *
 * 环境变量：
 *   DB_AGENT_URL — 默认 http://127.0.0.1:13101
 *   AGENT_SERVICE_TOKEN / CLAWHIVE_INTERNAL_TOKEN
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { postJson } from '../lib/agentFetch.mjs'
import { DB_MCP_TOOLS } from './tools.mjs'

const DB_BASE = String(process.env.DB_AGENT_URL || 'http://127.0.0.1:13101').replace(/\/$/, '')

const server = new Server(
  { name: 'clawhive-db-readonly', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: DB_MCP_TOOLS
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String(req.params?.name || '')
  const args = (req.params?.arguments ?? {}) 

  if (name === 'db_health') {
    const res = await fetch(`${DB_BASE}/api/ready`)
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { ok: res.ok, raw: text.slice(0, 500) }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ status: res.status, ...data }, null, 2) }]
    }
  }

  if (name === 'db_probe') {
    const question = String(args.question || '').trim()
    if (!question) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'question_required' }) }], isError: true }
    }
    const data = await postJson(DB_BASE, '/api/probe', { question })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  if (name === 'db_ask_readonly') {
    const question = String(args.question || '').trim()
    if (!question) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'question_required' }) }], isError: true }
    }
    const body = { question }
    const dbId = String(args.db_id || '').trim()
    if (dbId) body.dbId = dbId
    const data = await postJson(DB_BASE, '/api/ask', body)
    const payload = {
      ok: data?.ok !== false,
      answer: data?.answer ?? data?.result ?? null,
      agentResult: data?.agentResult ?? null,
      sql: data?.sql ?? data?.generated_sql ?? null,
      warning: 'readonly_nl2sql_via_expert_guard'
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unknown_tool', name }) }],
    isError: true
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
