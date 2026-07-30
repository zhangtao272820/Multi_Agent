import {
  callAiAdminAgent,
  callCodeAgent,
  callCrawlerAgent,
  callLobsterAgent,
  callDbAgent,
  callMultimodalAgent,
  callMusicAgent,
  callVideoAgent,
  callRagAgent,
  IntentSchema
} from './wireGraphUtilsDeps'
import {
  clampNumber,
  defaultPolicy,
  extractStructuredPayload,
  maybeUpdateManagerPolicy,
  safeJsonParse,
  sanitizeUntrustedText
} from '../core/shared'
import {
  buildStepContext,
  getEffectivePlanSteps,
  mergeTaskPlan,
  normalizePlanSteps
} from '../core/plan'
import {
  appendConstraintsToQuery,
  crawlerTaskPlanPatch,
  deriveScenarioKey,
  filterCrawlerResultDomestic,
  hasStrongDbAnchor,
  lastUserText,
  normalizeFinalUserText,
  parseCrawlerClarifyPayload,
  parseRagClarifyPayload,
  stripLatexMath,
  uncertaintyFromConfidence
} from '../core/text'
import { createPlanPreviewNode } from '../nodes/planPreview'
import { createFixNode } from '../nodes/fix'
import { createExecutionNodes } from '../nodes/exec'
import { createMultiNode } from '../nodes/multi'
import { createFinalNodes } from '../nodes/final'
import { appendMemory, appendMetrics, appendNluMetrics, isDbNoData, readFeedbackForRun } from '../core/runtime/runtimePersistence'
import { createPlanLinterNode } from '../nodes/planLinter'
import { createMonitorNode } from '../nodes/monitor'
import { createEvaluatorNode } from '../nodes/evaluator'
import { createOptimizerNode } from '../nodes/optimizer'
import { buildClarifyQuestions, readEnvNumber, readEnvString } from './graphFactoryHelpers'
import type { wireManagerGraphNodes } from './wireManagerGraphNodes'
import type { wireGraphRoutePhase } from './wireGraphRoutePhase'

type WireCtx = Parameters<typeof wireManagerGraphNodes>[0]
type RoutePhase = ReturnType<typeof wireGraphRoutePhase>

export function wireGraphExecPhase(ctx: WireCtx, route: RoutePhase) {
  const {
    opts,
    policyDir,
    ensureNotAborted,
    mergeMeta,
    llmInvoke,
    lastUserText: lastUserTextFn,
    policyPromise,
    defaultPolicy: defaultPolicyFn,
    appendMemory,
    appendMetrics,
    safeJsonParse: safeJsonParseFn,
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

  const { ragRelevanceJudge, ragEvidenceMatchJudge, ragScopeHintJudge } = route

  const planLinterNode = createPlanLinterNode({
    ensureNotAborted,
    policyDir,
    opts,
    getEffectivePlanSteps,
    lastUserText: lastUserTextFn,
    buildClarifyQuestions,
    mergeMeta,
    llmInvoke
  })

  const { dbNode, ragNode, codeNode, adminNode, adminConfirmResumeNode, crawlerNode, guiNode, mcpToolNode, cleanNode, visualizeNode, reportNode, multimodalNode, musicNode, videoNode } = createExecutionNodes({
    ensureNotAborted,
    opts,
    policyPromise,
    defaultPolicy: defaultPolicyFn,
    lastUserText: lastUserTextFn,
    hasStrongDbAnchor,
    callDbAgent,
    appendMetrics,
    isDbNoData,
    emitTrace,
    summarize,
    deriveScenarioKey,
    callRagAgent,
    ragEvidenceFromProbe,
    probeRagEvidence,
    parseRagClarifyPayload,
    mergeTaskPlan,
    getEffectivePlanSteps,
    mergeMeta,
    callCodeAgent,
    callAiAdminAgent,
    callCrawlerAgent,
    callLobsterAgent,
    parseCrawlerClarifyPayload,
    crawlerTaskPlanPatch,
    runInternalAgent,
    filterCrawlerResultDomestic,
    callMultimodalAgent,
    callMusicAgent,
    callVideoAgent,
    ragRelevanceJudge,
    ragEvidenceMatchJudge,
    ragScopeHintJudge,
    llmInvoke
  })

  const multiNode = createMultiNode({
    ensureNotAborted,
    opts,
    policyPromise,
    defaultPolicy: defaultPolicyFn,
    getEffectivePlanSteps,
    normalizePlanSteps,
    buildStepContext,
    lastUserText: lastUserTextFn,
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
    appendMetrics,
    isDbNoData,
    emitTrace,
    summarize,
    mergeMeta,
    mergeTaskPlan,
    ragRelevanceJudge,
    ragEvidenceMatchJudge,
    ragScopeHintJudge,
    llmInvoke
  })

  const { synthNode, criticNode, verifierNode, finalizeNode, emitUserAnswerNode } = createFinalNodes({
    ensureNotAborted,
    opts,
    llmInvoke,
    lastUserText: lastUserTextFn,
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
    defaultPolicy: defaultPolicyFn,
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
    safeJsonParse: safeJsonParseFn,
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
  const optimizerNode = createOptimizerNode({ opts })
  const monitorNode = createMonitorNode({ opts, mergeMeta, appendMetrics })

  const fixNode = createFixNode({
    ensureNotAborted,
    opts,
    lastUserText: lastUserTextFn,
    llmInvoke,
    FixStrategySchema,
    safeJsonParse: safeJsonParseFn,
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

  const planPreviewNode = createPlanPreviewNode({ ensureNotAborted, opts, mergeMeta })

  return {
    planLinterNode,
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
