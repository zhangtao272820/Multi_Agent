/**
 * Phase2：续轮 cap 复用 — 结构信号判定是否跳过编排 LLM。
 * probe 与 anchor 数据面冲突时必须降级全量编排（禁 silent 错路由）。
 */
import type { SessionIntentAnchor } from '../memory/multiTurnIntent'
import type { TurnRoutingScope } from './turnScope'
import { isExplicitMultiRequest } from '../text/routingContext'
import { mockIntentClassifyForTest, type IntentClassifyResult } from '../../llm/intentClassifyLlm'
import type { OrchestratorDecision } from '../../orchestrate/orchestratorInvariants'
import type { ExecutableAgent } from './routeFinalize'
import { probeStrongSolePlane, type RouteSkipProbeHint } from './routeSkipCascade'
import { buildTopologyBlueprintFromCap } from '../../llm/planBlueprintLlm'
import { EMPTY_TASK_CONSTRAINTS } from '../../llm/taskConstraintsLlm'
import { turnScopeLlmFromMeta } from '../../llm/turnScopeLlm'

const CONT_KINDS = new Set(['continuation', 'output_followup', 'slot_answer'])
const DATA_PLANES = new Set(['db', 'rag', 'crawler', 'admin'])
/** 续轮跳过编排 LLM 的最低置信；灰区（<0.7）强制全量编排 */
export const CONTINUATION_BYPASS_MIN_CONFIDENCE = 0.7

export type ContinuationBypassResult = {
  ok: boolean
  reasons: string[]
  allowedAgents: string[]
  primaryIntent: string
  planShortcut: IntentClassifyResult['planShortcut']
  coalescedTask: string
}

function anchorDataAgents(anchor: SessionIntentAnchor | null | undefined): string[] {
  if (!anchor) return []
  const exec = (anchor.lastExecutedAgents ?? []).map(String).filter((a) => DATA_PLANES.has(a))
  if (exec.length) return [...new Set(exec)]
  const plane = String(anchor.primaryPlane || '').trim()
  if (plane === 'db' || plane === 'rag' || plane === 'crawler') return [plane]
  const pi = String(anchor.primaryIntent || '').trim()
  if (DATA_PLANES.has(pi)) return [pi]
  return []
}

function shortcutForAgents(agents: string[], anchor: SessionIntentAnchor): IntentClassifyResult['planShortcut'] {
  const sc = String(anchor.planShortcut || '').trim()
  if (sc === 'db_only' || sc === 'rag_only' || sc === 'admin_only' || sc === 'db_chart') {
    return sc as IntentClassifyResult['planShortcut']
  }
  if (agents.length === 1 && agents[0] === 'db') return 'db_only'
  if (agents.length === 1 && agents[0] === 'rag') return 'rag_only'
  if (agents.length === 1 && agents[0] === 'admin') return 'admin_only'
  return 'none'
}

/** probe 强单源与上轮 cap 冲突 → 禁止 bypass */
export function continuationProbeConflictsAnchor(input: {
  probe?: RouteSkipProbeHint | null
  allowedAgents: string[]
}): boolean {
  const strong = probeStrongSolePlane(input.probe)
  if (!strong) return false
  const data = input.allowedAgents.filter((a) => a === 'db' || a === 'rag')
  if (!data.length) return false
  // 上轮单源与 probe 强面不一致
  if (data.length === 1 && data[0] !== strong) return true
  // 上轮多数据面但 probe 明确只剩一端 — 仍可 bypass（不扩），不算冲突
  return false
}

/**
 * 是否可跳过编排 LLM、复用上轮数据面 cap。
 * 结构信号 only：turnKind / mode / anchor / multi-line bullets / probe。
 */
