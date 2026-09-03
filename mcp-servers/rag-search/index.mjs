#!/usr/bin/env node
/**
 * ClawHive RAG MCP Server（stdio）
 * 代理 RAG_Agent /api/retrieve — Retrieve-first，不直接生成用户可见长答案。
 *
 * 环境变量：
 *   RAG_AGENT_URL — 默认 http://127.0.0.1:13102
 *   AGENT_SERVICE_TOKEN / CLAWHIVE_INTERNAL_TOKEN — 企业档出站鉴权
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { postJson } from '../lib/agentFetch.mjs'
import { RAG_MCP_TOOLS } from './tools.mjs'

const RAG_BASE = String(process.env.RAG_AGENT_URL || 'http://127.0.0.1:13102').replace(/\/$/, '')

const server = new Server(
  { name: 'clawhive-rag-search', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: RAG_MCP_TOOLS
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String(req.params?.name || '')
  const args = (req.params?.arguments ?? {}) 

  if (name === 'kb_health') {
    const res = await fetch(`${RAG_BASE}/api/ready`)
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

  if (name === 'kb_search') {
    const query = String(args.query || '').trim()
    if (!query) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'query_required' }) }], isError: true }
    }
    const topK = Math.min(20, Math.max(1, Number(args.top_k ?? 5) || 5))
    const data = await postJson(RAG_BASE, '/api/retrieve', {
      query,
      skipLlmRerank: false,
      fastPath: false
    })
    const evidence = Array.isArray(data?.evidence) ? data.evidence : []
    const hits = evidence.slice(0, topK).map((e) => ({
      source: String(e?.source || e?.docKey || ''),
      score: e?.score ?? e?.rrfScore ?? null,
      snippet: String(e?.content || e?.snippet || '').slice(0, 1200),
      ingest_at: e?.ingest_at ?? e?.ingestAt ?? null
    }))
    const payload = {
      ok: true,
      query,
      hit_count: hits.length,
      hits,
      intent: data?.intent ?? data?.route_intent ?? null,
      retrieval_failure: hits.length === 0
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
