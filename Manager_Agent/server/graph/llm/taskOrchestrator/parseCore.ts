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
import {
  TaskOrchestratorSchema,
  type TaskOrchestratorRaw,
  type TaskOrchestratorBundle,
  type OrchestratorParseFailure,
  COMPACT_ORCHESTRATOR_SCHEMA,
  ROUTE_INTENTS,
  EXEC_AGENTS,
  ClauseSchema,
  assignClauseIds,
  coerceTaskIntent
} from './schemas'
import { coerceTimeRangeHint } from '../../core/routing/taskForms'
import { coerceExecutionTopology } from '../../core/plan/executionTopology'

function filterExecAgents(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((a) => String(a ?? '').trim()).filter((a) => (EXEC_AGENTS as readonly string[]).includes(a))
}

function boundedStringSlice(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const s = String(item ?? '').trim()
    if (!s) continue
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

function boundedAgentSlice(raw: unknown, max: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const a of filterExecAgents(raw)) {
    if (seen.has(a)) continue
    seen.add(a)
    out.push(a)
    if (out.length >= max) break
  }
  return out
}

/** LLM 常输出超长数组（如五年 timeHints、单 clause 堆满 agents）；裁到 schema 上限，避免整包 safeParse 失败 */
function enforceOrchestratorSchemaBounds(o: Record<string, unknown>): void {
  o.timeHints = boundedStringSlice(o.timeHints, 8)
  o.subjectHints = boundedStringSlice(o.subjectHints, 4)
  o.fieldHints = boundedStringSlice(o.fieldHints, 6)
  o.dataSources = boundedStringSlice(o.dataSources, 3)
  o.suggestedAgents = boundedAgentSlice(o.suggestedAgents, 8)
  o.allowedAgents = boundedAgentSlice(o.allowedAgents, 10)
  if (Array.isArray(o.clarifyQuestions)) {
    o.clarifyQuestions = boundedStringSlice(o.clarifyQuestions, 4)
  }
  if (Array.isArray(o.clauses)) {
    o.clauses = (o.clauses as Record<string, unknown>[]).slice(0, 8).map((c) => ({
      ...c,
      agents: boundedAgentSlice(c.agents, 4)
    }))
  }
  if (o.planBlueprint && typeof o.planBlueprint === 'object') {
    const bp = o.planBlueprint as Record<string, unknown>
    if (Array.isArray(bp.steps)) {
      bp.steps = (bp.steps as Record<string, unknown>[]).slice(0, 12).map((s) => ({
        ...s,
        clauseIds: Array.isArray(s.clauseIds) ? s.clauseIds.map(String).slice(0, 4) : s.clauseIds,
        dependsOnAgents: boundedAgentSlice(s.dependsOnAgents, 6)
      }))
    }
  }
}

function coerceRouteIntent(v: unknown, fallback = 'multi'): (typeof ROUTE_INTENTS)[number] {
  const x = String(v ?? '').trim()
  if ((ROUTE_INTENTS as readonly string[]).includes(x)) return x as (typeof ROUTE_INTENTS)[number]
  return fallback as (typeof ROUTE_INTENTS)[number]
}

export function syncOrchestratorFlagsFromCap(
  allowed: string[],
  flags: { wantsVisualize?: boolean; wantsReport?: boolean; explicitWantsVisualize?: boolean; explicitWantsReport?: boolean }
) {
  const hasViz = allowed.includes('visualize')
  const hasRep = allowed.includes('report')
  const hasCode = allowed.includes('code')
  return {
    wantsVisualize: Boolean(flags.wantsVisualize || flags.explicitWantsVisualize || hasViz),
    wantsReport: Boolean(flags.wantsReport || flags.explicitWantsReport || hasRep),
    explicitWantsVisualize: Boolean(flags.explicitWantsVisualize || hasViz),
    explicitWantsReport: Boolean(flags.explicitWantsReport || hasRep),
    needsCodeInCap: hasCode || hasViz || hasRep
  }
}

