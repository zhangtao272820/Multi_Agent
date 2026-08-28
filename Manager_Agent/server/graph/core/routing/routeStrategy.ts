import { readSignals, type UnifiedLearningSignal } from '../unifiedLearning'
import { implicitStressForSession, isImplicitLearningEnabled } from '../evolution/implicitLearning'
import {
  formatRoutePreferencesBlock,
  isRoutePreferenceLearnEnabled,
  loadRoutePreferences,
  maybeRefreshRoutePreferences
} from './routePreferences'
import { applyDeprioritizePreserveOrder } from '#agent-shared/routeAgentOrder'
import { resolveManagerEnvBool } from '../../../utils/platform/managerEnvModes'
import { isEvolutionRoutingHintEnabled } from '../evolution/evolutionRoutingGate'

export type RouteStrategyAdvice = {
  enabled: boolean
  sessionAvgComposite: number | null
  sessionAvgFeedback: number | null
  feedbackCoverage: number
  globalAvgComposite: number | null
  preferClarifyBoost: number
  clarifyThresholdAdjust: number
  forceLowCostMode: boolean
  suppressCanary: boolean
  deprioritizeAgents: string[]
  agentHealthPenalty: Record<string, number>
  routerHintBlock: string
  reasons: string[]
}

/** 收敛期默认关：Strategy hint 不得在未通过路由矩阵前注入编排 prompt */
export function isRouteStrategyEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (!isEvolutionRoutingHintEnabled(env)) return false
  return resolveManagerEnvBool('MANAGER_ROUTE_STRATEGY', env)
}

function sessionSignals(signals: UnifiedLearningSignal[], sessionId?: string, limit = 8) {
  const sid = String(sessionId || '').trim()
  if (!sid) return []
  return signals.filter((s) => s.sessionId === sid).slice(-limit)
}

