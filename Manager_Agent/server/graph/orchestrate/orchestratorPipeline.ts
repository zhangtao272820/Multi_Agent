/**
 * 统一编排流水线（LLM-First：单次编排 LLM → 轻量不变量 → 可选 Judge）
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { LlmInvokeFn } from '../llm/taskConstraintsLlm'
import type { TurnRoutingScope } from '../core/routing/turnScope'
import {
  resolveTaskOrchestrationByLlm,
  type TaskOrchestratorBundle
} from '../llm/taskOrchestrator'
import { applyOrchestratorInvariants, type OrchestratorDecision } from './orchestratorInvariants'
import {
  lintOrchestratorBundle,
  orchestratorLintSeverity
} from './orchestratorStructuralLint'
import { judgeOrchestratorDecision, isOrchestratorJudgeEnabled } from '../llm/orchestratorJudgeLlm'
import {
  blueprintCoversRequiredAgents,
  type PlanBlueprint
} from '../llm/planBlueprintLlm'
import type { SessionIntentAnchor } from '../core/memory/multiTurnIntent'
import type { IntentRagRecallResult } from '../core/rag/intentRagRecallCore'
import { resolveManagerEnvBool } from '../../utils/platform/managerEnvModes'
import {
  formatPuStackDraftBindingForOrchestrator,
  formatPuStackOrchestratorHint,
  orchestratorSourceLabel,
  shouldPuStackBypassOrchestratorLlm
} from '../core/routing/proRoutePolicy'
import { isLlmFirstRouteEnabled } from './unifiedRouting'
import { alignOrchestratorBundleToUserIntent, isUserIntentAlignLlmEnabled } from '../llm/userIntentAlignLlm'
import { rejudgePlaneCoverageByInventory } from '../llm/planeCoverageRejudgeLlm'
import { stepDispatchDraftFromMeta } from '../core/proPuStack'
import { buildBlueprintFromPuStackDispatch } from '../llm/planBlueprintLlm'
import { alignOrchestratorWebExecutionMode } from './orchestratorWebExecutionAlign'
import { rematerializeWeatherCrawlerMisbind } from './weatherAdminBoundary'
import { rematerializeMapCrawlerMisbind } from './mapAdminBoundary'
import {
  isClearSolePlaneNoWeb,
  shouldSkipWebAlignLlm,
  stripUnboundCrawlerArtifacts
} from './stripUnboundCrawler'
import {
  shouldSkipRouteReviewLlm,
  buildRouteSkipsSnapshot,
  estimateRouteLlmCalls,
  type RouteReviewSkipDecision
} from '../core/routing/routeSkipCascade'
import { sortAgentsByPipelineOrder } from '../core/routing/clauses'
import type { ExecutableAgent } from '../core/routing/routeFinalize'
import { isLlmRateLimitError } from '../../utils/chat/llmRateLimit'

const EXEC_COVER = new Set(['rag', 'db', 'crawler', 'clean', 'code', 'visualize', 'report', 'admin', 'gui', 'multimodal', 'music', 'video'])

/** web-align 之后再跑天气/地图契约，防止 supplement/composite 把 crawler 加回 */
function reapplyAdminApiCrawlerBoundary(decision: OrchestratorDecision): OrchestratorDecision {
  const draft = Array.isArray(decision.metaPatch?.stepDispatchDraft)
    ? (decision.metaPatch.stepDispatchDraft as Parameters<typeof rematerializeWeatherCrawlerMisbind>[0]['stepDispatchDraft'])
    : decision.stepDispatchDraft
  const commitmentRaw = decision.raw as unknown as Record<string, unknown>
  const weatherFixed = rematerializeWeatherCrawlerMisbind({
    allowedAgents: decision.allowedAgents as ExecutableAgent[],
    clauses: decision.clauses,
    classify: decision.intentClassify,
    planBlueprint: decision.planBlueprint,
    stepDispatchDraft: draft,
    needsWebSearch: decision.needsWebSearch,
    sourceCommitmentRaw: commitmentRaw
  })
  const fixed = rematerializeMapCrawlerMisbind({
    allowedAgents: weatherFixed.allowedAgents,
    clauses: weatherFixed.clauses,
    classify: weatherFixed.classify,
    planBlueprint: weatherFixed.planBlueprint,
    stepDispatchDraft: weatherFixed.stepDispatchDraft,
    needsWebSearch: weatherFixed.needsWebSearch,
    sourceCommitmentRaw: commitmentRaw
  })
  if (!weatherFixed.changed && !fixed.changed) return decision
  const allowed = sortAgentsByPipelineOrder(fixed.allowedAgents) as OrchestratorDecision['allowedAgents']
  return {
    ...decision,
    clauses: fixed.clauses,
    intentClassify: fixed.classify,
    allowedAgents: allowed,
    planBlueprint: fixed.planBlueprint,
    needsWebSearch: fixed.needsWebSearch === false ? false : decision.needsWebSearch,
    metaPatch: {
      ...decision.metaPatch,
      intentClassify: fixed.classify,
      taskClauses: fixed.clauses,
      planBlueprint: fixed.planBlueprint ?? undefined,
      needsWebSearch: fixed.needsWebSearch === false ? false : decision.needsWebSearch,
      ...(fixed.stepDispatchDraft?.length ? { stepDispatchDraft: fixed.stepDispatchDraft } : {})
    }
  }
}

