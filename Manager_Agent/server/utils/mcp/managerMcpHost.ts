/**
 * Manager MCP Host：聚合各子 Agent /api/mcp，供 LangGraph / Cursor 统一发现。
 */
import { agentWsUrlToHttpOrigin, resolveAgentUrl } from '../platform/agentEndpoints'
import {
  mcpErr,
  mcpOk,
  mcpTextResult,
  parseMcpToolCallParams,
  prefixToolName,
  splitPrefixedToolName,
  type McpJsonRpcRequest,
} from '#agent-shared/mcpJsonRpc'
import {
  hasLobsterBrowseEvidence,
  isLobsterInfrastructureFailure,
  isLobsterRetryableFailure,
} from '#agent-shared/lobsterRunVerifyLite'
import { callLobsterGuiRunWithPoll, type LobsterPollCallbacks } from './lobsterGuiPoll'

export type ManagerMcpServerDef = {
  name: string
  url: string
  agents?: string[]
}

export function isManagerMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_MCP_ENABLED ?? '0').trim() === '1'
}

function trimUrl(v: unknown) {
  return String(v ?? '').trim().replace(/\/+$/, '')
}

function parseManagerMcpServersJson(raw: string): ManagerMcpServerDef[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((row) => {
        if (!row || typeof row !== 'object') return null
        const r = row as Record<string, unknown>
        const name = String(r.name ?? '').trim()
        const url = trimUrl(r.url)
        if (!name || !url) return null
        const agents = Array.isArray(r.agents)
          ? r.agents.map((a) => String(a).trim()).filter(Boolean)
          : undefined
        return { name, url, agents }
      })
      .filter(Boolean) as ManagerMcpServerDef[]
  } catch {
    return []
  }
}

/** 默认子 Agent MCP 端点（env 开关对齐各 Agent export） */
export function resolveManagerMcpServers(env: NodeJS.ProcessEnv = process.env): ManagerMcpServerDef[] {
  const explicit = parseManagerMcpServersJson(String(env.MANAGER_MCP_SERVERS ?? '').trim())
  if (explicit.length) return explicit

  const out: ManagerMcpServerDef[] = []
  const push = (def: ManagerMcpServerDef) => {
    if (!out.some((x) => x.name === def.name)) out.push(def)
  }

  const guiWs = trimUrl(resolveAgentUrl(env.LOBSTER_AGENT_WS_URL, env))
  const guiHttp = guiWs ? agentWsUrlToHttpOrigin(guiWs) : ''
  if (guiHttp && String(env.LOBSTER_MCP_EXPORT ?? '1').trim() !== '0') {
    push({ name: 'lobster-gui', url: `${guiHttp}/api/mcp`, agents: ['gui'] })
  }

  const codeWs = trimUrl(resolveAgentUrl(env.CODE_AGENT_WS_URL, env))
  const codeHttp = codeWs ? agentWsUrlToHttpOrigin(codeWs) : ''
  if (codeHttp && String(env.CODE_MCP_SERVER ?? '0').trim() === '1') {
    push({ name: 'code-assist', url: `${codeHttp}/api/mcp`, agents: ['code'] })
  }

  const ragHttp = trimUrl(resolveAgentUrl(env.RAG_AGENT_HTTP_URL, env))
  if (ragHttp && String(env.RAG_MCP_SERVER ?? '0').trim() === '1') {
    push({ name: 'rag', url: `${ragHttp}/api/mcp`, agents: ['rag'] })
  }

  const crawlerHttp =
    trimUrl(resolveAgentUrl(env.CRAWLER_AGENT_HTTP_URL, env)) ||
    (trimUrl(resolveAgentUrl(env.CRAWLER_AGENT_WS_URL, env))
      ? agentWsUrlToHttpOrigin(trimUrl(resolveAgentUrl(env.CRAWLER_AGENT_WS_URL, env)))
      : '')
  if (crawlerHttp && String(env.EXTRACTOR_MCP_SERVER ?? '1').trim() !== '0') {
    push({ name: 'extractor', url: `${crawlerHttp}/api/mcp`, agents: ['crawler'] })
  }

  return out
}

function internalTokenHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = String(
    env.CLAWHIVE_INTERNAL_TOKEN || env.AGENT_INTERNAL_TOKEN || ''
  ).trim()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) {
    headers['x-clawhive-internal-token'] = token
    headers['x-internal-token'] = token
  }
  return headers
}

async function proxyMcp(url: string, body: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const res = await fetch(url, {
    method: 'POST',
    headers: internalTokenHeaders(env),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`MCP proxy ${url} HTTP ${res.status}: ${t.slice(0, 200)}`)
  }
  return (await res.json()) as Record<string, unknown>
}

export async function handleManagerMcpRequest(
  body: McpJsonRpcRequest,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isManagerMcpEnabled(env)) {
    return mcpErr(body.id, -32000, 'Manager MCP Host disabled (MANAGER_MCP_ENABLED=0)')
  }

  const servers = resolveManagerMcpServers(env)
  const method = String(body.method ?? '').trim()
  const params = (body.params ?? {}) as Record<string, unknown>

  if (method === 'initialize') {
    return mcpOk(body.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'manager-mcp-host', version: '1.0.0' },
      capabilities: { tools: {} },
    })
  }
  if (method === 'ping') return mcpOk(body.id, { servers: servers.map((s) => s.name) })
  if (method === 'tools/list') {
    const merged: Array<Record<string, unknown>> = []
    for (const s of servers) {
      try {
        const res = await proxyMcp(
          s.url,
          { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
          env,
        )
        const tools = Array.isArray((res.result as any)?.tools) ? (res.result as any).tools : []
        for (const t of tools) {
          if (!t || typeof t !== 'object') continue
          const name = String((t as any).name ?? '').trim()
          if (!name) continue
          merged.push({
            ...t,
            name: prefixToolName(s.name, name),
            description: `[${s.name}] ${String((t as any).description ?? '')}`.trim(),
          })
        }
      } catch {
        /* skip unreachable server */
      }
    }
    return mcpOk(body.id, { tools: merged })
  }

  if (method === 'tools/call') {
    const { name, args } = parseMcpToolCallParams(params)
    const split = splitPrefixedToolName(name)
    if (!split) {
      return mcpErr(body.id, -32602, 'tool name must be server__tool (use tools/list from host)')
    }
    const server = servers.find((s) => s.name === split.serverName)
    if (!server) return mcpErr(body.id, -32602, `unknown MCP server: ${split.serverName}`)
    try {
      const res = await proxyMcp(
        server.url,
        {
          jsonrpc: '2.0',
          id: body.id ?? 1,
          method: 'tools/call',
          params: { name: split.toolName, arguments: args },
        },
        env,
      )
      if (res.error) return mcpErr(body.id, -32000, String((res.error as any)?.message ?? 'proxy error'))
      return mcpOk(body.id, res.result)
    } catch (e: unknown) {
      return mcpErr(body.id, -32000, String((e as Error)?.message ?? e ?? 'proxy failed'))
    }
  }

  return mcpErr(body.id, -32601, `unknown method: ${method}`)
}

/** gui 步 MCP-first：HTTP start + poll + in-run confirm 桥接（对齐 OpenClaw 类执行面） */
export async function callLobsterGuiMcpTask(input: {
  task: string
  startUrl?: string
  engineHint?: string
  storageProfile?: string
  browserProfile?: 'managed' | 'user'
  sessionId?: string
  traceId?: string
  timeoutMs?: number
  managerTask?: Record<string, unknown>
  managerTaskEnvelope?: string
  /** initial=首次执行；post_human_confirm=人工 HITL 后重试（Lobster 侧可调整策略） */
  handoffContext?: 'initial' | 'post_human_confirm'
  callbacks?: LobsterPollCallbacks
  env?: NodeJS.ProcessEnv
}): Promise<{ ok: boolean; text: string; raw?: unknown; retryable?: boolean }> {
  const env = input.env ?? process.env
  try {
    return await callLobsterGuiRunWithPoll({
      task: input.task,
      startUrl: input.startUrl,
      engineHint: input.engineHint,
      storageProfile: input.storageProfile,
      browserProfile: input.browserProfile,
      sessionId: input.sessionId,
      traceId: input.traceId,
      timeoutMs: input.timeoutMs,
      managerTask: input.managerTask,
      managerTaskEnvelope: input.managerTaskEnvelope,
      handoffContext: input.handoffContext,
      callbacks: input.callbacks,
      env,
    })
  } catch (pollErr) {
    return callLobsterGuiMcpTaskBlocking({ ...input, env, pollFallbackError: pollErr })
  }
}

