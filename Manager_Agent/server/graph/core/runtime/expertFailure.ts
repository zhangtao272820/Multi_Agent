/** N2：专家调用失败分类、有限重试与用户可解释降级话术 */

import type { AgentResult } from '../../../utils/agents/types'
import { isCrawlerTransportError, isRetriableAgentTransportError, withTimeout } from '../../../utils/agents/agentTransport'
import type { ExpertErrorCode } from './observabilitySchema'

export type ClassifiedExpertFailure = {
  code: ExpertErrorCode
  retryable: boolean
  message: string
}

const AGENT_LABEL: Record<string, string> = {
  db: '数据库专家',
  rag: '知识库（RAG）',
  code: '代码专家',
  crawler: '网页抓取',
  gui: 'GUI 执行',
  admin: '办公助手',
  multimodal: '多模态',
  music: '音乐',
  video: '视频',
  clean: '清洗',
  visualize: '可视化',
  report: '报告'
}

function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '').trim()
}

export function classifyExpertFailure(input: {
  error?: unknown
  httpStatus?: number
  agentResult?: Partial<AgentResult> | null
  policy?: string
}): ClassifiedExpertFailure {
  if (input.policy === 'circuit_open_core' || input.policy === 'circuit_degrade_optional') {
    return {
      code: 'circuit_open',
      retryable: false,
      message: '连续失败已触发熔断，本步已跳过'
    }
  }
  if (input.policy === 'budget_exceeded') {
    return {
      code: 'budget_exceeded',
      retryable: false,
      message: '本轮成本预算已超限，后续步骤已跳过'
    }
  }
  if (input.policy === 'overloaded') {
    return {
      code: 'overloaded',
      retryable: false,
      message: '系统并发已满，本步已跳过'
    }
  }
  if (input.policy === 'tool_health_down' || input.policy === 'expert_hard_down') {
    return {
      code: 'network',
      retryable: false,
      message:
        input.policy === 'expert_hard_down'
          ? '专家本轮已判定不可用，后续调用已截断'
          : '专家服务不可用（健康检查未通过）'
    }
  }
  if (input.policy === 'upstream_failed') {
    return {
      code: 'skipped',
      retryable: false,
      message: '上游步骤失败，本步已跳过以免空转'
    }
  }
  if (input.policy === 'deadline_exceeded') {
    return {
      code: 'timeout',
      retryable: false,
      message: '本轮截止时间将近，非关键步骤已截断'
    }
  }

  const arCode = String(input.agentResult?.error_code || '').trim()
  if (input.agentResult?.ok === false && arCode) {
    const code = normalizeErrorCode(arCode)
    return {
      code,
      // 硬失败不可传输重试；业务软失败也不重试
      retryable: false,
      message: arCode
    }
  }

  const status = Number(input.httpStatus)
  if (Number.isFinite(status) && status >= 500) {
    // 仅明确 5xx 允许有限传输重试
    return { code: 'http_5xx', retryable: true, message: `HTTP ${status}` }
  }
  if (Number.isFinite(status) && status >= 400) {
    return { code: 'business', retryable: false, message: `HTTP ${status}` }
  }

  const msg = errMsg(input.error).toLowerCase()
  if (!msg && input.agentResult?.ok === false) {
    return { code: 'business', retryable: false, message: '业务失败' }
  }
  // 可达性/超时：硬失败，不重试（避免 offline 叠乘烧时延与 token）
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
    return { code: 'timeout', retryable: false, message: errMsg(input.error) || 'timeout' }
  }
  if (
    isRetriableAgentTransportError(msg) ||
    isCrawlerTransportError(input.error) ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('enotfound') ||
    msg.includes('econnreset') ||
    msg.includes('network')
  ) {
    return { code: 'network', retryable: false, message: errMsg(input.error) || 'network error' }
  }
  if (msg.includes('http 5') || /\b5\d{2}\b/.test(msg)) {
    return { code: 'http_5xx', retryable: true, message: errMsg(input.error) }
  }
  if (msg) {
    return { code: 'business', retryable: false, message: errMsg(input.error) }
  }
  return { code: 'unknown', retryable: false, message: 'unknown failure' }
}

