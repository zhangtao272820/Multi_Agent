import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { effectiveUserTask } from '../../core/text'
import { z } from 'zod'
import type { Intent } from '../../../utils/shared/taskPlan'
import {
  buildCompositeMediaFinal,
  inferMediaPlanAgents,
  isMediaOnlyPlanAgents,
  textHasPlayableMediaUrl,
  isSynthRejectingMedia,
  mediaAgentsInPlan,
  pickPrimaryResultText,
  type StructuredFact
} from '../../core/shared'
import { recordPolicyRolloutBaseline } from '../../core/evolution/policyRollout'
import { buildGovernanceSnapshot, writeGovernanceSnapshot } from '../../core/evolution/governance'
import { isExperienceReplayEnabled } from '../../core/memory/experienceReplay'
import { indexMemoryEntry, isVectorMemoryEnabled } from '../../core/memory/vectorMemory'
import { runEvolutionExperimentCycle } from '../../core/evolution/evolutionExperiments'
import { updateUserProfileFromRun } from '../../core/memory/userProfile'
import { recordLayeredMemoryFromRun } from '../../core/layeredMemory'
import { recordUnifiedLearningFromRun } from '../../core/unifiedLearning'
import { interactionModeFromMeta } from '../../core/runtime/modeIsolate'
import { inferManagerRouteMatrixPass } from '#agent-shared/evolutionConvergence'
import { recordToolMemoryEvent } from '#agent-shared/toolMemoryStore'
import { isAgentToolSuccess, isSkillDraftEligible } from '#agent-shared/agentOutcomePolicy'
import { syncDbExperienceFromManagerRun } from '#agent-shared/dbExperienceBridge'
import { syncRagExperienceFromManagerRun } from '#agent-shared/ragExperienceBridge'
import { syncAdminExperienceFromManagerRun } from '#agent-shared/adminExperienceBridge'
import { syncCodeExperienceFromManagerRun } from '#agent-shared/codeExperienceBridge'
import { syncCrawlerExperienceFromManagerRun } from '#agent-shared/crawlerExperienceBridge'
import { syncGuiExperienceFromManagerRun } from '#agent-shared/guiExperienceBridge'
import { captureRunArtifactsFromState } from '#agent-shared/artifactRunCapture'
import { saveShadowRunArtifacts } from '#agent-shared/artifactFeedbackOrchestrator'
import { hashSql } from '#agent-shared/artifactStore'
import { isFederationFeedbackGated } from '#agent-shared/artifactFeedbackPolicy'
import { upsertProcessMemory } from '#agent-shared/processMemoryStore'
import { upsertKgFromManagerRun } from '#agent-shared/kgMemoryStore'
import { maybeAutoDraftSkillFromSuccess } from '../../../utils/skills/skillDraftAuto'
import {
  qualifiesSkillAutoDraft,
  refineExperienceWrite,
  isStrictExperienceWriteEnabled,
  shouldIndexExperienceMemory
} from '../../core/memory/experienceWritePolicy'
import { extractSearchRunMetrics, searchMetricsForLearning } from '../../../utils/search/managerSearchMetrics'
import { buildSerpDirectSynthBlock } from '../../../utils/search/managerWebDirectSynth'
import { formatChatWebSynthHint, shouldForceChatWebDirectSynth } from '../../../utils/chat/managerChatWeb'
import { buildEchartsOptionBlock, ensureVisualizeBlocksInFinal } from '../../core/output/finalOutputBlocks'
import {
  appendStructuredReportIfNeeded,
  buildStructuredRunReport
} from '../../core/output/structuredRunReport'
import { extractTaggedBlockFull, wrapTaggedBlock } from '../../../utils/shared/outputMarkers'
import { CODE_AUTHORITY_CRITIC_RULE, CODE_AUTHORITY_SYNTH_RULE, REPORT_SYNTH_ALIGNMENT_CRITIC_RULE, REPORT_SYNTH_ALIGNMENT_SYNTH_RULE, hasCodeInResults } from '#agent-shared/codeFirstAuthority'
import { parseCleanPayload } from '#agent-shared/cleanPayload'
import {
  hasDeterministicReportEvidence,
  shouldPassthroughDbOnly,
  shouldPassthroughDeterministicReport
} from '#agent-shared/deterministicPassthrough'
import { isMultiSourceDataPipeline } from '#agent-shared/dbPipelineDeterministic'
import { resolveSynthShapeSignals } from '#agent-shared/synthShapePolicy'
import { buildDeferredReportFromSynth } from '#agent-shared/deferredReportBlock'
import { maybeCompleteTaskStackFromRun } from '../../core/task/taskStackFinalize'
import {
  assessEvidenceGate,
  hasDbEvidenceInRun
} from '../../core/db/evidenceGate'
import { appendMetrics } from '../../core/runtime/runtimePersistence'
import {
  criticRetryContradictsRunEvidence,
  formatEvaluatorForCriticAudit,
  formatEvidenceForCriticAudit
} from '../../core/output/criticEvidence'
import { shouldSkipCriticLlm } from '../../core/output/criticPolicy'
import { loadTaskStack } from '../../core/task/taskStack'
import { extractAndUpsertTasksFromAssistantText, isTaskStackFinalizeLlmExtractEnabled } from '../../core/task/taskStackLlmExtract'
import {
  extractCrawlerItems,
  extractCrawlerTableMarkdown,
  parseCrawlerPayload,
} from '../../../utils/crawler/managerCrawlerTaskPayload'
import { buildCrawlerSourcesTaggedBlock, resolveCrawlerTableMarkdown, extractCrawlerItemsFromText } from '../../../utils/crawler/crawlerItemsParse'
import { pickRicherNarrativeWithAuxBlocks, extractAuxBlocksStructural } from '#agent-shared/auxBlocks'
import { polishFinalPayload } from '../../core/output/replyPolish'
import { isReportDeferredToSynth } from '#agent-shared/reportSynthDefer'
import { stripSynthPromptLeakage } from '#agent-shared/synthOutputSanitize'
import { sanitizeVisionAnswer } from '../../../utils/media/managerVisionSanitize'
import { formatAgentResultSourcesForSynth } from '../../../utils/agents/agentResult'
import { assessCodeDownstreamConsistencyAsync } from '../../../utils/code/managerCodeAuthorityNormalize'
import { isManagerSynthStreamEnabled } from '../../core/runtime/runtime'
import type { LlmInvokeOptions } from '../../core/shared/modelTier'
import { resolveManagerInteractionMode } from '../../../utils/platform/managerInteractionMode'
import { buildCodeFirstBundle } from '#agent-shared/codeFirstAuthority'
import { createCodeAuthorityLlmModel } from '../../../utils/code/managerCodeAuthorityLlm'
import { repairCodeAuthorityVisualize } from '../../../utils/code/managerCodeDownstream'
import { canManagerRetryMore, resolveManagerRetryLimits } from '../../core/runtime/retryBudget'
import { maybeCurateManagerMemory } from '../../core/memory/memoryCurator'
import { attributeFailure } from '../../core/evolution/failureAttribution'
import { analyzeFailureInsights, appendFailureInsightSnapshot } from '../../core/evolution/failureInsights'
import type { CreateFinalNodesDeps } from './types'
import { CriticVerdictSchema, type CriticVerdict } from './schemas'
import { mergeSynthFinalWithReportBody, appendDeferredReportBlockIfNeeded } from './helpers'
import { pushOtlpTraceForRun } from '../../core/runtime/otelOtlpPush'
import { emitRunFinalizeLog } from '../../core/runtime/structuredLog'

