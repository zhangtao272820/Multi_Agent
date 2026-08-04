/**
 * 统一编排器结构性不变量（唯一后处理入口，替代分散的 route/composite/align 补丁链）。
 * 只做拓扑/数据面/写闸，不做正则意图判断。
 */

import type { TaskOrchestratorBundle } from '../llm/taskOrchestrator'
import type { TurnRoutingScope } from '../core/routing/turnScope'
import {
  alignAllowedAgentsWithDataPlane,
  ensureMultiIntentForPipeline,
  reconcileIntentClassifyDataPlane,
  requiresAgentPipelineExecution,
  stripDbUnlessDbAnchored
} from './routeOrchestration'
import { alignAllowedAgentsWithUnderstanding } from '../core/routing/routeUnderstandAlign'
import { filterAgentsRespectingWriteGate } from '../core/db/writeGate'
import {
  finalizeLlmAllowedAgents,
  finalizeLlmRouteIntent,
  type ExecutableAgent
} from '../core/routing/routeFinalize'
import type { PlanBlueprint } from '../llm/planBlueprintLlm'
import { buildTopologyBlueprintFromCap, blueprintCoversRequiredAgents, buildBlueprintFromPuStackDispatch } from '../llm/planBlueprintLlm'
import { stepDispatchDraftFromMeta } from '../core/proPuStack'
import {
  applyCapFloor,
  freezeCapAuthorityMeta,
  syncDbAnchorFromOrchestratorEvidence,
  type OrchestratorCapPolicy
} from './orchestratorCapPolicy'
import { planUpgradeMetaFromRaw } from '../core/plan/planUpgrade'
import { isPuStackOrchestratorAuthority, capFloorFromPuStackMeta } from './puStackOrchestratorAuthority'
import { shouldApplyFrozenPuCap } from '../core/routing/proRoutePolicy'
import { isLlmFirstRouteEnabled } from './unifiedRouting'
import { rematerializeWeatherCrawlerMisbind } from './weatherAdminBoundary'
import { rematerializeMapCrawlerMisbind } from './mapAdminBoundary'
import { inferPipelineHintsStructural } from '../llm/pipelineHintsLlm'
import {
  adminExplicitlyRequested,
  applyOrchestratorCapAlignment,
  collectExplicitOrchestratorAgents,
  filterBlueprintToExplicitAgents,
  reconcileClassifyAgainstExplicitAgents,
  stripSpuriousOptionalAgents
} from '../core/agent/agentPollutionGuard'
import { sortAgentsByPipelineOrder } from '../core/routing/clauses'
import type { TaskClause } from '../core/routing/clauses'
import { repairOrchestratorClauses } from '../core/routing/clauseStructuralRepair'
import {
  inferDbAnchorFromProbe,
  mergeDataSourcesWithClauses
} from '../core/probe/probeRoutingAnchor'
import type { ProbeDbSlice } from '../core/probe/probeInterpretation'

const WEB_CAP_AGENTS = new Set(['crawler', 'music', 'video'])

/** 编排置信 → meta.routeConfidence；禁止落成 0（会被学习看板当成「无置信」） */
function clampRouteConfidence(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 0.65
  if (n < 0.35) return 0.65
  return Math.min(1, Math.max(0.35, n))
}

/** needsWebSearch 须同时：cap 含公网 agent，且存在对应子句或 draft 绑定 */
function resolveNeedsWebSearchFlag(input: {
  allowed: string[]
  clauses: TaskClause[]
  draft?: Array<{ agent?: string }> | null
  bundleNeedsWeb?: boolean
}): boolean {
  const capHasWeb = input.allowed.some((a) => WEB_CAP_AGENTS.has(String(a)))
  if (!capHasWeb) return false
  const clauseBound = input.clauses.some((c) =>
    (c.agents ?? []).some((a) => WEB_CAP_AGENTS.has(String(a)))
  )
  const draftBound = (input.draft ?? []).some((d) => WEB_CAP_AGENTS.has(String(d.agent || '')))
  if (!clauseBound && !draftBound) return false
  return input.bundleNeedsWeb === true || capHasWeb
}

