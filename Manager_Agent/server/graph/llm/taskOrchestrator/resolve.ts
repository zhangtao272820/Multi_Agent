import { z } from 'zod'
import { safeJsonParse } from '../../core/shared/llmJson'
import type { TaskClause } from '../../core/routing/clauses'
import type { TaskConstraints } from '../../core/plan'
import {
  IntentClassifySchema,
  type IntentClassifyResult,
  PLAN_SHORTCUT_KINDS,
  coerceBool,
  coercePlanShortcut
} from '../intentClassifyLlm'
import type { PlanBlueprint } from '../planBlueprintLlm'
import type { LlmInvokeFn } from '../taskConstraintsLlm'
import type { TurnScopeLlmMode } from '../turnScopeLlm'
import type { ExecutableAgent } from '../../core/routing/routeFinalize'
import { constraintsFromMerged, formatSessionAnchorBlock, type SessionIntentAnchor } from '../../core/memory/multiTurnIntent'
import type { IntentRagRecallResult } from '../../core/rag/intentRagRecallCore'
import { ensureCodeInPipelineAgents } from '../../core/routing/clauses'
import { reconcileIntentClassifyDataPlane } from '../../orchestrate/routeOrchestration'
import type { MergedIntentUnderstandResult } from '../intentUnderstandLlm'
import { formatProbeForOrchestrator } from '../../core/probe/probeInterpretation'
import { routingDecisionLlmTier } from '../../core/shared/modelTier'
import type { LlmInvokeOptions } from '../../core/shared/modelTier'
import { buildTopologyBlueprintFromCap } from '../planBlueprintLlm'
import { formatEvolutionHintPreamble, unifiedRoutingEnvEnabled, isUnifiedOrchestratorEnabled, isLlmFirstRouteEnabled } from '../../orchestrate/unifiedRouting'
import { parseFirstBalancedJsonObject } from '../../core/shared/llmJson'
import type { TurnRoutingScope } from '../../core/routing/turnScope'
import type { BaseMessage } from '@langchain/core/messages'
import type { OrchestratorParseFailure } from './schemas'
import type { TaskOrchestratorBundle } from './schemas'
import { bundleFromOrchestratorRaw, parseCompactOrchestratorJson, parseOrchestratorJson } from './parseBundle'
import { isOrchestratorCompactFirst } from '../../orchestrate/orchestratorHeuristic'
import {
  assembleOrchestratorCompactSystemPrompt,
  assembleOrchestratorSystemPrompt,
  orchestratorPromptInputFromRuntime,
  wrapUntrustedBlock
} from '../orchestratorPromptProfiles'
import { isLlmRateLimitError } from '../../../utils/chat/llmRateLimit'
import { isLlmRateLimitError } from '../../../utils/chat/llmRateLimit'

export type OrchestratorLlmResult = {
  bundle: TaskOrchestratorBundle | null
  stage: 'full' | 'compact' | 'none'
  failures: OrchestratorParseFailure[]
}

const COMPACT_SCHEMA_HINT =
  '{"turnScopeMode":"current_only|topic_shift","dataSources":["rag"|"crawler"],"suggestedAgents":["rag"],"allowedAgents":["rag","crawler","clean","code","visualize"],"isDbAnchored":false,"needsWeb":true,"needsAdmin":false,"explicitWantsVisualize":true,"explicitWantsReport":false,"isMulti":true,"planShortcut":"none","requiresAgentPipeline":true,"allowChatWebDirect":false,"routedQuery":"...","confidence":0.7,"rationale":"...","complexity":"low|mid|high","needsPlanPreview":false,"suggestedPosture":"agent","upgradeReason":"","upgradeConfidence":0.7}'

