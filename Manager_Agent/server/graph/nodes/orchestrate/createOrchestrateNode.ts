import { buildIntentRagQueryText, buildSessionIntentAnchor, sessionIntentAnchorFromMeta } from '../../core/memory/multiTurnIntent'
import { buildIntentRagRecall, isIntentRagRecallEnabled } from '../../core/rag/intentRagRecall'
import { summarizeEvolutionHintsForOrchestrator } from '../../core/evolution/evolutionHints'
import { isUnifiedOrchestratorEnabled } from '../../llm/taskOrchestrator'
import { shouldSkipOrchestratorRagRecall } from '../../orchestrate/orchestratorHeuristic'
import {
  formatTurnScopeRouterHint,
  resolveTurnRoutingScope,
  shouldDirectChitchatSynth,
  buildChitchatIntentClassify,
  type TurnRoutingScope
} from '../../core/routing/turnScope'
import { turnScopeLlmFromMeta } from '../../llm/turnScopeLlm'
import { emitRouteCapEvent, emitRoutePlanCardEvent } from '../../core/routing/routeStepsEvent'
import { buildRoutePlanCardPayload, isRoutePlanCardEnabled } from '../../core/routing/routePlanCard'
import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'
import {
  isProChitchatContinuationEnabled,
  resolveManagerInteractionMode,
  type ManagerInteractionMode
} from '../../../utils/platform/managerInteractionMode'
import {
  filterAgentsForPosture,
  postureAllowsDebugRerun,
  postureForcesReadOnly,
  postureLabelZh,
  resolveCollaborationPosture,
  resolveEffectiveCollaborationPosture
} from '../../../utils/platform/collaborationPosture'
import { resolveUnifiedOrchestration } from '../../orchestrate/unifiedOrchestrate'
import { resolveOrchestratorRoutingContext } from '../../orchestrate/unifiedRouting'
import { buildRouteAuthorityChain } from '../../orchestrate/routeAuthorityChain'
import { recordAgentMorphologySnapshot } from '../../core/runtime/recordAgentMorphology'
import { buildTurnScopePayload } from '#agent-shared/turnScope'
import { resolveOrchestrationThickness, resolveIntentForOrchestrationThickness } from '../../core/routing/orchestrationThickness'
import {
  formatSessionAnchorCoalesceHint
} from '../../core/routing/routeSkipCascade'
import {
  resolveContinuationRouteBypass,
  buildContinuationBypassDecision
} from '../../core/routing/continuationRouteBypass'
import type { OrchestratorDecision } from '../../orchestrate/orchestratorInvariants'
import type { OrchestratorPipelineResult } from '../../orchestrate/orchestratorPipeline'

import type { CreateOrchestrateNodeDeps } from './types'

function applyProfessionalChitchatContinuation(
  turnScope: TurnRoutingScope,
  workbenchMode: ManagerInteractionMode
): TurnRoutingScope {
  if (workbenchMode !== 'professional' || !isProChitchatContinuationEnabled()) return turnScope
  if (turnScope.mode !== 'chitchat' && !turnScope.directChitchatSynth) return turnScope
  return {
    ...turnScope,
    mode: 'current_only',
    routingContext: turnScope.lastOnly,
    suppressSessionAnchor: false,
    suppressMultiTurnMerge: true,
    directChitchatSynth: false,
    refreshSessionAnchor: false
  }
}

