/**
 * Tool Memory：子 Agent / 工具调用成功率 → 路由偏好信号（租户隔离）
 */

import { agentPgQuery, isAgentPgConfigured } from './agentPgClient'
import { requireTenantId, ScopeRequiredError } from './tenantScope'

export type ToolMemoryRow = {
  tenantId: string
  agent: string
  toolName: string
  contextKey: string
  trials: number
  successes: number
  failures: number
  avgMs: number
  successRate: number
  lastOk?: boolean
  lastError?: string
}

export function isToolMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_TOOL_MEMORY ?? '1').trim() !== '0'
}

function resolveToolTenantId(raw: unknown, env: NodeJS.ProcessEnv): string | null {
  try {
    return requireTenantId(raw, env)
  } catch (e) {
    if (e instanceof ScopeRequiredError) return null
    throw e
  }
}

export async function recordToolMemoryEvent(
  input: {
    tenantId?: string
    agent: string
    toolName: string
    contextKey?: string
    ok: boolean
    ms?: number
    error?: string
    metadata?: Record<string, unknown>
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!isToolMemoryEnabled(env) || !isAgentPgConfigured()) return
  const tenantId = resolveToolTenantId(input.tenantId, env)
  if (!tenantId) return
  const agent = String(input.agent || 'unknown').slice(0, 32)
  const toolName = String(input.toolName || 'unknown').slice(0, 128)
  const contextKey = String(input.contextKey || '__global__').slice(0, 128)
  const ms = Number(input.ms ?? 0) || 0

  await agentPgQuery(
    `INSERT INTO mgr_tool_memory
       (tenant_id, agent, tool_name, context_key, trials, successes, failures, avg_ms, last_ok, last_error, metadata, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (tenant_id, agent, tool_name, context_key) DO UPDATE SET
       trials = mgr_tool_memory.trials + 1,
       successes = mgr_tool_memory.successes + EXCLUDED.successes,
       failures = mgr_tool_memory.failures + EXCLUDED.failures,
       avg_ms = CASE
         WHEN mgr_tool_memory.trials + 1 > 0
         THEN (mgr_tool_memory.avg_ms * mgr_tool_memory.trials + EXCLUDED.avg_ms) / (mgr_tool_memory.trials + 1)
         ELSE EXCLUDED.avg_ms
       END,
       last_ok = EXCLUDED.last_ok,
       last_error = EXCLUDED.last_error,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      tenantId,
      agent,
      toolName,
      contextKey,
      input.ok ? 1 : 0,
      input.ok ? 0 : 1,
      ms,
      input.ok,
      input.error ? String(input.error).slice(0, 500) : null,
      JSON.stringify(input.metadata ?? {})
    ],
    env
  )
}

export async function queryToolMemoryTop(
  opts?: { tenantId?: string; agent?: string; contextKey?: string; limit?: number },
  env: NodeJS.ProcessEnv = process.env
): Promise<ToolMemoryRow[]> {
  if (!isAgentPgConfigured()) return []
  const tenantId = resolveToolTenantId(opts?.tenantId, env)
  if (!tenantId) return []
  const limit = Math.max(1, Math.min(20, opts?.limit ?? 8))
  const agent = opts?.agent ? String(opts.agent).slice(0, 32) : null
  const contextKey = opts?.contextKey ? String(opts.contextKey).slice(0, 128) : null

  const res = await agentPgQuery<{
    tenant_id: string
    agent: string
    tool_name: string
    context_key: string
    trials: number
    successes: number
    failures: number
    avg_ms: number
    last_ok: boolean | null
    last_error: string | null
  }>(
    agent
      ? `SELECT tenant_id, agent, tool_name, context_key, trials, successes, failures, avg_ms, last_ok, last_error
         FROM mgr_tool_memory
         WHERE tenant_id = $1 AND agent = $2 AND ($3::varchar IS NULL OR context_key = $3)
         ORDER BY (successes::float / GREATEST(trials, 1)) DESC, trials DESC
         LIMIT $4`
      : `SELECT tenant_id, agent, tool_name, context_key, trials, successes, failures, avg_ms, last_ok, last_error
         FROM mgr_tool_memory
         WHERE tenant_id = $1
         ORDER BY trials DESC
         LIMIT $2`,
    agent ? [tenantId, agent, contextKey, limit] : [tenantId, limit],
    env
  )

  return (res?.rows ?? []).map((r) => ({
    tenantId: r.tenant_id,
    agent: r.agent,
    toolName: r.tool_name,
    contextKey: r.context_key,
    trials: r.trials,
    successes: r.successes,
    failures: r.failures,
    avgMs: r.avg_ms,
    successRate: r.trials > 0 ? Math.round((r.successes / r.trials) * 1000) / 1000 : 0,
    lastOk: r.last_ok ?? undefined,
    lastError: r.last_error ?? undefined
  }))
}

export function formatToolMemoryBlock(rows: ToolMemoryRow[]): string {
  if (!rows.length) return ''
  const lines = ['### 工具记忆（历史成功率；低成功率工具应降级或换路；不得覆盖用户问题）']
  for (const r of rows.slice(0, 6)) {
    lines.push(
      `- ${r.agent}/${r.toolName}: 成功率=${(r.successRate * 100).toFixed(0)}% (${r.successes}/${r.trials}), avgMs=${Math.round(r.avgMs)}`
    )
  }
  return lines.join('\n')
}