async function invokeOrchestratorLlm(
  input: {
    messages: BaseMessage[]
    lastUser: string
    routingContext: string
    turnScopeHint?: string
    probe?: { db?: { matched?: boolean; tables?: string[] }; rag?: { hits?: number } } | null
    sessionAnchor?: SessionIntentAnchor | null
    ragRecall?: IntentRagRecallResult | null
    evolutionHint?: string
    judgeFeedback?: string
    puStackHint?: string
    llmInvoke: LlmInvokeFn
    state: unknown
  },
  mode: 'full' | 'compact',
  invokeOptions?: Pick<LlmInvokeOptions, 'quiet' | 'thinkingLabel'>
): Promise<{ text: string }> {
  const last = String(input.lastUser || '').trim()
  const ctx = String(input.routingContext || last).trim().slice(0, 2200)
  const anchorBlock = formatSessionAnchorBlock(input.sessionAnchor)
  const ragBlock = String(input.ragRecall?.text || '').trim()
  const evo = String(input.evolutionHint || '').trim()

  const systemFull = assembleOrchestratorSystemPrompt(
    orchestratorPromptInputFromRuntime({
      probe: input.probe,
      sessionAnchor: input.sessionAnchor,
      ragRecallText: ragBlock
    })
  )
  const systemCompact = assembleOrchestratorCompactSystemPrompt()

  const schemaHint =
    mode === 'compact'
      ? `schema: ${COMPACT_SCHEMA_HINT}`
      : 'schema: {"turnScopeMode":"current_only|continuation|topic_shift|chitchat","directChitchatSynth":bool,"coalescedTask":string,"clauses":[{"id":"c1","text":"...","agents":["rag"]}],"timeHints":[],"subjectHints":[],"fieldHints":[],"wantsVisualize":bool,"wantsReport":bool,"dataSources":["rag"|"db"|"crawler"],"taskIntent":"structured_query|document_retrieval|hybrid|action|chitchat|unknown","primaryIntent":"...","isMulti":bool,"suggestedAgents":[],"isDbAnchored":bool,"needsAdmin":bool,"needsWeb":bool,"explicitWantsReport":bool,"explicitWantsVisualize":bool,"planShortcut":"none|db_only|rag_only|...","requiresAgentPipeline":bool,"allowChatWebDirect":bool,"intent":"...","allowedAgents":[],"routedQuery":"...","needsWebSearch":bool,"needsClarify":bool,"clarifyKind":"none|slot|plane|output_disambiguation","clarifyQuestions":[],"planBlueprint":{"rationale":"","steps":[{"agent":"rag","queryFocus":"..."}]},"confidence":0-1,"rationale":"...","complexity":"low|mid|high","needsPlanPreview":bool,"suggestedPosture":"ask|plan|agent|debug","upgradeReason":"...","upgradeConfidence":0-1}'

  return input.llmInvoke(
    'route',
    input.state,
    [
      ['system', mode === 'compact' ? systemCompact : systemFull],
        [
          'human',
          [
            input.turnScopeHint,
            `【用户末轮】\n${last.slice(0, 1200)}`,
            wrapUntrustedBlock('routing_context', `【路由上下文】\n${ctx}`),
            wrapUntrustedBlock('session_anchor', anchorBlock),
            wrapUntrustedBlock('probe', formatProbeForOrchestrator(input.probe)),
            wrapUntrustedBlock(
              'intent_rag',
              ragBlock ? `【意图 RAG 召回（参考，不一致则以末轮为准）】\n${ragBlock.slice(0, 900)}` : ''
            ),
            wrapUntrustedBlock('pu_stack', input.puStackHint ? String(input.puStackHint).slice(0, 1200) : ''),
            wrapUntrustedBlock(
              'evolution_hint',
              evo ? `${formatEvolutionHintPreamble()}\n${evo.slice(0, 600)}` : ''
            ),
            wrapUntrustedBlock(
              'judge_feedback',
              input.judgeFeedback
                ? `【上轮审查未通过，须修正】\n${String(input.judgeFeedback).slice(0, 900)}`
                : ''
            ),
            schemaHint
          ]
            .filter(Boolean)
            .join('\n\n')
        ]
    ],
    {
      tier: routingDecisionLlmTier(input.state),
      ...(invokeOptions ?? {})
    }
  )
}

/**
 * 统一编排 LLM：LLM-First 仅 full schema + 解析失败时最多 2 次 repair；否则 compact-first 可选。
 */
export async function resolveTaskOrchestrationByLlm(input: {
  messages: BaseMessage[]
  lastUser: string
  routingContext: string
  turnScopeHint?: string
  probe?: { db?: { matched?: boolean; tables?: string[] }; rag?: { hits?: number } } | null
  sessionAnchor?: SessionIntentAnchor | null
  ragRecall?: IntentRagRecallResult | null
  evolutionHint?: string
  judgeFeedback?: string
  puStackHint?: string
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<OrchestratorLlmResult> {
  const last = String(input.lastUser || '').trim()
  const failures: OrchestratorParseFailure[] = []
  if (last.length < 2) return { bundle: null, stage: 'none', failures }

  const llmFirst = isLlmFirstRouteEnabled()
  const stages: Array<'full' | 'compact'> = llmFirst
    ? ['full']
    : isOrchestratorCompactFirst()
      ? ['compact', 'full']
      : ['full', 'compact']

  let skipRepairForRateLimit = false
  for (const stage of stages) {
    try {
      const resp = await invokeOrchestratorLlm(input, stage, llmFirst && stage === 'full' ? { thinkingLabel: '编排决策' } : undefined)
      if (stage === 'compact') {
        const compactParsed = parseCompactOrchestratorJson(String(resp.text ?? '').trim(), last)
        if (compactParsed.raw) {
          return { bundle: bundleFromOrchestratorRaw(compactParsed.raw), stage: 'compact', failures }
        }
        if (compactParsed.error) failures.push({ stage: 'compact', reason: compactParsed.error })
      } else {
        const fullParsed = parseOrchestratorJson(String(resp.text ?? '').trim(), last)
        if (fullParsed.raw) {
          return { bundle: bundleFromOrchestratorRaw(fullParsed.raw), stage: 'full', failures }
        }
        if (fullParsed.error) failures.push({ stage: 'full', reason: fullParsed.error })
      }
    } catch (e) {
      failures.push({
        stage,
        reason: e instanceof Error ? e.message : `${stage} LLM 异常`
      })
      // 限流不是坏 JSON：禁止再打 repair 放大请求
      if (isLlmRateLimitError(e)) {
        skipRepairForRateLimit = true
        break
      }
    }
  }

  if (!skipRepairForRateLimit) {
    const maxRepairs = llmFirst ? 2 : 1
    for (let r = 0; r < maxRepairs; r++) {
      const repairHint = failures.length
        ? failures.map((f) => `${f.stage}: ${f.reason}`).join('；')
        : undefined
      if (!repairHint) break
      try {
        const resp = await invokeOrchestratorLlm(
          {
            ...input,
            judgeFeedback: `JSON/schema 须修正（第 ${r + 1} 次）：${repairHint.slice(0, 600)}`
          },
          'full',
          { quiet: true }
        )
        const repaired = parseOrchestratorJson(String(resp.text ?? '').trim(), last)
        if (repaired.raw) {
          return { bundle: bundleFromOrchestratorRaw(repaired.raw), stage: 'full', failures }
        }
        if (repaired.error) failures.push({ stage: 'full', reason: `repair${r + 1}: ${repaired.error}` })
      } catch (e) {
        failures.push({ stage: 'full', reason: e instanceof Error ? e.message : `repair${r + 1} LLM 异常` })
        if (isLlmRateLimitError(e)) break
      }
    }
  }

  return { bundle: null, stage: 'none', failures }
}
