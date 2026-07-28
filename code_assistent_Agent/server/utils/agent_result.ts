export type AgentSource = {
  type: 'url' | 'doc' | 'table' | 'sql'
  ref: string
}

/** 与 Manager N2 / U2 对齐的标准失败码 */
export type CodeErrorCode =
  | 'timeout'
  | 'empty_result'
  | 'needs_clarify'
  | 'business'
  | 'tool_round_limit'
  | 'http_5xx'

export type AgentResult = {
  ok: boolean
  agent: string
  trace_id?: string
  answer?: string
  sources?: AgentSource[]
  structured?: Record<string, unknown>
  error_code?: string
  latency_ms?: number
  /** G1：提供商或估算用量，供总管 runBudget */
  usage?: { tokens?: number; usd?: number; actual?: boolean }
}

export function classifyCodeThrownError(error: unknown): CodeErrorCode {
  const msg = String((error as Error)?.message || error || '').toLowerCase()
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('aborted') ||
    msg.includes('deadline')
  ) {
    return 'timeout'
  }
  if (msg.includes('tool_round_limit') || msg.includes('max tool rounds') || msg.includes('recursion limit')) {
    return 'tool_round_limit'
  }
  if (/\b5\d{2}\b/.test(msg) || msg.includes('http_5xx') || msg.includes('internal server')) {
    return 'http_5xx'
  }
  return 'business'
}

export function buildCodeFailAgentResult(params: {
  error_code: CodeErrorCode | string
  answer?: string
  trace_id?: string
  ms?: number
  structured?: Record<string, unknown>
}): AgentResult {
  return {
    ok: false,
    agent: 'code',
    trace_id: params.trace_id,
    answer: params.answer || '',
    structured: params.structured,
    error_code: String(params.error_code || 'business'),
    latency_ms: params.ms
  }
}

export function buildCodeComputeAgentResult(params: {
  answer: string
  trace_id?: string
  ms?: number
  task_kind?: string
  error_code?: string
  usage?: { tokens?: number; usd?: number; actual?: boolean }
}): AgentResult {
  const answer = String(params.answer || '')
  const ok = Boolean(answer.trim()) && !params.error_code
  return {
    ok,
    agent: 'code',
    trace_id: params.trace_id,
    answer,
    structured: {
      task_kind: params.task_kind || 'compute',
      ms: params.ms
    },
    error_code: ok ? undefined : params.error_code || 'empty_result',
    latency_ms: params.ms,
    ...(params.usage ? { usage: params.usage } : {})
  }
}

export function buildCodeRetrieveAgentResult(params: {
  query: string
  hits: number
  snippets: Array<{ path: string; score?: number }>
  trace_id?: string
  ms?: number
}): AgentResult {
  const sources: AgentSource[] = params.snippets
    .map((s) => String(s.path || '').trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((ref) => ({ type: 'doc' as const, ref }))
  return {
    ok: params.hits > 0,
    agent: 'code',
    trace_id: params.trace_id,
    answer: params.query,
    sources: sources.length ? sources : undefined,
    structured: { hits: params.hits, ms: params.ms },
    error_code: params.hits ? undefined : 'empty_result',
    latency_ms: params.ms
  }
}
