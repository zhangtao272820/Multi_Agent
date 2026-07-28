/**
 * G1：跨 Agent AgentResult 出站契约执法（类型层 + 运行时归一）。
 */

export type AgentResultLike = {
  ok?: boolean
  agent?: string
  trace_id?: string
  answer?: string
  error_code?: string
  latency_ms?: number
  usage?: { tokens?: number; usd?: number; actual?: boolean }
  handoff?: { summary?: string; evidenceRefs?: string[]; confidence?: number }
  structured?: Record<string, unknown>
}

export type AgentResultContractViolation = {
  field: string
  message: string
}

export type EnforceAgentResultOptions = {
  /** 失败时缺 error_code 的默认码 */
  defaultFailureCode?: string
  /** 是否记录 contract_violation 到 structured */
  tagViolations?: boolean
}

const REQUIRED_AGENTS = new Set(['db', 'rag', 'code', 'admin', 'crawler', 'gui', 'extractor', 'lobster'])

/** 校验出站形状；返回违规列表（空 = 通过基础形状） */
export function validateAgentResultShape(
  result: AgentResultLike | null | undefined,
  agent?: string
): AgentResultContractViolation[] {
  const violations: AgentResultContractViolation[] = []
  if (!result || typeof result !== 'object') {
    violations.push({ field: 'root', message: 'agentResult missing or not object' })
    return violations
  }
  const a = String(result.agent || agent || '').trim()
  if (!a) violations.push({ field: 'agent', message: 'agent required' })
  if (typeof result.ok !== 'boolean') violations.push({ field: 'ok', message: 'ok must be boolean' })
  if (result.ok === false && !String(result.error_code || '').trim()) {
    violations.push({ field: 'error_code', message: 'error_code required when ok=false' })
  }
  return violations
}

/** 失败缺码 → business；补 agent；可选打 contract_violation 标记 */
export function enforceAgentResultContract<T extends AgentResultLike>(
  result: T,
  opts?: EnforceAgentResultOptions
): T {
  const out = { ...result }
  const agent = String(out.agent || '').trim()
  if (!out.agent && agent) out.agent = agent

  if (out.ok === false && !String(out.error_code || '').trim()) {
    out.error_code = opts?.defaultFailureCode || 'business'
    if (opts?.tagViolations !== false) {
      out.structured = {
        ...(out.structured && typeof out.structured === 'object' ? out.structured : {}),
        contract_violation: 'missing_error_code'
      }
    }
  }

  if (typeof out.latency_ms !== 'number' || !Number.isFinite(out.latency_ms)) {
    const ms = Number((out.structured as { ms?: unknown } | undefined)?.ms)
    if (Number.isFinite(ms) && ms >= 0) out.latency_ms = ms
  }

  return out
}

/** 专家 registry 是否应暴露 AgentResult 契约 */
export function isContractEnforcedAgent(agent: string): boolean {
  const a = String(agent || '').trim().toLowerCase()
  if (!a) return false
  if (REQUIRED_AGENTS.has(a)) return true
  if (a === 'multimodal' || a === 'music' || a === 'video') return true
  return false
}
