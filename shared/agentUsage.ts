/**
 * G1：专家 AgentResult.usage 归一化（LangChain / OpenAI 形态 → 总管 extractStepUsage）。
 * actual=true：提供商回传；缺省则 chars/2 估算。
 */

export type AgentUsage = {
  tokens?: number
  usd?: number
  actual?: boolean
}

function positiveInt(n: unknown): number | undefined {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return undefined
  return Math.ceil(v)
}

function positiveNum(n: unknown): number | undefined {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return undefined
  return v
}

/** 从 LangChain usage_metadata / tokenUsage / OpenAI usage 抽 tokens（可累加） */
export function normalizeLlmUsage(raw: unknown): AgentUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const tokens =
    positiveInt(u.total_tokens) ??
    positiveInt(u.totalTokens) ??
    (() => {
      const inT =
        positiveInt(u.input_tokens) ??
        positiveInt(u.prompt_tokens) ??
        positiveInt(u.promptTokens) ??
        0
      const outT =
        positiveInt(u.output_tokens) ??
        positiveInt(u.completion_tokens) ??
        positiveInt(u.completionTokens) ??
        0
      const sum = inT + outT
      return sum > 0 ? sum : undefined
    })()
  const usd = positiveNum(u.usd) ?? positiveNum(u.cost_usd) ?? positiveNum(u.total_cost)
  if (!tokens && !usd) return undefined
  return {
    ...(tokens ? { tokens } : {}),
    ...(usd ? { usd } : {}),
    actual: u.actual === false ? false : true
  }
}

/** 无提供商用量时按输出长度估算（与 Manager extractStepUsage 同口径） */
export function estimateUsageFromText(text: string): AgentUsage | undefined {
  const s = String(text || '').trim()
  if (s.length < 40) return undefined
  return { tokens: Math.max(1, Math.ceil(s.length / 2)), actual: false }
}

/** 优先真实 usage，否则估算 */
export function resolveAgentUsage(input: {
  llmUsage?: unknown
  answerText?: string
}): AgentUsage | undefined {
  const fromLlm = normalizeLlmUsage(input.llmUsage)
  if (fromLlm?.tokens || fromLlm?.usd) return fromLlm
  return estimateUsageFromText(String(input.answerText || ''))
}

/** 累加多次 LLM 调用用量 */
export function accumulateLlmUsage(acc: AgentUsage | undefined, raw: unknown): AgentUsage | undefined {
  const next = normalizeLlmUsage(raw)
  if (!next) return acc
  if (!acc) return next
  const tokens = (acc.tokens || 0) + (next.tokens || 0)
  const usd = (acc.usd || 0) + (next.usd || 0)
  return {
    ...(tokens > 0 ? { tokens } : {}),
    ...(usd > 0 ? { usd } : {}),
    actual: acc.actual === false || next.actual === false ? false : true
  }
}
