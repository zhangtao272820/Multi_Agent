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
import { stripUnboundCrawlerArtifacts } from './stripUnboundCrawler'
import {
  ensureCommittedPlanesInAllowed,
  shouldClarifyForAmbiguousCommitment,
  shouldSkipAdminApiCrawlerRematerialize,
  sourceCommitmentFromRaw
} from './sourceCommitment'
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
import { collapseSingleSourceSameAgentOrchestrator } from '../llm/taskOrchestrator/parseCore'
import {
  coerceFollowupTextToAnchor,
  shouldGroundFollowupQuery
} from '#agent-shared/followupQueryGrounding'
import { sessionIntentAnchorFromMeta } from '../core/memory/multiTurnIntent'

const WEB_CAP_AGENTS = new Set(['crawler', 'music', 'video'])

/** output_followup / 短 continuation：强制 coalescedTask、clauses、queryFocus 锚定上轮任务 */
export function groundOrchestratorFollowupBundle(
  bundle: TaskOrchestratorBundle,
  turnScope: TurnRoutingScope,
  stateMeta?: unknown
): TaskOrchestratorBundle {
  const anchor = sessionIntentAnchorFromMeta(stateMeta)?.coalescedTask || ''
  if (
    !shouldGroundFollowupQuery({
      turnKind: turnScope.turnKind,
      lastUser: turnScope.lastOnly,
      anchorTask: anchor
    })
  ) {
    return bundle
  }
  const groundedTask = coerceFollowupTextToAnchor({
    text: String(bundle.coalescedTask || bundle.routedQuery || turnScope.lastOnly || ''),
    anchorTask: anchor,
    turnKind: turnScope.turnKind,
    lastUser: turnScope.lastOnly
  })
  const clauses = (bundle.clauses || []).map((c) => ({
    ...c,
    text: coerceFollowupTextToAnchor({
      text: String(c.text || ''),
      anchorTask: anchor,
      turnKind: turnScope.turnKind,
      lastUser: turnScope.lastOnly
    })
  }))
  const planBlueprint = bundle.planBlueprint
    ? {
        ...bundle.planBlueprint,
        steps: (bundle.planBlueprint.steps || []).map((s) => ({
          ...s,
          queryFocus: coerceFollowupTextToAnchor({
            text: String(s.queryFocus || ''),
            anchorTask: anchor,
            turnKind: turnScope.turnKind,
            lastUser: turnScope.lastOnly
          })
        }))
      }
    : bundle.planBlueprint
  return {
    ...bundle,
    coalescedTask: groundedTask,
    routedQuery: groundedTask,
    clauses,
    planBlueprint: planBlueprint ?? null,
    raw: {
      ...bundle.raw,
      coalescedTask: groundedTask,
      routedQuery: groundedTask
    }
  }
}