/** 复合任务：cap 含 crawler 但无 crawler 子句/draft 时剔除（禁止知识库/天气误扩公网） */
function stripUnboundCrawlerFromCap(
  allowed: ExecutableAgent[],
  clauses: TaskClause[],
  draft?: Array<{ agent?: string }> | null
): ExecutableAgent[] {
  if (clauses.length < 2 && !(draft && draft.length >= 2)) return allowed
  const bound =
    clauses.some((c) => (c.agents ?? []).includes('crawler' as TaskClause['agents'][number])) ||
    (draft ?? []).some((d) => String(d.agent || '') === 'crawler')
  if (bound) return allowed
  return allowed.filter((a) => String(a) !== 'crawler') as ExecutableAgent[]
}

export type OrchestratorDecision = TaskOrchestratorBundle & {
  intent: string
  allowedAgents: ExecutableAgent[]
  metaPatch: Record<string, unknown>
}

function filterBlueprintToCap(blueprint: PlanBlueprint | null, cap: Set<string>): PlanBlueprint | null {
  return filterBlueprintToExplicitAgents(blueprint, cap)
}

/** PU-Stack 权威：冻结 cap，禁止后处理删 agent */
function applyFrozenPuOrchestratorDecision(input: {
  bundle: TaskOrchestratorBundle
  turnScope: TurnRoutingScope
  state?: { meta?: unknown; probe?: { db?: ProbeDbSlice; rag?: { hits?: number } } }
  routerCapBaseline?: ExecutableAgent[]
}): OrchestratorDecision {
  const routingMeta = input.state?.meta
  const capFloor = capFloorFromPuStackMeta(routingMeta, input.state?.probe ?? null)
  let clauses = input.bundle.clauses
  const draft = stepDispatchDraftFromMeta(routingMeta)
  if (draft.length >= 2) {
    clauses = draft.map((d, i) => ({
      id: String(d.clauseIds?.[0] || `c${i + 1}`),
      text: String(d.scopedUserLanguage || '').trim().slice(0, 480),
      layer: ['rag', 'db', 'crawler'].includes(String(d.agent))
        ? ('data' as const)
        : String(d.agent) === 'admin'
          ? ('action' as const)
          : undefined,
      agents: [String(d.agent)] as TaskClause['agents']
    }))
  }
  let classify = mergeDataSourcesWithClauses(input.bundle.intentClassify, clauses)
  if (capFloor.includes('admin')) {
    classify = {
      ...classify,
      needsAdmin: true,
      suggestedAgents: [...new Set([...(classify.suggestedAgents ?? []), 'admin'])]
    }
  }
  let allowed = applyCapFloor(
    sortAgentsByPipelineOrder([
      ...(input.routerCapBaseline ?? input.bundle.allowedAgents),
      ...capFloor
    ]) as ExecutableAgent[],
    capFloor
  )
  allowed = filterAgentsRespectingWriteGate(allowed, input.state ?? {}) as ExecutableAgent[]
  classify = syncDbAnchorFromOrchestratorEvidence(classify, clauses, allowed)

  // 冻结 PU 路径也须天气/地图契约（否则 bypass LLM 编排时 crawler 误绑无法纠正）
  const weatherFixPu = rematerializeWeatherCrawlerMisbind({
    allowedAgents: allowed,
    clauses,
    classify,
    planBlueprint: input.bundle.planBlueprint ?? null,
    stepDispatchDraft: draft,
    needsWebSearch: input.bundle.needsWebSearch === true
  })
  const mapFixPu = rematerializeMapCrawlerMisbind({
    allowedAgents: weatherFixPu.allowedAgents,
    clauses: weatherFixPu.clauses,
    classify: weatherFixPu.classify,
    planBlueprint: weatherFixPu.planBlueprint,
    stepDispatchDraft: weatherFixPu.stepDispatchDraft?.length
      ? weatherFixPu.stepDispatchDraft
      : draft,
    needsWebSearch: weatherFixPu.needsWebSearch === true
  })
  allowed = mapFixPu.allowedAgents
  clauses = mapFixPu.clauses
  classify = mapFixPu.classify
  const draftAfterWeather = mapFixPu.stepDispatchDraft?.length
    ? mapFixPu.stepDispatchDraft
    : draft

  const capDataSources = [...new Set(allowed.filter((a) => ['rag', 'db', 'crawler'].includes(String(a))))] as Array<
    'rag' | 'db' | 'crawler'
  >
  if (capDataSources.length) {
    classify = {
      ...classify,
      dataSources: capDataSources,
      isMulti: capDataSources.length >= 2 || allowed.length >= 3,
      isDbAnchored: allowed.includes('db'),
      needsAdmin: allowed.includes('admin'),
      needsWeb: allowed.includes('crawler'),
      suggestedAgents: allowed,
      requiresAgentPipeline: allowed.some((a) =>
        ['clean', 'code', 'visualize', 'report'].includes(String(a))
      ),
      planShortcut: 'none'
    }
  }
  const pipelineRequired = requiresAgentPipelineExecution(classify, allowed)
  let intent = finalizeLlmRouteIntent(input.bundle.intent, allowed, null)
  intent = ensureMultiIntentForPipeline(intent, allowed, pipelineRequired)
  let planBlueprint = mapFixPu.planBlueprint ?? input.bundle.planBlueprint
  const mustCover = allowed.filter((a) =>
    ['rag', 'db', 'crawler', 'clean', 'code', 'visualize', 'report', 'admin'].includes(String(a))
  )
  const userTask = String(input.bundle.coalescedTask || input.turnScope.lastOnly || '').trim()
  if (draftAfterWeather.length >= 2) {
    planBlueprint =
      buildBlueprintFromPuStackDispatch({
        allowedAgents: allowed.map(String),
        clauses,
        stepDispatchDraft: draftAfterWeather,
        userTask
      }) ?? planBlueprint
  }
  if (!blueprintCoversRequiredAgents(planBlueprint, mustCover)) {
    planBlueprint =
      buildTopologyBlueprintFromCap({
        allowedAgents: allowed,
        clauses,
        constraints: input.bundle.constraints,
        userTask
      }) ?? planBlueprint
  }
  const adminApiClearedWeb =
    (weatherFixPu.changed && weatherFixPu.needsWebSearch === false) ||
    (mapFixPu.changed && mapFixPu.needsWebSearch === false)
  const needsWebSearch = resolveNeedsWebSearchFlag({
    allowed: allowed.map(String),
    clauses,
    draft: draftAfterWeather,
    bundleNeedsWeb: adminApiClearedWeb ? false : input.bundle.needsWebSearch === true
  })
  const compositeDataWeb =
    classify.needsWeb &&
    (classify.dataSources?.includes('rag') || classify.dataSources?.includes('db')) &&
    allowed.length >= 2
  const routeConfidence = clampRouteConfidence(classify.confidence)
  const metaPatch: Record<string, unknown> = {
    unifiedOrchestrator: true,
    orchestratorMode: 'pu_stack',
    turnScopeMode: input.turnScope.mode,
    turnKind: input.turnScope.turnKind,
    intentClassify: classify,
    intentClassifyMode: 'orchestrator',
    taskConstraints: input.bundle.constraints,
    taskClauses: clauses,
    clauseDecomposeMode: 'orchestrator',
    planBlueprint: planBlueprint ?? undefined,
    requiresAgentPipeline: pipelineRequired,
    allowChatWebDirect: pipelineRequired ? false : classify.allowChatWebDirect,
    nlHeuristicTask: input.bundle.coalescedTask,
    orchestratorCapFloor: capFloor,
    orchestratorCapPolicy: 'frozen',
    needsWebSearch,
    compositeDataWebRoute: compositeDataWeb,
    routeConfidence,
    uncertainty: routeConfidence >= 0.75 ? 'low' : routeConfidence >= 0.5 ? 'medium' : 'high',
    ...(draftAfterWeather.length ? { stepDispatchDraft: draftAfterWeather } : {}),
    ...(input.bundle.raw.codeMode && input.bundle.raw.codeMode !== 'auto'
      ? { codeMode: input.bundle.raw.codeMode }
      : {}),
    ...planUpgradeMetaFromRaw(input.bundle.raw as unknown as Record<string, unknown>)
  }
  return {
    ...input.bundle,
    clauses,
    intentClassify: classify,
    intent,
    allowedAgents: allowed,
    planBlueprint,
    needsWebSearch,
    needsClarify: input.bundle.needsClarify,
    clarifyQuestions: input.bundle.needsClarify ? input.bundle.clarifyQuestions : [],
    metaPatch: freezeCapAuthorityMeta(metaPatch)
  }
}