export function resolveContinuationRouteBypass(input: {
  turnScope: TurnRoutingScope
  sessionAnchor?: SessionIntentAnchor | null
  lastUser?: string | null
  probe?: RouteSkipProbeHint | null
  meta?: unknown
  /** 本轮新附件 → 禁止 bypass，须重跑 caption+编排 */
  attachment?: { filePath?: string } | null
}): ContinuationBypassResult {
  const reasons: string[] = []
  const scope = input.turnScope
  const anchor = input.sessionAnchor

  if (scope.mode === 'topic_shift') {
    return { ok: false, reasons: ['topic_shift'], allowedAgents: [], primaryIntent: '', planShortcut: 'none', coalescedTask: '' }
  }
  if (input.attachment?.filePath) {
    return {
      ok: false,
      reasons: ['new_attachment'],
      allowedAgents: [],
      primaryIntent: '',
      planShortcut: 'none',
      coalescedTask: ''
    }
  }
  if (!CONT_KINDS.has(scope.turnKind)) {
    return { ok: false, reasons: ['not_continuation_kind'], allowedAgents: [], primaryIntent: '', planShortcut: 'none', coalescedTask: '' }
  }
  const scopeConf = Number(scope.confidence)
  const metaLlm = turnScopeLlmFromMeta(input.meta)
  const conf = Number.isFinite(scopeConf)
    ? scopeConf
    : Number(metaLlm?.confidence)
  if (!Number.isFinite(conf) || conf < CONTINUATION_BYPASS_MIN_CONFIDENCE) {
    return {
      ok: false,
      reasons: ['low_confidence'],
      allowedAgents: [],
      primaryIntent: '',
      planShortcut: 'none',
      coalescedTask: ''
    }
  }
  if (scope.directChitchatSynth || scope.mode === 'chitchat') {
    return { ok: false, reasons: ['chitchat'], allowedAgents: [], primaryIntent: '', planShortcut: 'none', coalescedTask: '' }
  }
  const meta = input.meta && typeof input.meta === 'object' ? (input.meta as Record<string, unknown>) : {}
  if (meta.metaIntentHotGate === true || meta.directChitchatSynth === true) {
    return { ok: false, reasons: ['meta_intent_hot'], allowedAgents: [], primaryIntent: '', planShortcut: 'none', coalescedTask: '' }
  }
  if (meta.clarifyReplan === true) {
    return { ok: false, reasons: ['clarify_replan'], allowedAgents: [], primaryIntent: '', planShortcut: 'none', coalescedTask: '' }
  }
  if (!anchor) {
    return { ok: false, reasons: ['no_anchor'], allowedAgents: [], primaryIntent: '', planShortcut: 'none', coalescedTask: '' }
  }

  const agents = anchorDataAgents(anchor)
  if (!agents.length) {
    return { ok: false, reasons: ['no_anchor_agents'], allowedAgents: [], primaryIntent: '', planShortcut: 'none', coalescedTask: '' }
  }
  // 真 multi 上轮：续轮仍走全量编排，避免漏子句
  if (agents.length >= 2 || anchor.isMulti === true) {
    return { ok: false, reasons: ['anchor_multi'], allowedAgents: agents, primaryIntent: '', planShortcut: 'none', coalescedTask: '' }
  }

  const lastUser = String(input.lastUser || scope.lastOnly || '').trim()
  if (isExplicitMultiRequest(lastUser)) {
    return { ok: false, reasons: ['structural_multi_lines'], allowedAgents: agents, primaryIntent: '', planShortcut: 'none', coalescedTask: '' }
  }

  if (continuationProbeConflictsAnchor({ probe: input.probe, allowedAgents: agents })) {
    return { ok: false, reasons: ['probe_conflict'], allowedAgents: agents, primaryIntent: '', planShortcut: 'none', coalescedTask: '' }
  }

  const coalescedTask =
    String(anchor.coalescedTask || '').trim() ||
    lastUser
  const planShortcut = shortcutForAgents(agents, anchor)
  const primaryIntent = agents[0] || String(anchor.primaryIntent || 'multi').trim() || 'multi'
  reasons.push('continuation_cap_reuse')
  return {
    ok: true,
    reasons,
    allowedAgents: agents,
    primaryIntent,
    planShortcut,
    coalescedTask: coalescedTask.slice(0, 880)
  }
}

/** 从 bypass 结果材料化 OrchestratorDecision（跳过编排 LLM） */
export function buildContinuationBypassDecision(input: {
  bypass: ContinuationBypassResult
  turnScope: TurnRoutingScope
  lastUser: string
}): OrchestratorDecision {
  const agents = input.bypass.allowedAgents.map(String) as ExecutableAgent[]
  const primary = input.bypass.primaryIntent
  const shortcut = input.bypass.planShortcut
  const coalesced = input.bypass.coalescedTask || input.lastUser
  const routedQuery = String(input.lastUser || '').trim() || coalesced
  const dataSources = agents.filter((a) => a === 'db' || a === 'rag' || a === 'crawler') as Array<
    'db' | 'rag' | 'crawler'
  >

  const classify = mockIntentClassifyForTest({
    primaryIntent: (['db', 'rag', 'admin', 'crawler', 'multi'].includes(primary)
      ? primary
      : 'multi') as IntentClassifyResult['primaryIntent'],
    isMulti: false,
    suggestedAgents: agents as IntentClassifyResult['suggestedAgents'],
    isDbAnchored: agents.includes('db'),
    needsAdmin: agents.includes('admin'),
    needsWeb: false,
    planShortcut: shortcut,
    dataSources,
    requiresAgentPipeline: false,
    confidence: 0.86,
    rationale: `continuation_cap_reuse:${input.bypass.reasons.join('+')}`
  })

  const planBlueprint = buildTopologyBlueprintFromCap({
    allowedAgents: agents.map(String),
    userTask: coalesced,
    clauses: [{ id: 'c1', text: coalesced.slice(0, 480), agents: agents.map(String) as any }]
  })

  const routeSkips = {
    align: true,
    plane: true,
    webAlign: true,
    planner: true,
    audit: true
  }

  return {
    raw: {
      sourceCommitment: 'clear',
      committedPlanes: agents.filter((a) => ['db', 'rag', 'crawler', 'admin'].includes(a)),
      webFetchKind: 'none',
      continuationCapReuse: true,
      routeSkips,
      routeLlmCalls: 1
    } as any,
    turnScopeMode: input.turnScope.mode === 'continuation' ? 'continuation' : 'current_only',
    clauses: [{ id: 'c1', text: coalesced.slice(0, 480), agents: agents as any }],
    constraints: { ...EMPTY_TASK_CONSTRAINTS },
    intentClassify: classify,
    intent: primary === 'admin' || primary === 'db' || primary === 'rag' || primary === 'crawler' ? primary : agents[0] || 'multi',
    allowedAgents: agents,
    routedQuery,
    planBlueprint,
    needsWebSearch: false,
    needsClarify: false,
    clarifyKind: 'none',
    clarifyQuestions: [],
    directChitchatSynth: false,
    coalescedTask: coalesced,
    metaPatch: {
      intentClassify: classify,
      taskClauses: [{ id: 'c1', text: coalesced.slice(0, 480), agents }],
      planBlueprint,
      continuationCapReuse: true,
      routeSkips,
      routeLlmCalls: 1,
      routeSkipAlign: true,
      routeSkipPlane: true,
      routeSkipWebAlign: true,
      orchestratorSource: 'continuation_cap_reuse',
      sourceCommitment: 'clear',
      committedPlanes: agents.filter((a) => ['db', 'rag', 'crawler', 'admin'].includes(a)),
      webFetchKind: 'none'
    }
  }
}
