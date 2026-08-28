/**
 * 自进化信号摘要：作为编排器只读 hint，不得覆盖用户末轮语义。
 * 收敛期默认不注入（MANAGER_EVOLUTION_HINTS_ORCHESTRATOR=0 且 bandit/strategy 关）。
 */

import { buildRouteBanditAdvice, isRouteBanditEnabled } from '../routing/routeBandit'
import { buildRouteStrategyAdvice, isRouteStrategyEnabled } from '../routing/routeStrategy'
import { resolveManagerEnvBool } from '../../../utils/platform/managerEnvModes'
import { isEvolutionRoutingHintEnabled } from './evolutionRoutingGate'

export function isEvolutionHintsForOrchestratorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isEvolutionRoutingHintEnabled(env)) return false
  const raw = String(env.MANAGER_EVOLUTION_HINTS_ORCHESTRATOR ?? '').trim()
  if (raw === '1' || raw.toLowerCase() === 'on') return true
  if (raw === '0' || raw.toLowerCase() === 'off') return false
  return resolveManagerEnvBool('MANAGER_EVOLUTION_HINTS_ORCHESTRATOR', env)
}

export async function summarizeEvolutionHintsForOrchestrator(input: {
  policyDir: string
  sessionId?: string
  toolHealth?: unknown
  /** probe RAG 已命中时剥离「倾向澄清」文案，避免误导编排 */
  probeRagHits?: number
}): Promise<string> {
  if (!isEvolutionHintsForOrchestratorEnabled()) return ''
  const parts: string[] = []
  if (isRouteStrategyEnabled()) {
    try {
      const s = await buildRouteStrategyAdvice(input.policyDir, input.sessionId, input.toolHealth)
      if (s.routerHintBlock?.trim()) parts.push(s.routerHintBlock.trim().slice(0, 360))
    } catch {
      /* optional */
    }
  }
  if (isRouteBanditEnabled()) {
    try {
      const b = await buildRouteBanditAdvice(input.policyDir, input.sessionId)
      if (b.routerHintBlock?.trim()) parts.push(b.routerHintBlock.trim().slice(0, 320))
    } catch {
      /* optional */
    }
  }
  if (!parts.length) return ''
  let text = parts.join('\n')
  if (Number(input.probeRagHits ?? 0) > 0) {
    text = text
      .split('\n')
      .filter((line) => !/倾向澄清|先澄清|clarify/i.test(line))
      .join('\n')
      .trim()
  }
  return text
}
