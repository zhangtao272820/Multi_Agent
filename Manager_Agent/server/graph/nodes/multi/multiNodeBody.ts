import type { Step } from '../../../utils/shared/taskPlan'
import { effectiveUserTask, lastUserText } from '../../core/text'
import { extractStructuredPayload } from '../../core/shared'
import { structuralAnswerVerdict } from '../../core/agent/agentAnswerJudge'
import { buildInternalCollabContext } from '../../core/output/downstreamContext'
import { globalFactsForInternalPayload, hasCodeInResults, buildCodeFirstBundle } from '#agent-shared/codeFirstAuthority'
import {
  getManagerMaxParallel,
  isCodeStepCompletedInRun,
  isParallelIndependentEnabled,
  listBlockingDependencies,
  listDependentsToSkipAfterFailure,
  getUpstreamFailureSkipReason,
  suggestMaxParallelForPlan
} from '../../core/plan/planParallel'
import { validateAndPreparePlan } from '../../core/plan/planValidate'
import { runTaskFetcherLoop, describeParallelReadyBatch } from '../../core/task/taskFetcher'
import { hydrateCompletedById } from '../../core/runtime/stepReuse'
import { pipelineHintsFromMeta } from '../../llm/pipelineHintsLlm'
import { taskConstraintsFromMeta } from '../../llm/taskConstraintsLlm'
import { tryCodeAuthorityDownstreamOutput, repairCodeAuthorityVisualize } from '../../../utils/code/managerCodeDownstream'
import {
  shouldDeferReportToSynth,
  deferredReportEvidence,
  shouldDeferVisualizeToSynthCollab,
  deferredVisualizeCollabEvidence
} from '#agent-shared/reportSynthDefer'
import { tryDeterministicDownstreamOutput } from '#agent-shared/codeDownstreamOutput'
import { createCodeAuthorityLlmModel } from '../../../utils/code/managerCodeAuthorityLlm'
import { shouldPassUpstreamMissing, buildAdminEffectiveQuery, extractAdminSubtaskText } from '../../core/stepIsolation'
import { isAdminReadOnlyOrchestrationStep, resolveAdminAutoConfirm } from '../../core/db/writeGate'
import type { RagRelevanceJudge, RagEvidenceMatchJudge, RagScopeHintJudge } from '../../../utils/rag/managerRagRelevance'
import {
  createAgentRunTelemetry,
  precheckAgentStep,
  recordSkippedAgentStep,
  isCircuitSkipCoreEnabled,
  type StepRunRecord
} from '../../core/agent/agentRunner'
import { errorCodeFromStepOutcome } from '../../core/runtime/expertFailure'
import { acquireExpertInflight, releaseExpertInflight } from '../../core/runtime/backpressure'
import type { ManagerGraphState } from '../../state/state'
import type { AgentExecutorDeps, AgentExecutorOpts } from '../../core/executors'
import {
  applyAgentStepOutcome,
  buildMultiStepEffQuery,
  dispatchPlanAgentStep,
  hasUsableFactsFromText
} from '../../core/executors'
import { hasRagPrefetchOrStepEvidence } from '../../orchestrate/clarifyProbeGate'
import { resolveMultiDbEffectiveQuery, dbAnchorCtx } from '../../../utils/db/managerDbQuestionLlm'
import { resolveDbStepQuestionSync } from '../../core/db/dbStepQuestion'
import { adminScopedQueryFromMeta } from '../../../utils/admin/managerAdminTaskPayload'
import { stripAdminManagerGuards } from '../../../utils/route/managerSubAgentHelpers'
import { resolveSubAgentScopeByLlm, isGenericQueryFocus } from '../../../utils/route/managerSubAgentScopeLlm'
import { parseCleanPayload } from '#agent-shared/cleanPayload'
import { crawlerSourceHitsForEvent } from '../../../utils/crawler/crawlerItemsParse'
import { buildSpecialistHandoffFromStep } from '../../../utils/agents/specialistHandoff'
import {
  buildSoftHandoffFromStep,
  formatDependencySoftHandoffs,
  mergeSoftHandoffsIntoMeta
} from '../../core/routing/softHandoff'
import { buildStepStatus, estimateMultiEtaMs } from '../../core/runtime/stepStatus'
import { emitPlanStepsEvent } from '../../core/plan/planStepsEvent'
import { emitStepResultEvent } from '../../core/output/stepResultEvent'
import { emitCollabPreview } from '../../core/plan/collabPreview'
import {
  llmLocalReplanRemaining,
  localReplanMaxPerRun,
  shouldConsiderLocalReplan,
  shouldForcePlanRollback,
  filterStepsExcludingCircuitAgents,
  resolveCircuitBlockedReplan,
  classifyStepObservationFailure
} from '../../core/plan/localReplan'
import { llmPhaseContinue, maxRunPhases } from '../../core/plan/phaseContinue'
import {
  buildPlanPreviewPayload,
  mergeConfirmedPlanSteps
} from '../../core/plan/planPreview'
import { waitPlanConfirm } from '../../../utils/shared/planConfirmBridge'
import { formatLocalReplanNarrative } from '../../orchestrate/orchestrationNarrative'
import { clipObsSummary, keepLastObservations } from '../../core/shared/promptBudget'
import crypto from 'node:crypto'
import {
  buildGuiHandoffStep,
  crawlerOutcomeRouteSuggestion,
  shouldInjectGuiAfterCrawler
} from '../../core/agent/guiCrawlerHandoff'
import { resolveEmptyPlanFallbackAgent } from '../../core/runtime/emptyPlanFallback'
import type { CreateMultiNodeDeps } from './types'