function expandCompactToFull(compact: z.infer<typeof COMPACT_ORCHESTRATOR_SCHEMA>, lastUser: string): TaskOrchestratorRaw {
  const last = String(lastUser || '').trim()
  const agents = filterExecAgents(compact.allowedAgents?.length ? compact.allowedAgents : compact.suggestedAgents)
  const dsAgents = defaultAgentsFromDataSources(compact.dataSources || [])
  let allowed = (agents.length ? agents : dsAgents) as TaskOrchestratorRaw['allowedAgents']
  if (allowed.includes('visualize') || allowed.includes('report')) {
    allowed = ensureCodeInPipelineAgents([...allowed]) as TaskOrchestratorRaw['allowedAgents']
  }
  const sources = (compact.dataSources || []).filter((d) => d !== 'db' || compact.isDbAnchored)
  const intent = compact.isMulti || allowed.length >= 2 ? 'multi' : coerceRouteIntent(allowed[0], 'multi')
  const synced = syncOrchestratorFlagsFromCap(allowed, compact)
  const wantsViz = synced.wantsVisualize
  const wantsRep = synced.wantsReport
  const pipeline =
    compact.requiresAgentPipeline ||
    sources.length >= 2 ||
    wantsViz ||
    wantsRep ||
    (compact.needsWeb && sources.includes('rag'))
  const clauses: TaskOrchestratorRaw['clauses'] = [
    {
      id: 'c1',
      text: last.slice(0, 480),
      agents: allowed.filter((a) =>
        ['rag', 'db', 'crawler', 'admin', 'code', 'visualize', 'report'].includes(a)
      ) as TaskOrchestratorRaw['suggestedAgents']
    }
  ]
  const constraints = constraintsFromMerged({
    timeHints: [],
    subjectHints: [],
    fieldHints: [],
    wantsVisualize: wantsViz,
    wantsReport: wantsRep
  })
  const topologyBlueprint = buildTopologyBlueprintFromCap({
    allowedAgents: allowed,
    clauses: assignClauseIds(clauses),
    constraints,
    userTask: last
  })
  return {
    turnScopeMode: compact.turnScopeMode,
    directChitchatSynth: compact.turnScopeMode === 'chitchat',
    coalescedTask: last.slice(0, 900),
    clauses,
    timeHints: [],
    subjectHints: [],
    fieldHints: [],
    wantsVisualize: wantsViz,
    wantsReport: wantsRep,
    dataSources: sources,
    primaryIntent: intent,
    isMulti: compact.isMulti,
    suggestedAgents: allowed,
    isDbAnchored: compact.isDbAnchored,
    needsAdmin: compact.needsAdmin,
    needsWeb: compact.needsWeb,
    explicitWantsReport: synced.explicitWantsReport,
    explicitWantsVisualize: synced.explicitWantsVisualize,
    planShortcut: compact.planShortcut,
    requiresAgentPipeline: pipeline,
    allowChatWebDirect: pipeline ? false : compact.allowChatWebDirect,
    intent,
    allowedAgents: allowed,
    routedQuery: String(compact.routedQuery || last).slice(0, 1200),
    needsWebSearch: compact.needsWeb,
    needsClarify: false,
    confidence: compact.confidence,
    rationale: compact.rationale || '紧凑编排',
    planBlueprint: topologyBlueprint ?? undefined,
    complexity: compact.complexity ?? 'low',
    needsPlanPreview: compact.needsPlanPreview === true,
    suggestedPosture: compact.suggestedPosture ?? 'agent',
    upgradeReason: String(compact.upgradeReason || '').slice(0, 200),
    upgradeConfidence:
      typeof compact.upgradeConfidence === 'number' ? compact.upgradeConfidence : compact.confidence
  }
}

function stripThinkingBlocks(text: string): string {
  return String(text || '')
    .replace(/<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi, '')
    .trim()
}