function applyStripUnboundCrawlerDecision(decision: OrchestratorDecision): OrchestratorDecision {
  const draft = Array.isArray(decision.metaPatch?.stepDispatchDraft)
    ? (decision.metaPatch.stepDispatchDraft as Array<{ agent?: string }>)
    : decision.stepDispatchDraft
  const stripped = stripUnboundCrawlerArtifacts({
    allowedAgents: decision.allowedAgents,
    clauses: decision.clauses,
    classify: decision.intentClassify,
    planBlueprint: decision.planBlueprint,
    stepDispatchDraft: draft,
    needsWebSearch: decision.needsWebSearch,
    sourceCommitmentRaw: decision.raw as unknown as Record<string, unknown>,
    compositeDataWebRoute: decision.metaPatch?.compositeDataWebRoute === true
  })
  if (!stripped.changed) return decision
  const allowed = sortAgentsByPipelineOrder(stripped.allowedAgents) as OrchestratorDecision['allowedAgents']
  return {
    ...decision,
    allowedAgents: allowed,
    intentClassify: stripped.classify,
    planBlueprint: stripped.planBlueprint,
    needsWebSearch: stripped.needsWebSearch === false ? false : decision.needsWebSearch,
    metaPatch: {
      ...decision.metaPatch,
      intentClassify: stripped.classify,
      taskClauses: stripped.clauses,
      planBlueprint: stripped.planBlueprint ?? undefined,
      needsWebSearch: stripped.needsWebSearch === false ? false : decision.needsWebSearch,
      ...(stripped.stepDispatchDraft?.length ? { stepDispatchDraft: stripped.stepDispatchDraft } : {})
    }
  }
}

async function finalizeOrchestratorDecision(
  input: OrchestratorPipelineInput,
  decision: OrchestratorDecision,
): Promise<OrchestratorDecision> {
  const toolHealth = (input.state as { toolHealth?: { agents?: Array<{ agent: string; status: string }> } })
    ?.toolHealth
  const skipWeb = shouldSkipWebAlignLlm({
    allowedAgents: decision.allowedAgents,
    needsWeb: decision.intentClassify?.needsWeb,
    needsWebSearch: decision.needsWebSearch,
    sourceCommitmentRaw: decision.raw as unknown as Record<string, unknown>
  })
  if (!skipWeb) {
    input.onThinking?.('网页执行：判定抓取 / SERP / GUI 或无需公网…')
  }
  const aligned = skipWeb
    ? decision
    : await alignOrchestratorWebExecutionMode({
        decision,
        userTask: input.lastUser,
        llmInvoke: input.llmInvoke,
        state: input.state,
        toolHealth,
      })
  // web-align / composite 之后再硬剥幽灵 crawler（lint 告警不够）
  return applyStripUnboundCrawlerDecision(reapplyAdminApiCrawlerBoundary(aligned))
}

export function isOrchestratorLlmOnlyMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagerEnvBool('MANAGER_ORCHESTRATOR_LLM_ONLY', env)
}

export function orchestratorReflexMaxRetries(): number {
  if (isLlmFirstRouteEnabled()) return 0
  const n = Number(process.env.MANAGER_ORCHESTRATOR_REFLEX_RETRIES ?? '1')
  return Number.isFinite(n) ? Math.min(2, Math.max(0, Math.floor(n))) : 1
}