/** 阻塞式 MCP run_browser_task（poll 不可用时的回退） */
async function callLobsterGuiMcpTaskBlocking(input: {
  task: string
  startUrl?: string
  engineHint?: string
  storageProfile?: string
  browserProfile?: 'managed' | 'user'
  timeoutMs?: number
  managerTask?: Record<string, unknown>
  managerTaskEnvelope?: string
  handoffContext?: 'initial' | 'post_human_confirm'
  env?: NodeJS.ProcessEnv
  pollFallbackError?: unknown
}): Promise<{ ok: boolean; text: string; raw?: unknown; retryable?: boolean }> {
  const env = input.env ?? process.env
  const servers = resolveManagerMcpServers(env)
  const lobster = servers.find((s) => s.name === 'lobster-gui')
  if (!lobster) throw new Error('lobster-gui MCP 未配置')

  const res = await proxyMcp(
    lobster.url,
    {
      jsonrpc: '2.0',
      id: 'gui-exec',
      method: 'tools/call',
      params: {
        name: 'run_browser_task',
        arguments: {
          task: input.task,
          start_url: input.startUrl,
          engine_hint: input.engineHint,
          storage_profile: input.storageProfile,
          ...(input.browserProfile ? { browser_profile: input.browserProfile } : {}),
          timeout_ms: input.timeoutMs,
          ...(input.managerTask ? { manager_task: input.managerTask } : {}),
          ...(input.managerTaskEnvelope ? { manager_task_envelope_v2: input.managerTaskEnvelope } : {}),
          ...(input.handoffContext ? { handoff_context: input.handoffContext } : {}),
        },
      },
    },
    env,
  )
  if (res.error) throw new Error(String((res.error as any)?.message ?? 'lobster MCP failed'))
  const content = (res.result as any)?.content
  const text = Array.isArray(content)
    ? content.map((c: any) => String(c?.text ?? '')).filter(Boolean).join('\n')
    : JSON.stringify(res.result ?? {})
  const parsed = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  })()
  const verify = parsed?.verify && typeof parsed.verify === 'object' ? parsed.verify : undefined
  const verifyOk = verify?.ok !== false
  const status = String(parsed?.status || '').trim().toLowerCase()
  const infraFail = isLobsterInfrastructureFailure({
    status: parsed?.status,
    error: parsed?.error,
    result: parsed?.result,
    text,
  })
  const connFail = /Connection closed|playwright_mcp_browser_unavailable/i.test(
    String(parsed?.error || text || ''),
  )
  const browseOk = hasLobsterBrowseEvidence(parsed?.result)
  const ok =
    !infraFail &&
    !connFail &&
    verifyOk &&
    (status === 'done' || (status === 'error' && browseOk && verifyOk)) &&
    Boolean(parsed?.result)
  const retryable = isLobsterRetryableFailure({
    status: parsed?.status,
    error: parsed?.error,
    result: parsed?.result,
    text,
    verify: verify && typeof verify === 'object' ? { reason: String((verify as any).reason || '') } : undefined,
  })
  return { ok, text, raw: parsed ?? res.result, retryable }
}