function finishOrchestrateTurn(input: {
  state: any
  turnScope: TurnRoutingScope
  decision: OrchestratorDecision
  orchestratorSource: string
  pipelineResult: OrchestratorPipelineResult | null
  orchestratorMetaBase?: Record<string, unknown>
  mergeMeta: CreateOrchestrateNodeDeps['mergeMeta']
  opts: CreateOrchestrateNodeDeps['opts']
  sessionId?: string
  policyDir?: string
}) {
  const { state, turnScope, decision, orchestratorSource, pipelineResult, mergeMeta, opts } = input
  const judgeAccept =
    pipelineResult?.judgeAccept === false && orchestratorSource === 'pu_stack_fallback'
      ? true
      : (pipelineResult?.judgeAccept ?? true)
  emitRouteCapEvent(
    { sendEvent: opts.sendEvent, runId: opts.runId },
    {
      intent: decision.intent,
      allowedAgents: decision.allowedAgents as any,
      routedQuery: decision.routedQuery,
      rationale: decision.intentClassify?.rationale,
      needsWebSearch: decision.needsWebSearch
    }
  )
  if (isRoutePlanCardEnabled()) {
    emitRoutePlanCardEvent(
      { sendEvent: opts.sendEvent, runId: opts.runId },
      buildRoutePlanCardPayload({
        decision,
        orchestratorSource,
        lintIssues: pipelineResult?.lintIssues ?? [],
        judgeRationale: pipelineResult?.judgeRationale,
        judgeAccept,
        runId: opts.runId
      })
    )
  }
  const nextAnchor =
    turnScope.mode === 'topic_shift' || decision.directChitchatSynth
      ? null
      : buildSessionIntentAnchor(
          decision.intentClassify,
          decision.coalescedTask,
          decision.allowedAgents.filter((a) => ['rag', 'db', 'crawler'].includes(String(a))).map(String)
        )
  const thickness = resolveOrchestrationThickness({
    meta: {
      ...(input.orchestratorMetaBase ?? {}),
      ...decision.metaPatch,
      allowedAgents: decision.allowedAgents,
    },
    intent: decision.intent,
    allowedAgents: decision.allowedAgents,
  })
  const priorSkips =
    decision.metaPatch?.routeSkips && typeof decision.metaPatch.routeSkips === 'object'
      ? (decision.metaPatch.routeSkips as Record<string, boolean>)
      : {}
  const routeSkips = {
    align: Boolean(priorSkips.align ?? decision.metaPatch?.routeSkipAlign),
    plane: Boolean(priorSkips.plane ?? decision.metaPatch?.routeSkipPlane),
    webAlign: Boolean(priorSkips.webAlign ?? decision.metaPatch?.routeSkipWebAlign),
    planner: thickness === 'single_source',
    audit: thickness === 'single_source' || thickness === 'memory_capture'
  }
  const routeLlmCalls =
    typeof decision.metaPatch?.routeLlmCalls === 'number'
      ? Number(decision.metaPatch.routeLlmCalls)
      : undefined
  const routedIntent = resolveIntentForOrchestrationThickness({
    meta: {
      ...(input.orchestratorMetaBase ?? {}),
      ...decision.metaPatch,
      allowedAgents: decision.allowedAgents,
    },
    intent: decision.intent,
    allowedAgents: decision.allowedAgents,
  })
  const next = {
    intent: routedIntent,
    allowedAgents: decision.allowedAgents,
    routedQuery: decision.routedQuery,
    entities: [],
    meta: mergeMeta(state, {
      ...(input.orchestratorMetaBase ?? {}),
      ...decision.metaPatch,
      orchestratorSource,
      orchestratorMode: orchestratorSource,
      orchestratorLintIssues: pipelineResult?.lintIssues ?? [],
      orchestratorJudgeRationale: pipelineResult?.judgeRationale,
      orchestratorJudgeAccept: judgeAccept,
      orchestratorReflexRetries: pipelineResult?.judgeRetries ?? 0,
      turnKind: turnScope.turnKind,
      clarifyKind: decision.clarifyKind ?? turnScope.clarifyKind,
      turnScopeMode: turnScope.mode,
      turn_scope: buildTurnScopePayload(turnScope.mode, turnScope.turnKind),
      sessionIntentAnchor: nextAnchor,
      useLegacyRoute: false,
      orchestrationThickness: thickness,
      lowCostMode: thickness === 'single_source' || thickness === 'memory_capture' ? true : state.meta?.lowCostMode,
      plannerBypassed: thickness === 'single_source' ? true : undefined,
      routeSkips,
      ...(routeLlmCalls != null ? { routeLlmCalls } : {}),
      routeAuthorityChain: buildRouteAuthorityChain({
        meta: {
          ...(input.orchestratorMetaBase ?? {}),
          ...decision.metaPatch,
          allowedAgents: decision.allowedAgents,
          orchestrationThickness: thickness,
          orchestratorSource,
          routeSkips,
          ...(routeLlmCalls != null ? { routeLlmCalls } : {})
        },
        raw: (decision as { raw?: Record<string, unknown> }).raw ?? null,
        turnScopeMode: turnScope.mode,
        turnKind: turnScope.turnKind,
        allowedAgents: decision.allowedAgents.map(String)
      })
    })
  }
  void recordAgentMorphologySnapshot({
    kind: 'planned',
    runId: opts.runId,
    sessionId: input.sessionId,
    policyDir: input.policyDir,
    state: {
      intent: next.intent,
      allowedAgents: next.allowedAgents,
      plan: Array.isArray((decision as { planBlueprint?: { steps?: unknown[] } }).planBlueprint?.steps)
        ? (decision as { planBlueprint: { steps: unknown[] } }).planBlueprint.steps
        : undefined,
      probe: state.probe,
      meta: {
        ...(next.meta as Record<string, unknown>),
        orchestratorRaw: (decision as { raw?: Record<string, unknown> }).raw ?? undefined,
        needsClarify: Boolean((decision as { needsClarify?: boolean }).needsClarify)
      }
    }
  }).catch(() => undefined)
  if (thickness === 'single_source' && !state?.meta?.lowCostMode) {
    opts.sendEvent({
      event: 'thinking',
      data: `轻编排：单源 ${routedIntent}，跳过 Planner → 直连专才`,
      from: 'manager',
    })
  }
  return next
}

