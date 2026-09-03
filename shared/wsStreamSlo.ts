/**
 * P2-2：WS 流式体验 SLI（TTFT / 首事件类型），纯观测，不改变对话行为。
 */

export type WsStreamSloEventKind = 'thought_delta' | 'thinking' | 'phase' | 'status' | 'other'

let ttftSamplesMs: number[] = []
let firstEventByKind: Record<string, number> = {}
let cancelAfterMsSamples: number[] = []
const ttftRecordedRuns = new Set<string>()

const MAX_SAMPLES = 500

function pushSample(buf: number[], n: number): void {
  if (!Number.isFinite(n) || n < 0) return
  buf.push(Math.round(n))
  if (buf.length > MAX_SAMPLES) buf.shift()
}

export function classifyWsStreamEvent(event: string): WsStreamSloEventKind {
  const e = String(event || '').toLowerCase()
  if (e === 'thought_delta') return 'thought_delta'
  if (e === 'thinking') return 'thinking'
  if (e === 'phase') return 'phase'
  if (e === 'status') return 'status'
  return 'other'
}

/** 记录 run 首条用户可见流事件相对 chat 开始的 TTFT（ms） */
export function recordWsStreamFirstEvent(input: {
  runId: string
  chatStartedAtMs: number
  event: string
  nowMs?: number
}): { recorded: boolean; ttftMs?: number } {
  const rid = String(input.runId || '').trim()
  if (!rid || ttftRecordedRuns.has(rid)) return { recorded: false }
  const started = Number(input.chatStartedAtMs)
  if (!Number.isFinite(started) || started <= 0) return { recorded: false }
  const now = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now()
  const ttft = Math.max(0, now - started)
  const kind = classifyWsStreamEvent(input.event)
  if (kind === 'other') return { recorded: false }
  pushSample(ttftSamplesMs, ttft)
  firstEventByKind[kind] = (firstEventByKind[kind] || 0) + 1
  ttftRecordedRuns.add(rid)
  return { recorded: true, ttftMs: ttft }
}

export function recordWsStreamCancelLatency(input: { cancelRequestedAtMs: number; nowMs?: number }): void {
  const start = Number(input.cancelRequestedAtMs)
  if (!Number.isFinite(start) || start <= 0) return
  const now = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now()
  pushSample(cancelAfterMsSamples, Math.max(0, now - start))
}

function p50(nums: number[]): number {
  const sorted = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const idx = Math.floor(sorted.length * 0.5)
  return sorted[Math.min(sorted.length - 1, idx)] ?? 0
}

export function getWsStreamSloSnapshot(): {
  ttftP50Ms: number
  ttftSampleCount: number
  firstEventByKind: Record<string, number>
  cancelAckP50Ms: number
  cancelSampleCount: number
} {
  return {
    ttftP50Ms: p50(ttftSamplesMs),
    ttftSampleCount: ttftSamplesMs.length,
    firstEventByKind: { ...firstEventByKind },
    cancelAckP50Ms: p50(cancelAfterMsSamples),
    cancelSampleCount: cancelAfterMsSamples.length
  }
}

export function resetWsStreamSloForTests(): void {
  ttftSamplesMs = []
  firstEventByKind = {}
  cancelAfterMsSamples = []
  ttftRecordedRuns.clear()
}
