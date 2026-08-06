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
import { formatProbeForOrchestrator, isProbeDbRoutingRelevant } from '../../core/probe/probeInterpretation'
import { routingDecisionLlmTier } from '../../core/shared/modelTier'
import type { LlmInvokeOptions } from '../../core/shared/modelTier'
import { buildTopologyBlueprintFromCap } from '../planBlueprintLlm'
import { formatAgentBoundaryPrompt, formatEvolutionHintPreamble, unifiedRoutingEnvEnabled, isUnifiedOrchestratorEnabled, isLlmFirstRouteEnabled } from '../../orchestrate/unifiedRouting'
import { parseFirstBalancedJsonObject } from '../../core/shared/llmJson'
import type { TurnRoutingScope } from '../../core/routing/turnScope'
import type { BaseMessage } from '@langchain/core/messages'

const ROUTE_INTENTS = [
  'db',
  'rag',
  'code',
  'crawler',
  'gui',
  'admin',
  'clean',
  'visualize',
  'report',
  'multimodal',
  'music',
  'video',
  'multi'
] as const

const EXEC_AGENTS = [
  'db',
  'rag',
  'code',
  'crawler',
  'gui',
  'admin',
  'clean',
  'visualize',
  'report',
  'multimodal',
  'music',
  'video'
] as const

const ClauseSchema = z.object({
  id: z.string().max(16).optional(),
  text: z.string().min(4).max(480),
  layer: z.enum(['data', 'process', 'output', 'action']).optional(),
  agents: z.array(z.enum(EXEC_AGENTS)).max(4).optional()
})

export function assignClauseIds(clauses: z.infer<typeof ClauseSchema>[]): TaskClause[] {
  return clauses.map((c, i) => ({
    id: String(c.id || `c${i + 1}`).trim(),
    text: String(c.text).trim(),
    layer: c.layer,
    agents: c.agents ?? []
  }))
}

const CodeModeSchema = z.enum(['auto', 'compute', 'inspect', 'edit', 'script'])

const BlueprintStepSchema = z.object({
  agent: z.enum(EXEC_AGENTS),
  queryFocus: z.string().min(4).max(320),
  clauseIds: z.array(z.string()).max(4).optional(),
  dependsOnAgents: z.array(z.enum(EXEC_AGENTS)).max(6).optional(),
  parallelGroup: z.string().max(24).optional(),
  codeMode: CodeModeSchema.optional()
})

export const TaskOrchestratorSchema = z.object({
  turnScopeMode: z.enum(['current_only', 'continuation', 'topic_shift', 'chitchat']).default('current_only'),
  directChitchatSynth: z.boolean().default(false),
  coalescedTask: z.string().max(900).optional(),
  clauses: z.array(ClauseSchema).min(1).max(8),
  timeHints: z.array(z.string()).max(8).default([]),
  subjectHints: z.array(z.string()).max(4).default([]),
  fieldHints: z.array(z.string()).max(6).default([]),
  wantsVisualize: z.boolean().default(false),
  wantsReport: z.boolean().default(false),
  dataSources: z.array(z.enum(['rag', 'db', 'crawler'])).max(3).default([]),
  /** 任务形态：structured_query→db；document_retrieval→rag；hybrid→双源 */
  taskIntent: z
    .enum(['structured_query', 'document_retrieval', 'hybrid', 'action', 'chitchat', 'unknown'])
    .default('unknown'),
  primaryIntent: z.enum(ROUTE_INTENTS).default('multi'),
  isMulti: z.boolean().default(true),
  suggestedAgents: z.array(z.enum(EXEC_AGENTS)).max(8).default([]),
  isDbAnchored: z.boolean().default(false),
  needsAdmin: z.boolean().default(false),
  needsWeb: z.boolean().default(false),
  explicitWantsReport: z.boolean().default(false),
  explicitWantsVisualize: z.boolean().default(false),
  planShortcut: z.enum(PLAN_SHORTCUT_KINDS).default('none'),
  requiresAgentPipeline: z.boolean().default(false),
  allowChatWebDirect: z.boolean().default(true),
  intent: z.enum(ROUTE_INTENTS).default('multi'),
  allowedAgents: z.array(z.enum(EXEC_AGENTS)).max(10).default([]),
  routedQuery: z.string().min(4).max(1200),
  needsWebSearch: z.boolean().default(false),
  needsClarify: z.boolean().default(false),
  clarifyKind: z.enum(['none', 'slot', 'plane', 'output_disambiguation']).default('none'),
  clarifyQuestions: z.array(z.string()).max(4).optional(),
  planBlueprint: z
    .object({
      rationale: z.string().max(520).default(''),
      parallelNotes: z.string().max(400).optional(),
      steps: z.array(BlueprintStepSchema).min(1).max(12),
      confidence: z.number().min(0).max(1).default(0.6)
    })
    .optional(),
  confidence: z.number().min(0).max(1).default(0.65),
  rationale: z.string().max(520).default(''),
  codeMode: CodeModeSchema.optional(),
  /** B1 自动升档：并入同一次编排 JSON，禁止再开独立贵模型 */
  complexity: z.enum(['low', 'mid', 'high']).default('low'),
  needsPlanPreview: z.boolean().default(false),
  suggestedPosture: z.enum(['ask', 'plan', 'agent', 'debug']).default('agent'),
  upgradeReason: z.string().max(200).default(''),
  upgradeConfidence: z.number().min(0).max(1).default(0.65)
})

