import type { Step } from '../../../utils/shared/taskPlan'
import type { TaskConstraints } from '../plan'
import type { PipelineHints } from '../../llm/pipelineHintsLlm'
import { appendSerpContextToQuery } from '../../../utils/search/managerWebSearch'
import { adminScopedQueryFromMeta } from '../../../utils/admin/managerAdminTaskPayload'
import { resolveDbPrefetchQuestionFromState } from '../db/dbStepQuestion'
import { buildOutputFollowupNarrowHistory } from '../output/outputFollowupHistory'

/** 路由 allowedAgents 与计划步骤的 canonical 流水线顺序 */
export const PIPELINE_AGENT_ORDER: Step['agent'][] = [
  'rag',
  'db',
  'crawler',
  'multimodal',
  'music',
  'video',
  'clean',
  'code',
  'admin',
  'visualize',
  'report'
]

export function sortAgentsByPipelineOrder(agents: Iterable<Step['agent']>): Step['agent'][] {
  const rank = new Map(PIPELINE_AGENT_ORDER.map((a, i) => [a, i]))
  return [...new Set(agents)].sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999))
}

export type TaskClauseLayer = 'data' | 'process' | 'output' | 'action'

export type TaskClause = {
  id: string
  text: string
  /** 仅当 decompose 节点由 LLM 产出时填充；不用正则推断 */
  agents: Step['agent'][]
  /** decompose LLM 可选语义层：取数 / 加工 / 输出 / 动作 */
  layer?: TaskClauseLayer
  /** 任务级形态（可选）：仅约束职责形状，不改 cap */
  taskForm?: string
  relevance?: Partial<Record<Step['agent'], number>>
}

export type PipelinePlanOpts = {
  question?: string
  constraints?: TaskConstraints | null
  pipelineHints?: PipelineHints | null
}

const ALL_STEP_AGENTS = [
  'db',
  'rag',
  'code',
  'crawler',
  'gui',
  'admin',
  'visualize',
  'report',
  'clean',
  'multimodal',
  'music',
  'video'
] as const satisfies readonly Step['agent'][]

const DATA_SOURCE_AGENTS = new Set<Step['agent']>(['rag', 'db', 'crawler'])
const PIPELINE_OUTPUT_AGENTS = new Set<Step['agent']>(['visualize', 'report'])

/** P0-1：默认关闭「多步必插 clean/code」；设 1 恢复旧行为 */
export function isPipelineAutoCleanEnabled(): boolean {
  return String(process.env.MANAGER_PIPELINE_AUTO_CLEAN ?? '0').trim() === '1'
}

export function isPipelineAutoCodeEnabled(): boolean {
  return String(process.env.MANAGER_PIPELINE_AUTO_CODE ?? '0').trim() === '1'
}

function countDataSources(agents: Iterable<Step['agent']>): number {
  let n = 0
  for (const a of agents) if (DATA_SOURCE_AGENTS.has(a)) n++
  return n
}

function hintsWantClean(hints?: PipelineHints | null): boolean {
  return Boolean(hints?.needsClean)
}

function hintsWantCode(hints?: PipelineHints | null): boolean {
  return Boolean(hints?.needsCode)
}

/**
 * 是否需要 clean：统一 db/rag/crawler 上游供 code 消费。
 * 硬规则：有 code 且有取数面 → 必须 clean；多源 + 下游、或显式 pipeline 提示同理。
 */
export function needsCleanProcessing(plan: Step[], opts?: PipelinePlanOpts): boolean {
  const agents = new Set(plan.map((s) => s.agent))
  if (![...DATA_SOURCE_AGENTS].some((a) => agents.has(a))) return false
  if (agents.has('clean')) return false

  const dataFanIn = countDataSources(agents)
  const hasOutput = [...PIPELINE_OUTPUT_AGENTS].some((a) => agents.has(a))

  // 硬规则：code 消费清洗后数据，单源也须 clean
  if (agents.has('code')) return true
  if (hasOutput && dataFanIn >= 2) return true
  if (hintsWantClean(opts?.pipelineHints)) return true

  if (isPipelineAutoCleanEnabled()) {
    const hasDownstream =
      agents.has('code') || hasOutput || agents.has('admin') || agents.has('clean') || plan.length >= 2
    if (dataFanIn >= 1 && hasDownstream) return true
  }

  return false
}