/** LLM-First：信任编排 LLM cap/蓝图，仅写闸 + 拓扑排序 + 蓝图裁剪 + 可选 Agent 污染剔除 */
function applyLlmFirstOrchestratorDecision(input: {
  bundle: TaskOrchestratorBundle
  turnScope: TurnRoutingScope
  state?: { meta?: unknown; probe?: { db?: ProbeDbSlice; rag?: { hits?: number } } }
}): OrchestratorDecision {
  let clauses = input.bundle.clauses
  let classify = input.bundle.intentClassify
  const constraints = input.bundle.constraints
  const explicitAgents = collectExplicitOrchestratorAgents({
    classify,
    clauses,
    suggestedAgents: input.bundle.raw.suggestedAgents
  })
  classify = reconcileClassifyAgainstExplicitAgents(classify, explicitAgents)
  if (
    !adminExplicitlyRequested({
      classify,
      clauses,
      suggestedAgents: input.bundle.raw.suggestedAgents
    })
  ) {
    classify = { ...classify, needsAdmin: false, suggestedAgents: classify.suggestedAgents.filter((a) => a !== 'admin') }
  }
  let allowed = sortAgentsByPipelineOrder([...input.bundle.allowedAgents]) as ExecutableAgent[]
  allowed = stripSpuriousOptionalAgents(allowed, explicitAgents)
  const aligned = applyOrchestratorCapAlignment({
    allowed,
    classify,
    clauses,
    suggestedAgents: input.bundle.raw.suggestedAgents
  })
  allowed = aligned.allowed
  classify = aligned.classify
  allowed = filterAgentsRespectingWriteGate(allowed, input.state ?? {}) as ExecutableAgent[]
  let planBlueprint = input.bundle.planBlueprint ?? null
  const routingMeta = input.state?.meta
  let alignedDraft = input.bundle.stepDispatchDraft?.length
    ? input.bundle.stepDispatchDraft
    : stepDispatchDraftFromMeta(routingMeta)

  // 天气/地图能力契约：crawler 误绑 → admin（须在 stripUnboundCrawler 之前）
  const weatherFix = rematerializeWeatherCrawlerMisbind({
    allowedAgents: allowed,
    clauses,
    classify,
    planBlueprint,
    stepDispatchDraft: alignedDraft,
    needsWebSearch: input.bundle.needsWebSearch === true
  })
  const mapFix = rematerializeMapCrawlerMisbind({
    allowedAgents: weatherFix.allowedAgents,
    clauses: weatherFix.clauses,
    classify: weatherFix.classify,
    planBlueprint: weatherFix.planBlueprint,
    stepDispatchDraft: weatherFix.stepDispatchDraft,
    needsWebSearch: weatherFix.needsWebSearch === true
  })
  allowed = mapFix.allowedAgents
  clauses = mapFix.clauses
  classify = mapFix.classify
  planBlueprint = mapFix.planBlueprint
  if (mapFix.stepDispatchDraft) alignedDraft = mapFix.stepDispatchDraft

  allowed = stripUnboundCrawlerFromCap(allowed, clauses, alignedDraft)
  classify = {
    ...classify,
    dataSources: (classify.dataSources ?? []).filter(
      (d) => d !== 'crawler' || allowed.map(String).includes('crawler')
    ) as typeof classify.dataSources,
    needsWeb: allowed.map(String).includes('crawler') ? classify.needsWeb : false,
    needsAdmin: allowed.map(String).includes('admin') ? true : classify.needsAdmin
  }
  const userTask = String(
    input.bundle.coalescedTask || input.turnScope.lastOnly || input.bundle.routedQuery || ''
  ).trim()

  if (alignedDraft.length >= 1) {
    planBlueprint =
      buildBlueprintFromPuStackDispatch({
        allowedAgents: allowed.map(String),
        clauses,
        stepDispatchDraft: alignedDraft,
        userTask
      }) ?? planBlueprint
  }

  const pipelineRequired = requiresAgentPipelineExecution(classify, allowed)
  let intent = finalizeLlmRouteIntent(input.bundle.intent, allowed, null)
  intent = ensureMultiIntentForPipeline(intent, allowed, pipelineRequired)
  const capSet = new Set(allowed.map(String))
  planBlueprint = filterBlueprintToCap(planBlueprint, capSet)
  const needsWebSearch = resolveNeedsWebSearchFlag({
    allowed: allowed.map(String),
    clauses,
    draft: alignedDraft,
    bundleNeedsWeb:
      (weatherFix.changed && weatherFix.needsWebSearch === false) ||
      (mapFix.changed && mapFix.needsWebSearch === false)
        ? false
        : input.bundle.needsWebSearch === true
  })
  const routeConfidence = clampRouteConfidence(classify.confidence)
  const metaPatch: Record<string, unknown> = {
    unifiedOrchestrator: true,
    orchestratorMode: 'llm_first',
    turnScopeMode: input.turnScope.mode,
    turnKind: input.turnScope.turnKind,
    intentClassify: classify,
    intentClassifyMode: 'orchestrator',
    taskConstraints: constraints,
    taskClauses: clauses,
    clauseDecomposeMode: 'orchestrator',
    planBlueprint: planBlueprint ?? undefined,
    needsWebSearch,
    requiresAgentPipeline: pipelineRequired,
    allowChatWebDirect: classify.allowChatWebDirect,
    nlHeuristicTask: input.bundle.coalescedTask,
    needsClarify: input.bundle.needsClarify,
    clarifyQuestions: input.bundle.needsClarify ? input.bundle.clarifyQuestions : [],
    routeConfidence,
    uncertainty: routeConfidence >= 0.75 ? 'low' : routeConfidence >= 0.5 ? 'medium' : 'high',
    ...(alignedDraft.length ? { stepDispatchDraft: alignedDraft } : {}),
    ...(input.bundle.raw.codeMode && input.bundle.raw.codeMode !== 'auto'
      ? { codeMode: input.bundle.raw.codeMode }
      : {}),
    ...planUpgradeMetaFromRaw(input.bundle.raw as unknown as Record<string, unknown>)
  }
  return {
    ...input.bundle,
    clauses,
    intentClassify: classify,
    intent,
    allowedAgents: allowed,
    planBlueprint,
    needsWebSearch,
    needsClarify: input.bundle.needsClarify,
    clarifyQuestions: input.bundle.needsClarify ? input.bundle.clarifyQuestions : [],
    metaPatch
  }
}