function avg(nums: number[]) {
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function toolHealthRows(toolHealth: any): Array<{ agent: string; status: string; p95Ms: number }> {
  const arr = toolHealth?.agents
  if (!Array.isArray(arr)) return []
  return arr.map((x: any) => ({
    agent: String(x?.agent || ''),
    status: String(x?.status || 'unknown'),
    p95Ms: Number(x?.p95Ms ?? 0) || 0
  }))
}

/** 会话近期满意度/综合分偏低时抑制金丝雀（policy/prompt/planner 共用） */
export async function shouldSuppressCanaryForSession(
  policyDir: string,
  sessionId?: string
): Promise<boolean> {
  if (!isRouteStrategyEnabled() || !sessionId) return false
  const advice = await buildRouteStrategyAdvice(policyDir, sessionId, null)
  return advice.suppressCanary
}

export async function buildRouteStrategyAdvice(
  policyDir: string,
  sessionId: string | undefined,
  toolHealth: unknown
): Promise<RouteStrategyAdvice> {
  const empty: RouteStrategyAdvice = {
    enabled: isRouteStrategyEnabled(),
    sessionAvgComposite: null,
    sessionAvgFeedback: null,
    feedbackCoverage: 0,
    globalAvgComposite: null,
    preferClarifyBoost: 0,
    clarifyThresholdAdjust: 0,
    forceLowCostMode: false,
    suppressCanary: false,
    deprioritizeAgents: [],
    agentHealthPenalty: {},
    routerHintBlock: '',
    reasons: []
  }
  if (!empty.enabled) return empty

  const signals = await readSignals(policyDir, 400).catch(() => [] as UnifiedLearningSignal[])
  const routePrefs = isRoutePreferenceLearnEnabled() ? await loadRoutePreferences(policyDir).catch(() => null) : null
  const prefsBlock = formatRoutePreferencesBlock(routePrefs)
  const sess = sessionSignals(signals, sessionId, 10)
  const globalRecent = signals.slice(-40)

  const sessionComposites = sess.map((s) => s.compositeScore).filter((x) => Number.isFinite(x))
  const sessionFeedbacks = sess
    .map((s) => s.feedbackScore)
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  const sessionAvgComposite = avg(sessionComposites)
  const sessionAvgFeedback = avg(sessionFeedbacks)
  const feedbackCoverage = sess.length ? sessionFeedbacks.length / sess.length : 0
  const globalAvgComposite = avg(globalRecent.map((s) => s.compositeScore).filter((x) => Number.isFinite(x)))

  const reasons: string[] = []
  let preferClarifyBoost = 0
  let clarifyThresholdAdjust = 0
  let forceLowCostMode = false
  let suppressCanary = false
  const deprioritizeAgents: string[] = []
  const agentHealthPenalty: Record<string, number> = {}

  const lowComposite =
    sessionAvgComposite != null && sessionComposites.length >= 2 && sessionAvgComposite < 0.52
  const lowFeedback =
    sessionAvgFeedback != null &&
    sessionFeedbacks.length >= 2 &&
    feedbackCoverage >= 0.2 &&
    sessionAvgFeedback < 0.42
  const globalStress = globalAvgComposite != null && globalAvgComposite < 0.48 && globalRecent.length >= 8

  if (lowComposite) {
    reasons.push(`会话近期综合分偏低（${sessionAvgComposite?.toFixed(2)}）`)
    preferClarifyBoost += 0.08
    clarifyThresholdAdjust += 0.06
    suppressCanary = true
    forceLowCostMode = true
  }
  if (lowFeedback) {
    reasons.push(`会话近期满意度偏低（${sessionAvgFeedback?.toFixed(2)}）`)
    preferClarifyBoost += 0.06
    clarifyThresholdAdjust += 0.05
    suppressCanary = true
  }
  if (globalStress && !suppressCanary) {
    reasons.push(`全局近期质量承压（均分 ${globalAvgComposite?.toFixed(2)}）`)
    forceLowCostMode = true
  }

  for (const row of toolHealthRows(toolHealth)) {
    if (!row.agent) continue
    if (row.status === 'down') {
      deprioritizeAgents.push(row.agent)
      agentHealthPenalty[row.agent] = 1
      reasons.push(`Agent ${row.agent} 不可用`)
    } else if (row.status === 'degraded') {
      agentHealthPenalty[row.agent] = 0.35
      if (row.p95Ms > 25_000) {
        const stepFloorMs = Math.round(row.p95Ms * 1.2 + 5_000)
        reasons.push(
          `Agent ${row.agent} 历史 P95 延迟 ${row.p95Ms}ms（状态 degraded，非本次超时失败；单步超时下限约 ${stepFloorMs}ms）`
        )
      }
    } else if (row.p95Ms > 45_000) {
      agentHealthPenalty[row.agent] = 0.2
    }
  }

  if (routePrefs?.deprioritize?.length) {
    for (const intent of routePrefs.deprioritize) {
      if (!deprioritizeAgents.includes(intent)) deprioritizeAgents.push(intent)
    }
    reasons.push(`学习信号汇总：近期弱化 ${routePrefs.deprioritize.join('、')}`)
  }

  const recentSlow = sess.filter((s) => (s.durationMs ?? 0) > 90_000)
  if (recentSlow.length >= 2) {
    forceLowCostMode = true
    reasons.push('会话近期多次长耗时 run，启用低成本路由')
  }

  const searchRuns = sess.filter((s) => s.searchRequested)
  const searchMisses = searchRuns.filter((s) => (s.searchHitCount ?? 0) === 0)
  if (searchRuns.length >= 2 && searchMisses.length >= 2) {
    preferClarifyBoost += 0.04
    reasons.push(
      `会话近期联网搜索零命中 ${searchMisses.length}/${searchRuns.length} 次（请检查搜索 API Key 或 query 拆解）`
    )
  }
  const searchApiFails = searchRuns.filter((s) => s.searchFailed)
  if (searchApiFails.length >= 1) {
    reasons.push('近期 SERP 调用失败，联网任务宜先澄清数据源或稍后重试')
  }

  if (sessionId && isImplicitLearningEnabled()) {
    const implicit = await implicitStressForSession(policyDir, sessionId, 10).catch(() => ({
      count: 0,
      ratio: 0,
      kinds: [] as import('../evolution/implicitLearning').ImplicitKind[]
    }))
    if (implicit.count >= 2 || implicit.ratio >= 0.35) {
      preferClarifyBoost += 0.05
      clarifyThresholdAdjust += 0.04
      forceLowCostMode = true
      reasons.push(
        `会话近期隐式负向信号 ${implicit.count} 次（取消/打断/拒绝${implicit.kinds.length ? `：${implicit.kinds.join('、')}` : ''}）`
      )
    }
  }

  const routerHintBlock = [reasons.length ? [
        '【统一策略决策（系统根据健康/学习信号/时延自动生成，非用户新指令）】',
        ...reasons.map((r, i) => `${i + 1}. ${r}`),
        suppressCanary ? '- 本会话已暂停策略/Prompt/Planner 金丝雀试验，优先稳定路径。' : '',
        forceLowCostMode ? '- 本会话倾向低成本模型与精简链路。' : '',
        preferClarifyBoost > 0
          ? '- 近期质量/满意度偏低：仅在确无任何数据面证据时才澄清；probe/文档已命中则必须先执行检索再答。'
          : '',
        deprioritizeAgents.length ? `- 尽量避免或后置：${deprioritizeAgents.join('、')}` : ''
      ]
        .filter(Boolean)
        .join('\n') : '', prefsBlock].filter(Boolean).join('\n\n')

  return {
    enabled: true,
    sessionAvgComposite: sessionAvgComposite != null ? Math.round(sessionAvgComposite * 1000) / 1000 : null,
    sessionAvgFeedback: sessionAvgFeedback != null ? Math.round(sessionAvgFeedback * 1000) / 1000 : null,
    feedbackCoverage: Math.round(feedbackCoverage * 1000) / 1000,
    globalAvgComposite: globalAvgComposite != null ? Math.round(globalAvgComposite * 1000) / 1000 : null,
    preferClarifyBoost: Math.min(0.15, preferClarifyBoost),
    clarifyThresholdAdjust: Math.min(0.12, clarifyThresholdAdjust),
    forceLowCostMode,
    suppressCanary,
    deprioritizeAgents: [...new Set(deprioritizeAgents)],
    agentHealthPenalty,
    routerHintBlock,
    reasons
  }
}

export function applyAgentStrategyFilter(
  agents: string[],
  advice: RouteStrategyAdvice
): string[] {
  if (!advice.deprioritizeAgents.length) return agents
  const dep = new Set(advice.deprioritizeAgents)
  return applyDeprioritizePreserveOrder(agents, (a) => dep.has(a))
}