/** 是否需要 code：visualize/report 硬依赖；模型启发 + legacy 开关 */
export function needsCodeProcessing(plan: Step[], opts?: PipelinePlanOpts): boolean {
  const agents = new Set(plan.map((s) => s.agent))
  if (agents.has('code')) return false
  const hasData = [...DATA_SOURCE_AGENTS].some((a) => agents.has(a))
  if (!hasData) return false

  if (agents.has('visualize') || agents.has('report')) return true
  if (opts?.constraints?.wantsVisualize || opts?.constraints?.wantsReport) return true
  if (hintsWantCode(opts?.pipelineHints)) return true

  if (isPipelineAutoCodeEnabled()) {
    const hasOutput = [...PIPELINE_OUTPUT_AGENTS].some((a) => agents.has(a))
    if (hasOutput) return true
  }

  return false
}

export function shouldRetainCodeStep(plan: Step[], opts?: PipelinePlanOpts): boolean {
  if (!plan.some((s) => s.agent === 'code')) return false
  const agents = new Set(plan.map((s) => s.agent))
  if (agents.has('visualize') || agents.has('report')) return true
  if (opts?.constraints?.wantsVisualize || opts?.constraints?.wantsReport) return true
  if (hintsWantCode(opts?.pipelineHints)) return true
  if (
    isPipelineAutoCodeEnabled() &&
    [...DATA_SOURCE_AGENTS].some((a) => agents.has(a)) &&
    [...PIPELINE_OUTPUT_AGENTS].some((a) => agents.has(a))
  ) {
    return true
  }
  return false
}

export function shouldRetainCleanStep(plan: Step[], opts?: PipelinePlanOpts): boolean {
  if (!plan.some((s) => s.agent === 'clean')) return false
  const agents = new Set(plan.map((s) => s.agent))
  if (agents.has('code') && [...DATA_SOURCE_AGENTS].some((a) => agents.has(a))) return true
  if (countDataSources(agents) >= 2) return true
  if (hintsWantClean(opts?.pipelineHints)) return true
  return needsCleanProcessing(
    plan.filter((s) => s.agent !== 'clean'),
    opts
  )
}

/**
 * 路由 allowedAgents 与子句 agent 并集后排序；visualize/report 硬依赖 code，有 code+取数须 clean。
 */
export function reconcileRouteAllowedAgents(
  llmAllowed: Step['agent'][],
  clauses: TaskClause[],
  opts?: { standaloneMedia?: 'music' | 'video' | 'multimodal' | null }
): Step['agent'][] {
  if (opts?.standaloneMedia) return [opts.standaloneMedia]
  const merged = new Set<Step['agent']>(llmAllowed)
  for (const a of agentsFromClauses(clauses)) merged.add(a)
  const mediaOnly =
    merged.size > 0 && [...merged].every((a) => a === 'music' || a === 'video' || a === 'multimodal')
  if (mediaOnly && merged.size === 1) return [...merged]
  return ensureCodeInPipelineAgents(sortAgentsByPipelineOrder([...merged]))
}

/** Planner 拓扑层：visualize/report 硬依赖 code；有 code + 取数面须补 clean */
export function ensureCodeInPipelineAgents(agents: Iterable<Step['agent']>): Step['agent'][] {
  const merged = new Set<Step['agent']>(agents)
  const hasData = [...DATA_SOURCE_AGENTS].some((a) => merged.has(a))
  if (!hasData) return sortAgentsByPipelineOrder([...merged])

  if (merged.has('visualize') || merged.has('report')) merged.add('code')

  const dataCount = countDataSources(merged)
  const hasDownstream = merged.has('code') || merged.has('visualize') || merged.has('report')
  if (merged.has('code')) merged.add('clean')
  else if (dataCount >= 2 && hasDownstream) merged.add('clean')

  if (isPipelineAutoCleanEnabled()) {
    const hasOutput = [...PIPELINE_OUTPUT_AGENTS].some((a) => merged.has(a))
    const hasDownstreamAuto =
      merged.has('code') || hasOutput || merged.has('admin') || merged.has('clean') || merged.size >= 2
    if (hasData && hasDownstreamAuto) merged.add('clean')
  }
  if (isPipelineAutoCodeEnabled()) {
    const hasOutput = [...PIPELINE_OUTPUT_AGENTS].some((a) => merged.has(a))
    if (hasData && hasOutput) merged.add('code')
  }

  return sortAgentsByPipelineOrder([...merged])
}

