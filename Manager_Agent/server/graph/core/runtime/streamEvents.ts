/**
 * G6：Manager → 用户 WS 流式事件序校验（start → delta* → final|error）。
 */
import {
  canManagerRetryMore,
  isManagerRetryBudgetExhausted,
  resolveManagerRetryLimits
} from './retryBudget'
import { detectAdminWriteTerminalFailure } from './adminWriteTerminal'
import { detectGuiTerminalFailure, hasFailedGuiEvidenceInRun } from './guiTerminal'

export type WsStreamEventKind =
  | 'stream_start'
  | 'delta'
  | 'phase'
  | 'final'
  | 'error'
  | 'thinking'
  | 'other'

export type WsStreamEvent = { kind: WsStreamEventKind; from?: string; phase?: string }

export function classifyWsStreamEvent(event: string, data?: unknown): WsStreamEvent {
  const e = String(event || '').trim().toLowerCase()
  const from = typeof data === 'object' && data && 'from' in (data as object) ? String((data as { from?: string }).from || '') : undefined
  if (e === 'stream_start') return { kind: 'stream_start', from }
  if (e === 'delta') return { kind: 'delta', from }
  if (e === 'phase') {
    const phase = typeof data === 'string' ? data : String((data as { data?: string })?.data ?? data ?? '')
    return { kind: 'phase', phase, from }
  }
  if (e === 'final') return { kind: 'final', from }
  if (e === 'error') return { kind: 'error', from }
  if (e === 'thinking') return { kind: 'thinking', from }
  return { kind: 'other', from }
}

export type StreamOrderValidation = { ok: true } | { ok: false; reason: string; index: number }

/** 断言 synth 路径事件序：出现 stream_start 后可有 delta*，最终以 final 或 error 结束 */
export function validateSynthStreamOrder(events: WsStreamEvent[]): StreamOrderValidation {
  let sawStart = false
  let sawDelta = false
  let closed = false

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (closed) {
      return { ok: false, reason: 'events after final/error', index: i }
    }
    if (ev.kind === 'stream_start') {
      if (sawStart) return { ok: false, reason: 'duplicate stream_start', index: i }
      sawStart = true
      continue
    }
    if (ev.kind === 'delta') {
      if (!sawStart) return { ok: false, reason: 'delta before stream_start', index: i }
      sawDelta = true
      continue
    }
    if (ev.kind === 'final' || ev.kind === 'error') {
      if (sawStart && !sawDelta && ev.kind === 'final') {
        // 允许极短流式无 delta
      }
      closed = true
      continue
    }
  }

  if (!sawStart) return { ok: false, reason: 'missing stream_start', index: events.length }
  if (!closed) return { ok: false, reason: 'missing final/error terminator', index: events.length }
  return { ok: true }
}

/**
 * 用户面 synth 流式：仅终态开流。
 * 仍有重试预算且 Admin/GUI 可修复失败 → 静默算 final，不开 stream_start。
 */
export function shouldEmitUserSynthStream(state: {
  retryCount?: number
  intent?: string
  plan?: unknown[]
  results?: Record<string, unknown>
  evidence?: unknown[]
  meta?: Record<string, unknown>
  fixQuery?: string
  fixIntent?: string
}): boolean {
  const meta = state.meta || {}
  if (Boolean(meta.finalSynthPass) || Boolean(meta.synthOnlyRepair) || Boolean(meta.directChitchatSynth)) {
    return true
  }
  const limits = resolveManagerRetryLimits(state)
  const exhausted = isManagerRetryBudgetExhausted(limits)
  const adminTerminal = detectAdminWriteTerminalFailure(state)
  const guiTerminal = detectGuiTerminalFailure(state)
  // 终态失败：允许本轮流一次清晰失败说明（不再进 repair）
  if (adminTerminal.terminal || guiTerminal.terminal) return true

  const adminOut = String(state.results?.admin || '').trim()
  const adminLooksFailed =
    Boolean(adminOut) &&
    (/^(error|失败|错误)/i.test(adminOut) ||
      /未能完成写操作|协议异常|未确认，未写入|empty_result/i.test(adminOut))

  const records = Array.isArray(meta.lastStepRecords) ? meta.lastStepRecords : []
  const adminStepError = records.some((row) => {
    if (!row || typeof row !== 'object') return false
    const r = row as { agent?: string; status?: string; error?: string }
    return String(r.agent || '').toLowerCase() === 'admin' && String(r.status || '') === 'error'
  })
  const guiStepError = records.some((row) => {
    if (!row || typeof row !== 'object') return false
    const r = row as { agent?: string; status?: string }
    return String(r.agent || '').toLowerCase() === 'gui' && String(r.status || '') === 'error'
  })
  const guiOut = String(state.results?.gui || '').trim()
  const guiLooksFailed =
    Boolean(guiOut) &&
    (/GUI 自动化失败|lobster_workflow_not_found|task_blocked|timeout/i.test(guiOut) ||
      hasFailedGuiEvidenceInRun(state))
  const pendingGuiRepair =
    Boolean(String(state.fixQuery || '').trim()) &&
    String(state.fixIntent || '') === 'gui' &&
    canManagerRetryMore(limits) &&
    !exhausted

  if ((adminLooksFailed || adminStepError) && canManagerRetryMore(limits) && !exhausted) {
    return false
  }
  if ((guiLooksFailed || guiStepError || pendingGuiRepair) && canManagerRetryMore(limits) && !exhausted) {
    return false
  }
  return true
}

/** 统计面向用户的 stream_start 次数（忽略 provisional 标记的事件由调用方过滤） */
export function countUserFacingStreamStarts(
  events: Array<{ kind: string; provisional?: boolean }>
): number {
  return events.filter((e) => e.kind === 'stream_start' && !e.provisional).length
}