export function buildFinalizeNodeRun(deps: CreateFinalNodesDeps) {
    const {
      ensureNotAborted,
      opts,
      llmInvoke,
      lastUserText,
      runAlwaysInternalCollaborators,
      extractStructuredPayload,
      sanitizeUntrustedText,
      formatReferences,
      stripLatexMath,
      summarize,
      mergeMeta,
      getEffectivePlanSteps,
      timeLeftMs,
      policyPromise,
      defaultPolicy,
      appendMemory,
      appendNluMetrics,
      maybeUpdateManagerPolicy,
      policyDir,
      readFeedbackForRun,
      clampNumber,
      deriveScenarioKey,
      uncertaintyFromConfidence,
      normalizeFinalUserText,
      redactSecrets,
      safeJsonParse,
      IntentSchema
    } = deps

    return async (state: any) => {
        ensureNotAborted()
        opts.sendEvent({ event: 'phase', data: 'finalize', from: 'manager' })
        const question = effectiveUserTask(state.messages as any, state.routedQuery)
        const policy = await policyPromise.catch(() => defaultPolicy())
        const scenarioKey = deriveScenarioKey(question)
        const classifyConf = Number((state.meta as any)?.intentClassify?.confidence)
        const rawRouteConf = state.meta?.routeConfidence
        const routeConf =
          typeof rawRouteConf === 'number' && Number.isFinite(rawRouteConf) && rawRouteConf > 0
            ? rawRouteConf
            : Number.isFinite(classifyConf) && classifyConf > 0
              ? Math.min(1, Math.max(0.35, classifyConf))
              : 0.6
        const evidenceKinds = new Set<string>()
        for (const e of Array.isArray(state.evidence) ? state.evidence : []) {
          const k = String(e?.kind ?? '').trim()
          if (k) evidenceKinds.add(k)
        }
        const hasEvidence = evidenceKinds.size > 0
        const metaPenalty = Boolean(state.meta?.needsClarify) ? 0.18 : 0
        const boundaryPenalty = state.meta?.capabilityOk === false ? 0.25 : 0
        const lowCostPenalty = Boolean(state.meta?.lowCostMode) ? 0.05 : 0
        const conf = Math.max(0, Math.min(1, routeConf + (hasEvidence ? 0.08 : -0.04) - metaPenalty - boundaryPenalty - lowCostPenalty + (state.final?.trim() ? 0.04 : 0)))
        const uncertainty = uncertaintyFromConfidence(conf)
        const uncertaintyZh = uncertainty === 'low' ? '低' : uncertainty === 'medium' ? '中' : '高'
        void uncertaintyZh
        const appendUserTail = (_bodyText: string) => ''
        const durationMs = Math.max(0, Date.now() - Number(state.resources?.startedAtMs ?? Date.now()))
        const planAgents = (
          state.intent === 'multi'
            ? getEffectivePlanSteps(state as any).map((s: any) => String(s?.agent || ''))
            : [String(state.intent || '')]
        ).filter(Boolean)
        const failure = attributeFailure(state, { timeLeftMs: timeLeftMs(state.resources), finalText: state.final })
        let successScore = conf >= 0.8 ? 0.95 : conf >= 0.7 ? 0.85 : conf >= 0.6 ? 0.75 : conf >= 0.45 ? 0.6 : 0.4
        const retryCount = Number((state as any)?.retryCount ?? 0) || 0
        const fb = await readFeedbackForRun(policyDir, opts.runId).catch(() => null)
        if (fb && typeof fb.score === 'number') successScore = clampNumber(fb.score, 0, 1)

        const evidenceGate = assessEvidenceGate({
          intent: state.intent,
          meta: state.meta,
          plan: getEffectivePlanSteps(state as any),
          taskPlan: state.taskPlan,
          final: String(state.final || ''),
          results: state.results,
          evidence: state.evidence
        })
        void appendMetrics({
          runId: opts.runId,
          phase: 'evidence_gate',
          ms: 0,
          ok: evidenceGate.pass,
          error_code: evidenceGate.pass ? undefined : 'business',
          extra: { reason: evidenceGate.reason }
        }).catch(() => {})
        const evidenceSupportedClaimRate =
          typeof state.meta?.evidenceSupportedClaimRate === 'number' ? Number(state.meta.evidenceSupportedClaimRate) : null
        const routeMatrixPass = inferManagerRouteMatrixPass((state.meta || {}) as Record<string, unknown>)
        const orchestratorJudgeAccept = (state.meta as any)?.orchestratorJudgeAccept !== false
        const refined = refineExperienceWrite({
          successScore,
          failureCategory: failure.category,
          needsClarify: Boolean(state.meta?.needsClarify),
          feedbackScore: fb?.score ?? null,
          retryCount,
          routeConfidence: routeConf,
          finalConfidence: conf,
          evidenceSupportedClaimRate,
          evidenceGatePassed: evidenceGate.pass,
          hasSubstantialFinal: Boolean(String(state.final || '').trim().length >= 24),
          routeMatrixPass,
          orchestratorJudgeAccept
        })
        successScore = refined.successScore

        const replayN =
          typeof (state.meta as any)?.experienceReplayCount === 'number' ? Number((state.meta as any).experienceReplayCount) : 0
        const replayItems = Array.isArray((state.meta as any)?.experienceReplayItems) ? (state.meta as any).experienceReplayItems : []
        const clauseCount = Number((state.meta as any)?.clauseCount ?? 0) || 0
        const clauseDecomposeMode = String((state.meta as any)?.clauseDecomposeMode || '')
        const searchMetrics = extractSearchRunMetrics(state)
        const experienceEntry: Record<string, any> = {
          type: 'experience',
          user: question,
          scenarioKey,
          dataDomain: String(process.env.DB_AGENT_DOMAIN || process.env.AGENT_DOMAIN || 'general'),
          intent: state.intent,
          path: planAgents,
          interactionMode: interactionModeFromMeta(state.meta),
          successScore,
          feedbackScore: fb?.score,
          durationMs,
          usedTokens: Number(state.resources?.usedTokens ?? 0) || 0,
          usedUsd: Number(state.resources?.usedUsd ?? 0) || 0,
          routeConfidence: routeConf,
          finalConfidence: conf,
          probeDbMatched: Boolean(state.probe?.db?.matched),
          probeRagHits: Number(state.probe?.rag?.hits ?? 0) || 0,
          probeCrawlerHealthy: Boolean(state.probe?.crawler?.healthy),
          ...searchMetricsForLearning(searchMetrics),
          needsClarify: Boolean(state.meta?.needsClarify),
          policyVersion: Number(policy.version || 1),
          failureCategory: failure.category,
          failureSeverity: failure.severity,
          failureReasons: failure.reasons.slice(0, 6),
          learningQualified: refined.qualifiedHighQuality,
          learningCapped: refined.cappedForLearning,
          evidenceGatePassed: evidenceGate.pass,
          ...(replayN > 0 ? { routeReplayHintsUsed: replayN } : {}),
          ...(clauseCount > 0 ? { clauseCount, clauseDecomposeMode: clauseDecomposeMode || undefined } : {}),
          tenantId: String(state.tenantId || state.meta?.tenantId || opts.tenantId || ''),
          userId: opts.userId,
          sessionId: opts.sessionId
        }
        if (replayItems.length > 0) {
          experienceEntry.replayTopMatches = replayItems.slice(0, 3)
        }
        await appendMemory(experienceEntry)
        const runOutcome = {
          successScore,
          needsClarify: Boolean(state.meta?.needsClarify),
          failureCategory: failure.category,
          planAgents,
          results: (state.results || {}) as Record<string, unknown>,
          probeDbMatched: Boolean(state.probe?.db?.matched),
          probeRagHits: Number(state.probe?.rag?.hits ?? 0) || 0
        }
        for (const agentName of planAgents) {
          const resultText = String(runOutcome.results[agentName] || '').trim()
          const agentOk = isAgentToolSuccess({
            agentName,
            resultText,
            successScore,
            needsClarify: runOutcome.needsClarify,
            failureCategory: failure.category,
            probeDbMatched: runOutcome.probeDbMatched,
            probeRagHits: runOutcome.probeRagHits
          })
          recordToolMemoryEvent({
            agent: 'manager',
            toolName: agentName,
            contextKey: scenarioKey,
            ok: agentOk,
            ms: Math.round(durationMs / Math.max(1, planAgents.length)),
            error: agentOk ? undefined : failure.reasons[0] || failure.category
          }).catch(() => undefined)
        }
        const ragSources = Array.isArray(state.probe?.rag?.sources)
          ? state.probe.rag.sources.map((s: unknown) => String(s ?? '')).filter(Boolean)
          : []
        const captured = captureRunArtifactsFromState(state as Record<string, unknown>, planAgents, question)
        let dbSql = ''
        for (const e of Array.isArray(state.evidence) ? state.evidence : []) {
          if (String((e as any)?.kind ?? '') === 'db' && (e as any)?.executed_sql) {
            dbSql = String((e as any).executed_sql).trim()
            break
          }
        }
        const dbTables: string[] = []
        for (const e of Array.isArray(state.evidence) ? state.evidence : []) {
          if (String((e as any)?.kind ?? '') !== 'db') continue
          const src = (e as any)?.sources
          if (Array.isArray(src)) for (const s of src) dbTables.push(String(s))
        }
        let codeTaskKind = ''
        const codeHintFiles: string[] = []
        let crawlerTargetSite = ''
        let crawlerChannel = ''
        let crawlerSeedUrl = ''
        let guiScenario = String(state.intent || scenarioKey || '').slice(0, 64)
        let guiExecutionMode = String(process.env.LOBSTER_EXECUTION_MODE || 'auto').slice(0, 16)
        for (const e of Array.isArray(state.evidence) ? state.evidence : []) {
          const kind = String((e as any)?.kind ?? '')
          if (kind === 'code') {
            codeTaskKind = String((e as any)?.task_kind ?? (e as any)?.taskKind ?? '').trim()
            const files = (e as any)?.hint_files ?? (e as any)?.files
            if (Array.isArray(files)) for (const f of files) codeHintFiles.push(String(f))
          }
          if (kind === 'crawler') {
            crawlerTargetSite = String((e as any)?.target_site ?? (e as any)?.site ?? '').trim()
            crawlerChannel = String((e as any)?.channel ?? '').trim()
            crawlerSeedUrl = String((e as any)?.seed_url ?? (e as any)?.url ?? '').trim()
          }
          if (kind === 'gui') {
            guiScenario = String((e as any)?.scenario ?? guiScenario).slice(0, 64)
            guiExecutionMode = String((e as any)?.execution_mode ?? guiExecutionMode).slice(0, 16)
          }
        }
        const shadowPayload = {
          ...runOutcome,
          question,
          dataDomain: String(process.env.DB_AGENT_DOMAIN || 'general'),
          dbPath: 'sql_direct',
          dbSql: dbSql || undefined,
          dbTables: dbTables.length ? dbTables : undefined,
          ragPath: 'document_query',
          ragSources,
          scenarioKey,
          intent: String(state.intent || ''),
          adminTools: captured.subArtifacts.admin?.tools,
          codeTaskKind: codeTaskKind || undefined,
          codeHintFiles: codeHintFiles.length ? codeHintFiles : undefined,
          crawlerTargetSite: crawlerTargetSite || undefined,
          crawlerChannel: crawlerChannel || undefined,
          crawlerSeedUrl: crawlerSeedUrl || undefined,
          guiScenario: guiScenario || undefined,
          guiExecutionMode: guiExecutionMode || undefined
        }
        void saveShadowRunArtifacts(
          {
            runId: opts.runId,
            sessionId: opts.sessionId,
            question,
            planAgents,
            subArtifacts: captured.subArtifacts,
            runOutcome: shadowPayload
          },
          process.env
        ).catch(() => undefined)
        opts.sendEvent({
          event: 'run_artifacts',
          data: {
            runId: opts.runId,
            status: 'shadow',
            toolChain: captured.toolChain,
            subArtifacts: captured.subArtifacts,
            managerArtifact: captured.managerArtifact,
            ...(dbSql ? { sql_hash: hashSql(dbSql) } : {})
          },
          from: 'manager'
        })
        if (planAgents.length > 1 && successScore >= 0.72 && !Boolean(state.meta?.needsClarify)) {
          void upsertProcessMemory({
            scenarioKey,
            question,
            toolChain: planAgents,
            hint: `intent=${String(state.intent || '')}；路径=${planAgents.join('→')}；score=${successScore.toFixed(2)}`,
            successScore,
            source: 'manager_finalize'
          }).catch(() => undefined)
        }
        void upsertKgFromManagerRun({
          tenantId: String(state.tenantId || state.meta?.tenantId || ''),
          runId: opts.runId,
          question,
          planAgents,
          evidence: Array.isArray(state.evidence) ? state.evidence : [],
          scenarioKey
        }).catch(() => undefined)
        if (!isFederationFeedbackGated()) {
        const allowFederationSync = !isStrictExperienceWriteEnabled() || refined.qualifiedHighQuality
        if (allowFederationSync) {
        syncDbExperienceFromManagerRun({
          ...runOutcome,
          question,
          dataDomain: String(process.env.DB_AGENT_DOMAIN || 'general'),
          dbPath: 'sql_direct'
        }).catch(() => undefined)
        syncRagExperienceFromManagerRun({
          ...runOutcome,
          question,
          ragPath: 'document_query',
          ragSources
        }).catch(() => undefined)
        syncAdminExperienceFromManagerRun({
          ...runOutcome,
          question,
          scenarioKey,
          intent: String(state.intent || '')
        }).catch(() => undefined)
        syncCodeExperienceFromManagerRun({
          ...runOutcome,
          question,
          taskKind: codeTaskKind || undefined,
          hintFiles: codeHintFiles.length ? codeHintFiles : undefined
        }).catch(() => undefined)
        syncCrawlerExperienceFromManagerRun({
          ...runOutcome,
          question,
          targetSite: crawlerTargetSite || undefined,
          channel: crawlerChannel || undefined,
          seedUrl: crawlerSeedUrl || undefined
        }).catch(() => undefined)
        syncGuiExperienceFromManagerRun({
          ...runOutcome,
          question,
          scenario: guiScenario || undefined,
          executionMode: guiExecutionMode || undefined
        }).catch(() => undefined)
        }
        }
        if (isSkillDraftEligible(runOutcome) && qualifiesSkillAutoDraft({
          successScore,
          failureCategory: failure.category,
          needsClarify: Boolean(state.meta?.needsClarify),
          feedbackScore: fb?.score ?? null,
          retryCount,
          routeConfidence: routeConf,
          finalConfidence: conf,
          evidenceSupportedClaimRate,
          evidenceGatePassed: evidenceGate.pass,
          hasSubstantialFinal: Boolean(String(state.final || '').trim().length >= 24)
        })) {
          maybeAutoDraftSkillFromSuccess({
            agent: 'manager',
            question,
            answer: String(state.final || '').trim(),
            path: planAgents.join('→'),
            runId: opts.runId,
            successScore,
            needsClarify: Boolean(state.meta?.needsClarify),
            scenarioKey,
            hints: [
              `intent=${String(state.intent || '')}`,
              `failureCategory=${failure.category}`,
              runOutcome.probeDbMatched ? 'probeDbMatched=true' : ''
            ].filter(Boolean)
          }).catch(() => undefined)
        }
        if (opts.sessionId) {
          await updateUserProfileFromRun(policyDir, opts.sessionId, {
            user: question,
            intent: state.intent,
            path: planAgents,
            scenarioKey,
            successScore,
            probeRagHits: experienceEntry.probeRagHits,
            probeDbMatched: experienceEntry.probeDbMatched,
            userId: opts.userId,
            tenantId: String(state.tenantId || state.meta?.tenantId || opts.tenantId || '')
          }).catch(() => undefined)
          await recordLayeredMemoryFromRun(policyDir, {
            sessionId: opts.sessionId,
            tenantId: String(state.tenantId || state.meta?.tenantId || opts.tenantId || ''),
            user: question,
            scenarioKey,
            intent: state.intent,
            failure,
            successScore,
            finalSnippet: String(state.final || '').trim().slice(0, 400),
            messages: Array.isArray(state.messages)
              ? state.messages.map((m: any) => ({
                  role: m?.role === 'assistant' ? 'assistant' : 'user',
                  content: String(m?.content ?? '')
                }))
              : undefined
          }).catch(() => undefined)
        }
        await recordUnifiedLearningFromRun(policyDir, {
          runId: opts.runId,
          sessionId: opts.sessionId,
          intent: String(state.intent || 'unknown'),
          meta: state.meta,
          finalConfidence: conf,
          routeConfidence: routeConf,
          successScore,
          feedbackScore: fb?.score ?? null,
          durationMs,
          usedTokens: Number(state.resources?.usedTokens ?? 0) || 0,
          usedUsd: Number(state.resources?.usedUsd ?? 0) || 0,
          firstPassSuccess: retryCount === 0,
          needsClarify: Boolean(state.meta?.needsClarify),
          failureCategory: failure.category,
          policyVersion: Number(policy.version || 1),
          policyCanary: Boolean((state.meta as any)?.policyCanary),
          promptCanary: Boolean((state.meta as any)?.promptCanary),
          plannerRulesCanary: Boolean((state.meta as any)?.plannerRulesCanary),
          retryCount,
          routeMatrixPass,
          orchestratorSource: String((state.meta as any)?.orchestratorSource || ''),
          orchestratorJudgeAccept,
          orchestratorReflexRetries: Number((state.meta as any)?.orchestratorReflexRetries ?? 0) || 0,
          ...searchMetricsForLearning(searchMetrics)
        }).catch(() => undefined)
        if (opts.sessionId) {
          const tc = await maybeCompleteTaskStackFromRun(policyDir, opts.sessionId, {
            userQuery: question,
            intent: String(state.intent || ''),
            successScore,
            needsClarify: Boolean(state.meta?.needsClarify)
          }).catch(() => ({ completed: false }))
          if (tc.completed) {
            opts.sendEvent({
              event: 'thinking',
              data: `任务栈：已自动标记完成「${tc.title || ''}」`,
              from: 'manager'
            })
          }
          const finalBody = String(state.final || '').trim()
          if (
            isTaskStackFinalizeLlmExtractEnabled() &&
            finalBody.length >= 40 &&
            successScore >= 0.65 &&
            !Boolean(state.meta?.needsClarify)
          ) {
            const llmTs = await extractAndUpsertTasksFromAssistantText(
              policyDir,
              opts.sessionId,
              finalBody,
              question,
              { fromFinalize: true }
            ).catch(() => ({ added: 0, skipped: 'error' }))
            if (llmTs.added > 0) {
              opts.sendEvent({
                event: 'thinking',
                data: `任务栈：Finalize 自动提取 ${llmTs.added} 条待办`,
                from: 'manager'
              })
              const stack = await loadTaskStack(policyDir, opts.sessionId).catch(() => null)
              if (stack) opts.sendEvent({ event: 'task_stack', data: { stack }, from: 'manager' })
            }
          }
        }
        if (isVectorMemoryEnabled()) {
          const memCtx = {
            successScore,
            failureCategory: failure.category,
            needsClarify: Boolean(state.meta?.needsClarify),
            feedbackScore: fb?.score ?? null,
            retryCount,
            routeConfidence: routeConf,
            finalConfidence: conf,
            evidenceSupportedClaimRate,
            evidenceGatePassed: evidenceGate.pass,
            hasSubstantialFinal: Boolean(String(state.final || '').trim().length >= 24),
            routeMatrixPass,
            orchestratorJudgeAccept
          }
          if (shouldIndexExperienceMemory(memCtx)) {
            indexMemoryEntry(policyDir, {
              user: question,
              memoryType: 'experience',
              intent: String(state.intent || ''),
              scenarioKey,
              successScore,
              ts: new Date().toISOString()
            }).catch(() => undefined)
          }
        }
        await appendNluMetrics({
          runId: opts.runId,
          intent: state.intent,
          routeConfidence: routeConf,
          finalConfidence: conf,
          needsClarify: Boolean(state.meta?.needsClarify),
          firstPassSuccess: retryCount === 0,
          clarificationCount: Array.isArray(state.meta?.clarifyQuestions) ? state.meta!.clarifyQuestions!.length : 0,
          probeDbMatched: Boolean(state.probe?.db?.matched),
          probeRagHits: Number(state.probe?.rag?.hits ?? 0) || 0,
          policyVersion: Number(policy.version || 1),
          policyCanary: Boolean((state.meta as any)?.policyCanary),
          policySource: typeof (state.meta as any)?.policySource === 'string' ? String((state.meta as any).policySource) : undefined,
          promptCanary: Boolean((state.meta as any)?.promptCanary),
          promptPatchSource:
            typeof (state.meta as any)?.promptPatchSource === 'string' ? String((state.meta as any).promptPatchSource) : undefined,
          plannerRulesCanary: Boolean((state.meta as any)?.plannerRulesCanary),
          plannerRulesSource:
            typeof (state.meta as any)?.plannerRulesSource === 'string' ? String((state.meta as any).plannerRulesSource) : undefined,
          experienceReplayCount:
            typeof (state.meta as any)?.experienceReplayCount === 'number' ? Number((state.meta as any).experienceReplayCount) : undefined,
          experienceReplayScenarioKey:
            typeof (state.meta as any)?.experienceReplayScenarioKey === 'string'
              ? String((state.meta as any).experienceReplayScenarioKey)
              : undefined
        })
        const failureInsights = await analyzeFailureInsights(policyDir).catch(() => ({ samples: 0, failures: [], strongestSignals: [], fixSuggestions: [] }))
        await appendFailureInsightSnapshot(policyDir, failureInsights).catch(() => undefined)
        const polUp = await maybeUpdateManagerPolicy(policyDir).catch(() => ({ updated: false as const }))
        if (polUp && polUp.updated && typeof polUp.fromVersion === 'number' && typeof polUp.toVersion === 'number') {
          await recordPolicyRolloutBaseline(policyDir, polUp.fromVersion, polUp.toVersion).catch(() => undefined)
        }
        if (failureInsights.strongestSignals.length > 0) {
          opts.sendEvent({
            event: 'thinking',
            data: `失败洞察：${failureInsights.strongestSignals.join('，')}`,
            from: 'manager'
          })
        }
        if (failureInsights.fixSuggestions?.length) {
          const top = failureInsights.fixSuggestions
            .slice(0, 2)
            .map((b) => `${b.category}/${b.severity}: ${b.suggestions.map((s) => s.title).join('；')}`)
            .join(' | ')
          opts.sendEvent({ event: 'thinking', data: `自动修复建议：${top}`, from: 'manager' })
        }
        const governance = await buildGovernanceSnapshot(policyDir, failureInsights).catch(() => ({
          updatedAt: new Date().toISOString(),
          activeSamples: 0,
          failureConcentration: 0,
          canPromote: false,
          confidence: 0,
          reasons: ['governance_build_failed'],
          recommendedActions: []
        }))
        await writeGovernanceSnapshot(policyDir, governance).catch(() => undefined)
        if (governance.recommendedActions.length) {
          opts.sendEvent({ event: 'thinking', data: `治理建议：${governance.recommendedActions.join('，')}`, from: 'manager' })
        }
        const experimentCycle = await runEvolutionExperimentCycle(policyDir, failureInsights, {
          llmInvoke: async (stage, st, messages) => {
            const r = await llmInvoke(stage, st, messages)
            return { text: String(r.text ?? '') }
          }
        }).catch(() => ({
          hypothesesAdded: 0,
          experimentsStarted: 0,
          evaluation: { evaluated: 0, promoted: [], rolledBack: [], pending: [] },
          shadows: {}
        }))
        if (experimentCycle.hypothesesAdded > 0) {
          opts.sendEvent({
            event: 'thinking',
            data: `进化实验：新增假设 ${experimentCycle.hypothesesAdded} 条`,
            from: 'manager'
          })
        }
        if (experimentCycle.experimentsStarted > 0) {
          opts.sendEvent({
            event: 'thinking',
            data: `进化实验：启动对照实验 ${experimentCycle.experimentsStarted} 个（policy/prompt/rules 金丝雀分流）`,
            from: 'manager'
          })
        }
        if (experimentCycle.shadows.policy) {
          opts.sendEvent({ event: 'thinking', data: '已写入 policy shadow 候选', from: 'manager' })
        }
        if (experimentCycle.shadows.prompt) {
          opts.sendEvent({ event: 'thinking', data: '已写入 Prompt shadow 补丁', from: 'manager' })
        }
        if (experimentCycle.shadows.planner) {
          opts.sendEvent({ event: 'thinking', data: '已写入 Planner shadow 规则', from: 'manager' })
        }
        const ev = experimentCycle.evaluation
        if (ev.promoted.length) {
          opts.sendEvent({
            event: 'thinking',
            data: `进化实验晋级：${ev.promoted.join(', ')}（对照组更优，已自动 promote）`,
            from: 'manager'
          })
        }
        if (ev.rolledBack.length) {
          opts.sendEvent({
            event: 'thinking',
            data: `进化实验回滚：${ev.rolledBack.join(', ')}（对照组劣化，已撤销 shadow）`,
            from: 'manager'
          })
        }
        if (isExperienceReplayEnabled() || failure.category !== 'success') {
          await maybeCurateManagerMemory(policyDir).catch(() => undefined)
        }

        // P1b-1：run 结束推一次 OTLP → Tempo（失败不阻断主路径）
        void pushOtlpTraceForRun(opts.runId).catch(() => undefined)
        // P1b-2：结构化 JSON 行 → stdout → Promtail → Loki（按 run_id 检索）
        emitRunFinalizeLog(opts.runId)

        const appendUserTailLocal = (_bodyText: string) => ''
        if (String(state.final || '').trim() || String(state.meta?.synthStreamBody || '').trim()) {
          const reportBody = String(state?.results?.report || '').trim()
          const mm = String(state?.results?.multimodal || '').trim()
          const musicRaw = String(state?.results?.music || '').trim()
          const videoRaw = String(state?.results?.video || '').trim()
          let finalText = composeStreamAlignedFinal(state)
          if (musicRaw && textHasPlayableMediaUrl(musicRaw) && !textHasPlayableMediaUrl(finalText)) {
            finalText = musicRaw
          } else if (videoRaw && textHasPlayableMediaUrl(videoRaw) && !textHasPlayableMediaUrl(finalText)) {
            finalText = videoRaw
          } else if (mm && isSynthRejectingMedia(finalText, mm)) {
            const composite = buildCompositeMediaFinal(state.results, planAgents)
            finalText = composite.trim() || mm
          } else if (isMediaOnlyPlanAgents(planAgents) && mediaAgentsInPlan(planAgents).length > 1) {
            const composite = buildCompositeMediaFinal(state.results, planAgents)
            if (composite.trim()) finalText = composite
          }
          void reportBody
          return {
            final: finalText,
            meta: mergeMeta(state, { synthStreamBody: String(state.meta?.synthStreamBody ?? finalText).trim() }),
            messages: [new AIMessage(redactSecrets(`${finalText}${appendUserTailLocal(finalText)}`))]
          }
        }
        const intent = state.intent
        const content =
          intent === 'multi' && isMediaOnlyPlanAgents(planAgents)
            ? buildCompositeMediaFinal(state.results, planAgents)
            : intent === 'multimodal'
              ? state.results.multimodal
              : intent === 'music'
                ? state.results.music
                : intent === 'video'
                  ? state.results.video
                  : intent === 'rag'
                    ? state.results.rag
                    : intent === 'report'
                      ? state.results.report
                      : intent === 'visualize'
                        ? state.results.visualize
                        : intent === 'clean'
                          ? state.results.clean
                          : intent === 'code'
                            ? state.results.code
                            : intent === 'admin'
                              ? state.results.admin
                              : intent === 'crawler'
                                ? state.results.crawler
                                : intent === 'db'
                                  ? state.results.db
                                  : pickPrimaryResultText(state.results || {}) || ''
        const plain = composeStreamAlignedFinal({ ...state, final: String(content ?? ''), meta: state.meta })
        return { messages: [new AIMessage(redactSecrets(`${plain}${appendUserTailLocal(plain)}`))] }
  }

  function sanitizeVisionIfNeeded(text: string, state: any): string {
    const mm = String(state?.results?.multimodal || '').trim()
    if (!mm && String(state?.intent ?? '') !== 'multimodal') return String(text || '')
    const userTask = effectiveUserTask(state.messages as any, state.routedQuery)
    return sanitizeVisionAnswer(String(text || ''), userTask)
  }

  function composeStreamAlignedFinal(state: any): string {
    const stream = String(state.meta?.synthStreamBody ?? '').trim()
    const stored = String(state.final ?? '').trim()
    let body = pickRicherNarrativeWithAuxBlocks(stream, stored)
    body = stripSynthPromptLeakage(body)
    const reportBody = String(state?.results?.report || '').trim()
    body = mergeSynthFinalWithReportBody(body, reportBody)
    const steps = getEffectivePlanSteps(state as any)
    const plannedReport = steps.some((s: any) => String(s?.agent || '') === 'report')
    const plannedViz = steps.some((s: any) => String(s?.agent || '') === 'visualize')
    const hasVizEvidence = (Array.isArray(state.evidence) ? state.evidence : []).some(
      (e: any) => String(e?.kind ?? '') === 'visualize'
    )
    const directVisualize =
      plannedViz || hasVizEvidence ? String(state?.results?.visualize || '').trim() : ''
    body = ensureVisualizeBlocksInFinal(body, directVisualize, (state?.results || {}) as Record<string, string>)
    const cur = String(body || '')
    if (!extractCrawlerTableMarkdown(cur)) {
      const block = buildCrawlerSourcesTaggedBlock(state?.results?.crawler)
      if (block) body = `${cur}\n\n${block}`
    }
    const question = effectiveUserTask(state.messages as any, state.routedQuery)
    body = appendDeferredReportBlockIfNeeded({
      body,
      synthSource: stream || extractAuxBlocksStructural(body).narrative,
      results: (state?.results || {}) as Record<string, unknown>,
      evidence: Array.isArray(state.evidence) ? state.evidence : [],
      plannedReport,
      shapeCtx: { meta: state.meta, planSteps: state.plan }
    })
    const stepRecords = Array.isArray(state.meta?.lastStepRecords)
      ? (state.meta.lastStepRecords as Array<{ id?: string; agent?: string; status?: string; error?: string }>)
      : []
    const structured = buildStructuredRunReport({
      goal: question,
      intent: String(state.intent || ''),
      finalText: body,
      plan: steps,
      stepRecords,
      evidence: Array.isArray(state.evidence) ? state.evidence : [],
      meta: (state.meta || {}) as Record<string, unknown>,
      verifierVerdict:
        state.meta?.verifierVerdict && typeof state.meta.verifierVerdict === 'object'
          ? (state.meta.verifierVerdict as import('../../core/output/verifierCompletion').VerifierCompletionVerdict)
          : null
    })
    if (structured) {
      opts.sendEvent({
        event: 'run_report',
        data: structured,
        from: 'manager'
      })
    }
    body = appendStructuredReportIfNeeded(body, structured)
    return polishFinalPayload(
      stripLatexMath(normalizeFinalUserText(sanitizeVisionIfNeeded(String(body || '').trim(), state)))
    )
  }
}