export async function runMultiNodeBody(state: any, deps: any) {
  const {
      ensureNotAborted,
      opts,
      policyPromise,
      defaultPolicy,
      getEffectivePlanSteps,
      normalizePlanSteps,
      buildStepContext,
      lastUserText,
      timeLeftMs,
      callDbAgent,
      callRagAgent,
      callCrawlerAgent,
      callLobsterAgent,
      callAiAdminAgent,
      callCodeAgent,
      callMultimodalAgent,
      callMusicAgent,
      callVideoAgent,
      runInternalAgent,
      parseRagClarifyPayload,
      parseCrawlerClarifyPayload,
      probeRagEvidence,
      filterCrawlerResultDomestic,
      buildClarifyQuestions,
      appendMetrics: appendMetricsDep,
      isDbNoData,
      emitTrace,
      summarize,
      mergeMeta,
      mergeTaskPlan,
      ragRelevanceJudge,
      ragEvidenceMatchJudge,
      ragScopeHintJudge,
      llmInvoke
    } = deps

    const llmBundle = {
      openaiApiKey: opts.openaiApiKey as string | undefined,
      openaiModel: opts.openaiModel as string | undefined,
      openaiBaseUrl: opts.openaiBaseUrl as string | undefined
    }
    ensureNotAborted()
    const initialRunPhase = Math.max(1, Number(state?.meta?.runPhase || 1) || 1)
    opts.sendEvent({
      event: 'phase',
      data: { name: 'execute:multi', runPhase: initialRunPhase },
      from: 'manager'
    })
    // 兼容旧前端：同时发字符串 phase
    opts.sendEvent({ event: 'phase', data: `execute:multi:phase${initialRunPhase}`, from: 'manager' })
    const question = effectiveUserTask(state.messages as any, state.routedQuery)
    const policy = await policyPromise.catch(() => defaultPolicy())

    const sourceSteps = getEffectivePlanSteps(state as any)
    const taskText = effectiveUserTask(state.messages as any, state.routedQuery)
    const pipeOpts = {
      question: taskText,
      constraints: taskConstraintsFromMeta(state.meta) ?? undefined,
      pipelineHints: pipelineHintsFromMeta(state.meta) ?? undefined
    }
    const emptyPlanAgent = resolveEmptyPlanFallbackAgent(state as any)
    const steps = validateAndPreparePlan(
      normalizePlanSteps(
        sourceSteps.length ? sourceSteps : [{ agent: emptyPlanAgent, query: question }]
      ),
      {
        excerpt: taskText,
        pipelineOpts: pipeOpts,
          allowedCap: Array.isArray(state.allowedAgents)
            ? (state.allowedAgents as Step['agent'][]).filter(Boolean)
            : undefined
        }
      )
      const codePlannedInRun = steps.some((s) => s.agent === 'code')
      const carryPriorRunResults =
        Boolean(String(state.fixQuery || '').trim()) ||
        Number(state.retryCount || 0) > 0 ||
        Boolean((state as { resumeAdminConfirm?: boolean }).resumeAdminConfirm) ||
        Boolean((state.meta as { resumeAdminConfirm?: boolean } | undefined)?.resumeAdminConfirm)
      const out: Record<string, string> = carryPriorRunResults ? { ...(state.results || {}) } : {}
      const evidences: any[] = carryPriorRunResults ? [...(state.evidence || [])] : []
      const clarifyQuestions: string[] = []
      const voteDecisions: Array<{
        stepId: string
        agent: string
        selected: 'A' | 'B'
        winnerScore: number
        loserScore: number
        winnerSupportRate: number
        loserSupportRate: number
        winnerConflictCount: number
        loserConflictCount: number
        winnerReason: string
      }> = []
      const byId: Record<string, StepRunRecord> = {}
      const forceRerunStepIds = Array.isArray((state.meta as { forceRerunStepIds?: unknown })?.forceRerunStepIds)
        ? ((state.meta as { forceRerunStepIds: unknown[] }).forceRerunStepIds || [])
            .map((x) => String(x || '').trim())
            .filter(Boolean)
        : []
      if (carryPriorRunResults) {
        const priorRecords = Array.isArray(state.meta?.lastStepRecords)
          ? (state.meta.lastStepRecords as Array<{
              id?: string
              agent?: string
              status?: string
              error?: string
              output?: string
              summary?: string
              query?: string
            }>)
          : []
        const hydrated = hydrateCompletedById({
          plan: steps,
          lastStepRecords: priorRecords,
          results: out,
          evidence: evidences,
          forceRerunStepIds
        })
        Object.assign(byId, hydrated.byId)
        if (hydrated.reusedIds.length) {
          opts.sendEvent({
            event: 'thinking',
            data: `图级重试：复用已完成步 ${hydrated.reusedIds.length} 个（${hydrated.reusedIds
              .map((id) => `${id}:${hydrated.reasons[id] || 'reuse'}`)
              .join('、')}），避免重复调度`,
            from: 'manager'
          })
        }
      }
      const thinkingRelayState = new Map<string, { lastText: string; lastAt: number }>()
      const relayThinking = (agent: string, text: string, minIntervalMs = 1800) => {
        const now = Date.now()
        const normalized = String(text || '').replace(/\s+/g, ' ').trim()
        if (!normalized) return
        const key = String(agent || 'manager')
        const prev = thinkingRelayState.get(key)
        if (prev && prev.lastText === normalized && now - prev.lastAt < Math.max(4000, minIntervalMs * 2)) return
        if (prev && now - prev.lastAt < minIntervalMs) return
        thinkingRelayState.set(key, { lastText: normalized, lastAt: now })
        opts.sendEvent({ event: 'thinking', data: normalized, from: key })
      }

      const allowRetry = () => timeLeftMs(state.resources) > 14_000 && !Boolean(state.meta?.lowCostMode)
      const schedulerMaxParallel = Number(state?.scheduler?.maxParallel ?? 0)
      const schedulerTimeoutScale = Number(state?.scheduler?.timeoutScale ?? 1)
      const schedulerBudget = (state?.scheduler?.contextBudget && typeof state.scheduler.contextBudget === 'object') ? state.scheduler.contextBudget : {}
      const schedulerSkipAgents = Array.isArray(state?.scheduler?.skipAgents) ? state.scheduler.skipAgents.map((x: any) => String(x)) : []
      const schedulerCircuitOpenAgents = Array.isArray(state?.scheduler?.circuitOpenAgents) ? state.scheduler.circuitOpenAgents.map((x: any) => String(x)) : []
      const schedulerDegradeOptionalAgents = Array.isArray(state?.scheduler?.degradeOptionalAgents) ? state.scheduler.degradeOptionalAgents.map((x: any) => String(x)) : []
      const schedulerAgentTimeoutScale =
        (state?.scheduler?.agentTimeoutScale && typeof state.scheduler.agentTimeoutScale === 'object')
          ? state.scheduler.agentTimeoutScale as Record<string, number>
          : {}
      const toolHealthP95ByAgent = new Map<string, number>()
      for (const h of Array.isArray(state?.toolHealth?.agents) ? state.toolHealth.agents : []) {
        const k = String(h?.agent || '').trim()
        if (!k) continue
        toolHealthP95ByAgent.set(k, Number(h?.p95Ms || 0) || 0)
      }
      const telemetry = createAgentRunTelemetry({
        globalTimeoutMs: Number(opts.timeoutMs || 60_000),
        timeLeftMs: () => timeLeftMs(state.resources),
        schedulerTimeoutScale,
        schedulerAgentTimeoutScale,
        toolHealthP95ByAgent,
        schedulerCircuitOpenAgents
      })
      const seededHard =
        state?.meta?.expertHardDown && typeof state.meta.expertHardDown === 'object'
          ? (state.meta.expertHardDown as Record<string, string>)
          : {}
      for (const [agent, code] of Object.entries(seededHard)) {
        if (agent) telemetry.markExpertHardDown(String(agent), String(code || 'network'))
      }
      // E3/F3: enrich tokens from meta/output then accumulate spend for budget gate
      const appendMetrics = async (entry: Record<string, unknown>) => {
        const { extractStepUsage } = await import('../../core/runtime/expertFailure')
        const meta = entry.meta
        const outputText = String(entry.outputText || entry.output || '')
        const { meta: _meta, outputText: _ot, output: _out, ...rest } = entry
        let tokens = Number(rest.tokens || 0)
        let usd = Number(rest.usd || 0)
        const extraBase =
          rest.extra && typeof rest.extra === 'object' && !Array.isArray(rest.extra)
            ? { ...(rest.extra as Record<string, unknown>) }
            : {}
        let extra = { ...extraBase }
        if (!(Number.isFinite(tokens) && tokens > 0)) {
          const usage = extractStepUsage(meta, outputText)
          if (usage.tokens) tokens = usage.tokens
          if (usage.usd) usd = usage.usd
          if (usage.actual === false) extra = { ...extra, tokenAccounting: 'estimated' }
          else if (usage.actual === true) extra = { ...extra, tokenAccounting: 'actual' }
        }
        const cleaned: Record<string, unknown> = { ...rest }
        if (Number.isFinite(tokens) && tokens > 0) cleaned.tokens = tokens
        if (Number.isFinite(usd) && usd > 0) cleaned.usd = usd
        if (Object.keys(extra).length) cleaned.extra = extra
        else delete cleaned.extra
        telemetry.addSpend({
          tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : undefined,
          usd: Number.isFinite(usd) && usd > 0 ? usd : undefined
        })
        return appendMetricsDep(cleaned as any)
      }
      const {
        scaledTimeoutForAgent,
        recordAgentSuccess,
        recordAgentFailure,
        optionalAgents,
        runtimeCircuitOpenAgents,
        isExpertHardDown
      } =
        telemetry
      const executionMode = String(state?.executionMode?.mode || 'parallel')
      const voteEnabled = Boolean(state?.votePolicy?.enabled) && executionMode === 'vote'
      const voteTargets = Array.isArray(state?.votePolicy?.targets) ? state.votePolicy.targets.map((x: any) => String(x)) : []
      const voteScoring = state?.votePolicy?.scoring && typeof state.votePolicy.scoring === 'object' ? state.votePolicy.scoring : {}
      const factWeight = Number.isFinite(Number(voteScoring?.factWeight)) ? Number(voteScoring.factWeight) : 1
      const missingPenalty = Number.isFinite(Number(voteScoring?.missingPenalty)) ? Number(voteScoring.missingPenalty) : 1
      const lengthPenalty = Number.isFinite(Number(voteScoring?.lengthPenalty)) ? Number(voteScoring.lengthPenalty) : 0.0002
      const evidenceSupportWeight = Number.isFinite(Number(voteScoring?.evidenceSupportWeight)) ? Number(voteScoring.evidenceSupportWeight) : 1.2
      const conflictPenalty = Number.isFinite(Number(voteScoring?.conflictPenalty)) ? Number(voteScoring.conflictPenalty) : 1.5
      const trimForContext = (text: string, max = 700) => {
        const s = String(text || '').replace(/\s+/g, ' ').trim()
        if (s.length <= max) return s
        return `${s.slice(0, max)}…`
      }
      const toCompactFacts = (parsed: any, maxFacts = 8) => {
        const facts = Array.isArray(parsed?.facts) ? parsed.facts : []
        return facts
          .map((f: any) => ({ key: String(f?.key ?? '').trim(), value: String(f?.value ?? '').trim() }))
          .filter((f: any) => Boolean(f.key))
          .slice(0, maxFacts)
      }
      const collectSources = () => {
        const outSrc: string[] = []
        for (const ev of evidences) {
          const kind = String(ev?.kind || '')
          if (kind === 'rag') {
            const cites = Array.isArray(ev?.citations) ? ev.citations : []
            for (const c of cites) {
              const s = String(c?.source || c?.title || c?.url || '').trim()
              if (s) outSrc.push(s)
            }
          }
          if (kind === 'crawler') {
            const q = String(ev?.query || '').trim()
            if (q) outSrc.push(`crawler:${q.slice(0, 100)}`)
          }
        }
        return Array.from(new Set(outSrc)).slice(0, 8)
      }
      const buildInternalPayload = (step: Step, ctx: string) => {
        const depIds = Array.isArray((step as any).dependsOn) ? ((step as any).dependsOn as string[]) : []
        const depSummaries = depIds
          .map((id) => byId[String(id)])
          .filter(Boolean)
          .map((it: StepRunRecord) => {
            const handoff =
              it.handoff ||
              buildSpecialistHandoffFromStep({
                agent: String(it.agent),
                stepId: String(it.id),
                ok: it.status === 'ok',
                output: it.output,
                error: it.error,
                agentResult: (it.meta as { agentResult?: import('../../../utils/agents/types').AgentResult } | undefined)
                  ?.agentResult
              })
            const parsed = it.parsed || extractStructuredPayload(String(it.output ?? ''))
            return {
              id: it.id,
              agent: it.agent,
              summary: handoff.summary,
              evidenceRefs: handoff.evidenceRefs,
              confidence: handoff.confidence,
              failure: handoff.failure,
              rawRef: handoff.rawRef,
              facts: toCompactFacts(parsed, 6),
              missingFields: shouldPassUpstreamMissing(step.agent, it.agent)
                ? (Array.isArray((parsed as { missingFields?: unknown })?.missingFields)
                    ? (parsed as { missingFields: unknown[] }).missingFields
                    : []
                  )
                    .map((x: unknown) => String(x ?? '').trim())
                    .filter(Boolean)
                    .slice(0, 3)
                : []
            }
          })
        const softHandoffBlock = formatDependencySoftHandoffs(depSummaries)
        return {
          mode: 'structured_context_v2',
          stepAgent: step.agent,
          userTask: question,
          stepQuery: String(step.query || ''),
          ...(String((step as { taskForm?: string }).taskForm || '').trim()
            ? { taskForm: String((step as { taskForm?: string }).taskForm).trim() }
            : {}),
          dependencySummaries: depSummaries.slice(0, 5),
          softHandoff: softHandoffBlock || undefined,
          /** 父上下文摘要：禁止塞专才全文，仅 digest */
          contextDigest: trimForContext(ctx, 1000),
          globalFacts: globalFactsForInternalPayload(
            { ...(state.results || {}), ...out } as Record<string, unknown>,
            extractStructuredPayload
          ).map((g) => ({
            agent: g.agent,
            facts: toCompactFacts({ facts: g.facts }, 8),
            summary: g.summary
          })),
          sources: collectSources()
        }
      }
      const hasUsableFacts = hasUsableFactsFromText

      const executorDeps: AgentExecutorDeps = {
        callDbAgent,
        callRagAgent,
        callCrawlerAgent,
        callLobsterAgent,
        callCodeAgent,
        callAiAdminAgent,
        callMultimodalAgent,
        callMusicAgent,
        callVideoAgent,
        probeRagEvidence,
        filterCrawlerResultDomestic,
        isDbNoData,
        ragRelevanceJudge,
        ragEvidenceMatchJudge,
        ragScopeHintJudge,
        lastUserText,
        buildClarifyQuestions,
        runInternalAgent
      }
      const executorOpts: AgentExecutorOpts = {
        runId: opts.runId,
        threadId: opts.threadId,
        sessionId: opts.sessionId,
        userId: opts.userId,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        dbAgentWsUrl: opts.dbAgentWsUrl,
        dbAgentHttpUrl: opts.dbAgentHttpUrl,
        dbId: opts.dbId,
        ragAgentHttpUrl: opts.ragAgentHttpUrl,
        ragHistory: opts.ragHistory,
        ragConversationId: opts.ragConversationId,
        codeAgentWsUrl: opts.codeAgentWsUrl,
        crawlerAgentWsUrl: opts.crawlerAgentWsUrl,
        lobsterAgentWsUrl: opts.lobsterAgentWsUrl,
        aiAdminAgentWsUrl: opts.aiAdminAgentWsUrl,
        multimodalAgentHttpUrl: opts.multimodalAgentHttpUrl,
        musicAgentWsUrl: opts.musicAgentWsUrl,
        videoAgentWsUrl: opts.videoAgentWsUrl,
        sendEvent: opts.sendEvent
      }
      const collectEvidenceFacts = () => {
        const facts: string[] = []
        const valueLike = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim()
        for (const k of ['db', 'rag', 'crawler']) {
          const txt = valueLike((out as any)[k])
          if (!txt) continue
          const parsed = extractStructuredPayload(txt)
          const parsedFacts = Array.isArray(parsed?.facts) ? parsed.facts : []
          for (const f of parsedFacts) {
            const key = valueLike(f?.key)
            const value = valueLike(f?.value)
            if (key) facts.push(key)
            if (value) facts.push(value)
          }
        }
        return Array.from(new Set(facts.filter(Boolean))).slice(0, 48)
      }
      const evaluateCandidateAgainstEvidence = (text: string) => {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()
        if (!normalized) return { supportRate: 0, conflictCount: 0 }
        const evidenceFacts = collectEvidenceFacts().map((x) => x.toLowerCase())
        if (!evidenceFacts.length) return { supportRate: 0.5, conflictCount: 0 }
        const matched = evidenceFacts.filter((f) => f.length >= 3 && normalized.includes(f)).length
        const supportRate = Math.max(0, Math.min(1, matched / evidenceFacts.length))
        let conflictCount = 0
        const candidateVerdict = structuralAnswerVerdict(String(text || ''))
        if (candidateVerdict.empty && matched > 0) conflictCount += 1
        return { supportRate, conflictCount }
      }
      const scoreVoteCandidate = (text: string) => {
        const parsed = extractStructuredPayload(String(text || ''))
        const facts = Array.isArray(parsed?.facts) ? parsed.facts.length : 0
        const missing = Array.isArray(parsed?.missingFields) ? parsed.missingFields.length : 0
        const len = String(parsed?.answer || text || '').trim().length
        const evidenceEval = evaluateCandidateAgainstEvidence(String(parsed?.answer || text || ''))
        const base = facts * factWeight - missing * missingPenalty - len * lengthPenalty
        const evidenceScore = evidenceEval.supportRate * evidenceSupportWeight
        const conflictScore = evidenceEval.conflictCount * conflictPenalty
        return {
          total: base + evidenceScore - conflictScore,
          base,
          evidenceScore,
          conflictScore,
          supportRate: evidenceEval.supportRate,
          conflictCount: evidenceEval.conflictCount
        }
      }

      const crawlerHandoffHints = new Map<string, { suggestion: string; task: string }>()
      const runStep = async (step: Step) => {
        ensureNotAborted()
        const stepId = String(step.id || '').trim()
        const stepAgent = String(step.agent || '')
        const baseQuery = String(step.query || '').trim() || question
        const ctx = buildStepContext(step, byId)
        let effQuery = buildMultiStepEffQuery(step, question, ctx, state as ManagerGraphState)
        if (step.agent === 'db') {
          effQuery = resolveDbStepQuestionSync(
            baseQuery,
            lastUserText(state.messages),
            state.meta
          )
          if (!effQuery || effQuery.length < 4) {
            effQuery = resolveMultiDbEffectiveQuery(
              baseQuery,
              question,
              lastUserText(state.messages),
              dbAnchorCtx(state),
              state.meta
            )
          }
        }
        let adminScopeQuery: string | undefined
        if (step.agent === 'admin') {
          const fromUser = extractAdminSubtaskText(question)
          const adminScopeSeed =
            (fromUser.length >= 4 && !isGenericQueryFocus(fromUser) ? fromUser : '') ||
            (baseQuery.length >= 4 && !isGenericQueryFocus(baseQuery) ? baseQuery : '') ||
            fromUser ||
            baseQuery
          const scopeRes = await resolveSubAgentScopeByLlm({
            agent: 'admin',
            meta: state.meta,
            stepQuery: adminScopeSeed,
            userTask: question,
            llmInvoke,
            state
          })
          let picked =
            stripAdminManagerGuards(scopeRes.text) ||
            scopeRes.text ||
            adminScopedQueryFromMeta(state.meta, baseQuery) ||
            baseQuery
          picked = stripAdminManagerGuards(picked) || picked
          // scope 裁成缺槽空壳时，回退用户侧 admin 子句（保留时间/标题）
          if (
            isGenericQueryFocus(picked) ||
            (picked.length < 12 && fromUser.length > picked.length && /会议|日程|待办|提醒/.test(fromUser))
          ) {
            picked = fromUser || picked
          }
          adminScopeQuery = picked
          effQuery = buildAdminEffectiveQuery(
            adminScopeQuery,
            adminScopeQuery,
            ctx,
            resolveAdminAutoConfirm(state, adminScopeQuery),
            isAdminReadOnlyOrchestrationStep(adminScopeQuery)
          )
        }
        const t0 = Date.now()
        const precheck = precheckAgentStep({
          stepAgent,
          stepId,
          agent: step.agent,
          effQuery,
          plannedInTask: steps.some((s) => String(s.agent) === stepAgent),
          schedulerSkipAgents,
          schedulerDegradeOptionalAgents,
          telemetry,
          optionalStep: Boolean((step as { optional?: boolean }).optional) || optionalAgents.has(stepAgent)
        })
        if (precheck.action === 'skip') {
          await recordSkippedAgentStep({
            stepId,
            agent: step.agent,
            effQuery,
            reason: precheck.reason,
            policy: precheck.policy,
            t0,
            runId: opts.runId,
            byId,
            evidences,
            relayThinking,
            emitTrace,
            appendMetrics
          })
          return
        }

        const upstreamSkip = getUpstreamFailureSkipReason(
          step,
          steps,
          Object.fromEntries(Object.entries(byId).map(([id, rec]) => [id, { status: rec.status }]))
        )
        if (upstreamSkip) {
          await recordSkippedAgentStep({
            stepId,
            agent: step.agent,
            effQuery,
            reason: upstreamSkip,
            policy: 'upstream_failed',
            t0,
            runId: opts.runId,
            byId,
            evidences,
            relayThinking,
            emitTrace,
            appendMetrics
          })
          return
        }

        if (step.agent === 'clean') {
          const existingRaw = String(out.clean ?? '').trim()
          const existing = existingRaw ? parseCleanPayload(existingRaw) : null
          if (existing && (existing.facts?.length ?? 0) > 0) {
            await recordSkippedAgentStep({
              stepId,
              agent: step.agent,
              effQuery,
              reason: 'clean_already_done_in_run',
              policy: 'clean_dedupe',
              t0,
              runId: opts.runId,
              byId,
              evidences,
              relayThinking,
              emitTrace,
              appendMetrics
            })
            return
          }
        }

        const sharedDispatchAgents = new Set<Step['agent']>([
          'db',
          'rag',
          'crawler',
          'gui',
          'admin',
          'code',
          'clean',
          'visualize',
          'report',
          'multimodal',
          'music',
          'video'
        ])
        const stepTimeoutMs =
          step.agent === 'music'
            ? Math.min(scaledTimeoutForAgent('music', opts.timeoutMs), 300_000)
            : step.agent === 'video'
              ? Math.min(scaledTimeoutForAgent('video', opts.timeoutMs), 600_000)
              : step.agent === 'gui'
                ? Math.min(scaledTimeoutForAgent('gui', opts.timeoutMs), 600_000)
                : scaledTimeoutForAgent(stepAgent, opts.timeoutMs)
        if (sharedDispatchAgents.has(step.agent)) {
          acquireExpertInflight(stepAgent)
          try {
          emitTrace({
            type: 'step_start',
            agent: step.agent,
            stepId,
            input: effQuery,
            at: new Date().toISOString()
          })
          let internalCtx: Parameters<typeof dispatchPlanAgentStep>[1]['internal']
          if (step.agent === 'clean' || step.agent === 'visualize' || step.agent === 'report') {
            const mergedResults = { ...(state.results || {}), ...out } as Record<string, unknown>
            const runResults = { ...out } as Record<string, unknown>
            const codeDoneInRun = isCodeStepCompletedInRun(steps, byId)
            if (
              (step.agent === 'visualize' || step.agent === 'report') &&
              codePlannedInRun &&
              !codeDoneInRun
            ) {
              await recordSkippedAgentStep({
                stepId,
                agent: step.agent,
                effQuery,
                reason: 'blocked_until_code_complete',
                policy: 'code_authority_gate',
                t0,
                runId: opts.runId,
                byId,
                evidences,
                relayThinking,
                emitTrace,
                appendMetrics
              })
              return
            }
            if (
              (step.agent === 'visualize' || step.agent === 'report') &&
              codeDoneInRun &&
              hasCodeInResults(runResults)
            ) {
              if (step.agent === 'report' && shouldDeferReportToSynth(mergedResults, { meta: state.meta, planSteps: steps })) {
                relayThinking(step.agent, 'report：叙述性报告由 Synth 流式生成（跳过 report LLM）')
                const deferOutcome = {
                  ok: true as const,
                  agent: step.agent,
                  output: '',
                  query: baseQuery,
                  parsed: extractStructuredPayload(''),
                  evidence: deferredReportEvidence(baseQuery)
                }
                applyAgentStepOutcome({
                  outcome: deferOutcome,
                  stepId,
                  agent: step.agent,
                  byId,
                  out,
                  evidences,
                  clarifyQuestions
                })
                emitStepResultEvent(opts, { stepId, agent: String(step.agent), outcome: deferOutcome })
                await appendMetrics({ runId: opts.runId, phase: step.agent, ms: Date.now() - t0 })
                emitTrace({
                  type: 'step_end',
                  agent: step.agent,
                  stepId,
                  ms: Date.now() - t0,
                  status: 'ok',
                  outputSummary: 'deferred_to_synth',
                  at: new Date().toISOString()
                })
                recordAgentSuccess(stepAgent)
                return
              }
              const codeAuthorityQuestion = question
              if (
                step.agent === 'visualize' &&
                shouldDeferVisualizeToSynthCollab(String(state.intent ?? ''))
              ) {
                const deferBanner = buildCodeFirstBundle({
                  results: mergedResults,
                  extractPayload: extractStructuredPayload,
                  maxCodeChars: 400,
                  maxRefChars: 0
                }).authorityBanner
                const repairedEarly = repairCodeAuthorityVisualize(
                  mergedResults,
                  extractStructuredPayload,
                  deferBanner,
                  { evidence: [{ kind: 'visualize' }] }
                )
                if (repairedEarly) {
                  relayThinking(step.agent, 'visualize：结构层基于 Code 权威数据重组（跳过 LLM）')
                  const repairOutcome = {
                    ok: true as const,
                    agent: step.agent,
                    output: repairedEarly,
                    query: baseQuery,
                    parsed: extractStructuredPayload(repairedEarly),
                    evidence: { kind: step.agent, query: codeAuthorityQuestion, mode: 'code_authority_repair' }
                  }
                  applyAgentStepOutcome({
                    outcome: repairOutcome,
                    stepId,
                    agent: step.agent,
                    byId,
                    out,
                    evidences,
                    clarifyQuestions
                  })
                  emitStepResultEvent(opts, { stepId, agent: String(step.agent), outcome: repairOutcome })
                  emitCollabPreview(opts.sendEvent, step.agent, repairedEarly, 'code_authority_repair')
                  await appendMetrics({
                    runId: opts.runId,
                    phase: step.agent,
                    ms: Date.now() - t0,
                    ok: true,
                    agent: String(step.agent),
                    outputText: repairedEarly
                  })
                  emitTrace({
                    type: 'step_end',
                    agent: step.agent,
                    stepId,
                    ms: Date.now() - t0,
                    status: 'ok',
                    outputSummary: summarize(repairedEarly),
                    at: new Date().toISOString()
                  })
                  recordAgentSuccess(stepAgent)
                  return
                }
                relayThinking(
                  step.agent,
                  'visualize：交由 Synth 协作增强基于 Code 权威数据生成（避免计划步重复 LLM）'
                )
                const deferVizOutcome = {
                  ok: true as const,
                  agent: step.agent,
                  output: '',
                  query: baseQuery,
                  parsed: extractStructuredPayload(''),
                  evidence: deferredVisualizeCollabEvidence(codeAuthorityQuestion)
                }
                applyAgentStepOutcome({
                  outcome: deferVizOutcome,
                  stepId,
                  agent: step.agent,
                  byId,
                  out,
                  evidences,
                  clarifyQuestions
                })
                emitStepResultEvent(opts, { stepId, agent: String(step.agent), outcome: deferVizOutcome })
                await appendMetrics({ runId: opts.runId, phase: step.agent, ms: Date.now() - t0 })
                emitTrace({
                  type: 'step_end',
                  agent: step.agent,
                  stepId,
                  ms: Date.now() - t0,
                  status: 'ok',
                  outputSummary: 'deferred_to_internal_collab',
                  at: new Date().toISOString()
                })
                recordAgentSuccess(stepAgent)
                return
              }
              const codeModel = createCodeAuthorityLlmModel({
                openaiApiKey: llmBundle?.openaiApiKey,
                openaiBaseUrl: llmBundle?.openaiBaseUrl,
                modelName: llmBundle?.openaiModel
              })
              const shapeCtx = { meta: state.meta, planSteps: steps }
              const auth = await tryCodeAuthorityDownstreamOutput(
                step.agent,
                mergedResults,
                extractStructuredPayload,
                codeAuthorityQuestion,
                codeModel,
                shapeCtx
              )
              if (auth) {
                relayThinking(
                  step.agent,
                  auth.mode === 'code_authority_deterministic'
                    ? `${step.agent}：结构层基于 Code 权威数据确定性生成（跳过 LLM）`
                    : auth.mode === 'code_authority_llm'
                      ? `${step.agent}：启发模型规划 chart_plan（跳过通用 visualize/report LLM）`
                      : `${step.agent}：使用 Code 权威数据生成`
                )
                const authOutcome = {
                  ok: true as const,
                  agent: step.agent,
                  output: auth.output,
                  query: baseQuery,
                  parsed: extractStructuredPayload(auth.output),
                  evidence: { kind: step.agent, query: codeAuthorityQuestion, mode: auth.mode }
                }
                applyAgentStepOutcome({
                  outcome: authOutcome,
                  stepId,
                  agent: step.agent,
                  byId,
                  out,
                  evidences,
                  clarifyQuestions
                })
                emitStepResultEvent(opts, { stepId, agent: String(step.agent), outcome: authOutcome })
                emitCollabPreview(opts.sendEvent, step.agent, auth.output, auth.mode)
                await appendMetrics({
                  runId: opts.runId,
                  phase: step.agent,
                  ms: Date.now() - t0,
                  ok: true,
                  agent: String(step.agent),
                  outputText: auth.output
                })
                emitTrace({
                  type: 'step_end',
                  agent: step.agent,
                  stepId,
                  ms: Date.now() - t0,
                  status: 'ok',
                  outputSummary: summarize(auth.output),
                  at: new Date().toISOString()
                })
                recordAgentSuccess(stepAgent)
                return
              }
              if (codePlannedInRun || hasCodeInResults(runResults)) {
                const banner = buildCodeFirstBundle({
                  results: mergedResults,
                  extractPayload: extractStructuredPayload,
                  maxCodeChars: 400,
                  maxRefChars: 0
                }).authorityBanner
                let repairedOut: string | null = null
                if (step.agent === 'visualize') {
                  repairedOut = repairCodeAuthorityVisualize(mergedResults, extractStructuredPayload, banner, {
                    evidence: [{ kind: 'visualize' }]
                  })
                } else {
                  repairedOut = tryDeterministicDownstreamOutput(
                    'report',
                    mergedResults,
                    extractStructuredPayload,
                    { meta: state.meta, planSteps: steps }
                  )
                }
                if (repairedOut) {
                  relayThinking(step.agent, `${step.agent}：结构层基于 Code 权威数据重组（禁止通用 LLM）`)
                  const repairOutcome = {
                    ok: true as const,
                    agent: step.agent,
                    output: repairedOut,
                    query: baseQuery,
                    parsed: extractStructuredPayload(repairedOut),
                    evidence: { kind: step.agent, query: codeAuthorityQuestion, mode: 'code_authority_repair' }
                  }
                  applyAgentStepOutcome({
                    outcome: repairOutcome,
                    stepId,
                    agent: step.agent,
                    byId,
                    out,
                    evidences,
                    clarifyQuestions
                  })
                  emitStepResultEvent(opts, { stepId, agent: String(step.agent), outcome: repairOutcome })
                  emitCollabPreview(opts.sendEvent, step.agent, repairedOut, 'code_authority_repair')
                  await appendMetrics({
                    runId: opts.runId,
                    phase: step.agent,
                    ms: Date.now() - t0,
                    ok: true,
                    agent: String(step.agent),
                    outputText: repairedOut
                  })
                  recordAgentSuccess(stepAgent)
                  return
                }
                if (
                  step.agent === 'visualize' &&
                  shouldDeferVisualizeToSynthCollab(String(state.intent ?? ''))
                ) {
                  relayThinking(
                    step.agent,
                    'visualize：交由 Synth 协作增强基于 Code 权威数据生成（避免计划步重复 LLM）'
                  )
                  const deferVizOutcome = {
                    ok: true as const,
                    agent: step.agent,
                    output: '',
                    query: baseQuery,
                    parsed: extractStructuredPayload(''),
                    evidence: deferredVisualizeCollabEvidence(codeAuthorityQuestion)
                  }
                  applyAgentStepOutcome({
                    outcome: deferVizOutcome,
                    stepId,
                    agent: step.agent,
                    byId,
                    out,
                    evidences,
                    clarifyQuestions
                  })
                  emitStepResultEvent(opts, { stepId, agent: String(step.agent), outcome: deferVizOutcome })
                  await appendMetrics({ runId: opts.runId, phase: step.agent, ms: Date.now() - t0 })
                  emitTrace({
                    type: 'step_end',
                    agent: step.agent,
                    stepId,
                    ms: Date.now() - t0,
                    status: 'ok',
                    outputSummary: 'deferred_to_internal_collab',
                    at: new Date().toISOString()
                  })
                  recordAgentSuccess(stepAgent)
                  return
                }
                await recordSkippedAgentStep({
                  stepId,
                  agent: step.agent,
                  effQuery,
                  reason: 'code_authority_no_fallback',
                  policy: 'code_authority_gate',
                  t0,
                  runId: opts.runId,
                  byId,
                  evidences,
                  relayThinking,
                  emitTrace,
                  appendMetrics
                })
                return
              }
            }
            const internalContext = [
              ctx ? `依赖上下文:\n${trimForContext(ctx, Number(schedulerBudget?.code ?? 900))}` : '',
              buildInternalCollabContext(
                { ...(state.results || {}), ...out } as Record<string, unknown>,
                extractStructuredPayload,
                step.agent === 'report' ? 'report' : step.agent === 'visualize' ? 'visualize' : 'clean'
              )
            ]
              .filter(Boolean)
              .join('\n\n')
            internalCtx = {
              internalQuery: baseQuery,
              payload: buildInternalPayload(step, internalContext),
              vote: voteEnabled && voteTargets.includes(String(step.agent || ''))
                ? {
                    enabled: true,
                    score: scoreVoteCandidate,
                    onDecision: ({ selected, scoreA, scoreB, winnerReason }) => {
                      const pickA = selected === 'A'
                      const winner = pickA ? scoreA : scoreB
                      const loser = pickA ? scoreB : scoreA
                      voteDecisions.push({
                        stepId,
                        agent: String(step.agent || ''),
                        selected,
                        winnerScore: winner.total,
                        loserScore: loser.total,
                        winnerSupportRate: winner.supportRate,
                        loserSupportRate: loser.supportRate,
                        winnerConflictCount: winner.conflictCount,
                        loserConflictCount: loser.conflictCount,
                        winnerReason
                      })
                      opts.sendEvent({
                        event: 'thinking',
                        data: `投票执行：${String(step.agent)} 双候选评估完成，选择候选${selected}（A=${scoreA.total.toFixed(2)}, B=${scoreB.total.toFixed(2)}；evidence A=${scoreA.supportRate.toFixed(2)}, B=${scoreB.supportRate.toFixed(2)}）`,
                        from: 'manager'
                      })
                      emitTrace({
                        type: 'vote',
                        agent: step.agent,
                        stepId,
                        scores: { A: scoreA, B: scoreB },
                        selected,
                        winnerReason,
                        at: new Date().toISOString()
                      })
                      void appendMetrics({
                        runId: opts.runId,
                        phase: 'vote',
                        ms: Date.now() - t0,
                        extra: {
                          stepId,
                          agent: String(step.agent || ''),
                          selected,
                          winnerScore: Number(winner.total.toFixed(4)),
                          loserScore: Number(loser.total.toFixed(4)),
                          winnerSupportRate: Number(winner.supportRate.toFixed(4)),
                          loserSupportRate: Number(loser.supportRate.toFixed(4)),
                          winnerConflictCount: winner.conflictCount,
                          loserConflictCount: loser.conflictCount,
                          winnerReason
                        }
                      })
                    }
                  }
                : undefined
            }
          }
          const outcome = await dispatchPlanAgentStep(step.agent, {
            deps: executorDeps,
            opts: executorOpts,
            state: state as ManagerGraphState,
            question,
            baseQuery,
            effQuery,
            scopeQuery: adminScopeQuery,
            out,
            timeoutMs: stepTimeoutMs,
            sendThinking: relayThinking,
            allowRetry: allowRetry(),
            llm: llmBundle,
            llmInvoke,
            mcpTool: step.mcpTool,
            internal: internalCtx
          })
          if (outcome) {
            applyAgentStepOutcome({
              outcome,
              stepId,
              agent: step.agent,
              byId,
              out,
              evidences,
              clarifyQuestions
            })
            emitStepResultEvent(opts, { stepId, agent: String(step.agent), outcome })
            if (
              outcome.ok &&
              (step.agent === 'clean' || step.agent === 'visualize' || step.agent === 'report')
            ) {
              const evMode =
                outcome.evidence && typeof outcome.evidence === 'object' && 'mode' in outcome.evidence
                  ? String((outcome.evidence as { mode?: string }).mode ?? '')
                  : undefined
              emitCollabPreview(opts.sendEvent, step.agent, outcome.output, evMode || undefined)
            }
            await appendMetrics({
              runId: opts.runId,
              phase: step.agent,
              ms: Date.now() - t0,
              ok: outcome.ok,
              agent: String(step.agent),
              meta: (outcome as { meta?: unknown }).meta,
              outputText: String(outcome.output || ''),
              error_code: outcome.ok ? undefined : String((outcome as { error?: string }).error || '')
            })
            const lastRecord = byId[stepId]
            emitTrace({
              type: 'step_end',
              agent: step.agent,
              stepId,
              ms: Date.now() - t0,
              status: outcome.ok ? 'ok' : 'error',
              evidence: outcome.ok ? outcome.evidence : undefined,
              error: outcome.ok ? undefined : outcome.error,
              outputSummary: summarize(lastRecord?.output || ''),
              at: new Date().toISOString()
            })
            if (outcome.ok) recordAgentSuccess(stepAgent)
            else {
              const errCode =
                errorCodeFromStepOutcome({
                  ok: false,
                  error: outcome.error,
                  meta: outcome.meta
                }) ||
                String((outcome.meta as { error_code?: string } | undefined)?.error_code || '').trim() ||
                undefined
              recordAgentFailure(stepAgent, {
                error: outcome.error,
                errorCode: errCode,
                hard: Boolean((outcome.meta as { hardFailure?: boolean } | undefined)?.hardFailure)
              })
            }
            if (outcome.ok && step.agent === 'crawler') {
              const routeSuggestion = crawlerOutcomeRouteSuggestion(outcome)
              if (routeSuggestion) {
                crawlerHandoffHints.set(stepId, { suggestion: routeSuggestion, task: baseQuery })
              }
              const hits = crawlerSourceHitsForEvent(outcome.output)
              if (hits.length) {
                opts.sendEvent({
                  event: 'search_sources',
                  data: {
                    source: 'crawler',
                    itemCount: hits.length,
                    hits: hits.map((h) => ({ title: h.title, url: h.url }))
                  },
                  from: 'manager'
                })
              }
            }
            return
          }
          } finally {
            releaseExpertInflight(stepAgent)
          }
        }

      }

      const policyParallel = Number(policy.multi.maxParallel || 3)
      let baseParallel = Math.max(1, Math.min(getManagerMaxParallel(), schedulerMaxParallel > 0 ? schedulerMaxParallel : policyParallel))
      if (isParallelIndependentEnabled()) {
        baseParallel = Math.max(baseParallel, suggestMaxParallelForPlan(steps))
      }
      baseParallel = Math.min(getManagerMaxParallel(), baseParallel)
      const maxParallel = executionMode === 'serial' ? 1 : baseParallel

      const totalSteps = steps.length
      let completedSteps = 0
      emitPlanStepsEvent(opts, steps)
      const emitStepStatus = (
        stepId: string,
        agent: string,
        status: 'pending' | 'running' | 'success' | 'failed' | 'skipped',
        extra?: { query?: string; error?: string }
      ) => {
        const stepWeight = 100 / Math.max(1, totalSteps)
        const basePct = completedSteps * stepWeight
        const pct =
          status === 'running'
            ? Math.round(basePct + stepWeight * 0.5)
            : status === 'pending'
              ? Math.round(basePct)
              : Math.round(completedSteps * stepWeight)
        const eta_ms = estimateMultiEtaMs({
          totalSteps,
          completedSteps,
          maxParallel,
          timeoutScale: schedulerTimeoutScale
        })
        opts.sendEvent({
          event: 'step_status',
          data: buildStepStatus({ stepId, agent, status, pct, eta_ms, ...extra }, opts.runId),
          from: 'manager'
        })
      }
      for (const s of steps) {
        const stepId = String(s.id)
        const prior = byId[stepId]
        if (prior && (prior.status === 'ok' || prior.status === 'skipped')) {
          completedSteps += 1
          const reason =
            prior.status === 'skipped'
              ? 'already_skipped_in_prior_attempt'
              : String(s.agent) === 'admin'
                ? 'side_effect_done'
                : 'already_ok_in_prior_attempt'
          emitStepStatus(stepId, String(s.agent), 'skipped', {
            query: s.query,
            error: reason
          })
          opts.sendEvent({
            event: 'trace',
            data: {
              agent: String(s.agent),
              status: 'skipped',
              durationMs: 0,
              reason,
              text: `复用上轮结果（${reason}）`
            },
            from: 'manager'
          })
          continue
        }
        emitStepStatus(stepId, String(s.agent), 'pending', { query: s.query })
      }

      const toolHealthByAgent = new Map<string, string>()
      for (const h of Array.isArray(state?.toolHealth?.agents) ? state.toolHealth.agents : []) {
        const k = String(h?.agent || '').trim()
        if (!k) continue
        toolHealthByAgent.set(k, String(h?.status || 'unknown'))
      }
      const dependentsByStep = new Map<string, string[]>()
      for (const s of steps) {
        const sid = String(s.id || '')
        if (!sid) continue
        if (!dependentsByStep.has(sid)) dependentsByStep.set(sid, [])
        const deps = Array.isArray((s as any).dependsOn) ? ((s as any).dependsOn as string[]) : []
        for (const d of deps) {
          const depId = String(d || '').trim()
          if (!depId) continue
          const arr = dependentsByStep.get(depId) || []
          arr.push(sid)
          dependentsByStep.set(depId, arr)
        }
      }
      const depthMemo = new Map<string, number>()
      const computeDownstreamDepth = (sid: string, visiting = new Set<string>()): number => {
        if (!sid) return 0
        if (depthMemo.has(sid)) return Number(depthMemo.get(sid) || 0)
        if (visiting.has(sid)) return 0
        visiting.add(sid)
        const children = dependentsByStep.get(sid) || []
        let best = 0
        for (const child of children) {
          best = Math.max(best, 1 + computeDownstreamDepth(child, visiting))
        }
        visiting.delete(sid)
        depthMemo.set(sid, best)
        return best
      }
      const baseAgentPriority = (agent: string) => {
        if (agent === 'db' || agent === 'rag' || agent === 'crawler') return 300
        if (agent === 'gui') return 180
        if (agent === 'multimodal') return 220
        if (agent === 'music') return 200
        if (agent === 'video') return 190
        if (agent === 'code') return 240
        if (agent === 'clean') return 250
        if (agent === 'visualize' || agent === 'report') return 140
        if (agent === 'admin') return 120
        return 100
      }
      const healthPenalty = (agent: string) => {
        const status = String(toolHealthByAgent.get(agent) || 'unknown')
        if (status === 'degraded') return 40
        if (status === 'down') return 200
        return 0
      }
      const stepPriority = (s: Step) => {
        const sid = String(s.id || '').trim()
        const agent = String(s.agent || '').trim()
        const depth = computeDownstreamDepth(sid)
        return depth * 100 + baseAgentPriority(agent) - healthPenalty(agent)
      }
      let loggedSchedulePreview = false
      let localReplanCount = Number(state?.meta?.localReplanCount || 0) || 0
      const maxLocalReplans = localReplanMaxPerRun()
      let forcePlanRollback = Boolean(state?.meta?.forcePlanRollback)
      let lastReplanReason = String(state?.meta?.lastReplanReason || '').trim()
      let circuitShortCircuitCount = Number(state?.meta?.circuitShortCircuitCount || 0) || 0
      let runPhase = initialRunPhase
      const maxPhases = maxRunPhases()

      const fetcherCallbacks = {
          ensureNotAborted,
          stepPriority,
          filterReadyBatch: (ready) => {
            const deferredAdmin = ready.some(
              (s) => String(s.agent || '') === 'admin' && !resolveAdminAutoConfirm(state, String(s.query || ''))
            )
            if (deferredAdmin) {
              const nonAdmin = ready.filter((s) => String(s.agent || '') !== 'admin')
              if (nonAdmin.length > 0 && ready.length > nonAdmin.length) return nonAdmin
            }
            return ready
          },
          onReadyBatch: (ready) => {
            if (loggedSchedulePreview || ready.length <= 1) return
            const preview = ready
              .slice(0, 4)
              .map((s) => `${String(s.id)}:${String(s.agent)}(p=${stepPriority(s)})`)
              .join(' | ')
            const parallelNote =
              isParallelIndependentEnabled() && ready.length > 1
                ? `；同批并行：${describeParallelReadyBatch(ready)}`
                : ''
            opts.sendEvent({
              event: 'thinking',
              data: `Task Fetching Unit（maxParallel=${maxParallel}）：${preview}${parallelNote}`,
              from: 'manager'
            })
            loggedSchedulePreview = true
          },
          onScheduleWait: (detail) => {
            opts.sendEvent({
              event: 'thinking',
              data: `调度等待：待上游完成（${detail || 'clean/code/visualize 依赖链'}）`,
              from: 'manager'
            })
          },
          onScheduleStall: async (stuck) => {
            for (const s of stuck) {
              const stepId = String(s.id || '').trim()
              if (!stepId || byId[stepId]) continue
              const blockers = listBlockingDependencies(s, steps, byId)
              await recordSkippedAgentStep({
                stepId,
                agent: s.agent,
                effQuery: String(s.query || question),
                reason: blockers.length
                  ? `schedule_stall:blocked_by=${blockers.join(',')}`
                  : 'schedule_stall:no_progress',
                policy: 'schedule_stall',
                t0: Date.now(),
                runId: opts.runId,
                byId,
                evidences,
                relayThinking,
                emitTrace,
                appendMetrics
              })
            }
          },
          onStepComplete: async (s) => {
            const append: Step[] = []
            if (String(s.agent || '') === 'crawler') {
              const stepId = String(s.id || '').trim()
              const hint = crawlerHandoffHints.get(stepId)
              const record = byId[stepId]
              if (
                hint?.suggestion === 'gui' &&
                record?.status === 'ok' &&
                shouldInjectGuiAfterCrawler({
                  routeSuggestion: hint.suggestion,
                  allowedAgents: Array.isArray(state.allowedAgents) ? (state.allowedAgents as string[]) : [],
                  toolHealth: state.toolHealth,
                  existingSteps: steps
                })
              ) {
                const handoff = buildGuiHandoffStep({
                  crawlerTask: hint.task || String(s.query || question),
                  crawlerStepId: stepId,
                  existingSteps: steps
                })
                if (handoff) {
                  opts.sendEvent({
                    event: 'thinking',
                    data: '爬虫检测到登录/SPA 场景，自动追加 GUI（Lobster）交互步骤…',
                    from: 'manager'
                  })
                  emitPlanStepsEvent(opts, [...steps, handoff])
                  emitStepStatus(String(handoff.id), 'gui', 'pending', { query: handoff.query })
                  append.push(handoff)
                }
              }
            }

            const stepId = String(s.id || '').trim()
            const record = byId[stepId]
            const status = record?.status === 'error' ? 'failed' : String(record?.status || 'ok')
            const output = String(record?.output || '')
            const error = String(record?.error || '')
            const failedAgent = String(s.agent || '').trim()
            const pendingSteps = steps.filter((x) => {
              const id = String(x.id || '').trim()
              return id && id !== stepId && !byId[id]
            })

            // 上游失败/跳过：立即剪枝依赖消费链，避免 clean/code 空转
            if ((status === 'failed' || status === 'error' || status === 'skipped') && pendingSteps.length) {
              const completedSnap = Object.fromEntries(
                Object.entries(byId).map(([id, rec]) => [id, { status: rec.status }])
              )
              const toSkip = listDependentsToSkipAfterFailure(stepId, pendingSteps, steps, completedSnap)
              for (const ps of toSkip) {
                const pid = String(ps.id || '').trim()
                if (!pid || byId[pid]) continue
                await recordSkippedAgentStep({
                  stepId: pid,
                  agent: ps.agent,
                  effQuery: String(ps.query || question),
                  reason: `上游 ${failedAgent || stepId} 未成功，跳过关联步骤`,
                  policy: 'upstream_failed',
                  t0: Date.now(),
                  runId: opts.runId,
                  byId,
                  evidences,
                  relayThinking,
                  emitTrace,
                  appendMetrics
                })
                emitStepStatus(pid, String(ps.agent), 'skipped', {
                  error: `upstream_failed:${failedAgent || stepId}`
                })
              }
            }

            const pendingAfterPrune = steps.filter((x) => {
              const id = String(x.id || '').trim()
              return id && id !== stepId && !byId[id]
            })
            const wouldReplan = shouldConsiderLocalReplan({
              status,
              output,
              error,
              agent: failedAgent,
              expertHardDown: Boolean(failedAgent && isExpertHardDown(failedAgent)),
              circuitOpen: Boolean(failedAgent && runtimeCircuitOpenAgents.has(failedAgent))
            })
            if (pendingAfterPrune.length > 0 && wouldReplan) {
              const circuitBlocked =
                isCircuitSkipCoreEnabled() && !optionalAgents.has(failedAgent)
                  ? resolveCircuitBlockedReplan({
                      failedAgent,
                      pendingSteps: pendingAfterPrune,
                      circuitOpenAgents: runtimeCircuitOpenAgents
                    })
                  : ({ kind: 'passthrough' } as const)

              // 熔断 Agent：不烧 LLM 再写回同 Agent；去掉熔断步或强制回 Plan
              if (circuitBlocked.kind === 'strip_circuit') {
                for (const ps of circuitBlocked.skipped) {
                  const pid = String(ps.id || '').trim()
                  if (!pid || byId[pid]) continue
                  await recordSkippedAgentStep({
                    stepId: pid,
                    agent: ps.agent,
                    effQuery: String(ps.query || question),
                    reason: `circuit_open:skip_pending_${String(ps.agent)}`,
                    policy: 'circuit_open_core',
                    t0: Date.now(),
                    runId: opts.runId,
                    byId,
                    evidences,
                    relayThinking,
                    emitTrace,
                    appendMetrics
                  })
                  emitStepStatus(pid, String(ps.agent), 'skipped', {
                    error: `circuit_open:skip_pending_${String(ps.agent)}`
                  })
                }
                opts.sendEvent({
                  event: 'thinking',
                  data: formatLocalReplanNarrative({
                    kind: 'circuit_skip',
                    agent: failedAgent
                  }),
                  from: 'manager'
                })
                circuitShortCircuitCount += 1
                void appendMetrics({
                  runId: opts.runId,
                  phase: 'circuit_short_circuit',
                  ms: 0
                }).catch(() => {})
                const nextPlan = [
                  ...steps.filter((x) => byId[String(x.id || '')] || String(x.id) === stepId),
                  ...circuitBlocked.kept
                ]
                emitPlanStepsEvent(opts, nextPlan)
                for (const rs of circuitBlocked.kept) {
                  emitStepStatus(String(rs.id), String(rs.agent), 'pending', { query: rs.query })
                }
                return {
                  append: append.length ? append : undefined,
                  replaceRemaining: circuitBlocked.kept
                }
              }

              if (circuitBlocked.kind === 'force_plan_rollback') {
                // 剩余实质只剩熔断 Agent → 与 3/3 同一 UX：强制 Plan HITL
                forcePlanRollback = true
                opts.sendEvent({
                  event: 'thinking',
                  data: `Agent「${failedAgent}」已熔断且剩余计划无其它能力，回退 Plan Mode，请确认剩余计划`,
                  from: 'manager'
                })
                opts.sendEvent({
                  event: 'thought_delta',
                  data: {
                    text: '该能力已连续失败并熔断，请确认或调整剩余步骤后再继续。',
                    done: false
                  },
                  from: 'manager'
                })
                opts.sendEvent({ event: 'phase', data: 'plan_preview', from: 'manager' })
                const previewId = crypto.randomUUID()
                const payload = buildPlanPreviewPayload(pendingAfterPrune, opts.runId, previewId, {
                  intent: state.intent,
                  allowedAgents: state.allowedAgents,
                  meta: {
                    ...(state.meta || {}),
                    collaborationPosture: 'plan',
                    forcePlanRollback: true,
                    worldModelRisk: Math.max(0.65, Number(state.meta?.worldModelRisk || 0))
                  }
                })
                payload.hint =
                  '核心 Agent 已熔断，请确认新计划后再执行（或取消以中止剩余步）。已完成步保留可审计。'
                payload.approveTier = 'strict'
                opts.sendEvent({ event: 'plan_preview', data: payload, from: 'manager' })
                const decision = await waitPlanConfirm(opts.runId, previewId)
                if (decision.action === 'cancel') {
                  for (const ps of pendingAfterPrune) {
                    const pid = String(ps.id || '').trim()
                    if (!pid || byId[pid]) continue
                    await recordSkippedAgentStep({
                      stepId: pid,
                      agent: ps.agent,
                      effQuery: String(ps.query || question),
                      reason: 'plan_rollback:cancelled',
                      policy: 'circuit_degrade_optional',
                      t0: Date.now(),
                      runId: opts.runId,
                      byId,
                      evidences,
                      relayThinking,
                      emitTrace,
                      appendMetrics
                    })
                    emitStepStatus(pid, String(ps.agent), 'skipped', {
                      error: 'plan_rollback:cancelled'
                    })
                  }
                  opts.sendEvent({
                    event: 'thinking',
                    data: '已取消回退计划：剩余步骤已中止，需人工收紧计划后重跑',
                    from: 'manager'
                  })
                  return {
                    append: append.length ? append : undefined,
                    removePendingIds: pendingAfterPrune.map((x) => String(x.id || '')).filter(Boolean)
                  }
                }
                let nextRemaining = pendingAfterPrune
                if (Array.isArray(decision.steps) && decision.steps.length) {
                  nextRemaining = normalizePlanSteps(
                    mergeConfirmedPlanSteps(pendingSteps, decision.steps as Step[])
                  )
                }
                nextRemaining = filterStepsExcludingCircuitAgents(
                  nextRemaining,
                  runtimeCircuitOpenAgents
                )
                if (!nextRemaining.length) {
                  for (const ps of pendingSteps) {
                    const pid = String(ps.id || '').trim()
                    if (!pid || byId[pid]) continue
                    await recordSkippedAgentStep({
                      stepId: pid,
                      agent: ps.agent,
                      effQuery: String(ps.query || question),
                      reason: 'plan_rollback:empty_or_circuit',
                      policy: 'circuit_open_core',
                      t0: Date.now(),
                      runId: opts.runId,
                      byId,
                      evidences,
                      relayThinking,
                      emitTrace,
                      appendMetrics
                    })
                  }
                  return {
                    removePendingIds: pendingSteps.map((x) => String(x.id || '')).filter(Boolean)
                  }
                }
                localReplanCount = 0
                forcePlanRollback = false
                const constraints = String(decision.constraints || '').trim().slice(0, 500)
                if (constraints) {
                  state.meta = mergeMeta(state, { planConstraints: constraints, planConfirmed: true })
                } else {
                  state.meta = mergeMeta(state, { planConfirmed: true })
                }
                opts.sendEvent({
                  event: 'thinking',
                  data: `回退计划已确认，继续执行剩余 ${nextRemaining.length} 步…`,
                  from: 'manager'
                })
                const nextPlan = [
                  ...steps.filter((x) => byId[String(x.id || '')] || String(x.id) === stepId),
                  ...nextRemaining
                ]
                emitPlanStepsEvent(opts, nextPlan)
                for (const rs of nextRemaining) {
                  emitStepStatus(String(rs.id), String(rs.agent), 'pending', { query: rs.query })
                }
                return {
                  append: append.length ? append : undefined,
                  replaceRemaining: nextRemaining
                }
              }

              // A5：超阈强制回 Plan Mode，弹出 HITL 计划卡
              if (
                shouldForcePlanRollback({
                  localReplanCount,
                  maxLocalReplans,
                  wouldConsiderReplan: true
                })
              ) {
                forcePlanRollback = true
                lastReplanReason = lastReplanReason || 'local_replan_threshold'
                opts.sendEvent({
                  event: 'thinking',
                  data: formatLocalReplanNarrative({
                    kind: 'rollback',
                    reason: lastReplanReason,
                    count: localReplanCount,
                    max: maxLocalReplans
                  }),
                  from: 'manager'
                })
                opts.sendEvent({
                  event: 'thought_delta',
                  data: {
                    text: '局部改计划次数已用尽，请确认或调整剩余步骤后再继续。',
                    done: false
                  },
                  from: 'manager'
                })
                opts.sendEvent({ event: 'phase', data: 'plan_preview', from: 'manager' })
                opts.sendEvent({
                  event: 'posture_hint',
                  data: { suggest: 'plan', reason: 'local_replan_exhausted_or_circuit' },
                  from: 'manager'
                })
                const previewId = crypto.randomUUID()
                const payload = buildPlanPreviewPayload(pendingSteps, opts.runId, previewId, {
                  intent: state.intent,
                  allowedAgents: state.allowedAgents,
                  meta: {
                    ...(state.meta || {}),
                    collaborationPosture: 'plan',
                    suggestedPosture: 'plan',
                    needsPlanPreview: true,
                    forcePlanRollback: true,
                    worldModelRisk: Math.max(0.65, Number(state.meta?.worldModelRisk || 0))
                  }
                })
                payload.hint =
                  '局部修订次数已达上限，请确认新计划后再执行（或取消以中止剩余步）。已完成步保留可审计。'
                payload.approveTier = 'strict'
                opts.sendEvent({ event: 'plan_preview', data: payload, from: 'manager' })
                const decision = await waitPlanConfirm(opts.runId, previewId)
                if (decision.action === 'cancel') {
                  for (const ps of pendingSteps) {
                    const pid = String(ps.id || '').trim()
                    if (!pid || byId[pid]) continue
                    await recordSkippedAgentStep({
                      stepId: pid,
                      agent: ps.agent,
                      effQuery: String(ps.query || question),
                      reason: 'plan_rollback:cancelled',
                      policy: 'circuit_degrade_optional',
                      t0: Date.now(),
                      runId: opts.runId,
                      byId,
                      evidences,
                      relayThinking,
                      emitTrace,
                      appendMetrics
                    })
                    emitStepStatus(pid, String(ps.agent), 'skipped', {
                      error: 'plan_rollback:cancelled'
                    })
                  }
                  opts.sendEvent({
                    event: 'thinking',
                    data: '已取消回退计划：剩余步骤已中止，需人工收紧计划后重跑',
                    from: 'manager'
                  })
                  return {
                    append: append.length ? append : undefined,
                    removePendingIds: pendingSteps.map((x) => String(x.id || '')).filter(Boolean)
                  }
                }
                let nextRemaining = pendingSteps
                if (Array.isArray(decision.steps) && decision.steps.length) {
                  nextRemaining = normalizePlanSteps(
                    mergeConfirmedPlanSteps(pendingSteps, decision.steps as Step[])
                  )
                }
                nextRemaining = filterStepsExcludingCircuitAgents(
                  nextRemaining,
                  runtimeCircuitOpenAgents
                )
                if (!nextRemaining.length) {
                  for (const ps of pendingSteps) {
                    const pid = String(ps.id || '').trim()
                    if (!pid || byId[pid]) continue
                    await recordSkippedAgentStep({
                      stepId: pid,
                      agent: ps.agent,
                      effQuery: String(ps.query || question),
                      reason: 'plan_rollback:empty',
                      policy: 'circuit_degrade_optional',
                      t0: Date.now(),
                      runId: opts.runId,
                      byId,
                      evidences,
                      relayThinking,
                      emitTrace,
                      appendMetrics
                    })
                  }
                  return {
                    removePendingIds: pendingSteps.map((x) => String(x.id || '')).filter(Boolean)
                  }
                }
                // 人批通过后重置局部 replan 计数，并清除强制回退标记以便继续执行
                localReplanCount = 0
                forcePlanRollback = false
                const constraints = String(decision.constraints || '').trim().slice(0, 500)
                if (constraints) {
                  state.meta = mergeMeta(state, { planConstraints: constraints, planConfirmed: true })
                } else {
                  state.meta = mergeMeta(state, { planConfirmed: true })
                }
                opts.sendEvent({
                  event: 'thinking',
                  data: `回退计划已确认，继续执行剩余 ${nextRemaining.length} 步…`,
                  from: 'manager'
                })
                opts.sendEvent({
                  event: 'thought_delta',
                  data: { text: '已确认，继续执行', done: false },
                  from: 'manager'
                })
                const nextPlan = [
                  ...steps.filter((x) => byId[String(x.id || '')] || String(x.id) === stepId),
                  ...nextRemaining
                ]
                emitPlanStepsEvent(opts, nextPlan)
                for (const rs of nextRemaining) {
                  emitStepStatus(String(rs.id), String(rs.agent), 'pending', { query: rs.query })
                }
                return {
                  append: append.length ? append : undefined,
                  replaceRemaining: nextRemaining
                }
              }

              const completedSummaries = keepLastObservations(
                Object.values(byId).map((r) => {
                  const handoff =
                    (r as { handoff?: { summary?: string } }).handoff ||
                    buildSpecialistHandoffFromStep({
                      agent: String(r.agent || ''),
                      stepId: String(r.id || ''),
                      ok: String(r.status || '') === 'ok',
                      output: String(r.output || ''),
                      error: String(r.error || ''),
                      agentResult: (r.meta as { agentResult?: import('../../../utils/agents/types').AgentResult } | undefined)
                        ?.agentResult
                    })
                  return {
                    id: String(r.id || ''),
                    agent: String(r.agent || ''),
                    status: String(r.status || ''),
                    summary: clipObsSummary(String(handoff.summary || r.error || r.output || ''))
                  }
                })
              )
              const replan = await llmLocalReplanRemaining({
                llmInvoke,
                state,
                question,
                observation: {
                  step: s,
                  status,
                  output: clipObsSummary(String(output || '')),
                  error: error ? clipObsSummary(String(error)) : error,
                  observationKind: classifyStepObservationFailure({
                    status,
                    output: String(output || ''),
                    error: error ? String(error) : undefined,
                    agent: String(s.agent || failedAgent || '')
                  })
                },
                pendingSteps,
                completedSummaries,
                planConstraints: String(state?.meta?.planConstraints || '').trim(),
                maxTotalSteps: 8,
                imageCaption: String(
                  (state?.mediaAttachment as { caption?: string } | null)?.caption ||
                    state?.meta?.routeImageCaption ||
                    ''
                ).trim(),
                localReplanCount
              }).catch(() => null)
              if (replan?.remainingSteps?.length) {
                const filteredRemaining = filterStepsExcludingCircuitAgents(
                  replan.remainingSteps,
                  runtimeCircuitOpenAgents
                )
                if (!filteredRemaining.length) {
                  opts.sendEvent({
                    event: 'thinking',
                    data: '局部修订结果仅含已熔断 Agent，已丢弃，不追加空转步骤',
                    from: 'manager'
                  })
                  return append.length ? append : undefined
                }
                localReplanCount += 1
                const reason = replan.reason || 'observation'
                lastReplanReason = String(reason).slice(0, 200)
                opts.sendEvent({
                  event: 'thinking',
                  data: formatLocalReplanNarrative({
                    kind: 'replan',
                    reason: lastReplanReason,
                    count: localReplanCount,
                    max: maxLocalReplans,
                    remainingSteps: filteredRemaining.length
                  }),
                  from: 'manager'
                })
                opts.sendEvent({
                  event: 'thought_delta',
                  data: {
                    text: `根据上一步结果（${lastReplanReason}），已调整后续 ${filteredRemaining.length} 步。`,
                    done: false
                  },
                  from: 'manager'
                })
                const nextPlan = [
                  ...steps.filter((x) => byId[String(x.id || '')] || String(x.id) === stepId),
                  ...filteredRemaining
                ]
                emitPlanStepsEvent(opts, nextPlan)
                for (const rs of filteredRemaining) {
                  emitStepStatus(String(rs.id), String(rs.agent), 'pending', { query: rs.query })
                }
                return {
                  append: append.length ? append : undefined,
                  replaceRemaining: filteredRemaining
                }
              }
            }

            return append.length ? append : undefined
          },
          onRunStep: async (s) => {
            const stepId = String(s.id)
            emitStepStatus(stepId, String(s.agent), 'running')
            opts.sendEvent({
              event: 'thought_delta',
              data: { text: `正在执行：${String(s.agent)}…`, done: false },
              from: 'manager'
            })
            await runStep(s)
            const res = byId[stepId]
            const status = res?.status === 'error' ? 'failed' : res?.status === 'skipped' ? 'skipped' : 'success'
            if (status === 'success' || status === 'failed' || status === 'skipped') completedSteps += 1
            emitStepStatus(stepId, String(s.agent), status, { error: res?.error })
          }
      }

      for (;;) {
        await runTaskFetcherLoop({
          steps,
          maxParallel,
          completedById: byId,
          callbacks: fetcherCallbacks
        })
        if (runPhase >= maxPhases) break
        const completedSummaries = keepLastObservations(
          Object.entries(byId).map(([id, rec]) => {
            const handoff =
              (rec as { handoff?: { summary?: string } }).handoff ||
              buildSpecialistHandoffFromStep({
                agent: String((rec as any)?.agent || steps.find((s) => String(s.id) === id)?.agent || ''),
                stepId: id,
                ok: String((rec as any)?.status || 'ok') !== 'error',
                output: String((rec as any)?.output || ''),
                error: String((rec as any)?.error || ''),
                agentResult: (rec as { meta?: { agentResult?: import('../../../utils/agents/types').AgentResult } })?.meta
                  ?.agentResult
              })
            return {
              id,
              agent: String((rec as any)?.agent || steps.find((s) => String(s.id) === id)?.agent || ''),
              status: String((rec as any)?.status || 'ok'),
              summary: clipObsSummary(String(handoff.summary || (rec as any)?.output || (rec as any)?.error || ''))
            }
          })
        )
        const phaseCont = await llmPhaseContinue({
          llmInvoke,
          state,
          question,
          runPhase,
          maxPhases,
          completedSummaries,
          planConstraints: taskConstraintsFromMeta(state.meta) ?? undefined
        })
        if (!phaseCont) break
        runPhase = phaseCont.nextPhase
        for (const s of phaseCont.nextSteps) {
          const id = String(s.id || '').trim()
          if (!id || byId[id] || steps.some((x) => String(x.id) === id)) continue
          steps.push(s)
        }
        opts.sendEvent({
          event: 'phase',
          data: { name: 'execute:multi', runPhase },
          from: 'manager'
        })
        opts.sendEvent({ event: 'phase', data: `execute:multi:phase${runPhase}`, from: 'manager' })
        opts.sendEvent({
          event: 'thinking',
          data: `进入 phase ${runPhase}/${maxPhases}：${phaseCont.reason}`,
          from: 'manager'
        })
        opts.sendEvent({
          event: 'thought_delta',
          data: { text: `目标未完成，启动 phase ${runPhase}（${phaseCont.nextSteps.length} 步）。`, done: false },
          from: 'manager'
        })
        emitPlanStepsEvent(opts, steps)
        for (const rs of phaseCont.nextSteps) {
          emitStepStatus(String(rs.id), String(rs.agent), 'pending', { query: rs.query })
        }
      }

      const missingFromSteps: string[] = []
      for (const agent of Object.keys(out)) {
        if (!['rag', 'db', 'crawler', 'clean'].includes(agent)) continue
        const val = out[agent]
        if (!val) continue
        const extracted = extractStructuredPayload(String(val))
        if (Array.isArray(extracted.missingFields) && extracted.missingFields.length) {
          missingFromSteps.push(...extracted.missingFields.map((x: any) => String(x ?? '').trim()).filter(Boolean))
        }
      }
      const mergedClarify = [...clarifyQuestions, ...missingFromSteps]
      // 副作用写操作（admin）澄清不得被「已有取数证据」吞掉
      const adminWriteClarify = Object.values(byId).some((s) => {
        if (String(s?.agent || '') !== 'admin' || s?.status !== 'error') return false
        const err = String(s?.error || '')
        const ar = (s as { meta?: { agentResult?: { needs_clarify?: boolean } } })?.meta?.agentResult
        return err === 'needs_clarify' || ar?.needs_clarify === true || /needs_clarify/i.test(err)
      })
      if (adminWriteClarify && !mergedClarify.length) {
        for (const s of Object.values(byId)) {
          if (String(s?.agent || '') !== 'admin' || s?.status !== 'error') continue
          const stepOut = String((s as { output?: string })?.output || '').trim()
          if (stepOut.length >= 4) mergedClarify.push(stepOut.slice(0, 240))
        }
      }
      const uniqClarify = Array.from(new Set(mergedClarify.map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 6)
      const hasTimeoutFailure = Object.values(byId).some((s) => s?.status === 'error' && /timeout/i.test(String(s?.error || '')))
      const hasDataEvidence = evidences.some((e) => ['rag', 'db', 'crawler'].includes(String(e?.kind || '')))
      const planHasRag = steps.some((s) => String(s?.agent || '') === 'rag')
      const ragUsable = hasUsableFacts(String(out.rag || ''))
      const hasUsableDataResult =
        (planHasRag ? ragUsable && !clarifyQuestions.length : false) ||
        hasUsableFacts(String(out.db || '')) ||
        hasUsableFacts(String(out.crawler || '')) ||
        (!planHasRag && ragUsable)
      const allDataStepsFailed = Object.values(byId)
        .filter((s) => ['rag', 'db', 'crawler'].includes(String(s?.agent || '')))
        .every((s) => s?.status === 'error')
      const prefetchOrEvidence = hasRagPrefetchOrStepEvidence({
        meta: state.meta as Record<string, unknown> | null,
        hasDataEvidence
      })
      const dataNeedsClarify =
        uniqClarify.length > 0 &&
        !hasUsableDataResult &&
        !prefetchOrEvidence &&
        !(hasTimeoutFailure && hasDataEvidence) &&
        (allDataStepsFailed || !hasDataEvidence)
      // admin 写澄清：即使问句稍后才从 output 回填，也必须 needsClarify
      const needsClarify = adminWriteClarify || dataNeedsClarify

      const finalClarifyQuestions = (needsClarify ? uniqClarify : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .slice(0, 6)
      const combinedNeedsClarify = needsClarify
      if (!combinedNeedsClarify && uniqClarify.length > 0) {
        opts.sendEvent({
          event: 'thinking',
          data: prefetchOrEvidence
            ? '已有文档预取/证据，忽略澄清信号并继续生成最终结果。'
            : '已获取可用数据，忽略澄清信号并继续生成最终结果。',
          from: 'manager'
        })
      }
      const voteSummary = voteDecisions.length
        ? voteDecisions.map((x) => `${x.agent}:${x.selected}(support=${x.winnerSupportRate.toFixed(2)}, conflict=${x.winnerConflictCount})`).join(' | ')
        : ''

      const lastStepRecords = keepLastObservations(
        Object.entries(byId).map(([id, rec]) => {
          const ar = (
            rec as {
              meta?: {
                agentResult?: {
                  needs_clarify?: boolean
                  structured?: { evolutionApplied?: unknown }
                }
              }
            }
          )?.meta?.agentResult
          const err = String((rec as any)?.error || '')
          const needsClarifyStep =
            err === 'needs_clarify' || ar?.needs_clarify === true || /needs_clarify/i.test(err)
          const handoff =
            (rec as { handoff?: { summary?: string } }).handoff ||
            buildSpecialistHandoffFromStep({
              agent: String((rec as any)?.agent || steps.find((s) => String(s.id) === id)?.agent || ''),
              stepId: id,
              ok: String((rec as any)?.status || 'ok') !== 'error',
              output: String((rec as any)?.output || ''),
              error: err,
              agentResult: (rec as { meta?: { agentResult?: import('../../../utils/agents/types').AgentResult } })?.meta
                ?.agentResult
            })
          const rawOut = String((rec as any)?.output || '')
          const summaryText = clipObsSummary(String(handoff.summary || rawOut || err))
          return {
            id,
            agent: String((rec as any)?.agent || steps.find((s) => String(s.id) === id)?.agent || ''),
            status: String((rec as any)?.status || 'ok'),
            error: err.slice(0, 300) || undefined,
            output: rawOut ? clipObsSummary(rawOut) : undefined,
            summary: summaryText || undefined,
            handoff,
            needsClarify: needsClarifyStep || undefined,
            ...(ar?.structured?.evolutionApplied
              ? { evolutionApplied: ar.structured.evolutionApplied }
              : {})
          }
        })
      )

      const hardDownMap: Record<string, string> = {
        ...((state?.meta?.expertHardDown && typeof state.meta.expertHardDown === 'object'
          ? state.meta.expertHardDown
          : {}) as Record<string, string>)
      }
      for (const a of ['rag', 'db', 'admin', 'code', 'crawler', 'gui', 'multimodal', 'music', 'video'] as const) {
        if (isExpertHardDown(a)) hardDownMap[a] = telemetry.getExpertHardDownCode(a) || hardDownMap[a] || 'network'
      }

      const adminWriteTerminal = Object.values(byId).some((s) => {
        if (String(s?.agent || '') !== 'admin') return false
        const m = (s as { meta?: { adminWriteTerminal?: boolean; agentResult?: { error_code?: string } } })?.meta
        if (m?.adminWriteTerminal === true) return true
        const code = String(m?.agentResult?.error_code || (s as { error?: string })?.error || '')
        return [
          'user_cancelled_admin_write',
          'confirm_timeout',
          'admin_protocol_garbage',
          'admin_write_failed'
        ].includes(code)
      })

      const replanAudit = {
        localReplanCount,
        runPhase,
        phaseBudget: 8,
        lastStepRecords,
        ...(lastReplanReason ? { lastReplanReason } : {}),
        ...(circuitShortCircuitCount > 0 ? { circuitShortCircuitCount } : {}),
        ...(forcePlanRollback
          ? {
              forcePlanRollback: true,
              collaborationPosture: 'plan',
              suggestedPosture: 'plan',
              needsPlanPreview: true,
              upgradeReason: 'local_replan_exhausted_or_circuit'
            }
          : {}),
        ...(Object.keys(hardDownMap).length ? { expertHardDown: hardDownMap } : {}),
        ...(adminWriteTerminal ? { adminWriteTerminal: true } : {})
      }

      const softHandoffs = mergeSoftHandoffsIntoMeta(
        state.meta as Record<string, unknown>,
        Object.values(byId).map((rec) =>
          buildSoftHandoffFromStep({
            agent: String(rec.agent || ''),
            stepId: String(rec.id || ''),
            ok: rec.status === 'ok',
            output: rec.output,
            error: rec.error,
            agentResult: (rec.meta as { agentResult?: import('../../../utils/agents/types').AgentResult } | undefined)
              ?.agentResult,
            taskForm: String((rec as { taskForm?: string }).taskForm || '').trim() || undefined
          })
        )
      )

      return {
        results: out,
        evidence: evidences.filter(Boolean),
        meta: combinedNeedsClarify
          ? mergeMeta(state, {
              needsClarify: true,
              clarifyQuestions: finalClarifyQuestions,
              uncertainty: 'high',
              voteSummary,
              softHandoffs,
              ...replanAudit
            })
          : mergeMeta(state, {
              ...(voteSummary ? { voteSummary } : {}),
              softHandoffs,
              ...replanAudit
            }),
        taskPlan: combinedNeedsClarify
          ? mergeTaskPlan(state.taskPlan ?? null, { needsClarification: true, clarificationQuestions: finalClarifyQuestions }, state.intent, steps)
          : (state.taskPlan ?? null)
      }
}