/** 从 markdown 代码块或夹杂文本中提取 JSON 正文 */
function extractOrchestratorJsonText(text: string): string {
  let t = stripThinkingBlocks(String(text ?? '').trim())
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]?.trim()) return fence[1].trim()
  const firstBrace = t.indexOf('{')
  const lastBrace = t.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) return t.slice(firstBrace, lastBrace + 1)
  return t
}

function coerceTurnScopeMode(v: unknown): TaskOrchestratorRaw['turnScopeMode'] {
  const x = String(v ?? '').trim()
  const allowed = ['current_only', 'continuation', 'topic_shift', 'chitchat'] as const
  if ((allowed as readonly string[]).includes(x)) return x as TaskOrchestratorRaw['turnScopeMode']
  if (/shift|切换/.test(x)) return 'topic_shift'
  if (/chat|寒暄/.test(x)) return 'chitchat'
  if (/continue|续/.test(x)) return 'continuation'
  return 'current_only'
}

function normalizeCodeMode(raw: unknown): 'compute' | 'inspect' | 'edit' | 'script' | undefined {
  const k = String(raw ?? '').trim().toLowerCase()
  if (k === 'compute' || k === 'inspect' || k === 'edit' || k === 'script') return k
  return undefined
}

function sanitizePlanBlueprint(raw: unknown): TaskOrchestratorRaw['planBlueprint'] {
  if (!raw || typeof raw !== 'object') return undefined
  const bp = raw as Record<string, unknown>
  const steps = Array.isArray(bp.steps) ? bp.steps : []
  const validSteps = steps
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const step = s as Record<string, unknown>
      const agent = filterExecAgents([step.agent])[0]
      const qf = String(step.queryFocus ?? step.focus ?? step.query ?? step.scopedUserLanguage ?? '').trim()
      if (!agent || qf.length < 4) return null
      const depends = filterExecAgents(step.dependsOnAgents)
      const codeMode = agent === 'code' ? normalizeCodeMode(step.codeMode) : undefined
      return {
        agent,
        queryFocus: qf.slice(0, 320),
        clauseIds: Array.isArray(step.clauseIds) ? step.clauseIds.map(String).slice(0, 4) : undefined,
        dependsOnAgents: depends.length ? depends.slice(0, 6) : undefined,
        parallelGroup: step.parallelGroup ? String(step.parallelGroup).slice(0, 24) : undefined,
        ...(codeMode ? { codeMode } : {})
      }
    })
    .filter(Boolean)
    .slice(0, 12) as NonNullable<TaskOrchestratorRaw['planBlueprint']>['steps']
  if (!validSteps.length) return undefined
  const conf = typeof bp.confidence === 'number' ? Math.min(1, Math.max(0, bp.confidence)) : 0.6
  return {
    rationale: String(bp.rationale ?? '').slice(0, 520),
    parallelNotes: bp.parallelNotes ? String(bp.parallelNotes).slice(0, 400) : undefined,
    steps: validSteps,
    confidence: conf
  }
}

function defaultAgentsFromDataSources(sources: string[] | undefined | null): string[] {
  return (Array.isArray(sources) ? sources : []).filter((d) => ['rag', 'db', 'crawler'].includes(String(d)))
}

/**
 * LLM 常显式输出 null；Zod .optional()/.default() 不接受 null。
 * 将 null 视作缺省（undefined）；数组去 null 元；对象递归清洗。
 */
export function scrubOrchestratorNulls(value: unknown): unknown {
  if (value === null) return undefined
  if (Array.isArray(value)) {
    return value
      .map((x) => scrubOrchestratorNulls(x))
      .filter((x) => x !== undefined && x !== null)
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = scrubOrchestratorNulls(v)
      if (next !== undefined) out[k] = next
    }
    return out
  }
  return value
}

function coerceOptionalString(v: unknown, max: number): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  if (!s || s === 'null' || s === 'undefined') return undefined
  return s.slice(0, max)
}