/** gui 桌面任务：HTTP poll + desktop 引擎（Win 宿主机 + Windows-MCP） */
export async function callLobsterDesktopMcpTask(input: {
  task: string
  targetApp?: string
  timeoutMs?: number
  sessionId?: string
  traceId?: string
  managerTask?: Record<string, unknown>
  managerTaskEnvelope?: string
  callbacks?: LobsterPollCallbacks
  env?: NodeJS.ProcessEnv
}): Promise<{ ok: boolean; text: string; raw?: unknown; retryable?: boolean }> {
  const env = input.env ?? process.env
  return callLobsterGuiRunWithPoll({
    task: input.task,
    engineHint: 'desktop',
    timeoutMs: input.timeoutMs ?? 300_000,
    sessionId: input.sessionId,
    traceId: input.traceId,
    managerTask: input.managerTask,
    managerTaskEnvelope: input.managerTaskEnvelope,
    callbacks: input.callbacks,
    env,
  })
}

export function extractMcpToolResponseText(result: unknown): string {
  const content = (result as any)?.content
  if (Array.isArray(content)) {
    return content.map((c: any) => String(c?.text ?? '')).filter(Boolean).join('\n')
  }
  return typeof result === 'string' ? result : JSON.stringify(result ?? {})
}

export async function callManagerMcpTool(input: {
  serverName: string
  toolName: string
  args?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
}): Promise<{ ok: boolean; text: string; raw?: unknown }> {
  const env = input.env ?? process.env
  const servers = resolveManagerMcpServers(env)
  const server = servers.find((s) => s.name === input.serverName)
  if (!server) throw new Error(`MCP server not configured: ${input.serverName}`)

  const res = await proxyMcp(
    server.url,
    {
      jsonrpc: '2.0',
      id: `${input.serverName}-${input.toolName}`,
      method: 'tools/call',
      params: { name: input.toolName, arguments: input.args ?? {} },
    },
    env,
  )
  if (res.error) throw new Error(String((res.error as any)?.message ?? 'MCP tool failed'))
  const text = extractMcpToolResponseText(res.result)
  const parsed = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  })()
  const ok = parsed?.ok !== false && parsed?.fallback !== 'websocket'
  return { ok, text, raw: parsed ?? res.result }
}

/** code 步 MCP-first：直调 code-assist run_code_task */
export async function callCodeAssistMcpTask(input: {
  message: string
  managerTask?: Record<string, unknown>
  managerTaskEnvelope?: string
  threadId?: string
  env?: NodeJS.ProcessEnv
}): Promise<{ ok: boolean; text: string; raw?: unknown; fallback?: boolean }> {
  const env = input.env || process.env
  const codeRoot = String(env.MANAGER_CODE_PROJECT_ROOT || env.CODE_PROJECT_DIR || '').trim()
  const out = await callManagerMcpTool({
    serverName: 'code-assist',
    toolName: 'run_code_task',
    args: {
      message: input.message,
      manager_task: input.managerTask,
      manager_task_envelope_v2: input.managerTaskEnvelope,
      thread_id: input.threadId,
      ...(codeRoot ? { root: codeRoot } : {}),
    },
    env: input.env,
  })
  const raw = out.raw as Record<string, unknown> | null
  if (raw?.fallback === 'websocket') {
    return { ok: false, text: out.text, raw: out.raw, fallback: true }
  }
  const answer = typeof raw?.answer === 'string' ? raw.answer : out.text
  return { ok: out.ok && Boolean(answer), text: answer, raw: out.raw }
}

/** rag 步 MCP-first：直调 rag retrieve */
export async function callRagMcpRetrieve(input: {
  query: string
  fastPath?: boolean
  env?: NodeJS.ProcessEnv
}): Promise<{ ok: boolean; text: string; raw?: unknown }> {
  const out = await callManagerMcpTool({
    serverName: 'rag',
    toolName: 'retrieve',
    args: {
      query: input.query,
      fast_path: input.fastPath === true,
    },
    env: input.env,
  })
  const raw = out.raw as Record<string, unknown> | null
  const answer = typeof raw?.answer === 'string' ? raw.answer : out.text
  return { ok: out.ok && Boolean(answer), text: answer, raw: out.raw }
}

