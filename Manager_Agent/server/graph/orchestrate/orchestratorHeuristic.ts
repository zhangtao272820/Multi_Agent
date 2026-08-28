/**
 * Semantic Router 快路径（参考 LangGraph / RouteLLM）：
 * probe + 用户末轮结构性能力 → 跳过统一编排 full LLM，Planner 仍可做细调。
 * @deprecated B4: heuristic 编排快路径；convergence 默认 LLM-only，仅 MANAGER_ROUTE_MODE=heuristic 或显式开关时使用
 */
import type { PlanBlueprint } from '../llm/planBlueprintLlm'
import type { ExecutableAgent } from '../core/routing/routeFinalize'
import { sortAgentsByPipelineOrder } from '../core/routing/clauses'
import { isProbeDbRoutingRelevant } from '../core/probe/probeInterpretation'
import type { TurnRoutingScope } from '../core/routing/turnScope'
import {
  bundleFromOrchestratorRaw,
  type TaskOrchestratorBundle,
  type TaskOrchestratorRaw
} from '../llm/taskOrchestrator'
import { parseUserExplicitCapabilities } from '../core/memory/userIntentSupremacy'
import { resolveManagerEnvBool } from '../../utils/platform/managerEnvModes'
import { isLlmFirstRouteEnabled } from './unifiedRouting'

export function isOrchestratorHeuristicEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagerEnvBool('MANAGER_ORCHESTRATOR_HEURISTIC', env)
}

export function isOrchestratorCompactFirst(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagerEnvBool('MANAGER_ORCHESTRATOR_COMPACT_FIRST', env)
}

/** 编排 / Judge / Blueprint 使用决策模型档（plus 或 max），不用 flash */
export function isOrchestratorStandardModelTier(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagerEnvBool('MANAGER_ORCHESTRATOR_STANDARD_MODEL', env) || isLlmFirstRouteEnabled(env)
}

export function shouldSkipOrchestratorRagRecall(input: {
  probe?: { rag?: { hits?: number } } | null
  turnScopeMode?: string
  /** Phase3：续轮 / 输出追问且上轮已有单数据面 → 跳过 intent RAG recall */
  turnKind?: string
  sessionAnchorAgents?: string[] | null
}): boolean {
  if (String(process.env.MANAGER_ORCHESTRATOR_SKIP_RAG_RECALL ?? '1').trim() === '0') return false
  if (Number(input.probe?.rag?.hits ?? 0) > 0) return true
  if (String(input.turnScopeMode || '').trim() === 'current_only') return true
  const kind = String(input.turnKind || '').trim()
  const agents = (input.sessionAnchorAgents ?? []).map(String).filter(Boolean)
  const data = agents.filter((a) => a === 'db' || a === 'rag' || a === 'crawler')
  if (
    data.length === 1 &&
    (kind === 'continuation' || kind === 'output_followup' || kind === 'slot_answer')
  ) {
    return true
  }
  return false
}

function probeConfirmsDataPlane(
  caps: ReturnType<typeof parseUserExplicitCapabilities>,
  probe?: { db?: { matched?: boolean; tables?: string[] }; rag?: { hits?: number } } | null
): boolean {
  const ragHits = Number(probe?.rag?.hits ?? 0) || 0
  const dbOk = isProbeDbRoutingRelevant(probe?.db)
  if (caps.dataPlane === 'rag') return ragHits > 0
  if (caps.dataPlane === 'db') return dbOk
  if (caps.dataPlane === 'mixed') {
    const needRag = caps.allowedAgents.has('rag')
    const needDb = caps.allowedAgents.has('db')
    return (!needRag || ragHits > 0) && (!needDb || dbOk)
  }
  return false
}

function buildBlueprint(agents: ExecutableAgent[], lastUser: string): PlanBlueprint {
  const q = String(lastUser || '').trim().slice(0, 320)
  return {
    rationale: 'probe+结构快路径（免统一编排 LLM）',
    steps: agents.map((agent) => ({
      agent,
      queryFocus: q,
      clauseIds: ['c1']
    })),
    confidence: 0.86
  }
}

/** probe 与末轮能力一致时返回编排 bundle，否则 null 走 LLM */
export function buildProbeHeuristicOrchestration(input: {
  lastUser: string
  turnScope: TurnRoutingScope
  probe?: { db?: { matched?: boolean; tables?: string[] }; rag?: { hits?: number } } | null
}): TaskOrchestratorBundle | null {
  const last = String(input.lastUser || '').trim()
  if (last.length < 6) return null

  const caps = parseUserExplicitCapabilities(last)
  if (caps.wantsAdmin || caps.wantsWeb) return null
  if (caps.dataPlane === 'unknown' && caps.allowedAgents.size === 0) return null
  if (!probeConfirmsDataPlane(caps, input.probe)) return null

  const agents = sortAgentsByPipelineOrder([...caps.allowedAgents]) as ExecutableAgent[]
  if (!agents.length) return null

  const dataSources: TaskOrchestratorRaw['dataSources'] = []
  if (caps.allowedAgents.has('db')) dataSources.push('db')
  if (caps.allowedAgents.has('rag')) dataSources.push('rag')
  if (caps.allowedAgents.has('crawler')) dataSources.push('crawler')

  const pipeline = agents.length >= 2 || caps.wantsVisualize || caps.wantsReport
  const intent = pipeline || agents.length >= 2 ? 'multi' : String(agents[0] || 'multi')

  const raw: TaskOrchestratorRaw = {
    turnScopeMode: input.turnScope.mode,
    directChitchatSynth: false,
    coalescedTask: last.slice(0, 900),
    clauses: [
      {
        id: 'c1',
        text: last.slice(0, 480),
        agents: agents.filter((a) => ['db', 'rag', 'crawler'].includes(a)) as TaskOrchestratorRaw['suggestedAgents']
      }
    ],
    timeHints: [],
    subjectHints: [],
    fieldHints: [],
    wantsVisualize: caps.wantsVisualize,
    wantsReport: caps.wantsReport,
    dataSources,
    primaryIntent: (agents[0] as TaskOrchestratorRaw['primaryIntent']) || 'multi',
    isMulti: pipeline,
    suggestedAgents: agents,
    isDbAnchored: caps.dataPlane === 'db' || (caps.dataPlane === 'mixed' && caps.allowedAgents.has('db')),
    needsAdmin: false,
    needsWeb: false,
    explicitWantsReport: caps.wantsReport,
    explicitWantsVisualize: caps.wantsVisualize,
    planShortcut: pipeline ? 'none' : agents[0] === 'rag' ? 'rag_only' : agents[0] === 'db' ? 'db_only' : 'none',
    requiresAgentPipeline: pipeline,
    allowChatWebDirect: !pipeline,
    intent,
    allowedAgents: agents,
    routedQuery: last.slice(0, 1200),
    needsWebSearch: false,
    needsClarify: false,
    planBlueprint: buildBlueprint(agents, last),
    confidence: 0.86,
    rationale: 'probe 命中 + 用户末轮结构性能力解析（免统一编排 LLM）'
  }

  return bundleFromOrchestratorRaw(raw)
}