function collectOrchestratorAgentUnion(o: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  const optional = new Set(['admin', 'gui', 'multimodal', 'music', 'video'])
  for (const a of filterExecAgents(o.suggestedAgents)) out.add(a)
  for (const c of (Array.isArray(o.clauses) ? o.clauses : []) as Record<string, unknown>[]) {
    for (const a of filterExecAgents(c.agents)) out.add(a)
  }
  for (const a of filterExecAgents(o.allowedAgents)) {
    if (!optional.has(a)) out.add(a)
  }
  return out
}

function stripSpuriousOptionalOrchestratorAgents(o: Record<string, unknown>): void {
  const optional = new Set(['admin', 'gui', 'multimodal', 'music', 'video'])
  const explicit = new Set<string>()
  for (const a of filterExecAgents(o.suggestedAgents)) explicit.add(a)
  for (const c of (Array.isArray(o.clauses) ? o.clauses : []) as Record<string, unknown>[]) {
    for (const a of filterExecAgents(c.agents)) explicit.add(a)
  }
  const strip = (list: unknown) =>
    filterExecAgents(list).filter((a) => !optional.has(a) || explicit.has(a))
  o.suggestedAgents = strip(o.suggestedAgents)
  o.allowedAgents = strip(o.allowedAgents)
  if (!explicit.has('admin')) o.needsAdmin = false
}

const SINGLE_SOURCE_DATA_AGENTS = new Set(['db', 'rag'])
const SINGLE_SOURCE_BLOCKING_DOWNSTREAM = new Set([
  'code',
  'report',
  'visualize',
  'admin',
  'crawler',
  'gui',
  'multimodal',
  'music',
  'video'
])

/**
 * 单源同数据面 agent：把「基本信息 + 联系方式」这类过度拆分折叠为一步，
 * 并关闭假 isMulti / requiresAgentPipeline，恢复 db_only|rag_only。
 * @returns 是否发生了折叠/标志修正
 */
export function collapseSingleSourceSameAgentOrchestrator(
  o: Record<string, unknown>,
  lastUser = ''
): boolean {
  if (o.explicitWantsReport === true || o.wantsReport === true) return false
  if (o.explicitWantsVisualize === true || o.wantsVisualize === true) return false

  const allowed = filterExecAgents(o.allowedAgents)
  const suggested = filterExecAgents(o.suggestedAgents)
  const sources = Array.isArray(o.dataSources)
    ? (o.dataSources as unknown[]).map((d) => String(d)).filter((d) => SINGLE_SOURCE_DATA_AGENTS.has(d))
    : []
  const cap = [...new Set([...allowed, ...suggested])]
  const dataInCap = cap.filter((a) => SINGLE_SOURCE_DATA_AGENTS.has(a))
  const soleFromSources = sources.length === 1 ? sources[0]! : ''
  const sole = dataInCap.length === 1 ? dataInCap[0]! : soleFromSources
  if (!sole || !SINGLE_SOURCE_DATA_AGENTS.has(sole)) return false
  if (dataInCap.length > 1) return false
  if (cap.some((a) => SINGLE_SOURCE_BLOCKING_DOWNSTREAM.has(a))) return false

  const clauses = Array.isArray(o.clauses) ? (o.clauses as Record<string, unknown>[]) : []
  const clauseAgents = clauses.flatMap((c) => filterExecAgents(c.agents))
  if (clauseAgents.length && !clauseAgents.every((a) => a === sole)) return false

  const bp = o.planBlueprint as
    | { rationale?: string; confidence?: number; steps?: Array<{ agent?: string; queryFocus?: string }> }
    | undefined
  const steps = Array.isArray(bp?.steps) ? bp!.steps! : []
  if (steps.length >= 2 && !steps.every((s) => String(s.agent || '').trim() === sole)) return false

  const needsCollapse = clauses.length >= 2 || steps.length >= 2 || o.isMulti === true || o.requiresAgentPipeline === true
  if (!needsCollapse && String(o.planShortcut || '') === `${sole}_only`) return false

  const focus =
    String(o.coalescedTask || '').trim() ||
    String(o.routedQuery || '').trim() ||
    String(lastUser || '').trim() ||
    String(steps[0]?.queryFocus || clauses[0]?.text || '').trim()
  if (focus.length < 4) return false

  o.clauses = [{ id: 'c1', text: focus.slice(0, 480), agents: [sole] }]
  o.planBlueprint = {
    rationale: String(bp?.rationale || '单源同 agent 折叠为一步').slice(0, 520),
    steps: [{ agent: sole, queryFocus: focus.slice(0, 320), clauseIds: ['c1'] }],
    confidence: typeof bp?.confidence === 'number' ? Math.min(1, Math.max(0, bp.confidence)) : 0.85
  }
  o.isMulti = false
  o.requiresAgentPipeline = false
  o.allowChatWebDirect = true
  o.planShortcut = sole === 'db' ? 'db_only' : 'rag_only'
  o.intent = sole
  o.primaryIntent = sole
  o.allowedAgents = [sole]
  o.suggestedAgents = [sole]
  o.dataSources = [sole]
  o.complexity = 'low'
  return true
}