/** 单源同 agent 过度拆分：在 invariants 入口再折叠一次（覆盖 PU seed / 未走 normalize 的路径） */
function collapseBundleSingleSource(bundle: TaskOrchestratorBundle, lastUser: string): TaskOrchestratorBundle {
  const o: Record<string, unknown> = {
    ...(bundle.raw as unknown as Record<string, unknown>),
    clauses: bundle.clauses,
    planBlueprint: bundle.planBlueprint ?? undefined,
    allowedAgents: bundle.allowedAgents,
    suggestedAgents: bundle.raw.suggestedAgents ?? bundle.allowedAgents,
    dataSources: bundle.intentClassify.dataSources,
    isMulti: bundle.intentClassify.isMulti,
    requiresAgentPipeline: bundle.intentClassify.requiresAgentPipeline,
    planShortcut: bundle.intentClassify.planShortcut,
    intent: bundle.intent,
    primaryIntent: bundle.intentClassify.primaryIntent,
    coalescedTask: bundle.coalescedTask,
    routedQuery: bundle.routedQuery,
    explicitWantsReport: bundle.intentClassify.explicitWantsReport,
    explicitWantsVisualize: bundle.intentClassify.explicitWantsVisualize,
    wantsReport: bundle.constraints?.wantsReport,
    wantsVisualize: bundle.constraints?.wantsVisualize
  }
  const did = collapseSingleSourceSameAgentOrchestrator(o, lastUser)
  if (!did) return bundle
  const sole = filterCapSole(o.allowedAgents as string[])
  if (!sole) return bundle
  const clauses = (Array.isArray(o.clauses) ? o.clauses : bundle.clauses) as TaskClause[]
  const planBlueprint = (o.planBlueprint as TaskOrchestratorBundle['planBlueprint']) ?? bundle.planBlueprint
  const intent = String(o.intent || sole)
  const focus = String(o.coalescedTask || o.routedQuery || lastUser || '').trim()
  const stepDispatchDraft = [
    {
      agent: sole,
      scopedUserLanguage: focus.slice(0, 480) || String(clauses[0]?.text || '').slice(0, 480),
      clauseIds: ['c1']
    }
  ]
  return {
    ...bundle,
    clauses,
    planBlueprint,
    allowedAgents: [sole] as ExecutableAgent[],
    intent,
    coalescedTask: String(o.coalescedTask || bundle.coalescedTask),
    routedQuery: String(o.routedQuery || bundle.routedQuery),
    stepDispatchDraft,
    intentClassify: {
      ...bundle.intentClassify,
      isMulti: false,
      requiresAgentPipeline: false,
      allowChatWebDirect: true,
      planShortcut: sole === 'db' ? 'db_only' : 'rag_only',
      primaryIntent: sole as typeof bundle.intentClassify.primaryIntent,
      dataSources: [sole] as typeof bundle.intentClassify.dataSources,
      suggestedAgents: [sole] as typeof bundle.intentClassify.suggestedAgents
    },
    raw: {
      ...bundle.raw,
      isMulti: false,
      requiresAgentPipeline: false,
      planShortcut: sole === 'db' ? 'db_only' : 'rag_only',
      intent,
      primaryIntent: sole,
      allowedAgents: [sole],
      suggestedAgents: [sole],
      dataSources: [sole],
      clauses,
      planBlueprint: planBlueprint ?? undefined
    }
  }
}

function filterCapSole(agents: string[] | undefined): 'db' | 'rag' | null {
  const data = (agents ?? []).map(String).filter((a) => a === 'db' || a === 'rag')
  const uniq = [...new Set(data)]
  return uniq.length === 1 ? (uniq[0] as 'db' | 'rag') : null
}

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

export type OrchestratorDecision = TaskOrchestratorBundle & {
  intent: string
  allowedAgents: ExecutableAgent[]
  metaPatch: Record<string, unknown>
}

const DATA_PLANE_AGENTS = new Set(['db', 'rag', 'crawler'])

/**
 * 单源文档面：禁止编排前因「缺月份/来源」误澄清；先检索，无命中 graceful miss。
 * 结构信号（planShortcut / taskIntent / sole rag），不读用户原话。
 */
export function shouldClearClarifyForSingleSourceRag(input: {
  planShortcut?: string | null
  taskIntent?: string | null
  intent?: string | null
  allowedAgents?: string[] | null
}): boolean {
  if (String(input.planShortcut || '').trim() === 'rag_only') return true
  if (String(input.taskIntent || '').trim() === 'document_retrieval') return true
  if (String(input.intent || '').trim() === 'rag') return true
  const planes = (input.allowedAgents ?? [])
    .map((a) => String(a || '').trim())
    .filter((a) => DATA_PLANE_AGENTS.has(a))
  return planes.length === 1 && planes[0] === 'rag'
}

function applySingleSourceRagClarifyInvariant(
  decision: OrchestratorDecision,
  bundle: TaskOrchestratorBundle
): OrchestratorDecision {
  const slice = sourceCommitmentFromRaw(bundle.raw as Record<string, unknown>)
  // 模糊 / plane 澄清（含缺源）不得被单源 rag 抑制清掉
  if (
    shouldClarifyForAmbiguousCommitment(slice) ||
    decision.clarifyKind === 'plane' ||
    decision.metaPatch?.clarifyForNoCoverage === true ||
    decision.metaPatch?.clarifyForAmbiguousCommitment === true
  ) {
    return decision
  }
  const taskIntent = String((bundle.raw as { taskIntent?: string } | undefined)?.taskIntent || '').trim()
  if (
    !shouldClearClarifyForSingleSourceRag({
      planShortcut: decision.intentClassify?.planShortcut,
      taskIntent,
      intent: decision.intent,
      allowedAgents: decision.allowedAgents?.map(String)
    })
  ) {
    return decision
  }
  return {
    ...decision,
    needsClarify: false,
    clarifyQuestions: [],
    clarifyKind: 'none',
    raw: {
      ...decision.raw,
      needsClarify: false,
      clarifyKind: 'none',
      clarifyQuestions: []
    },
    metaPatch: {
      ...decision.metaPatch,
      needsClarify: false,
      clarifyQuestions: [],
      clarifyKind: 'none',
      clarifySuppressedBySingleSourceRag: true
    }
  }
}