/** 将统一编排 LLM 产出收敛为可执行路由决策 */
export function applyOrchestratorInvariants(input: {
  bundle: TaskOrchestratorBundle
  turnScope: TurnRoutingScope
  state?: { meta?: unknown; probe?: { db?: ProbeDbSlice; rag?: { hits?: number } } }
  routerCapBaseline?: ExecutableAgent[]
  capPolicy?: OrchestratorCapPolicy
}): OrchestratorDecision {
  const routingMeta = input.state?.meta
  if (isLlmFirstRouteEnabled()) {
    return applyLlmFirstOrchestratorDecision(input)
  }
  if (shouldApplyFrozenPuCap(routingMeta, input.capPolicy)) {
    return applyFrozenPuOrchestratorDecision(input)
  }
  let clauses = input.bundle.clauses
  let classify = mergeDataSourcesWithClauses(input.bundle.intentClassify, clauses)
  classify = inferDbAnchorFromProbe({
    classify,
    probe: input.state?.probe ?? null,
    clauses
  })
  const repairedDs = (classify.dataSources ?? []) as Array<'rag' | 'db' | 'crawler'>
  if (repairedDs.length >= 2) {
    clauses = repairOrchestratorClauses(clauses, repairedDs, input.turnScope.lastOnly)
    classify = mergeDataSourcesWithClauses(classify, clauses)
  }
  classify = reconcileIntentClassifyDataPlane(classify, clauses)
  const constraints = input.bundle.constraints
  const explicitAgents = collectExplicitOrchestratorAgents({
    classify,
    clauses,
    suggestedAgents: input.bundle.raw.suggestedAgents
  })
  classify = reconcileClassifyAgainstExplicitAgents(classify, explicitAgents)
  if (
    !adminExplicitlyRequested({
      classify,
      clauses,
      suggestedAgents: input.bundle.raw.suggestedAgents
    })
  ) {
    classify = { ...classify, needsAdmin: false, suggestedAgents: classify.suggestedAgents.filter((a) => a !== 'admin') }
  }
  const baseline = input.routerCapBaseline ?? input.bundle.allowedAgents

  let allowed = alignAllowedAgentsWithUnderstanding({
    routerAllowed: [...baseline],
    intentClassify: classify,
    clauses,
    constraints,
    userText: input.turnScope.lastOnly
  })

  allowed = alignAllowedAgentsWithDataPlane(allowed, classify, baseline)

  allowed = finalizeLlmAllowedAgents(
    finalizeLlmRouteIntent(input.bundle.intent, allowed, null),
    allowed,
    null
  )
  allowed = stripDbUnlessDbAnchored(allowed, classify)
  allowed = stripSpuriousOptionalAgents(allowed, explicitAgents)
  const aligned = applyOrchestratorCapAlignment({
    allowed,
    classify,
    clauses,
    suggestedAgents: input.bundle.raw.suggestedAgents
  })
  allowed = aligned.allowed
  classify = aligned.classify
  allowed = filterAgentsRespectingWriteGate(allowed, input.state ?? {}) as ExecutableAgent[]
  allowed = sortAgentsByPipelineOrder(allowed) as ExecutableAgent[]
  let classicDraft = stepDispatchDraftFromMeta(input.state?.meta)

  const weatherFixClassic = rematerializeWeatherCrawlerMisbind({
    allowedAgents: allowed,
    clauses,
    classify,
    planBlueprint: input.bundle.planBlueprint ?? null,
    stepDispatchDraft: classicDraft,
    needsWebSearch: input.bundle.needsWebSearch === true
  })
  const mapFixClassic = rematerializeMapCrawlerMisbind({
    allowedAgents: weatherFixClassic.allowedAgents,
    clauses: weatherFixClassic.clauses,
    classify: weatherFixClassic.classify,
    planBlueprint: weatherFixClassic.planBlueprint,
    stepDispatchDraft: weatherFixClassic.stepDispatchDraft,
    needsWebSearch: weatherFixClassic.needsWebSearch === true
  })
  allowed = mapFixClassic.allowedAgents
  clauses = mapFixClassic.clauses
  classify = mapFixClassic.classify
  if (mapFixClassic.stepDispatchDraft) classicDraft = mapFixClassic.stepDispatchDraft

  allowed = stripUnboundCrawlerFromCap(allowed, clauses, classicDraft)
  classify = {
    ...classify,
    dataSources: (classify.dataSources ?? []).filter(
      (d) => d !== 'crawler' || allowed.map(String).includes('crawler')
    ) as typeof classify.dataSources,
    needsWeb: allowed.map(String).includes('crawler') ? classify.needsWeb : false,
    needsAdmin: allowed.map(String).includes('admin') ? true : classify.needsAdmin
  }

  const pipelineRequired = requiresAgentPipelineExecution(classify, allowed)
  let intent = finalizeLlmRouteIntent(input.bundle.intent, allowed, null)
  intent = ensureMultiIntentForPipeline(intent, allowed, pipelineRequired)
  allowed = sortAgentsByPipelineOrder(finalizeLlmAllowedAgents(intent, allowed, null)) as ExecutableAgent[]

  const capSet = new Set(allowed.map(String))
  let planBlueprint = filterBlueprintToCap(
    mapFixClassic.planBlueprint ?? input.bundle.planBlueprint,
    capSet
  )
  const mustCover = allowed.filter((a) =>
    ['rag', 'db', 'crawler', 'clean', 'code', 'visualize', 'report', 'admin'].includes(String(a))
  )
  if (!blueprintCoversRequiredAgents(planBlueprint, mustCover)) {
    planBlueprint =
      buildTopologyBlueprintFromCap({
        allowedAgents: allowed,
        clauses,
        constraints: input.bundle.constraints,
        userTask: input.bundle.coalescedTask || input.turnScope.lastOnly
      }) ?? planBlueprint
  }
  const pipelineHints = inferPipelineHintsStructural({
    allowedAgents: allowed,
    constraints: input.bundle.constraints
  })

  const compositeDataWeb =
    classify.needsWeb &&
    (classify.dataSources?.includes('rag') || classify.dataSources?.includes('db')) &&
    allowed.length >= 2

  const needsWebSearch = resolveNeedsWebSearchFlag({
    allowed: allowed.map(String),
    clauses,
    draft: classicDraft,
    bundleNeedsWeb:
      (weatherFixClassic.changed && weatherFixClassic.needsWebSearch === false) ||
      (mapFixClassic.changed && mapFixClassic.needsWebSearch === false)
        ? false
        : input.bundle.needsWebSearch === true
  })

  const metaPatch: Record<string, unknown> = {
    unifiedOrchestrator: true,
    orchestratorMode: 'llm',
    turnScopeMode: input.turnScope.mode,
    turnKind: input.turnScope.turnKind,
    turnScopeLlm: {
      mode: input.bundle.turnScopeMode,
      directChitchatSynth: input.bundle.directChitchatSynth,
      confidence: classify.confidence,
      rationale: classify.rationale
    },
    intentClassify: classify,
    intentClassifyMode: 'orchestrator',
    taskConstraints: constraints,
    taskClauses: clauses,
    clauseDecomposeMode: 'orchestrator',
    planBlueprint: planBlueprint ?? undefined,
    ...(pipelineHints ? { pipelineHints } : {}),
    needsWebSearch,
    requiresAgentPipeline: pipelineRequired,
    allowChatWebDirect: pipelineRequired ? false : classify.allowChatWebDirect,
    chatWebOnly: false,
    compositeDataWebRoute: compositeDataWeb,
    nlHeuristicTask: input.bundle.coalescedTask,
    directChitchatSynth: input.bundle.directChitchatSynth,
    needsClarify: input.bundle.needsClarify,
    clarifyQuestions: input.bundle.needsClarify ? input.bundle.clarifyQuestions : [],
    routeConfidence: clampRouteConfidence(classify.confidence),
    ...(classicDraft.length ? { stepDispatchDraft: classicDraft } : {}),
    ...(input.bundle.raw.codeMode && input.bundle.raw.codeMode !== 'auto'
      ? { codeMode: input.bundle.raw.codeMode }
      : {}),
    ...planUpgradeMetaFromRaw(input.bundle.raw as unknown as Record<string, unknown>)
  }

  if (input.turnScope.mode === 'topic_shift') {
    metaPatch.turnTopicShift = true
    metaPatch.sessionIntentAnchor = null
  }

  return {
    ...input.bundle,
    clauses,
    intentClassify: classify,
    intent,
    allowedAgents: allowed,
    planBlueprint,
    needsWebSearch,
    metaPatch
  }
}
