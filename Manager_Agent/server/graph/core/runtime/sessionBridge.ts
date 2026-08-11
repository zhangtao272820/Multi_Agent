import type { ChatMessage } from '../../../utils/agents/types'
import type { AgentExecutorOpts } from '../executors'
import { buildTaskScopedRagHistory } from '../routing/clauses'
import {
  parseTurnScopeMode,
  parseTurnKind,
  isOutputFollowupTurn,
  shouldSuppressHistory,
  type TurnScopeMode,
  type TurnScopePayload,
  buildTurnScopePayload
} from '../../../utils/route/managerTurnScopePayload'
import { buildOutputFollowupNarrowHistory } from '../output/outputFollowupHistory'

/**
 * Admin 等需跨步共享会话时使用。
 * DB/RAG 执行请用 `resolveSubAgentStepSessionId`，避免 Manager session 污染子 Agent 服务端历史。
 */
export function resolveManagerAgentSessionId(opts: Pick<AgentExecutorOpts, 'sessionId' | 'ragConversationId' | 'runId'>): string {
  const sid = String(opts.sessionId || opts.ragConversationId || '').trim()
  if (sid) return sid
  const runId = String(opts.runId || '').trim()
  return runId ? `mgr-${runId}` : 'manager-default'
}

export { resolveSubAgentStepSessionId } from '../routing/subAgentPassthrough'

const DB_HISTORY_MAX_TURNS = 8

export { buildOutputFollowupNarrowHistory } from '../output/outputFollowupHistory'

export function resolveTurnScopeFromMeta(meta: unknown): TurnScopePayload | null {
  const o = meta as { turnScopeMode?: unknown; turnKind?: unknown; turn_scope?: unknown } | null
  const embedded = o?.turn_scope
  if (embedded && typeof embedded === 'object') {
    const mode = parseTurnScopeMode((embedded as { mode?: unknown }).mode)
    if (mode) return buildTurnScopePayload(mode, parseTurnKind((embedded as { turn_kind?: unknown }).turn_kind))
  }
  const mode = parseTurnScopeMode(o?.turnScopeMode)
  if (!mode) return null
  return buildTurnScopePayload(mode, parseTurnKind(o?.turnKind))
}

/** 总管多 Agent 编排：子 Agent 默认 current_only，避免 Manager 会话 history 污染 DB/Admin NLU */
export function resolveSubAgentTurnScope(meta: unknown): TurnScopePayload | null {
  const existing = resolveTurnScopeFromMeta(meta)
  if (existing) return existing
  const m = meta as {
    intent?: string
    stepDispatchDraft?: unknown[]
    planBlueprint?: { steps?: unknown[] }
  } | null
  const multi =
    String(m?.intent || '').trim() === 'multi' ||
    (Array.isArray(m?.stepDispatchDraft) && m!.stepDispatchDraft!.length >= 2) ||
    (Array.isArray(m?.planBlueprint?.steps) && m!.planBlueprint!.steps!.length >= 2)
  if (multi) return buildTurnScopePayload('current_only', 'new_task')
  return null
}

/** DB 追问：携带近期会话轮次（不含当前问句）；topic_shift/current_only 时不传历史；output_followup 仅 assistant 片段 */
export function buildDbHistoryFromState(
  messages: Array<{ role?: string; content?: string }> | undefined,
  currentQuestion: string,
  opts?: { maxTurns?: number; turnScopeMode?: TurnScopeMode | string | null; turnKind?: string | null }
): ChatMessage[] {
  const q = String(currentQuestion || '').trim()
  const turnKind = parseTurnKind(opts?.turnKind)
  if (isOutputFollowupTurn(turnKind)) {
    return [...buildOutputFollowupNarrowHistory(messages, q), ...(q ? [{ role: 'user' as const, content: q }] : [])]
  }
  const mode = opts?.turnScopeMode ?? null
  if (shouldSuppressHistory(mode)) {
    return q ? [{ role: 'user', content: q }] : []
  }

  const maxTurns = opts?.maxTurns ?? DB_HISTORY_MAX_TURNS
  const all = (Array.isArray(messages) ? messages : [])
    .map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(m.content ?? '').trim()
    }))
    .filter((m) => m.content)
  const cap = Math.max(2, maxTurns * 2)
  let recent = all.slice(-cap)
  if (recent.length && recent[recent.length - 1]?.role === 'user' && recent[recent.length - 1]?.content === q) {
    recent = recent.slice(0, -1)
  }
  if (!q) return recent
  return [...recent, { role: 'user', content: q }]
}

/** RAG chat 历史：turn 隔离时为空；output_followup 窄 assistant；否则 task-scoped 过滤 */
export function buildRagHistoryFromState(
  messages: Array<{ role?: string; content?: string }> | undefined,
  currentUserText: string,
  turnScopeMode?: TurnScopeMode | string | null,
  turnKind?: string | null
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const cur = String(currentUserText || '').trim()
  const tk = parseTurnKind(turnKind)
  if (isOutputFollowupTurn(tk)) {
    return buildOutputFollowupNarrowHistory(messages, cur) as Array<{ role: 'user' | 'assistant'; content: string }>
  }
  if (shouldSuppressHistory(turnScopeMode)) return []
  const all = (Array.isArray(messages) ? messages : [])
    .map((m) => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: String(m.content ?? '').trim()
    }))
    .filter((m) => m.content)
  const scoped = buildTaskScopedRagHistory(all, cur, turnScopeMode, tk)
  if (scoped.length) return scoped as Array<{ role: 'user' | 'assistant'; content: string }>
  const last = all.filter((m) => m.role === 'user').slice(-1)
  return last
}