export function normalizeOrchestratorPayload(raw: unknown, lastUser: string): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const scrubbed = scrubOrchestratorNulls(raw)
  if (!scrubbed || typeof scrubbed !== 'object') return scrubbed
  const o = { ...(scrubbed as Record<string, unknown>) }
  const last = String(lastUser || '').trim()
  o.turnScopeMode = coerceTurnScopeMode(o.turnScopeMode)
  // 禁止把字面 "null" 当成 routedQuery
  {
    const rq = coerceOptionalString(o.routedQuery, 1200)
    o.routedQuery = rq && rq.length >= 4 ? rq : last.slice(0, 1200)
  }
  if (!Array.isArray(o.clauses) || !(o.clauses as unknown[]).length) {
    const dsAgents = defaultAgentsFromDataSources(o.dataSources as string[])
    const agents = filterExecAgents(o.suggestedAgents)
    const picked = agents.length ? agents : dsAgents
    o.clauses = [{ id: 'c1', text: last.slice(0, 480), agents: boundedAgentSlice(picked, 4) }]
  } else {
    o.clauses = (o.clauses as Record<string, unknown>[])
      .filter((c) => c && typeof c === 'object')
      .map((c, i) => {
        let text = coerceOptionalString(c.text, 480) || last.slice(0, 480)
        if (text.length < 4) text = last.slice(0, 480)
        const clauseAgents = filterExecAgents(c.agents)
        const dsAgents = defaultAgentsFromDataSources(o.dataSources as string[])
        const layer = coerceOptionalString(c.layer, 24)
        const taskForm = c.taskForm
        return {
          id: String(c.id || `c${i + 1}`),
          text,
          ...(layer && ['data', 'process', 'output', 'action'].includes(layer) ? { layer } : {}),
          agents: boundedAgentSlice(clauseAgents.length ? clauseAgents : dsAgents, 4),
          ...(taskForm != null ? { taskForm } : {})
        }
      })
  }
  o.primaryIntent = coerceRouteIntent(o.primaryIntent, coerceRouteIntent(o.intent, 'multi'))
  o.intent = coerceRouteIntent(o.intent, o.primaryIntent as string)
  if (!Array.isArray(o.suggestedAgents) || !(o.suggestedAgents as unknown[]).length) {
    const fromDs = defaultAgentsFromDataSources(o.dataSources as string[])
    o.suggestedAgents = filterExecAgents(o.allowedAgents).length
      ? filterExecAgents(o.allowedAgents)
      : fromDs
  } else {
    o.suggestedAgents = filterExecAgents(o.suggestedAgents)
  }
  if (!Array.isArray(o.allowedAgents) || !(o.allowedAgents as unknown[]).length) {
    o.allowedAgents = o.suggestedAgents
  } else {
    o.allowedAgents = filterExecAgents(o.allowedAgents)
  }
  o.dataSources = Array.isArray(o.dataSources)
    ? (o.dataSources as unknown[]).map((d) => String(d)).filter((d) => ['rag', 'db', 'crawler'].includes(d))
    : []
  o.isMulti = coerceBool(o.isMulti, (o.dataSources as string[]).length >= 2 || (o.suggestedAgents as string[]).length >= 2)
  o.isDbAnchored = coerceBool(o.isDbAnchored, false)
  o.needsAdmin = coerceBool(o.needsAdmin, false)
  o.needsWeb = coerceBool(o.needsWeb, (o.dataSources as string[]).includes('crawler'))
  o.explicitWantsReport = coerceBool(o.explicitWantsReport, false)
  o.explicitWantsVisualize = coerceBool(o.explicitWantsVisualize, false)
  o.wantsVisualize = coerceBool(o.wantsVisualize, o.explicitWantsVisualize as boolean)
  o.wantsReport = coerceBool(o.wantsReport, o.explicitWantsReport as boolean)
  o.directChitchatSynth = coerceBool(o.directChitchatSynth, o.turnScopeMode === 'chitchat')
  o.requiresAgentPipeline = coerceBool(
    o.requiresAgentPipeline,
    (o.dataSources as string[]).length >= 2 ||
      o.isMulti === true ||
      o.explicitWantsVisualize === true ||
      o.explicitWantsReport === true
  )
  o.allowChatWebDirect = coerceBool(o.allowChatWebDirect, !o.requiresAgentPipeline)
  o.needsWebSearch = coerceBool(o.needsWebSearch, o.needsWeb as boolean)
  o.needsClarify = coerceBool(o.needsClarify, false)
  const ck = String(o.clarifyKind ?? 'none').trim()
  o.clarifyKind = ['none', 'slot', 'plane', 'output_disambiguation'].includes(ck) ? ck : 'none'
  if (o.clarifyKind === 'output_disambiguation' || o.clarifyKind === 'none') {
    if (o.clarifyKind === 'output_disambiguation') o.needsClarify = false
  }
  if (o.clarifyKind === 'slot' || o.clarifyKind === 'plane') {
    o.needsClarify = coerceBool(o.needsClarify, true)
  }
  // 意图清晰度（缺省 none；ambiguous 强制 plane clarify）
  {
    const sc = String(o.sourceCommitment ?? 'none').trim().toLowerCase()
    o.sourceCommitment = ['clear', 'ambiguous', 'none'].includes(sc) ? sc : 'none'
    o.committedPlanes = Array.isArray(o.committedPlanes)
      ? [
          ...new Set(
            (o.committedPlanes as unknown[])
              .map((x) => String(x || '').trim())
              .filter((a) =>
                [
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
                ].includes(a)
              )
          )
        ]
      : []
    const wf = String(o.webFetchKind ?? 'none').trim().toLowerCase()
    o.webFetchKind = ['none', 'policy_page', 'general_page'].includes(wf) ? wf : 'none'
    o.adminCapabilityHints = Array.isArray(o.adminCapabilityHints)
      ? [
          ...new Set(
            (o.adminCapabilityHints as unknown[])
              .map((x) => String(x || '').trim().toLowerCase())
              .filter((x) =>
                ['weather', 'calendar', 'map', 'briefing', 'mail', 'files', 'other'].includes(x)
              )
          )
        ]
      : []
    if (o.sourceCommitment === 'ambiguous') {
      o.needsClarify = true
      if (o.clarifyKind === 'none' || o.clarifyKind === 'output_disambiguation') o.clarifyKind = 'plane'
      if (!Array.isArray(o.clarifyQuestions) || !(o.clarifyQuestions as unknown[]).length) {
        o.clarifyQuestions = ['请问您要查业务库记录、内部文档，还是联网公开网页？']
      }
    }
    if (o.webFetchKind !== 'none') {
      o.needsWeb = true
      o.needsWebSearch = true
      if (!(o.committedPlanes as string[]).includes('crawler') && o.sourceCommitment === 'clear') {
        o.committedPlanes = [...new Set([...(o.committedPlanes as string[]), 'crawler'])]
      }
    }
  }
  o.planShortcut = coercePlanShortcut(o.planShortcut, {
    dataSources: o.dataSources as string[],
    isMulti: o.isMulti as boolean,
    needsWeb: o.needsWeb as boolean,
    explicitWantsVisualize: o.explicitWantsVisualize as boolean,
    explicitWantsReport: o.explicitWantsReport as boolean,
    suggestedAgents: o.suggestedAgents as string[]
  })
  const topCodeMode = String(o.codeMode ?? '').trim().toLowerCase()
  if (topCodeMode === 'auto') o.codeMode = 'auto'
  else {
    const cm = normalizeCodeMode(o.codeMode)
    if (cm) o.codeMode = cm
    else delete o.codeMode
  }
  // timeRange / planBlueprint：null 或缺合法结构 → 删除，避免 Zod Expected object, received null
  {
    const tr = coerceTimeRangeHint(o.timeRange)
    if (tr) o.timeRange = tr
    else delete o.timeRange
  }
  if (o.planBlueprint !== undefined) {
    const bp = sanitizePlanBlueprint(o.planBlueprint)
    if (bp) o.planBlueprint = bp
    else delete o.planBlueprint
  }
  o.rationale = coerceOptionalString(o.rationale, 520) ?? ''
  o.coalescedTask = coerceOptionalString(o.coalescedTask, 900)
  if (!o.coalescedTask) delete o.coalescedTask
  if (Array.isArray(o.clarifyQuestions)) {
    o.clarifyQuestions = (o.clarifyQuestions as unknown[])
      .map((q) => coerceOptionalString(q, 200))
      .filter(Boolean)
      .slice(0, 4)
  } else {
    delete o.clarifyQuestions
  }
  if (Array.isArray(o.timeHints)) {
    o.timeHints = (o.timeHints as unknown[])
      .map((t) => coerceOptionalString(t, 80))
      .filter(Boolean)
      .slice(0, 8)
  } else {
    o.timeHints = []
  }
  if (Array.isArray(o.subjectHints)) {
    o.subjectHints = (o.subjectHints as unknown[])
      .map((t) => coerceOptionalString(t, 80))
      .filter(Boolean)
      .slice(0, 4)
  } else {
    o.subjectHints = []
  }
  if (Array.isArray(o.fieldHints)) {
    o.fieldHints = (o.fieldHints as unknown[])
      .map((t) => coerceOptionalString(t, 80))
      .filter(Boolean)
      .slice(0, 6)
  } else {
    o.fieldHints = []
  }
  const agentUnion = collectOrchestratorAgentUnion(o)
  if (agentUnion.has('db')) o.isDbAnchored = true
  if (agentUnion.has('admin')) o.needsAdmin = true
  if (o.isDbAnchored !== true) {
    o.isDbAnchored = false
    o.dataSources = (o.dataSources as string[]).filter((d) => d !== 'db')
    o.suggestedAgents = (o.suggestedAgents as string[]).filter((a) => a !== 'db')
    o.allowedAgents = (o.allowedAgents as string[]).filter((a) => a !== 'db')
  }
  if (!agentUnion.has('admin') && o.needsAdmin !== true) {
    o.needsAdmin = false
    o.suggestedAgents = (o.suggestedAgents as string[]).filter((a) => a !== 'admin')
    o.allowedAgents = (o.allowedAgents as string[]).filter((a) => a !== 'admin')
  }
  if ((o.allowedAgents as string[]).length === 0 && (o.suggestedAgents as string[]).length > 0) {
    o.allowedAgents = o.suggestedAgents
  }
  if ((o.suggestedAgents as string[]).length === 0 && agentUnion.size > 0) {
    o.suggestedAgents = [...agentUnion]
    o.allowedAgents = [...agentUnion]
  } else if (agentUnion.size > 0) {
    o.suggestedAgents = [...new Set([...(o.suggestedAgents as string[]), ...agentUnion])]
    o.allowedAgents = [...new Set([...(o.allowedAgents as string[]), ...agentUnion])]
  }
  if (typeof o.confidence !== 'number') {
    const n = Number(o.confidence)
    o.confidence = Number.isFinite(n) ? Math.min(1, Math.max(0.35, n)) : 0.65
  } else if (Number(o.confidence) < 0.35) {
    o.confidence = 0.65
  }
  const cx = String(o.complexity ?? 'low').trim().toLowerCase()
  o.complexity = ['low', 'mid', 'high'].includes(cx) ? cx : 'low'
  o.needsPlanPreview = coerceBool(o.needsPlanPreview, false)
  const sp = String(o.suggestedPosture ?? 'agent').trim().toLowerCase()
  o.suggestedPosture = ['ask', 'plan', 'agent', 'debug'].includes(sp) ? sp : 'agent'
  o.taskIntent = coerceTaskIntent(o.taskIntent)
  {
    const topo = coerceExecutionTopology(o.executionTopology)
    if (topo) o.executionTopology = topo
    else delete o.executionTopology
  }
  o.upgradeReason = coerceOptionalString(o.upgradeReason ?? o.reason, 200) ?? ''
  if (typeof o.upgradeConfidence !== 'number') {
    const uc = Number(o.upgradeConfidence)
    o.upgradeConfidence = Number.isFinite(uc)
      ? Math.min(1, Math.max(0, uc))
      : Number(o.confidence)
  } else {
    o.upgradeConfidence = Math.min(1, Math.max(0, Number(o.upgradeConfidence)))
  }
  stripSpuriousOptionalOrchestratorAgents(o)
  collapseSingleSourceSameAgentOrchestrator(o, last)
  enforceOrchestratorSchemaBounds(o)
  return o
}

