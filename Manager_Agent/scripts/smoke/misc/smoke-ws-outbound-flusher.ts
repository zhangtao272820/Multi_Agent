/**
 * WS 出站 flusher：setImmediate 逐条冲帧，避免 async handler 内缓冲。
 * 用法：cd Manager_Agent && npx --yes tsx --tsconfig tsconfig.smoke.json scripts/smoke/misc/smoke-ws-outbound-flusher.ts
 */
import { createWsOutboundFlusher } from '../../../server/utils/ws/wsOutboundFlusher'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-ws-outbound-flusher] ${msg}`)
}

const sent: Array<{ event: string; data?: unknown; runId?: string }> = []
const flush = createWsOutboundFlusher({
  send: (raw) => {
    const parsed = JSON.parse(raw) as { event?: string; data?: unknown; runId?: string }
    sent.push({
      event: String(parsed.event || ''),
      data: parsed.data,
      runId: parsed.runId
    })
  }
})

flush({ event: 'thinking', data: '开始处理', from: 'manager', runId: 'r1' })
flush({ event: 'delta', data: '你好', from: 'synth', runId: 'r1' })
flush({ event: 'final', data: '完整回答', from: 'manager', runId: 'r1' })

await new Promise<void>((r) => setTimeout(r, 40))

assert(sent.length === 3, `expected 3 frames, got ${sent.length}`)
assert(sent[0]?.event === 'thinking' && sent[0]?.data === '开始处理', 'thinking first')
assert(sent[1]?.event === 'delta' && sent[1]?.data === '你好', 'delta second')
assert(sent[2]?.event === 'final' && sent[2]?.data === '完整回答', 'final third')
assert(sent.every((s) => s.runId === 'r1'), 'runId preserved')

console.log('smoke-ws-outbound-flusher: PASS')
