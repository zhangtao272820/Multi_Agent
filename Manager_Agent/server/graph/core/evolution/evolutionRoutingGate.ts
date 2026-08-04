/**
 * 自进化 → 路由弱参考门禁（与 shared/evolutionConvergence.ts 对齐）。
 *
 * learning / MANAGER_EVOLUTION_ROUTING_CAP=1：允许 Bandit/Strategy/经验回放等注入编排 prompt 或软排序
 *（弱参考）。编排 LLM 仍是 cap 权威，hint 不得静默覆盖用户末轮语义。
 *
 * convergence：默认关闭上述注入，避免噪声抢路由。
 */

function evolutionModeToken(env: NodeJS.ProcessEnv): string {
  return String(env.MANAGER_EVOLUTION_MODE ?? '').trim().toLowerCase()
}

/**
 * 历史命名：是否允许「路由侧学习通道」开启。
 * 实际效果是弱参考（hint / soft order），不是硬改编排 cap。
 */
export function isEvolutionRoutingCapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const m = evolutionModeToken(env)
  if (m === 'learning' || m === 'full' || m === 'bandit') return true
  return String(env.MANAGER_EVOLUTION_ROUTING_CAP ?? '0').trim() === '1'
}

/** 是否允许将自进化信号注入路由/编排 prompt（弱参考；不得直接改 cap） */
export function isEvolutionRoutingHintEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEvolutionRoutingCapEnabled(env)
}
