/** N3：Manager 侧统一观测字段契约（trace_id / run_id / phase / error_code） */

export const WORKER_AGENT_PHASES = new Set([
  'db',
  'rag',
  'code',
  'crawler',
  'gui',
  'admin',
  'multimodal',
  'music',
  'video',
  'clean',
  'visualize',
  'report'
])

export type ExpertErrorCode =
  | 'timeout'
  | 'http_5xx'
  | 'network'
  | 'business'
  | 'circuit_open'
  | 'skipped'
  | 'budget_exceeded'
  | 'overloaded'
  | 'unknown'

export type ManagerMetricEntryInput = {
  runId: string
  phase: string
  ms: number
  trace_id?: string
  ok?: boolean
  agent?: string
  error_code?: string
  tokens?: number
  usd?: number
  model?: string
  extra?: Record<string, unknown>
}

export type NormalizedManagerMetricEntry = ManagerMetricEntryInput & {
  trace_id: string
  ts: string
}

export function resolveMetricAgentFromEntry(input: {
  agent?: string
  phase?: string
  extra?: Record<string, unknown>
}): string | undefined {
  const direct = String(input.agent || input.extra?.agent || '').trim()
  if (direct) return direct
  const phase = String(input.phase || '').trim()
  if (WORKER_AGENT_PHASES.has(phase)) return phase
  if (phase.startsWith('execute:')) return phase.slice('execute:'.length) || undefined
  return undefined
}

export function normalizeManagerMetricEntry(input: ManagerMetricEntryInput): NormalizedManagerMetricEntry {
  const runId = String(input.runId || '').trim() || 'unknown'
  const phase = String(input.phase || 'unknown').trim() || 'unknown'
  const agent = resolveMetricAgentFromEntry({ agent: input.agent, phase, extra: input.extra })
  const row: NormalizedManagerMetricEntry = {
    runId,
    trace_id: String(input.trace_id || runId).trim() || runId,
    phase,
    ms: Math.max(0, Number(input.ms) || 0),
    ts: new Date().toISOString()
  }
  if (typeof input.ok === 'boolean') row.ok = input.ok
  if (agent) row.agent = agent
  if (input.error_code) row.error_code = String(input.error_code)
  if (typeof input.tokens === 'number' && Number.isFinite(input.tokens) && input.tokens > 0) {
    row.tokens = input.tokens
  }
  if (typeof input.usd === 'number' && Number.isFinite(input.usd) && input.usd > 0) {
    row.usd = input.usd
  }
  if (typeof input.model === 'string' && input.model.trim()) row.model = input.model.trim()
  if (input.extra && typeof input.extra === 'object' && Object.keys(input.extra).length) {
    row.extra = input.extra
  }
  return row
}

/** worker 步执行后写入 metrics 的标准入口 */
export function buildWorkerStepMetric(input: {
  runId: string
  agent: string
  ms: number
  ok: boolean
  error?: unknown
  error_code?: string
  agentResult?: { ok?: boolean; error_code?: string }
}): ManagerMetricEntryInput {
  return {
    runId: input.runId,
    phase: String(input.agent || 'unknown'),
    ms: input.ms,
    ok: input.ok,
    agent: String(input.agent || ''),
    error_code: input.error_code
  }
}

export function validateManagerMetricEntry(entry: NormalizedManagerMetricEntry): string[] {
  const issues: string[] = []
  if (!entry.runId || entry.runId === 'unknown') issues.push('missing runId')
  if (!entry.phase) issues.push('missing phase')
  if (!entry.trace_id) issues.push('missing trace_id')
  if (typeof entry.ok === 'boolean' && !entry.ok && !entry.error_code) {
    issues.push('failed step missing error_code')
  }
  return issues
}
