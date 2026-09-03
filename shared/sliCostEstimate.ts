/**
 * SLI 成本估算：metrics 行无 usd 时按 token × 单价回落。
 */

export function readCostPer1kTokensUsd(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MANAGER_COST_PER_1K_TOKENS_USD ?? 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n
}

export function estimateUsdFromTokens(tokens: number, env: NodeJS.ProcessEnv = process.env): number {
  const tok = Number(tokens)
  if (!Number.isFinite(tok) || tok <= 0) return 0
  const rate = readCostPer1kTokensUsd(env)
  if (rate <= 0) return 0
  return Math.round((tok / 1000) * rate * 1_000_000) / 1_000_000
}

/** 行内 usd 优先；否则 token × MANAGER_COST_PER_1K_TOKENS_USD */
export function resolveMetricRowUsd(
  row: { usd?: unknown; tokens?: unknown },
  env: NodeJS.ProcessEnv = process.env
): number {
  const usd = Number(row?.usd ?? 0)
  if (Number.isFinite(usd) && usd > 0) return usd
  return estimateUsdFromTokens(Number(row?.tokens ?? 0), env)
}
