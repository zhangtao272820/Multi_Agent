/**
 * 路由决策升档：仅 ambiguous / high complexity / cascade 二次pass 才用 ROUTE_MAX（=CAP_REASON）。
 * 默认主编排保持 CAP_ROUTE（T0），禁止无差别烧 T1。
 */
export function shouldEscalateRouteDecisionToMax(
  state?: unknown,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const force = String(env.MANAGER_ROUTE_DECISION_TIER || '')
    .trim()
    .toLowerCase()
  if (force === 'max' || force.startsWith('qwen-max')) return true

  const meta = (state as { meta?: Record<string, unknown> } | null)?.meta
  if (!meta || typeof meta !== 'object') return false

  const commitment = String(meta.sourceCommitment || '').trim().toLowerCase()
  if (commitment === 'ambiguous') return true

  const complexity = String(meta.complexity || '').trim().toLowerCase()
  if (complexity === 'high') return true

  const selfCheck = meta.selfCheck
  if (selfCheck && typeof selfCheck === 'object') {
    if ((selfCheck as { needsSecondPass?: boolean }).needsSecondPass === true) return true
  }

  if (meta.routeEscalateMax === true) return true
  return false
}

/** 二次审查（align/plane）把编排 raw 的 commitment/complexity 注入假 meta，供升档判定 */
export function stateWithRouteEscalateHints(
  state: unknown,
  raw?: Record<string, unknown> | null
): unknown {
  if (!raw || typeof raw !== 'object') return state
  const prev =
    state && typeof state === 'object'
      ? (state as { meta?: Record<string, unknown> })
      : { meta: {} }
  const meta = {
    ...(prev.meta && typeof prev.meta === 'object' ? prev.meta : {}),
    sourceCommitment: raw.sourceCommitment ?? prev.meta?.sourceCommitment,
    complexity: raw.complexity ?? prev.meta?.complexity,
    selfCheck: raw.selfCheck ?? prev.meta?.selfCheck
  }
  return { ...(prev as object), meta }
}
