import type { ChatOpenAI } from '@langchain/openai'
import {
  createManagerChatOpenAI,
  callAiAdminAgent,
  callCodeAgent,
  callCrawlerAgent,
  callLobsterAgent,
  callDbAgent,
  callMultimodalAgent,
  callMusicAgent,
  callVideoAgent,
  callRagAgent,
  fetchDbTaskPlan,
  ragProbeTimeoutMs,
  buildAgentTraceHeaders,
  EntitiesSchema,
  ForceIntentSchema,
  IntentSchema,
  PlanSchema,
  RouteSchema,
  StepSchema,
  normalizeEntities,
  type ForceIntent,
  type Intent,
  type Step,
  type TaskPlan,
  createRagRelevanceJudge,
  createRagEvidenceMatchJudge,
  createRagScopeHintJudge
} from './wireGraphUtilsDeps'
import { Annotation } from '@langchain/langgraph'
import { BaseMessage } from '@langchain/core/messages'
import { z } from 'zod'
import {
  clampNumber,
  defaultPolicy,
  extractStructuredPayload,
  extractTotalTokens,
  loadManagerPolicy,
  loadManagerPolicyShadow,
  maybeUpdateManagerPolicy,
  readHistoryEntries,
  safeJsonParse,
  sanitizeUntrustedText,
  summarizeManagerPolicyDiff
} from '../core/shared'
import { buildStepContext, buildTaskPlan, enforcePlanConstraints, enforcePlanCoverage, getEffectivePlanSteps, mergeTaskPlan, normalizePlanSteps, type TaskConstraints } from '../core/plan'
import { appendConstraintsToQuery, crawlerTaskPlanPatch, deriveScenarioKey, estimateTokensFromMessages, estimateTokensFromText, filterCrawlerResultDomestic, hasStrongDbAnchor, isCapabilityOutOfScope, isExplicitMultiRequest, lastUserText, needsDataFoundation, normalizeFinalUserText, parseCrawlerClarifyPayload, parseRagClarifyPayload, percentile, shouldPreferMulti, stripLatexMath, uncertaintyFromConfidence } from '../core/text'
import { createPlanPreviewNode } from '../nodes/planPreview'
import { compileManagerGraph } from './graph'
import { getManagerLangGraphCheckpointer } from '../core/runtime/langgraphCheckpointer'
import { createFixNode } from '../nodes/fix'
import { createExecutionNodes } from '../nodes/exec'
import { createMultiNode } from '../nodes/multi'
import { createFinalNodes } from '../nodes/final'
import { appendMemory, appendMetrics, appendNluMetrics, appendPolicyShadowObserve, isDbNoData, readFeedbackForRun } from '../core/runtime/runtimePersistence'
import { resolveManagerPolicyDir } from '../../utils/session/managerPolicyDir'
import { buildClarifyQuestionsFromContext } from '../core/plan/clarifyContext'
import { createPlanLinterNode } from '../nodes/planLinter'
import { createResourceNode } from '../nodes/resource'
import { createToolHealthNode } from '../nodes/toolHealth'
import { createTurnScopeNode } from '../nodes/turnScope'
import { createProbeNode } from '../nodes/probe'
import { createClarifyNode, createMetacogNode } from '../nodes/meta'
import { createRouterNode } from '../nodes/router'
import { createDecomposeNode } from '../nodes/decompose'
import { createIntentClassifyNode } from '../nodes/intentClassify'
import { createOrchestrateNode } from '../nodes/orchestrate'
import { createWebSearchNode } from '../nodes/search'
import { createPrefetchNode } from '../nodes/prefetch'
import { createPlanNode } from '../nodes/plan'
import { analyzePlanQualityFromMemory, planQualityHintForPlanner, recordPlanOutcome } from '../core/plan/planQuality'
import { createManagerRuntime } from '../core/runtime/runtime'
import { createInternalCollaborators } from '../core/runtime/internalCollaborators'
import { createSecurityNode } from '../nodes/security'
import { createSchedulerNode } from '../nodes/scheduler'
import { createMonitorNode } from '../nodes/monitor'
import { createEvaluatorNode } from '../nodes/evaluator'
import { createOptimizerNode } from '../nodes/optimizer'
import { createExecutionModeNode } from '../nodes/mode'
import { createVoteAggregatorNode } from '../nodes/voteAggregator'
import { resolveEffectiveManagerPolicy } from '../core/evolution/policyCanary'
import { shouldSuppressCanaryForSession } from '../core/routing/routeStrategy'
import fs from 'node:fs/promises'
import path from 'node:path'
import { traceable } from 'langsmith/traceable'