export function planNeedsCleanProcessingLayer(plan: Step[], opts?: PipelinePlanOpts): boolean {
  if (isPipelineAutoCleanEnabled()) {
    const hasData = plan.some((s) => DATA_SOURCE_AGENTS.has(s.agent))
    const hasClean = plan.some((s) => s.agent === 'clean')
    if (!hasData || hasClean) return false
    const agents = new Set(plan.map((s) => s.agent))
    const hasOutput = [...PIPELINE_OUTPUT_AGENTS].some((a) => agents.has(a))
    return agents.has('code') || hasOutput || agents.has('admin') || plan.length >= 2
  }
  return needsCleanProcessing(plan, opts)
}

export function planNeedsCodeProcessingLayer(plan: Step[], opts?: PipelinePlanOpts): boolean {
  if (isPipelineAutoCodeEnabled()) {
    const hasData = plan.some((s) => DATA_SOURCE_AGENTS.has(s.agent))
    const hasOutput = plan.some((s) => PIPELINE_OUTPUT_AGENTS.has(s.agent))
    const hasCode = plan.some((s) => s.agent === 'code')
    return hasData && hasOutput && !hasCode
  }
  return needsCodeProcessing(plan, opts)
}

import { rolloutHit } from '../evolution/featureRollout'

export function isClauseDecomposeEnabled(sessionId?: string): boolean {
  const raw = String(process.env.MANAGER_CLAUSE_DECOMPOSE ?? '').trim()
  if (raw === '1') return true
  if (raw === '0') return false
  return rolloutHit('MANAGER_CLAUSE_DECOMPOSE_PCT', sessionId, 25)
}

export function isClauseDecomposeForcedOff(): boolean {
  return String(process.env.MANAGER_CLAUSE_DECOMPOSE ?? '').trim() === '0'
}

export function mergeClausesText(clauses: TaskClause[]): string {
  return clauses.map((c) => c.text).join('；')
}

/** 从 decompose LLM 子句收集全部 agent（结构化来源，非正则） */
export function agentsFromClauses(clauses: TaskClause[]): Step['agent'][] {
  const out: Step['agent'][] = []
  const seen = new Set<string>()
  for (const c of clauses) {
    for (const a of c.agents || []) {
      if (!(ALL_STEP_AGENTS as readonly string[]).includes(a) || seen.has(a)) continue
      seen.add(a)
      out.push(a)
    }
  }
  return out
}

/** 仅读取 LLM 拆解结果；无则返回空（gate 在 decomposeNode） */
export function clausesFromMeta(meta: any): TaskClause[] {
  const arr = meta?.taskClauses
  if (!Array.isArray(arr) || !arr.length) return []
  return arr
    .map((c: any, i: number) => ({
      id: String(c?.id || `c${i + 1}`),
      text: String(c?.text || '').trim(),
      agents: (Array.isArray(c?.agents) ? c.agents : []).filter((a: string) =>
        (ALL_STEP_AGENTS as readonly string[]).includes(a)
      ) as Step['agent'][],
      ...(c?.layer ? { layer: c.layer as TaskClauseLayer } : {}),
      ...(c?.taskForm ? { taskForm: String(c.taskForm).trim().slice(0, 40) } : {}),
      relevance: c?.relevance || {}
    }))
    .filter((c: TaskClause) => c.text.length >= 4)
}

/** 数据加工类 agent 在无专属子句时，不得继承 admin-only 子句或整句复合任务 */
const PIPELINE_SCOPE_AGENTS = new Set<Step['agent']>(['clean', 'code', 'visualize', 'report'])
const DATA_SOURCE_ONLY_AGENTS = new Set<Step['agent']>(['rag', 'db', 'crawler'])