export type OrchestratorPipelineInput = {
  messages: BaseMessage[]
  lastUser: string
  routingContext: string
  turnScopeHint?: string
  turnScope: TurnRoutingScope
  probe?: { db?: { matched?: boolean; tables?: string[] }; rag?: { hits?: number } } | null
  sessionAnchor?: SessionIntentAnchor | null
  ragRecall?: IntentRagRecallResult | null
  evolutionHint?: string
  llmInvoke: LlmInvokeFn
  state: unknown
  /** 仅 MANAGER_PRO_MODE=fast 快路径使用，LLM-First 失败时不作兜底 */
  seedBundle?: TaskOrchestratorBundle | null
  /** 编排子阶段中文进展（thought_delta） */
  onThinking?: (line: string) => void
}

export type OrchestratorPipelineResult = {
  decision: OrchestratorDecision
  source: string
  judgeRetries: number
  lintIssues: string[]
  judgeRationale?: string
  judgeAccept: boolean
}

/** 快路径 only：MANAGER_PRO_MODE=fast */
async function resolvePuStackAuthorityPipeline(
  input: OrchestratorPipelineInput,
  seedBundle: TaskOrchestratorBundle
): Promise<OrchestratorPipelineResult> {
  const userTask = String(input.lastUser || '').trim()
  const meta = (input.state as { meta?: Record<string, unknown> })?.meta
  let decision = applyOrchestratorInvariants({
    bundle: seedBundle,
    turnScope: input.turnScope,
    state: input.state as { meta?: unknown; probe?: unknown },
    routerCapBaseline: seedBundle.allowedAgents,
    capPolicy: { mode: 'frozen' }
  })

  const draft = stepDispatchDraftFromMeta(meta)
  if (draft.length >= 2) {
    const puBp = buildBlueprintFromPuStackDispatch({
      allowedAgents: decision.allowedAgents.map(String),
      clauses: decision.clauses,
      stepDispatchDraft: draft,
      userTask
    })
    if (puBp) {
      decision = {
        ...decision,
        planBlueprint: puBp,
        metaPatch: { ...decision.metaPatch, planBlueprint: puBp }
      }
    }
  }

  const lastLint = lintOrchestratorBundle({
    userTask,
    allowedAgents: [...decision.allowedAgents],
    clauses: decision.clauses,
    classify: decision.intentClassify,
    planBlueprint: decision.planBlueprint
  })

  return {
    decision: await finalizeOrchestratorDecision(input, decision),
    source: 'pu_stack_authority',
    judgeRetries: 0,
    lintIssues: lastLint,
    judgeAccept: true
  }
}

