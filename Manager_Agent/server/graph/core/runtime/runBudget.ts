/**
 * E3：单 run 成本硬预算。超限 → error_code=budget_exceeded。
 * MANAGER_RUN_MAX_USD / MANAGER_RUN_MAX_TOKENS；0 或未设 = 不限。
 */

export type RunBudgetLimits = {
  maxUsd: number | null
  maxTokens: number | null
}

export type RunBudgetSpend = {
  usd: number
  tokens: number
}

export type RunBudgetCheck = {
  ok: boolean
  error_code?: 'budget_exceeded'
  reason?: string
  limits: RunBudgetLimits
  spend: RunBudgetSpend
}

export function readRunBudgetLimits(env: NodeJS.ProcessEnv = process.env): RunBudgetLimits {
  const usdRaw = Number(env.MANAGER_RUN_MAX_USD ?? 0)
  const tokRaw = Number(env.MANAGER_RUN_MAX_TOKENS ?? 0)
  return {
    maxUsd: Number.isFinite(usdRaw) && usdRaw > 0 ? usdRaw : null,
    maxTokens: Number.isFinite(tokRaw) && tokRaw > 0 ? Math.floor(tokRaw) : null
  }
}

export function checkRunBudget(spend: RunBudgetSpend, env: NodeJS.ProcessEnv = process.env): RunBudgetCheck {
  const limits = readRunBudgetLimits(env)
  const usd = Math.max(0, Number(spend.usd) || 0)
  const tokens = Math.max(0, Number(spend.tokens) || 0)
  const base = { limits, spend: { usd, tokens } }
  if (limits.maxUsd != null && usd > limits.maxUsd) {
    return {
      ok: false,
      error_code: 'budget_exceeded',
      reason: `run USD ${usd.toFixed(4)} > max ${limits.maxUsd}`,
      ...base
    }
  }
  if (limits.maxTokens != null && tokens > limits.maxTokens) {
    return {
      ok: false,
      error_code: 'budget_exceeded',
      reason: `run tokens ${tokens} > max ${limits.maxTokens}`,
      ...base
    }
  }
  return { ok: true, ...base }
}

/** 诚实标注：有 usd>0 记为含实测；纯 tokens 无 usd → estimated */
export function resolveTokenAccounting(
  rows: Array<{ tokens?: unknown; usd?: unknown; usageActual?: unknown }>
): 'estimated' | 'mixed' | 'actual' {
  let hasActual = false
  let hasEstimated = false
  for (const r of rows) {
    const tok = Number(r?.tokens || 0)
    if (!Number.isFinite(tok) || tok <= 0) continue
    if (r?.usageActual === true || (Number(r?.usd) || 0) > 0) hasActual = true
    else hasEstimated = true
  }
  if (hasActual && hasEstimated) return 'mixed'
  if (hasActual) return 'actual'
  return 'estimated'
}
