/**
 * G6：Manager → 用户 WS 流式事件序校验（start → delta* → final|error）。
 */
import { detectAdminWriteTerminalFailure } from './adminWriteTerminal'
import { detectGuiTerminalFailure } from './guiTerminal'

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
 * - finalSynthPass / 寒暄捷径 / Admin·GUI 终态失败 → 开流
 * - draft / 自愈重试中（含 synthOnlyRepair）→ 静默写 final，不开 stream_start
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
  if (Boolean(meta.finalSynthPass) || Boolean(meta.directChitchatSynth)) {
    return true
  }
  const adminTerminal = detectAdminWriteTerminalFailure(state)
  const guiTerminal = detectGuiTerminalFailure(state)
  // 终态失败：允许本轮流一次清晰失败说明（不再进 repair）
  if (adminTerminal.terminal || guiTerminal.terminal) return true
  return false
}

/** 统计面向用户的 stream_start 次数（忽略 provisional 标记的事件由调用方过滤） */
export function countUserFacingStreamStarts(
  events: Array<{ kind: string; provisional?: boolean }>
): number {
  return events.filter((e) => e.kind === 'stream_start' && !e.provisional).length
}