export function parseOrchestratorJson(text: string, lastUser: string): { raw: TaskOrchestratorRaw | null; error?: string } {
  const cleaned = extractOrchestratorJsonText(text)
  let raw = safeJsonParse(cleaned)
  if (!raw) raw = parseFirstBalancedJsonObject(cleaned)
  if (!raw) return { raw: null, error: 'JSON 解析失败' }
  const normalized = normalizeOrchestratorPayload(raw, lastUser)
  const parsed = TaskOrchestratorSchema.safeParse(normalized)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ')
    return { raw: null, error: detail || 'schema 校验失败' }
  }
  return { raw: parsed.data }
}

export function parseCompactOrchestratorJson(text: string, lastUser: string): { raw: TaskOrchestratorRaw | null; error?: string } {
  const cleaned = extractOrchestratorJsonText(text)
  let obj = safeJsonParse(cleaned)
  if (!obj) obj = parseFirstBalancedJsonObject(cleaned)
  if (!obj || typeof obj !== 'object') return { raw: null, error: '紧凑 JSON 解析失败' }
  const o = { ...(obj as Record<string, unknown>) }
  if (!String(o.routedQuery ?? '').trim()) o.routedQuery = lastUser.slice(0, 1200)
  o.suggestedAgents = filterExecAgents(o.suggestedAgents)
  o.allowedAgents = filterExecAgents(o.allowedAgents)
  if (o.isDbAnchored !== true) {
    o.isDbAnchored = false
    o.dataSources = (Array.isArray(o.dataSources) ? o.dataSources : []).filter((d) => d !== 'db')
    o.suggestedAgents = (o.suggestedAgents as string[]).filter((a) => a !== 'db')
    o.allowedAgents = (o.allowedAgents as string[]).filter((a) => a !== 'db')
  }
  const parsed = COMPACT_ORCHESTRATOR_SCHEMA.safeParse(o)
  if (!parsed.success) {
    return { raw: null, error: parsed.error.issues.slice(0, 2).map((i) => i.message).join('; ') }
  }
  return { raw: expandCompactToFull(parsed.data, lastUser) }
}

/** 意图识别回退 → 编排 bundle */