function clausesForAgentScope(agent: Step['agent'], clauses: TaskClause[]): TaskClause[] {
  const withAgent = clauses.filter((c) => c.agents.includes(agent))
  if (withAgent.length) return withAgent
  if (clauses.length === 1) return clauses
  if (PIPELINE_SCOPE_AGENTS.has(agent)) {
    return clauses.filter((c) => c.agents.some((a) => DATA_SOURCE_ONLY_AGENTS.has(a) || a === agent))
  }
  return []
}

export function buildAgentScopedQuery(
  agent: Step['agent'],
  clauses: TaskClause[],
  fallback: string,
  meta?: Record<string, unknown> | null
): string {
  const fb = String(fallback || '').trim()
  if (!clauses.length) {
    return appendSerpContextToQuery(fb, meta, agent)
  }

  const pick = clausesForAgentScope(agent, clauses)
  if (!pick.length) return appendSerpContextToQuery(fb, meta, agent)

  const texts = pick.map((c) => c.text.trim()).filter(Boolean)
  const q = texts.length === 1 ? texts[0]! : texts.map((t, i) => `${i + 1}. ${t}`).join(' ')
  return appendSerpContextToQuery(q, meta, agent)
}

export function resolveExecutionQuery(
  agent: Step['agent'],
  state: { routedQuery?: string; meta?: any; intent?: string; messages?: unknown[] },
  lastUserMessage: string
): string {
  const last = String(lastUserMessage || '').trim()
  const routed = String(state.routedQuery || '').trim()
  const heur = String(state.meta?.nlHeuristicTask || '').trim()
  if (agent === 'admin') {
    const scoped = adminScopedQueryFromMeta(state.meta, routed || heur || last)
    if (scoped.length >= 4) return scoped
  }
  if (agent === 'db') {
    const dbQ = resolveDbPrefetchQuestionFromState(
      state as { meta?: unknown; intent?: string; routedQuery?: string; messages?: unknown[] },
      last,
      routed || heur || last
    )
    if (dbQ.length >= 4) return dbQ
  }
  return routed || heur || last
}

/** RAG 专用：仅保留与当前任务相关的会话轮次（token 重叠，非 agent 分配） */
export function buildTaskScopedRagHistory(
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  currentUserText: string,
  turnScopeMode?: string | null,
  turnKind?: string | null
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  const cur = String(currentUserText || '').trim()
  if (!cur) return []
  if (String(turnKind || '').trim() === 'output_followup') {
    return buildOutputFollowupNarrowHistory(messages, cur) as typeof messages
  }
  const mode = String(turnScopeMode || '').trim()
  if (mode === 'topic_shift' || mode === 'current_only' || mode === 'chitchat') return []
  if (!messages.length) return []

  const tokenize = (t: string) => {
    const s = String(t || '').toLowerCase()
    return new Set((s.match(/[\p{L}\p{N}_]{2,}/gu) || []).slice(0, 80))
  }
  const curBag = tokenize(cur)
  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    return inter / (a.size + b.size - inter)
  }

  const users = messages.filter((m) => m.role === 'user' && String(m.content || '').trim())
  if (!users.length) return []

  const lastUser = users[users.length - 1]!
  const out: typeof messages = []
  const lastIdx = messages.lastIndexOf(lastUser)
  if (lastIdx >= 0 && lastIdx + 1 < messages.length) {
    const reply = messages[lastIdx + 1]
    if (reply?.role === 'assistant') out.push(reply)
  }

  let bestPrior: (typeof messages)[0] | null = null
  let bestScore = 0
  for (let i = 0; i < users.length - 1; i++) {
    const u = users[i]!
    const score = jaccard(curBag, tokenize(String(u.content || '')))
    if (score > bestScore && score >= 0.12) {
      bestScore = score
      bestPrior = u
    }
  }
  if (bestPrior) {
    const pi = messages.indexOf(bestPrior)
    if (pi >= 0 && pi + 1 < messages.length && messages[pi + 1]?.role === 'assistant') {
      return [bestPrior, messages[pi + 1]!, ...out].filter(Boolean) as typeof messages
    }
    return [bestPrior, ...out]
  }

  return out.slice(-2)
}
