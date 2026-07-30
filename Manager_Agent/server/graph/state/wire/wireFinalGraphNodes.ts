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
} from '../wireGraphUtilsDeps'
import { Annotation } from '@langchain/langgraph'
import { BaseMessage } from '@langchain/core/messages'
import { z } from 'zod'
import {  clampNumber,
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
} from '../../core/shared'
import { buildStepContext, buildTaskPlan, enforcePlanConstraints, enforcePlanCoverage, getEffectivePlanSteps, mergeTaskPlan, normalizePlanSteps, type TaskConstraints } from '../../core/plan'
import { appendConstraintsToQuery, crawlerTaskPlanPatch, deriveScenarioKey, estimateTokensFromMessages, estimateTokensFromText, filterCrawlerResultDomestic, hasStrongDbAnchor, isCapabilityOutOfScope, isExplicitMultiRequest, lastUserText, needsDataFoundation, normalizeFinalUserText, parseCrawlerClarifyPayload, parseRagClarifyPayload, percentile, shouldPreferMulti, stripLatexMath, uncertaintyFromConfidence } from '../../core/text'
import { createPlanPreviewNode } from '../../nodes/planPreview'
import { compileManagerGraph } from '../graph'
import { getManagerLangGraphCheckpointer } from '../../core/runtime/langgraphCheckpointer'
import { createFixNode } from '../../nodes/fix'
import { createExecutionNodes } from '../../nodes/exec'
import { createMultiNode } from '../../nodes/multi'
import { createFinalNodes } from '../../nodes/final'
import { appendMemory, appendMetrics, appendNluMetrics, appendPolicyShadowObserve, isDbNoData, readFeedbackForRun } from '../../core/runtime/runtimePersistence'
import { buildClarifyQuestionsFromContext } from '../../core/plan/clarifyContext'
import { createPlanLinterNode } from '../../nodes/planLinter'
import { createResourceNode } from '../../nodes/resource'
import { createToolHealthNode } from '../../nodes/toolHealth'
import { createTurnScopeNode } from '../../nodes/turnScope'
import { createProbeNode } from '../../nodes/probe'
import { createClarifyNode, createMetacogNode } from '../../nodes/meta'
import { createRouterNode } from '../../nodes/router'
import { createDecomposeNode } from '../../nodes/decompose'
import { createIntentClassifyNode } from '../../nodes/intentClassify'
import { createOrchestrateNode } from '../../nodes/orchestrate'
import { createWebSearchNode } from '../../nodes/search'
import { createPrefetchNode } from '../../nodes/prefetch'
import { createPlanNode } from '../../nodes/plan'
import { analyzePlanQualityFromMemory, planQualityHintForPlanner, recordPlanOutcome } from '../../core/plan/planQuality'
import { createManagerRuntime } from '../../core/runtime/runtime'
import { createInternalCollaborators } from '../../core/runtime/internalCollaborators'
import { createSecurityNode } from '../../nodes/security'
import { createSchedulerNode } from '../../nodes/scheduler'
import { createMonitorNode } from '../../nodes/monitor'
import { createEvaluatorNode } from '../../nodes/evaluator'
import { createOptimizerNode } from '../../nodes/optimizer'
import { createExecutionModeNode } from '../../nodes/mode'
import { createVoteAggregatorNode } from '../../nodes/voteAggregator'
import { resolveEffectiveManagerPolicy } from '../../core/evolution/policyCanary'
import { shouldSuppressCanaryForSession } from '../../core/routing/routeStrategy'
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
import type { WireGraphNodesCtx } from './wireGraphCtx'

export function wireFinalGraphNodes(ctx: WireGraphNodesCtx) {
  const {
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
  } = ctx
    const { synthNode, criticNode, verifierNode, finalizeNode, emitUserAnswerNode } = createFinalNodes({
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
    })
    const evaluatorNode = createEvaluatorNode({
      opts,
      mergeMeta,
      llm: {
        openaiApiKey: opts.openaiApiKey,
        openaiBaseUrl: opts.openaiBaseUrl,
        openaiModel: opts.openaiModel
      }
    })
    const optimizerNode = createOptimizerNode({
      opts
    })
    const monitorNode = createMonitorNode({
      opts,
      mergeMeta,
      appendMetrics
    })

    const fixNode = createFixNode({
      ensureNotAborted,
      opts,
      lastUserText,
      llmInvoke,
      FixStrategySchema,
      safeJsonParse,
      callDbAgent,
      callRagAgent,
      callCrawlerAgent,
      callCodeAgent,
      callAiAdminAgent,
      parseCrawlerClarifyPayload,
      crawlerTaskPlanPatch,
      mergeMeta,
      mergeTaskPlan,
      getEffectivePlanSteps,
      appendMetrics,
      runInternalAgent,
      emitTrace,
      summarize,
      probeRagEvidence,
      isDbNoData
    })

    const planPreviewNode = createPlanPreviewNode({
      ensureNotAborted,
      opts,
      mergeMeta
    })
  return {
    synthNode,
    criticNode,
    verifierNode,
    finalizeNode,
    emitUserAnswerNode,
    evaluatorNode,
    optimizerNode,
    monitorNode,
    fixNode,
    planPreviewNode
  }
}