import { GraphState, FixStrategySchema } from './graphAnnotation'
import {
  buildClarifyQuestions,
  readEnvNumber,
  readEnvString,
  type ExperienceIndex,
  type SendEvent
} from './graphFactoryHelpers'

import { buildManagerGraphRuntimeBundle, type ManagerGraphRuntimeBundle } from './runtimeBundle'
import { wireManagerGraphNodes } from './wireManagerGraphNodes'

export function createManagerGraph(opts: {
  openaiApiKey: string
  openaiBaseUrl: string
  openaiModel: string
  llmProfile?: {
    modelRoute?: string
    modelRouteMax?: string
    modelPlan?: string
    modelSynth?: string
    modelCritic?: string
    modelVerifier?: string
    modelLowCost?: string
  }
  dbAgentWsUrl: string
  dbAgentHttpUrl: string
  dbId?: string
  ragAgentHttpUrl: string
  codeAgentWsUrl: string
  crawlerAgentWsUrl: string
  lobsterAgentWsUrl: string
  aiAdminAgentWsUrl: string
  multimodalAgentHttpUrl: string
  musicAgentWsUrl: string
  videoAgentWsUrl: string
  timeoutMs: number
  sendEvent: SendEvent
  threadId: string
  runId: string
  sessionId?: string
  userId?: string
  tenantId?: string
  platformTraceId?: string
  ragConversationId?: string
  ragHistory?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  signal?: AbortSignal
}) {
  const modelCache = new Map<string, ChatOpenAI>()
  const policyDir = resolveManagerPolicyDir(opts.tenantId)
  const suppressCanaryPromise = opts.sessionId
    ? shouldSuppressCanaryForSession(policyDir, opts.sessionId).catch(() => false)
    : Promise.resolve(false)
  const resolvedPolicyPromise = suppressCanaryPromise.then((suppressCanary) =>
    resolveEffectiveManagerPolicy(policyDir, opts.sessionId, { suppressCanary })
  )
  const policyPromise = resolvedPolicyPromise.then((r) => r.policy)
  const lsEnabled = /^(1|true|yes|on)$/i.test(String(process.env.LANGSMITH_TRACING ?? ''))
  if (lsEnabled) {
    if (!String(process.env.LANGCHAIN_TRACING_V2 || '').trim()) {
      ;(process.env as any).LANGCHAIN_TRACING_V2 = 'true'
    }
    const proj = String(process.env.LANGSMITH_PROJECT || process.env.LANGCHAIN_PROJECT || '').trim()
    if (proj && !String(process.env.LANGCHAIN_PROJECT || '').trim()) {
      ;(process.env as any).LANGCHAIN_PROJECT = proj
    }
  }
  const traceRun = <T,>(name: string, fn: () => Promise<T>, extra?: Record<string, any>) => {
    if (!lsEnabled) return fn()
    const wrapped = traceable(fn, {
      name,
      metadata: {
        runId: opts.runId,
        threadId: opts.threadId,
        sessionId: opts.sessionId,
        langsmithProject: String(process.env.LANGSMITH_PROJECT || process.env.LANGCHAIN_PROJECT || '').trim() || undefined,
        ...extra
      }
    })
    return wrapped()
  }
  const getModel = (modelName: string, temperature = 0) => {
    const name = String(modelName || '').trim()
    if (!name) throw new Error('missing modelName')
    const key = `${name}|${temperature}`
    const cached = modelCache.get(key)
    if (cached) return cached
    const m = createManagerChatOpenAI({
      apiKey: opts.openaiApiKey,
      modelName: name,
      openaiBaseUrl: opts.openaiBaseUrl,
      temperature
    })
    modelCache.set(key, m)
    return m
  }

  const loadExperienceIndex = async (): Promise<ExperienceIndex> => {
    try {
      const dir = resolveManagerPolicyDir(opts.tenantId)
      const jsonlPath = path.join(dir, 'manager-memory.jsonl')
      const jsonPath = path.join(dir, 'manager-memory.json')
      const history = await readHistoryEntries(jsonlPath, jsonPath, 260)
      const byKey: Record<string, { win: number; total: number; intent: Intent; lastTs?: string }> = {}
      for (const h of history.slice(-200)) {
        if (h?.type !== 'experience') continue
        const key = String(h?.scenarioKey ?? '').trim()
        const intent = IntentSchema.safeParse(String(h?.intent ?? '')).success ? (h.intent as Intent) : null
        if (!key || !intent) continue
        const score = Number(h?.successScore ?? 0)
        const win = score >= 0.75 ? 1 : 0
        const rec = byKey[key] || { win: 0, total: 0, intent, lastTs: undefined }
        rec.total += 1
        rec.win += win
        rec.lastTs = typeof h?.ts === 'string' ? h.ts : rec.lastTs
        if (rec.total <= 1) rec.intent = intent
        byKey[key] = rec
      }
      const out: ExperienceIndex = {}
      for (const [k, v] of Object.entries(byKey)) {
        const successRate = v.total ? v.win / v.total : 0
        out[k] = { intent: v.intent, count: v.total, successRate, lastTs: v.lastTs }
      }
      return out
    } catch {
      return {}
    }
  }

  const experienceIndexPromise = loadExperienceIndex()

  const ensureNotAborted = () => {
    if (opts.signal?.aborted) throw new Error('aborted')
  }

  const mergeMeta = (state: any, patch: Partial<(typeof GraphState.State)['meta']>) => {
    const base = (state?.meta ??
      ({
        capabilityOk: true,
        uncertainty: 'medium',
        needsClarify: false,
        clarifyQuestions: [],
        lowCostMode: false
      } as any)) as any
    return { ...base, ...patch }
  }

  const mergeResources = (state: any, patch: Partial<(typeof GraphState.State)['resources']>) => {
    const base = (state?.resources ??
      ({
        startedAtMs: Date.now(),
        deadlineAtMs: Date.now() + Math.max(1, opts.timeoutMs),
        usedUsd: 0,
        usedTokens: 0,
        modelRoute: opts.openaiModel,
        modelPlan: opts.openaiModel,
        modelSynth: opts.openaiModel,
        modelCritic: opts.openaiModel,
        modelVerifier: opts.openaiModel,
        modelLowCost: opts.openaiModel,
        costPer1kTokensUsd: 0
      } as any)) as any
    return { ...base, ...patch }
  }

  const { timeLeftMs, llmInvoke } = createManagerRuntime({
    ensureNotAborted,
    opts,
    getEffectivePlanSteps,
    traceRun,
    getModel,
    extractTotalTokens,
    estimateTokensFromMessages,
    estimateTokensFromText,
    mergeResources,
    appendMetrics,
    mergeMeta
  })

  const {
    summarize,
    formatReferences,
    redactSecrets,
    emitTrace,
    runInternalAgent,
    runAlwaysInternalCollaborators,
    fetchJson,
    ragEvidenceFromProbe,
    probeRagEvidence
  } = buildManagerGraphRuntimeBundle({
    opts,
    ensureNotAborted,
    getModel,
    traceRun,
    mergeResources,
    appendMetrics,
    timeLeftMs
  })

  const nodes = wireManagerGraphNodes({
    opts,
    policyDir,
    ensureNotAborted,
    mergeMeta,
    mergeResources,
    llmInvoke,
    lastUserText,
    fetchJson,
    policyPromise,
    defaultPolicy,
    appendMemory,
    appendMetrics,
    safeJsonParse,
    percentile,
    summarize,
    emitTrace,
    probeRagEvidence,
    ragEvidenceFromProbe,
    runInternalAgent,
    runAlwaysInternalCollaborators,
    formatReferences,
    redactSecrets,
    timeLeftMs,
    buildClarifyQuestions,
    FixStrategySchema,
    getModel,
    traceRun
  })

  const {
    resourceNode,
    toolHealthNode,
    turnScopeNode,
    probeNode,
    metacogNode,
    securityNode,
    decomposeNode,
    intentClassifyNode,
    routerNode,
    orchestrateNode,
    prefetchNode,
    webSearchNode,
    clarifyNode,
    planNode,
    schedulerNode,
    executionModeNode,
    voteAggregatorNode,
    dbNode,
    ragNode,
    codeNode,
    adminNode,
    adminConfirmResumeNode,
    crawlerNode,
    guiNode,
    mcpToolNode,
    cleanNode,
    visualizeNode,
    reportNode,
    multimodalNode,
    musicNode,
    videoNode,
    multiNode,
    planLinterNode,
    planPreviewNode,
    synthNode,
    evaluatorNode,
    criticNode,
    optimizerNode,
    emitUserAnswerNode,
    verifierNode,
    monitorNode,
    finalizeNode,
    fixNode
  } = nodes

  const graph = compileManagerGraph(GraphState, {
    resourceNode,
    toolHealthNode,
    turnScopeNode,
    probeNode,
    metacogNode,
    securityNode,
    decomposeNode,
    intentClassifyNode,
    routerNode,
    orchestrateNode,
    prefetchNode,
    webSearchNode,
    clarifyNode,
    planNode,
    schedulerNode,
    executionModeNode,
    voteAggregatorNode,
    dbNode,
    ragNode,
    codeNode,
    adminNode,
    adminConfirmResumeNode,
    crawlerNode,
    guiNode,
    mcpToolNode,
    cleanNode,
    visualizeNode,
    reportNode,
    multimodalNode,
    musicNode,
    videoNode,
    multiNode,
    planLinterNode,
    planPreviewNode,
    synthNode,
    evaluatorNode,
    criticNode,
    optimizerNode,
    emitUserAnswerNode,
    verifierNode,
    monitorNode,
    finalizeNode,
    fixNode
  }, { checkpointer: getManagerLangGraphCheckpointer() })

  const policyShadowLogEnabled = () =>
    /^(1|true|yes|on)$/i.test(String(process.env.MANAGER_POLICY_SHADOW_LOG ?? ''))
  const policyShadowObserveMetaEnabled = () => String(process.env.MANAGER_POLICY_SHADOW_OBSERVE ?? '1').trim() !== '0'

  const shouldWrapGraphInvoke = lsEnabled || policyShadowLogEnabled()
  if (!shouldWrapGraphInvoke) return graph

  return new Proxy(graph as any, {
    get(target, prop, receiver) {
      if (prop === 'invoke') {
        return async (state: any, config?: any) => {
          const resolved = await resolvedPolicyPromise.catch(() => ({
            policy: defaultPolicy(),
            source: 'active' as const,
            canary: false
          }))
          const baseMeta = (state?.meta && typeof state.meta === 'object' ? state.meta : {}) as Record<string, any>
          state = {
            ...state,
            meta: {
              ...baseMeta,
              policySource: resolved.source,
              policyCanary: resolved.canary,
              policyVersion: resolved.policy.version
            }
          }
          let traceExtra: Record<string, any> = {
            kind: 'langgraph_root',
            policySource: resolved.source,
            policyCanary: resolved.canary
          }
          if (policyShadowLogEnabled() || (lsEnabled && policyShadowObserveMetaEnabled())) {
            const shadow = await loadManagerPolicyShadow(policyDir).catch(() => null)
            if (shadow) {
              const active = await loadManagerPolicy(policyDir).catch(() => defaultPolicy())
              const diff = summarizeManagerPolicyDiff(active, shadow)
              if (policyShadowLogEnabled() && diff.diffPathCount > 0) {
                await appendPolicyShadowObserve({
                  runId: opts.runId,
                  sessionId: opts.sessionId,
                  activeVersion: active.version,
                  shadowVersion: shadow.version,
                  diffPathCount: diff.diffPathCount,
                  paths: diff.paths
                }).catch(() => undefined)
              }
              if (lsEnabled && policyShadowObserveMetaEnabled()) {
                traceExtra = {
                  ...traceExtra,
                  policyShadowPresent: true,
                  policyShadowVersion: shadow.version,
                  activePolicyVersion: active.version,
                  policyShadowDiffCount: diff.diffPathCount,
                  policyShadowDiffSample: diff.paths.slice(0, 8)
                }
              }
            }
          }
          if (lsEnabled) {
            return traceRun('manager_graph_invoke', () => target.invoke.call(target, state, config), traceExtra)
          }
          return target.invoke.call(target, state, config)
        }
      }
      return Reflect.get(target, prop, receiver)
    }
  }) as typeof graph
}