export function normalizeErrorCode(raw: string): ExpertErrorCode {
  const c = String(raw || '').trim().toLowerCase()
  if (c === 'timeout' || c === 'http_5xx' || c === 'network' || c === 'business') return c
  if (c === 'circuit_open' || c === 'skipped' || c === 'budget_exceeded' || c === 'overloaded') return c
  if (c.includes('budget')) return 'budget_exceeded'
  if (c.includes('timeout')) return 'timeout'
  if (c.includes('circuit')) return 'circuit_open'
  // 专家细码 → ExpertErrorCode（U2 四档）
  if (c === 'vector_not_ready' || c === 'retrieve_timeout') {
    return c.includes('timeout') ? 'timeout' : 'network'
  }
  if (c === 'upstream_failed' || c.startsWith('upstream_')) return 'skipped'
  if (
    c.includes('clarify') ||
    c.includes('empty') ||
    c.includes('schema_miss') ||
    c.includes('needs_human') ||
    c.includes('admin_write') ||
    c.includes('failure') ||
    c === 'business'
  ) {
    return 'business'
  }
  return 'unknown'
}

/**
 * 硬失败：服务不可达 / 超时 / 5xx / 熔断 / 向量未就绪等不可恢复态。
 * 软失败（business miss、clarify、空结果）不 hard-down，避免误杀。
 */
export function isHardExpertFailureCode(code: string | undefined | null): boolean {
  const c = normalizeErrorCode(String(code || ''))
  return (
    c === 'network' ||
    c === 'timeout' ||
    c === 'http_5xx' ||
    c === 'circuit_open' ||
    c === 'budget_exceeded'
  )
}

/** 细码在 normalize 前也可判硬失败（如 vector_not_ready） */
export function isHardExpertFailureRaw(raw: string | undefined | null): boolean {
  const r = String(raw || '').trim().toLowerCase()
  if (!r) return false
  if (r === 'vector_not_ready') return true
  return isHardExpertFailureCode(r)
}

export function classifyAndDetectHard(input: {
  error?: unknown
  httpStatus?: number
  agentResult?: Partial<AgentResult> | null
  policy?: string
}): ClassifiedExpertFailure & { hard: boolean } {
  const classified = classifyExpertFailure(input)
  const raw = String(input.agentResult?.error_code || '').trim()
  const hard =
    isHardExpertFailureCode(classified.code) ||
    isHardExpertFailureRaw(raw) ||
    input.policy === 'expert_hard_down' ||
    input.policy === 'deadline_exceeded' ||
    input.policy === 'upstream_failed'
  return { ...classified, hard }
}

export function buildExpertDegradeMessage(agent: string, code: ExpertErrorCode, detail?: string): string {
  const label = AGENT_LABEL[String(agent || '').trim()] || String(agent || '专家')
  const hint = detail ? `（${detail.slice(0, 120)}）` : ''
  switch (code) {
    case 'timeout':
      return `${label}响应超时，已停止等待${hint}`
    case 'http_5xx':
    case 'network':
      return `${label}暂不可用，已跳过或降级${hint}`
    case 'circuit_open':
      return `${label}连续失败已熔断，本步已跳过${hint}`
    case 'budget_exceeded':
      return `本轮成本预算已超限，后续专家步骤已跳过${hint}`
    case 'overloaded':
      return `系统并发已满，${label}本步已跳过${hint}`
    case 'business':
      return `${label}返回业务失败${hint}`
    case 'skipped':
      return `${label}步骤已跳过${hint}`
    default:
      return `${label}执行失败${hint}`
  }
}

export function readExpertTransportMaxRetries(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MANAGER_EXPERT_TRANSPORT_RETRIES ?? 1)
  if (!Number.isFinite(n)) return 1
  return Math.max(0, Math.min(2, Math.floor(n)))
}

export type FetchWithExpertPolicyOpts = {
  timeoutMs?: number
  maxRetries?: number
  signal?: AbortSignal
  label?: string
}