export async function resolveOrchestratorPipeline(
  input: OrchestratorPipelineInput
): Promise<OrchestratorPipelineResult> {
  const userTask = String(input.lastUser || '').trim()
  let source = 'unified_llm'
  let judgeRetries = 0
  let lastLint: string[] = []
  let judgeRationale: string | undefined
  let fixHint: string | undefined

  const meta = (input.state as { meta?: Record<string, unknown> })?.meta

  if (shouldPuStackBypassOrchestratorLlm(meta) && input.seedBundle) {
    return resolvePuStackAuthorityPipeline(input, input.seedBundle)
  }

  const puHint = formatPuStackOrchestratorHint(meta)
  const draftBinding = formatPuStackDraftBindingForOrchestrator(meta)
  const turnScopeHint = [input.turnScopeHint, puHint, draftBinding].filter(Boolean).join('\n\n') || undefined

  const llmBase = {
    messages: input.messages,
    lastUser: userTask,
    routingContext: input.routingContext,
    turnScopeHint,
    probe: input.probe,
    sessionAnchor: input.sessionAnchor,
    ragRecall: input.ragRecall,
    evolutionHint: input.evolutionHint,
    llmInvoke: input.llmInvoke,
    state: input.state,
    puStackHint: [puHint, draftBinding].filter(Boolean).join('\n\n') || undefined
  }

  let bundle: TaskOrchestratorBundle | null = null

  input.onThinking?.('主路由：正在调用编排 LLM 判定能力组合…')
  const first = await resolveTaskOrchestrationByLlm({ ...llmBase, judgeFeedback: fixHint })
  bundle = first.bundle
  source = orchestratorSourceLabel(
    first.stage === 'compact' ? 'compact_llm' : first.stage === 'full' ? 'full_llm' : 'llm_failed',
    meta
  )
  const llmFailureNote = first.failures?.map((f) => `${f.stage}:${f.reason}`).join(' | ')

  if (!bundle) {
    if (llmFailureNote && isLlmRateLimitError(llmFailureNote)) {
      throw new Error('orchestrator_llm_exhausted (模型限流 429，请稍后重试)')
    }
    throw new Error(
      llmFailureNote ? `orchestrator_llm_exhausted (${llmFailureNote.slice(0, 480)})` : 'orchestrator_llm_exhausted'
    )
  }

  const probeForCover =
    (input.probe as { db?: unknown; rag?: unknown } | null | undefined) ??
    (input.state as { probe?: { db?: unknown; rag?: unknown } } | null)?.probe ??
    null

  // Phase1：审查 skip 级联 SSOT（含 clear_sole / admin_only / probe 强单源；ambiguous 禁止跳）
  const reviewSkip: RouteReviewSkipDecision = shouldSkipRouteReviewLlm({
    allowedAgents: bundle.allowedAgents,
    planShortcut: bundle.intentClassify?.planShortcut,
    needsWeb: bundle.intentClassify?.needsWeb,
    needsWebSearch: bundle.needsWebSearch,
    sourceCommitmentRaw: bundle.raw as unknown as Record<string, unknown>,
    meta,
    probe: probeForCover as Parameters<typeof shouldSkipRouteReviewLlm>[0]['probe']
  })
  // 兼容：soleClear 仍可用于 source 标签后缀
  const soleClearNoWeb = isClearSolePlaneNoWeb({
    allowedAgents: bundle.allowedAgents,
    planShortcut: bundle.intentClassify?.planShortcut,
    needsWeb: bundle.intentClassify?.needsWeb,
    needsWebSearch: bundle.needsWebSearch,
    sourceCommitmentRaw: bundle.raw as unknown as Record<string, unknown>
  })

  if (isUserIntentAlignLlmEnabled() && !reviewSkip.skipAlign) {
    input.onThinking?.('对齐：审查 cap 是否与末轮语义一致…')
    const weakHints = [puHint, draftBinding].filter(Boolean).join('\n')
    const aligned = await alignOrchestratorBundleToUserIntent({
      lastUser: userTask,
      bundle,
      weakHints: weakHints || undefined,
      llmInvoke: input.llmInvoke,
      state: input.state
    })
    if (aligned.aligned) {
      bundle = aligned.bundle
      if (aligned.stepDispatchDraft?.length) {
        bundle = { ...bundle, stepDispatchDraft: aligned.stepDispatchDraft }
      }
      source = `${source}_user_align`
    }
  } else if (reviewSkip.skipAlign) {
    source = `${source}_skip_align`
  }

  // 库存存在性再判：单源 db↔rag 纠正（目录能答/不能答），禁止扩 multi
  if (!reviewSkip.skipPlane) {
    input.onThinking?.('平面覆盖：对照库存判断 db/rag 是否真能回答…')
    const covered = await rejudgePlaneCoverageByInventory({
      lastUser: userTask,
      bundle: bundle!,
      probe: probeForCover as Parameters<typeof rejudgePlaneCoverageByInventory>[0]['probe'],
      llmInvoke: input.llmInvoke,
      state: input.state
    })
    if (covered.rewritten) {
      bundle = covered.bundle
      source = `${source}_plane_cover`
    }
    if (covered.noCoverageClarify && bundle) {
      const qs =
        bundle.clarifyQuestions?.length > 0
          ? bundle.clarifyQuestions
          : ['当前环境库存似乎无法覆盖该查询，请确认要查的库表/文档，或换一种问法。']
      bundle = {
        ...bundle,
        needsClarify: true,
        clarifyKind: 'plane',
        clarifyQuestions: qs,
        raw: {
          ...bundle.raw,
          needsClarify: true,
          clarifyKind: 'plane',
          clarifyQuestions: qs
        }
      }
      source = `${source}_no_cover_clarify`
    }
  } else {
    source = `${source}_skip_plane_cover`
  }

  const skipWebAlign = shouldSkipWebAlignLlm({
    allowedAgents: bundle.allowedAgents,
    needsWeb: bundle.intentClassify?.needsWeb,
    needsWebSearch: bundle.needsWebSearch,
    sourceCommitmentRaw: bundle.raw as unknown as Record<string, unknown>
  })
  const routeSkips = buildRouteSkipsSnapshot({
    skipAlign: reviewSkip.skipAlign,
    skipPlane: reviewSkip.skipPlane,
    skipWebAlign: reviewSkip.skipWebAlign || skipWebAlign,
    plannerBypassed: false,
    skipAudit: false
  })
  const routeLlmCalls = estimateRouteLlmCalls({
    priorAuxCalls: Number((meta as Record<string, unknown> | undefined)?.routeAuxLlmCalls) || 0,
    ranOrchestratorLlm: true,
    skipAlign: routeSkips.align,
    skipPlane: routeSkips.plane,
    skipWebAlign: routeSkips.webAlign
  })
  // 写入 bundle.raw 旁路字段，供 decision metaPatch 合并（finishOrchestrateTurn）
  if (bundle) {
    bundle = {
      ...bundle,
      raw: {
        ...bundle.raw,
        routeSkips,
        routeLlmCalls,
        routeSkipReasons: reviewSkip.reasons,
        soleClearNoWeb
      }
    }
  }

  const maxRetries = orchestratorReflexMaxRetries()
  const judgeEnabled = isOrchestratorJudgeEnabled()

  const attachRouteSkipMeta = (decision: OrchestratorDecision): OrchestratorDecision => ({
    ...decision,
    metaPatch: {
      ...decision.metaPatch,
      routeSkips,
      routeLlmCalls,
      routeSkipReasons: reviewSkip.reasons,
      routeSkipAlign: routeSkips.align,
      routeSkipPlane: routeSkips.plane,
      routeSkipWebAlign: routeSkips.webAlign
    }
  })

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && fixHint) {
      const retry = await resolveTaskOrchestrationByLlm({ ...llmBase, judgeFeedback: fixHint })
      if (retry.bundle) {
        bundle = retry.bundle
        source = orchestratorSourceLabel(`reflex_${retry.stage}`, meta)
        judgeRetries += 1
      }
    }

    const decision = attachRouteSkipMeta(
      await finalizeOrchestratorDecision(
        input,
        applyOrchestratorInvariants({
          bundle: bundle!,
          turnScope: input.turnScope,
          state: input.state as { meta?: unknown; probe?: unknown },
          routerCapBaseline: bundle!.allowedAgents,
        }),
      )
    )

    lastLint = lintOrchestratorBundle({
      userTask,
      allowedAgents: [...decision.allowedAgents],
      clauses: decision.clauses,
      classify: decision.intentClassify,
      planBlueprint: decision.planBlueprint
    })

    if (!judgeEnabled) {
      return { decision, source, judgeRetries, lintIssues: lastLint, judgeRationale, judgeAccept: true }
    }

    const severity = orchestratorLintSeverity(lastLint)
    const dataAgents = decision.allowedAgents.filter((a) => ['rag', 'db', 'crawler'].includes(String(a))).length
    const mustCover = decision.allowedAgents.filter((a) => EXEC_COVER.has(String(a)))
    const needsJudge =
      severity === 'fail' ||
      (severity === 'warn' && dataAgents >= 2) ||
      (decision.clauses.length >= 2 && dataAgents >= 2) ||
      (dataAgents >= 2 && !blueprintCoversRequiredAgents(decision.planBlueprint, mustCover))

    if (!needsJudge) {
      return { decision, source, judgeRetries, lintIssues: lastLint, judgeRationale, judgeAccept: true }
    }

    input.onThinking?.('审查：校验编排结果结构是否自洽…')
    const judge = await judgeOrchestratorDecision({
      userTask,
      decision,
      structuralIssues: lastLint,
      llmInvoke: input.llmInvoke,
      state: input.state
    })
    judgeRationale = judge.rationale

    if (judge.accept) {
      return { decision, source, judgeRetries, lintIssues: lastLint, judgeRationale, judgeAccept: true }
    }

    fixHint = [judge.fixHint, judge.issues.length ? `须修正：${judge.issues.slice(0, 5).join('；')}` : '']
      .filter(Boolean)
      .join('\n')

    if (attempt >= maxRetries) {
      return {
        decision,
        source: `${source}_judge_warn`,
        judgeRetries,
        lintIssues: judge.issues.length ? judge.issues : lastLint,
        judgeRationale,
        judgeAccept: false
      }
    }
  }

  const decision = attachRouteSkipMeta(
    await finalizeOrchestratorDecision(
      input,
      applyOrchestratorInvariants({
        bundle: bundle!,
        turnScope: input.turnScope,
        state: input.state as { meta?: unknown; probe?: unknown },
        routerCapBaseline: bundle!.allowedAgents,
      }),
    )
  )
  return { decision, source, judgeRetries, lintIssues: lastLint, judgeRationale, judgeAccept: false }
}