export function createOrchestrateNode(deps: CreateOrchestrateNodeDeps) {
  const { policyDir, sessionId, opts, lastUserText: lastUserFn, llmInvoke, mergeMeta } = deps

  return async (state: any) => {
    if (!isUnifiedOrchestratorEnabled()) {
      return { meta: mergeMeta(state, { unifiedOrchestrator: false, useLegacyRoute: true }) }
    }

    opts.sendEvent({ event: 'phase', data: 'orchestrate', from: 'manager' })
    const lastOnlyRaw = String(lastUserFn(state.messages) || '').trim()
    const metaObj = (state.meta && typeof state.meta === 'object' ? state.meta : {}) as Record<string, unknown>
    const clarifyReplan = metaObj.clarifyReplan === true
    const clarifyMerged = String(metaObj.clarifyMergedQuery || '').trim()
    const lastOnly = clarifyReplan && clarifyMerged ? clarifyMerged : lastOnlyRaw
    const workbenchMode = resolveManagerInteractionMode(state.meta)
    /** 用户显式姿态；门禁用有效姿态（可回落 suggestedPosture） */
    const collaborationPosture = resolveCollaborationPosture(state.meta)
    const effectivePosture = resolveEffectiveCollaborationPosture(state.meta)
    const sessionAnchor = sessionIntentAnchorFromMeta(state.meta)

    let turnScope = resolveTurnRoutingScope({
      messages: state.messages as any,
      lastUser: lastOnly,
      sessionAnchor,
      attachment: state.mediaAttachment,
      turnScopeLlm: turnScopeLlmFromMeta(state.meta),
      meta: state.meta
    })
    turnScope = applyProfessionalChitchatContinuation(turnScope, workbenchMode)

    if (!state?.meta?.lowCostMode) {
      const postureNote =
        effectivePosture !== collaborationPosture
          ? `（编排建议 ${postureLabelZh(effectivePosture)}）`
          : ''
      opts.sendEvent({
        event: 'thought_delta',
        data: {
          text: `编排工作台：${workbenchMode === 'professional' ? '专业（PU-Stack·域任务）' : '对话（闲聊/联网/代码）'} · 姿态 ${postureLabelZh(collaborationPosture)}${postureNote}`,
          done: false
        },
        from: 'manager'
      })
    }

    if (effectivePosture === 'debug' && !postureAllowsDebugRerun('debug', state.meta)) {
      const msg =
        'Debug 姿态需要上轮/本轮 Step Observation（步证据）才能定点重验。请先切到 Agent 跑一轮，或在上下文中附带步状态后再进 Debug。'
      opts.sendEvent({
        event: 'thinking',
        data: 'Debug：缺少 Observation，拒绝空猜全图重跑',
        from: 'manager'
      })
      opts.sendEvent({
        event: 'posture_hint',
        data: { suggest: 'agent', reason: 'debug_needs_observation' },
        from: 'manager'
      })
      return {
        intent: 'multi',
        allowedAgents: [],
        routedQuery: lastOnly,
        final: msg,
        meta: mergeMeta(state, {
          collaborationPosture: 'debug',
          postureBlocked: 'debug_no_observation',
          directChitchatSynth: true,
          useLegacyRoute: false
        })
      }
    }

    if (
      workbenchMode === 'chat' &&
      shouldDirectChitchatSynth({ meta: state.meta, turnScope }) &&
      !state.mediaAttachment?.filePath
    ) {
      const classify = buildChitchatIntentClassify(lastOnly)
      opts.sendEvent({
        event: 'thinking',
        data: '对话模式：寒暄/确认 → 直连 synth',
        from: 'manager'
      })
      return {
        intent: 'multi',
        allowedAgents: [],
        routedQuery: lastOnly,
        meta: mergeMeta(state, {
          unifiedOrchestrator: true,
          orchestratorMode: 'chitchat',
          orchestratorSource: 'chitchat',
          interactionMode: 'chat',
          workbenchMode: 'chat',
          directChitchatSynth: true,
          intentClassify: classify,
          intentClassifyMode: 'orchestrator',
          turnScopeMode: turnScope.mode,
          routeConfidence: Number(classify.confidence ?? 0.92) || 0.92,
          uncertainty: 'low',
          useLegacyRoute: false
        })
      }
    }

    const routingContext =
      clarifyReplan && clarifyMerged
        ? clarifyMerged
        : resolveOrchestratorRoutingContext(turnScope)
    const turnHint = [
      formatTurnScopeRouterHint(turnScope),
      turnScope.turnKind === 'output_followup' && sessionAnchor?.lastExecutedAgents?.length
        ? `【输出追问·窄 cap】上轮数据面=${sessionAnchor.lastExecutedAgents.join('+')}；allowedAgents 不得超出此集合（可直连 synth）。`
        : '',
      formatSessionAnchorCoalesceHint({
        turnKind: turnScope.turnKind,
        turnScopeMode: turnScope.mode,
        coalescedTask: sessionAnchor?.coalescedTask,
        lastExecutedAgents: sessionAnchor?.lastExecutedAgents
      }),
      metaObj.clarifyReplan === true ? '【澄清补答】已合并原问与补答，禁止二次 clarify。' : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    if (clarifyReplan) {
      opts.sendEvent({
        event: 'thought_delta',
        data: {
          text: `clarify→replan：合并原问与补答后重编排（${clarifyMerged.slice(0, 72)}${clarifyMerged.length > 72 ? '…' : ''}）`,
          done: false
        },
        from: 'manager'
      })
    }

    let ragRecall = null as Awaited<ReturnType<typeof buildIntentRagRecall>> | null
    if (
      workbenchMode === 'professional' &&
      isIntentRagRecallEnabled() &&
      !turnScope.suppressSessionAnchor &&
      turnScope.mode !== 'topic_shift' &&
      !shouldSkipOrchestratorRagRecall({
        probe: state.probe,
        turnScopeMode: turnScope.mode,
        turnKind: turnScope.turnKind,
        sessionAnchorAgents: sessionAnchor?.lastExecutedAgents
      })
    ) {
      const ragQuery = buildIntentRagQueryText({
        messages: state.messages as any,
        lastUser: lastOnly,
        sessionAnchor: turnScope.suppressSessionAnchor ? null : sessionAnchor
      })
      if (ragQuery.query.length >= 6) {
        try {
          ragRecall = await buildIntentRagRecall({
            policyDir,
            queryText: ragQuery.query,
            probe: state.probe,
            sessionAnchor: turnScope.suppressSessionAnchor ? null : sessionAnchor,
            multiTurn: ragQuery.multiTurn
          })
        } catch {
          ragRecall = null
        }
      }
    }

    const evolutionHint = await summarizeEvolutionHintsForOrchestrator({
      policyDir,
      sessionId,
      toolHealth: state.toolHealth,
      probeRagHits: Number(state.probe?.rag?.hits ?? 0) || 0
    }).catch(() => '')

    const onThinking = (line: string) => {
      if (state?.meta?.lowCostMode) return
      const text = String(line || '').trim()
      if (!text) return
      opts.sendEvent({
        event: 'thought_delta',
        data: { text, done: false },
        from: 'manager'
      })
    }

    const orchInput = {
      state,
      messages: state.messages as any,
      lastUser: lastOnly,
      routingContext,
      turnScopeHint: turnHint,
      turnScope,
      probe: state.probe,
      sessionAnchor: turnScope.suppressSessionAnchor ? null : sessionAnchor,
      ragRecall,
      evolutionHint,
      llmInvoke,
      mergeMeta,
      onThinking
    }

    // Phase2：续轮单源 cap 复用 — 跳过编排 LLM（probe 冲突则降级全量）
    const contBypass = resolveContinuationRouteBypass({
      turnScope,
      sessionAnchor: turnScope.suppressSessionAnchor ? null : sessionAnchor,
      lastUser: lastOnly,
      probe: state.probe,
      meta: state.meta
    })
    if (contBypass.ok) {
      const decision = buildContinuationBypassDecision({
        bypass: contBypass,
        turnScope,
        lastUser: lastOnly
      })
      const filteredAgents = filterAgentsForPosture(decision.allowedAgents as string[], effectivePosture)
      const finalDecision =
        filteredAgents.length !== decision.allowedAgents.length
          ? { ...decision, allowedAgents: filteredAgents as typeof decision.allowedAgents }
          : decision
      if (!state?.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thought_delta',
          data: {
            text: `续轮复用上轮 cap：${finalDecision.allowedAgents.join('→')}（跳过编排 LLM）`,
            done: false
          },
          from: 'manager'
        })
      }
      return finishOrchestrateTurn({
        state,
        turnScope,
        decision: finalDecision,
        orchestratorSource: 'continuation_cap_reuse',
        pipelineResult: null,
        orchestratorMetaBase: {
          unifiedOrchestrator: true,
          llmFirstRoute: true,
          collaborationPosture,
          effectivePosture,
          continuationCapReuse: true,
          ...(postureForcesReadOnly(effectivePosture) ? { postureReadOnly: true } : {})
        },
        mergeMeta,
        opts,
        sessionId,
        policyDir
      })
    }

    try {
      const unified = await resolveUnifiedOrchestration(orchInput)
      let { decision, orchestratorSource, pipelineResult } = unified
      const filteredAgents = filterAgentsForPosture(decision.allowedAgents as string[], effectivePosture)
      if (filteredAgents.length !== decision.allowedAgents.length) {
        decision = {
          ...decision,
          allowedAgents: filteredAgents as typeof decision.allowedAgents
        }
        onThinking(
          `姿态 ${postureLabelZh(effectivePosture)}：已剔除写副作用专才（Ask/Debug 只读）`
        )
      }
      const modeLabel = workbenchMode === 'professional' ? '专业' : '对话'
      if (!state?.meta?.lowCostMode) {
        const bp = decision.planBlueprint?.steps?.map((s) => s.agent).join('→') || '（无蓝图）'
        const webMode = (decision.metaPatch as Record<string, unknown>)?.webExecutionMode as
          | { mode?: string }
          | undefined
        const webHint = webMode?.mode ? ` web=${webMode.mode}` : ''
        const planes = decision.allowedAgents.filter((a) => ['db', 'rag', 'crawler', 'gui', 'admin'].includes(String(a)))
        const summary = [
          `${modeLabel}编排[${orchestratorSource}]：${decision.intent}`,
          `数据/工具面=${planes.join('+') || '（加工链）'}`,
          `执行链=${decision.allowedAgents.join('→')}`,
          `蓝图=${bp}${webHint}`,
          decision.intentClassify?.needsWeb ? '含公网腿' : '无公网腿'
        ].join('｜')
        opts.sendEvent({
          event: 'thought_delta',
          data: { text: summary, done: false },
          from: 'manager'
        })
        onThinking(
          `路由结论：${planes.length ? `选用 ${planes.join('、')}` : '仅加工链'}；${
            decision.intentClassify?.needsWeb ? '需要公网采集' : '不调用采集网页'
          }；计划 ${bp}`
        )
      }
      return finishOrchestrateTurn({
        state,
        turnScope,
        decision,
        orchestratorSource,
        pipelineResult,
        orchestratorMetaBase: {
          ...(unified.orchestratorMetaBase ?? {}),
          collaborationPosture,
          effectivePosture,
          ...(postureForcesReadOnly(effectivePosture) ? { postureReadOnly: true } : {})
        },
        mergeMeta,
        opts,
        sessionId,
        policyDir
      })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      onThinking(`编排失败：${detail}`)
      throw e instanceof Error ? e : new Error(detail || 'unified_orchestration_failed')
    }
  }
}