export type TaskOrchestratorRaw = z.infer<typeof TaskOrchestratorSchema>

export type TaskOrchestratorBundle = {
  raw: TaskOrchestratorRaw
  turnScopeMode: TurnScopeLlmMode
  clauses: TaskClause[]
  constraints: TaskConstraints
  intentClassify: IntentClassifyResult
  intent: string
  allowedAgents: ExecutableAgent[]
  routedQuery: string
  planBlueprint: PlanBlueprint | null
  needsWebSearch: boolean
  needsClarify: boolean
  clarifyKind: 'none' | 'slot' | 'plane' | 'output_disambiguation'
  clarifyQuestions: string[]
  directChitchatSynth: boolean
  coalescedTask?: string
  /** userIntentAlign 或 PU-Stack 对齐后写入，供 invariants / metaPatch 材料化 scope */
  stepDispatchDraft?: import('../../core/proPuStack').StepDispatchDraft[]
}

const COMPACT_ORCHESTRATOR_SCHEMA = z.object({
  turnScopeMode: z.enum(['current_only', 'continuation', 'topic_shift', 'chitchat']).default('current_only'),
  dataSources: z.array(z.enum(['rag', 'db', 'crawler'])).max(3).default([]),
  suggestedAgents: z.array(z.enum(EXEC_AGENTS)).max(8).default([]),
  allowedAgents: z.array(z.enum(EXEC_AGENTS)).max(10).default([]),
  isDbAnchored: z.boolean().default(false),
  needsWeb: z.boolean().default(false),
  needsAdmin: z.boolean().default(false),
  explicitWantsVisualize: z.boolean().default(false),
  explicitWantsReport: z.boolean().default(false),
  isMulti: z.boolean().default(true),
  planShortcut: z.enum(PLAN_SHORTCUT_KINDS).default('none'),
  requiresAgentPipeline: z.boolean().default(false),
  allowChatWebDirect: z.boolean().default(true),
  routedQuery: z.string().min(2).max(1200),
  confidence: z.number().min(0).max(1).default(0.62),
  rationale: z.string().max(520).default(''),
  complexity: z.enum(['low', 'mid', 'high']).default('low'),
  needsPlanPreview: z.boolean().default(false),
  suggestedPosture: z.enum(['ask', 'plan', 'agent', 'debug']).default('agent'),
  upgradeReason: z.string().max(200).default(''),
  upgradeConfidence: z.number().min(0).max(1).default(0.62)
})

export type OrchestratorParseFailure = {
  stage: 'full' | 'compact'
  reason: string
}

export { COMPACT_ORCHESTRATOR_SCHEMA, ROUTE_INTENTS, EXEC_AGENTS, ClauseSchema, BlueprintStepSchema }