/** 意图清晰度：ambiguous→clarify；clear→锁 committedPlanes；公网 skip 标记写入 meta */
function applySourceCommitmentInvariant(
  decision: OrchestratorDecision,
  bundle: TaskOrchestratorBundle
): OrchestratorDecision {
  const slice = sourceCommitmentFromRaw(bundle.raw as Record<string, unknown>)
  let next = decision
  let allowed = ensureCommittedPlanesInAllowed(
    decision.allowedAgents.map(String),
    slice
  ) as ExecutableAgent[]
  if (allowed.join('|') !== decision.allowedAgents.map(String).join('|')) {
    allowed = sortAgentsByPipelineOrder(allowed) as ExecutableAgent[]
    next = { ...next, allowedAgents: allowed }
  }

  const metaExtra: Record<string, unknown> = {
    sourceCommitment: slice.sourceCommitment,
    committedPlanes: slice.committedPlanes,
    webFetchKind: slice.webFetchKind,
    adminCapabilityHints: slice.adminCapabilityHints,
    skipWeatherMapRematerialize: shouldSkipAdminApiCrawlerRematerialize(slice)
  }

  if (shouldClarifyForAmbiguousCommitment(slice)) {
    const qs =
      next.clarifyQuestions?.length > 0
        ? next.clarifyQuestions
        : ['请问您要查业务库记录、内部文档，还是联网公开网页？']
    next = {
      ...next,
      needsClarify: true,
      clarifyKind: 'plane',
      clarifyQuestions: qs,
      raw: {
        ...next.raw,
        needsClarify: true,
        clarifyKind: 'plane',
        clarifyQuestions: qs,
        sourceCommitment: 'ambiguous'
      },
      metaPatch: {
        ...next.metaPatch,
        ...metaExtra,
        needsClarify: true,
        clarifyKind: 'plane',
        clarifyQuestions: qs,
        clarifyForAmbiguousCommitment: true
      }
    }
    return next
  }

  return {
    ...next,
    metaPatch: {
      ...next.metaPatch,
      ...metaExtra
    }
  }
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
  const commitmentRawPu = input.bundle.raw as unknown as Record<string, unknown>
  const weatherFixPu = rematerializeWeatherCrawlerMisbind({
    allowedAgents: allowed,
    clauses,
    classify,
    planBlueprint: input.bundle.planBlueprint ?? null,
    stepDispatchDraft: draft,
    needsWebSearch: input.bundle.needsWebSearch === true,
    sourceCommitmentRaw: commitmentRawPu
  })
  const mapFixPu = rematerializeMapCrawlerMisbind({
    allowedAgents: weatherFixPu.allowedAgents,
    clauses: weatherFixPu.clauses,
    classify: weatherFixPu.classify,
    planBlueprint: weatherFixPu.planBlueprint,
    stepDispatchDraft: weatherFixPu.stepDispatchDraft?.length
      ? weatherFixPu.stepDispatchDraft
      : draft,
    needsWebSearch: weatherFixPu.needsWebSearch === true,
    sourceCommitmentRaw: commitmentRawPu
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
  const collapsed = collapseBundleSingleSource(input.bundle, input.turnScope.lastOnly)
  let clauses = collapsed.clauses
  let classify = collapsed.intentClassify
  const constraints = collapsed.constraints
  const explicitAgents = collectExplicitOrchestratorAgents({
    classify,
    clauses,
    suggestedAgents: collapsed.raw.suggestedAgents
  })
  classify = reconcileClassifyAgainstExplicitAgents(classify, explicitAgents)
  if (
    !adminExplicitlyRequested({
      classify,
      clauses,
      suggestedAgents: collapsed.raw.suggestedAgents
    })
  ) {
    classify = { ...classify, needsAdmin: false, suggestedAgents: classify.suggestedAgents.filter((a) => a !== 'admin') }
  }
  let allowed = sortAgentsByPipelineOrder([...collapsed.allowedAgents]) as ExecutableAgent[]
  allowed = stripSpuriousOptionalAgents(allowed, explicitAgents)
  const aligned = applyOrchestratorCapAlignment({
    allowed,
    classify,
    clauses,
    suggestedAgents: collapsed.raw.suggestedAgents
  })
  allowed = aligned.allowed
  classify = aligned.classify
  allowed = filterAgentsRespectingWriteGate(allowed, input.state ?? {}) as ExecutableAgent[]
  let planBlueprint = collapsed.planBlueprint ?? null
  const routingMeta = input.state?.meta
  let alignedDraft = collapsed.stepDispatchDraft?.length
    ? collapsed.stepDispatchDraft
    : stepDispatchDraftFromMeta(routingMeta)

  // 天气/地图能力契约：crawler 误绑 → admin（须在 stripUnboundCrawler 之前）
  const commitmentRaw = collapsed.raw as unknown as Record<string, unknown>
  const weatherFix = rematerializeWeatherCrawlerMisbind({
    allowedAgents: allowed,
    clauses,
    classify,
    planBlueprint,
    stepDispatchDraft: alignedDraft,
    needsWebSearch: input.bundle.needsWebSearch === true,
    sourceCommitmentRaw: commitmentRaw
  })
  const mapFix = rematerializeMapCrawlerMisbind({
    allowedAgents: weatherFix.allowedAgents,
    clauses: weatherFix.clauses,
    classify: weatherFix.classify,
    planBlueprint: weatherFix.planBlueprint,
    stepDispatchDraft: weatherFix.stepDispatchDraft,
    needsWebSearch: weatherFix.needsWebSearch === true,
    sourceCommitmentRaw: commitmentRaw
  })
  allowed = mapFix.allowedAgents
  clauses = mapFix.clauses
  classify = mapFix.classify
  planBlueprint = mapFix.planBlueprint
  if (mapFix.stepDispatchDraft) alignedDraft = mapFix.stepDispatchDraft

  {
    const stripped = stripUnboundCrawlerArtifacts({
      allowedAgents: allowed,
      clauses,
      classify,
      planBlueprint,
      stepDispatchDraft: alignedDraft,
      needsWebSearch: mapFix.needsWebSearch === true,
      sourceCommitmentRaw: commitmentRaw
    })
    allowed = stripped.allowedAgents
    classify = stripped.classify
    planBlueprint = stripped.planBlueprint
    if (stripped.stepDispatchDraft) alignedDraft = [...stripped.stepDispatchDraft]
    classify = {
      ...classify,
      needsAdmin: allowed.map(String).includes('admin') ? true : classify.needsAdmin
    }
  }
  const userTask = String(
    collapsed.coalescedTask || input.turnScope.lastOnly || collapsed.routedQuery || ''
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
  let intent = finalizeLlmRouteIntent(collapsed.intent || input.bundle.intent, allowed, null)
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
        : collapsed.needsWebSearch === true
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
    nlHeuristicTask: collapsed.coalescedTask,
    needsClarify: collapsed.needsClarify,
    clarifyQuestions: collapsed.needsClarify ? collapsed.clarifyQuestions : [],
    routeConfidence,
    uncertainty: routeConfidence >= 0.75 ? 'low' : routeConfidence >= 0.5 ? 'medium' : 'high',
    ...(alignedDraft.length ? { stepDispatchDraft: alignedDraft } : {}),
    ...(collapsed.raw.codeMode && collapsed.raw.codeMode !== 'auto'
      ? { codeMode: collapsed.raw.codeMode }
      : {}),
    ...planUpgradeMetaFromRaw(collapsed.raw as unknown as Record<string, unknown>)
  }
  return {
    ...collapsed,
    clauses,
    intentClassify: classify,
    intent,
    allowedAgents: allowed,
    planBlueprint,
    needsWebSearch,
    needsClarify: collapsed.needsClarify,
    clarifyQuestions: collapsed.needsClarify ? collapsed.clarifyQuestions : [],
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
  const groundedBundle = groundOrchestratorFollowupBundle(
    collapseBundleSingleSource(input.bundle, input.turnScope.lastOnly),
    input.turnScope,
    input.state?.meta
  )
  const collapsedInput = {
    ...input,
    bundle: groundedBundle
  }
  const routingMeta = collapsedInput.state?.meta
  let decision: OrchestratorDecision
  if (isLlmFirstRouteEnabled()) {
    decision = applyLlmFirstOrchestratorDecision(collapsedInput)
  } else if (shouldApplyFrozenPuCap(routingMeta, collapsedInput.capPolicy)) {
    decision = applyFrozenPuOrchestratorDecision(collapsedInput)
  } else {
    decision = applyClassicOrchestratorDecision(collapsedInput)
  }
  decision = applySourceCommitmentInvariant(decision, collapsedInput.bundle)
  return applySingleSourceRagClarifyInvariant(decision, collapsedInput.bundle)
}

function applyClassicOrchestratorDecision(input: {
  bundle: TaskOrchestratorBundle
  turnScope: TurnRoutingScope
  state?: { meta?: unknown; probe?: { db?: ProbeDbSlice; rag?: { hits?: number } } }
  routerCapBaseline?: ExecutableAgent[]
  capPolicy?: OrchestratorCapPolicy
}): OrchestratorDecision {
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
  let classicDraft =
    input.bundle.stepDispatchDraft?.length
      ? input.bundle.stepDispatchDraft
      : stepDispatchDraftFromMeta(input.state?.meta)

  const commitmentRawClassic = input.bundle.raw as unknown as Record<string, unknown>
  const weatherFixClassic = rematerializeWeatherCrawlerMisbind({
    allowedAgents: allowed,
    clauses,
    classify,
    planBlueprint: input.bundle.planBlueprint ?? null,
    stepDispatchDraft: classicDraft,
    needsWebSearch: input.bundle.needsWebSearch === true,
    sourceCommitmentRaw: commitmentRawClassic
  })
  const mapFixClassic = rematerializeMapCrawlerMisbind({
    allowedAgents: weatherFixClassic.allowedAgents,
    clauses: weatherFixClassic.clauses,
    classify: weatherFixClassic.classify,
    planBlueprint: weatherFixClassic.planBlueprint,
    stepDispatchDraft: weatherFixClassic.stepDispatchDraft,
    needsWebSearch: weatherFixClassic.needsWebSearch === true,
    sourceCommitmentRaw: commitmentRawClassic
  })
  allowed = mapFixClassic.allowedAgents
  clauses = mapFixClassic.clauses
  classify = mapFixClassic.classify
  if (mapFixClassic.stepDispatchDraft) classicDraft = mapFixClassic.stepDispatchDraft

  let classicBlueprint = mapFixClassic.planBlueprint ?? input.bundle.planBlueprint ?? null
  {
    const stripped = stripUnboundCrawlerArtifacts({
      allowedAgents: allowed,
      clauses,
      classify,
      planBlueprint: classicBlueprint,
      stepDispatchDraft: classicDraft,
      needsWebSearch: mapFixClassic.needsWebSearch === true,
      sourceCommitmentRaw: commitmentRawClassic
    })
    allowed = stripped.allowedAgents
    classify = stripped.classify
    classicBlueprint = stripped.planBlueprint
    if (stripped.stepDispatchDraft) classicDraft = [...stripped.stepDispatchDraft]
    classify = {
      ...classify,
      needsAdmin: allowed.map(String).includes('admin') ? true : classify.needsAdmin
    }
  }

  const pipelineRequired = requiresAgentPipelineExecution(classify, allowed)
  let intent = finalizeLlmRouteIntent(input.bundle.intent, allowed, null)
  intent = ensureMultiIntentForPipeline(intent, allowed, pipelineRequired)
  allowed = sortAgentsByPipelineOrder(finalizeLlmAllowedAgents(intent, allowed, null)) as ExecutableAgent[]

  const capSet = new Set(allowed.map(String))
  let planBlueprint = filterBlueprintToCap(classicBlueprint, capSet)
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