/** 传输层有限重试：仅 timeout / 5xx / network；业务失败不重试 */
export async function fetchWithExpertPolicy(
  url: string,
  init: RequestInit,
  opts?: FetchWithExpertPolicyOpts
): Promise<Response> {
  const label = opts?.label || 'expert-fetch'
  const maxRetries = opts?.maxRetries ?? readExpertTransportMaxRetries()
  const timeoutMs = Math.max(2_000, Number(opts?.timeoutMs) || 30_000)
  let lastErr: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await withTimeout(
        fetch(url, { ...init, signal: opts?.signal }),
        timeoutMs,
        label,
        opts?.signal
      )
      if (res.status >= 500 && attempt < maxRetries) {
        lastErr = new Error(`${label} HTTP ${res.status}`)
        await sleep(backoffMs(attempt))
        continue
      }
      return res
    } catch (e) {
      lastErr = e
      const classified = classifyExpertFailure({ error: e })
      if (!classified.retryable || attempt >= maxRetries) throw e
      await sleep(backoffMs(attempt))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? `${label} failed`))
}

function backoffMs(attempt: number): number {
  return Math.min(800, 200 * Math.pow(2, attempt))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 从 step outcome 提取标准 error_code */
export function errorCodeFromStepOutcome(input: {
  ok: boolean
  error?: string
  meta?: unknown
  policy?: string
}): string | undefined {
  if (input.ok) return undefined
  const meta = input.meta as { agentResult?: AgentResult } | undefined
  const classified = classifyExpertFailure({
    error: input.error,
    agentResult: meta?.agentResult,
    policy: input.policy
  })
  return classified.code
}

/** worker 步 metrics 标准条目（multi / exec 共用） */
export function buildWorkerStepMetricEntry(input: {
  runId: string
  agent: string
  ms: number
  ok: boolean
  error?: string
  meta?: unknown
  policy?: string
  /** 步输出文本，无 usage 时估算 tokens（chars/2） */
  outputText?: string
}): import('./observabilitySchema').ManagerMetricEntryInput {
  const usage = extractStepUsage(input.meta, input.outputText)
  return {
    runId: input.runId,
    phase: String(input.agent),
    ms: input.ms,
    ok: input.ok,
    agent: String(input.agent),
    tokens: usage.tokens,
    usd: usage.usd,
    error_code: input.ok
      ? undefined
      : errorCodeFromStepOutcome({
          ok: false,
          error: input.error,
          meta: input.meta,
          policy: input.policy
        }),
    extra: usage.actual === false ? { tokenAccounting: 'estimated' } : usage.actual ? { tokenAccounting: 'actual' } : undefined
  }
}

/** 从 AgentResult.usage / structured / 输出长度提取用量 */
export function extractStepUsage(
  meta: unknown,
  outputText?: string
): { tokens?: number; usd?: number; actual?: boolean } {
  const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null
  const ar =
    m && m.agentResult && typeof m.agentResult === 'object'
      ? (m.agentResult as Record<string, unknown>)
      : null
  const usage =
    (ar?.usage && typeof ar.usage === 'object' ? (ar.usage as Record<string, unknown>) : null) ||
    (m?.usage && typeof m.usage === 'object' ? (m.usage as Record<string, unknown>) : null) ||
    (ar?.structured &&
    typeof ar.structured === 'object' &&
    (ar.structured as Record<string, unknown>).usage &&
    typeof (ar.structured as Record<string, unknown>).usage === 'object'
      ? ((ar.structured as Record<string, unknown>).usage as Record<string, unknown>)
      : null)
  if (usage) {
    const tokens = Number(usage.tokens ?? usage.total_tokens ?? 0)
    const usd = Number(usage.usd ?? usage.cost_usd ?? 0)
    const actual = usage.actual === false ? false : true
    return {
      ...(Number.isFinite(tokens) && tokens > 0 ? { tokens } : {}),
      ...(Number.isFinite(usd) && usd > 0 ? { usd } : {}),
      ...(tokens > 0 || usd > 0 ? { actual } : {})
    }
  }
  const text = String(outputText || '').trim()
  if (text.length >= 40) {
    return { tokens: Math.max(1, Math.ceil(text.length / 2)), actual: false }
  }
  return {}
}
