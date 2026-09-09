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
import { coerceTaskForm, coerceTimeRangeHint, TaskFormFieldSchema } from '../../core/routing/taskForms'
import {
  ADMIN_CAPABILITY_HINTS,
  SOURCE_COMMITMENT_KINDS,
  WEB_FETCH_KINDS
} from '../../orchestrate/sourceCommitment'

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
  agents: z.array(z.enum(EXEC_AGENTS)).max(4).optional(),
  /** 任务级形态：仅约束职责形状，禁止据此改 allowedAgents；勿填 taskIntent 值（如 hybrid） */
  taskForm: TaskFormFieldSchema
})

export function assignClauseIds(clauses: z.infer<typeof ClauseSchema>[]): TaskClause[] {
  return clauses.map((c, i) => {
    const taskForm = coerceTaskForm(c.taskForm)
    return {
      id: String(c.id || `c${i + 1}`).trim(),
      text: String(c.text).trim(),
      layer: c.layer,
      agents: c.agents ?? [],
      ...(taskForm ? { taskForm } : {})
    }
  })
}

const CodeModeSchema = z.enum(['auto', 'compute', 'inspect', 'edit', 'script'])

const TimeRangeSchema = z
  .object({
    start: z.string().max(40).optional(),
    end: z.string().max(40).optional(),
    label: z.string().max(80).optional()
  })
  .optional()

const BlueprintStepSchema = z.object({
  agent: z.enum(EXEC_AGENTS),
  queryFocus: z.string().min(4).max(320),
  clauseIds: z.array(z.string()).max(4).optional(),
  dependsOnAgents: z.array(z.enum(EXEC_AGENTS)).max(6).optional(),
  parallelGroup: z.string().max(24).optional(),
  codeMode: CodeModeSchema.optional(),
  taskForm: TaskFormFieldSchema
})

export const TaskOrchestratorSchema = z.object({
  turnScopeMode: z.enum(['current_only', 'continuation', 'topic_shift', 'chitchat']).default('current_only'),
  directChitchatSynth: z.boolean().default(false),
  coalescedTask: z.string().max(900).optional(),
  clauses: z.array(ClauseSchema).min(1).max(8),
  timeHints: z.array(z.string()).max(8).default([]),
  /** ISO 区间优先；与 timeHints 并存，子 Agent 落地 */
  timeRange: TimeRangeSchema,
  subjectHints: z.array(z.string()).max(4).default([]),
  fieldHints: z.array(z.string()).max(6).default([]),
  /** 顶层任务形态（可选；子句/步级优先）；≠ taskIntent */
  taskForm: TaskFormFieldSchema,
  wantsVisualize: z.boolean().default(false),
  wantsReport: z.boolean().default(false),
  dataSources: z.array(z.enum(['rag', 'db', 'crawler'])).max(3).default([]),
  /** 任务形态：structured_query→db；document_retrieval→rag；hybrid→双源 */
  taskIntent: z
    .enum(['structured_query', 'document_retrieval', 'hybrid', 'action', 'chitchat', 'unknown'])
    .default('unknown'),
  /**
   * 意图清晰度（语义推断，非字面「查数据库」）：
   * clear=锁定 committedPlanes；ambiguous=须 clarify；none=可按 taskIntent+catalog 推断。
   */
  sourceCommitment: z.enum(SOURCE_COMMITMENT_KINDS).default('none'),
  /** clear 时必填：语义锁定的能力面（可隐晦） */
  committedPlanes: z.array(z.enum(EXEC_AGENTS)).max(8).default([]),
  /** 公网抓取形态；≠none 表示清晰要网页/联网（含「联网搜天气」） */
  webFetchKind: z.enum(WEB_FETCH_KINDS).default('none'),
  /** Admin 结构化能力提示（能力卡语义，非用户原话 regex） */
  adminCapabilityHints: z.array(z.enum(ADMIN_CAPABILITY_HINTS)).max(4).default([]),
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
  upgradeConfidence: z.number().min(0).max(1).default(0.65),
  /** solo=单专才；parallel=取数 fan-out；hub=有依赖 DAG（默认） */
  executionTopology: z.enum(['solo', 'parallel', 'hub']).optional(),
  /** Phase4 cascade：显式 false 且 MANAGER_ROUTE_CASCADE=1 时可跳过 align/plane */
  selfCheck: z
    .object({
      needsSecondPass: z.boolean().optional(),
      reason: z.string().max(200).optional()
    })
    .optional()
})

export type TaskOrchestratorRaw = z.infer<typeof TaskOrchestratorSchema>

/** 从 raw 提取可观察槽位（写入 meta；不改 cap） */
export function extractOrchestratorSlotHints(raw: TaskOrchestratorRaw | Record<string, unknown> | null | undefined): {
  taskForm?: string
  timeRange?: { start?: string; end?: string; label?: string }
} {
  if (!raw || typeof raw !== 'object') return {}
  const taskForm = coerceTaskForm((raw as { taskForm?: unknown }).taskForm)
  const timeRange = coerceTimeRangeHint((raw as { timeRange?: unknown }).timeRange)
  return {
    ...(taskForm ? { taskForm } : {}),
    ...(timeRange ? { timeRange } : {})
  }
}

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
  upgradeConfidence: z.number().min(0).max(1).default(0.62),
  executionTopology: z.enum(['solo', 'parallel', 'hub']).optional(),
  selfCheck: z
    .object({
      needsSecondPass: z.boolean().optional(),
      reason: z.string().max(200).optional()
    })
    .optional()
})

export type OrchestratorParseFailure = {
  stage: 'full' | 'compact'
  reason: string
}

export { COMPACT_ORCHESTRATOR_SCHEMA, ROUTE_INTENTS, EXEC_AGENTS, ClauseSchema, BlueprintStepSchema }
