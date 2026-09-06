/**
 * G6：Manager → 用户 WS 流式事件序校验（provisional → commit/revise → final）。
 */
import { detectAdminWriteTerminalFailure } from './adminWriteTerminal'
import { detectGuiTerminalFailure } from './guiTerminal'

export type WsStreamEventKind =
  | 'stream_start'
  | 'stream_revise'
  | 'stream_commit'
  | 'delta'
  | 'phase'
  | 'final'
  | 'error'
  | 'thinking'
  | 'other'

export type WsStreamEvent = {
  kind: WsStreamEventKind
  from?: string
  phase?: string
  provisional?: boolean
}

function readProvisionalFlag(data?: unknown): boolean | undefined {
  if (!data || typeof data !== 'object') return undefined
  if ('provisional' in (data as object)) return Boolean((data as { provisional?: unknown }).provisional)
  if ('data' in (data as object)) {
    const inner = (data as { data?: unknown }).data
    if (inner && typeof inner === 'object' && 'provisional' in (inner as object)) {
      return Boolean((inner as { provisional?: unknown }).provisional)
    }
  }
  return undefined
}

export function classifyWsStreamEvent(event: string, data?: unknown): WsStreamEvent {
  const e = String(event || '').trim().toLowerCase()
  const from = typeof data === 'object' && data && 'from' in (data as object) ? String((data as { from?: string }).from || '') : undefined
  const provisional = readProvisionalFlag(data)
  if (e === 'stream_start') return { kind: 'stream_start', from, provisional }
  if (e === 'stream_revise') return { kind: 'stream_revise', from, provisional }
  if (e === 'stream_commit') return { kind: 'stream_commit', from, provisional }
  if (e === 'delta') return { kind: 'delta', from, provisional }
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

/**
 * 断言 synth 路径事件序：
 * stream_start → delta* → (stream_revise → stream_start → delta*)* → (stream_commit)? → final|error
 */
export function validateSynthStreamOrder(events: WsStreamEvent[]): StreamOrderValidation {
  let sawStart = false
  let sawDelta = false
  let closed = false

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (closed) {
      return { ok: false, reason: 'events after final/error', index: i }
    }
    if (ev.kind === 'stream_revise') {
      sawStart = false
      sawDelta = false
      continue
    }
    if (ev.kind === 'stream_commit') {
      if (!sawStart) return { ok: false, reason: 'stream_commit before stream_start', index: i }
      continue
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

export type SynthStreamGateState = {
  retryCount?: number
  intent?: string
  plan?: unknown[]
  results?: Record<string, unknown>
  evidence?: unknown[]
  meta?: Record<string, unknown>
  fixQuery?: string
  fixIntent?: string
}

/**
 * 审计路径 synth 阶段：允许 provisional 真流（用户可见草稿 token）。
 * 自愈重写轮同样允许（配合 stream_revise 清空前端缓冲）。
 */
export function mayEmitProvisionalSynthStream(state?: SynthStreamGateState): boolean {
  void state
  return true
}

/**
 * 用户面定稿流式：仅终态开流（含 stream_commit / 非 provisional 回放）。
 * - finalSynthPass / 寒暄捷径 / Admin·GUI 终态失败 → 可定稿
 * - draft / 自愈重试中（含 synthOnlyRepair）→ 不可定稿
 */
export function mayEmitFinalSynthStream(state: SynthStreamGateState): boolean {
  const meta = state.meta || {}
  if (Boolean(meta.finalSynthPass) || Boolean(meta.directChitchatSynth)) {
    return true
  }
  const adminTerminal = detectAdminWriteTerminalFailure(state)
  const guiTerminal = detectGuiTerminalFailure(state)
  if (adminTerminal.terminal || guiTerminal.terminal) return true
  return false
}

/** @deprecated 使用 mayEmitFinalSynthStream；保留别名以免旧 import 断裂 */
export function shouldEmitUserSynthStream(state: SynthStreamGateState): boolean {
  return mayEmitFinalSynthStream(state)
}

/** 统计面向用户的定稿 stream_start 次数（忽略 provisional） */
export function countUserFacingStreamStarts(
  events: Array<{ kind: string; provisional?: boolean }>
): number {
  return events.filter((e) => e.kind === 'stream_start' && !e.provisional).length
}

/** 审计通过前不得出现非 provisional 的定稿 stream_start */
export function assertNoFinalStreamBeforeAuditPass(
  events: Array<{ kind: string; phase?: string; auditPassed?: boolean; provisional?: boolean }>
): void {
  let auditPassed = false
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.auditPassed === true) auditPassed = true
    if (e.kind === 'stream_start' && !e.provisional && !auditPassed) {
      throw new Error(`final stream_start before audit pass at index ${i}`)
    }
  }
}
