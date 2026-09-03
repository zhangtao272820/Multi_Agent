/**
 * P2-2：WS 流式 SLI 契约（纯函数，不调 LLM / 不打 WS）。
 */
import {
  recordWsStreamFirstEvent,
  getWsStreamSloSnapshot,
  resetWsStreamSloForTests,
  recordWsStreamCancelLatency
} from '../../../agent-repo-shared/wsStreamSlo'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-ws-stream-slo] ${msg}`)
}

console.log('smoke-ws-stream-slo: start')
resetWsStreamSloForTests()

const t0 = Date.now()
const r1 = recordWsStreamFirstEvent({
  runId: 'r1',
  chatStartedAtMs: t0,
  event: 'status',
  nowMs: t0 + 120
})
assert(r1.recorded && r1.ttftMs === 120, 'status ttft')

const r2 = recordWsStreamFirstEvent({
  runId: 'r2',
  chatStartedAtMs: t0,
  event: 'thought_delta',
  nowMs: t0 + 450
})
assert(r2.recorded && r2.ttftMs === 450, 'thought_delta ttft')

recordWsStreamCancelLatency({ cancelRequestedAtMs: t0, nowMs: t0 + 800 })

const snap = getWsStreamSloSnapshot()
assert(snap.ttftSampleCount === 2, 'two ttft samples')
assert(snap.ttftP50Ms >= 120, 'p50 ttft')
assert(snap.firstEventByKind.status === 1, 'status count')
assert(snap.firstEventByKind.thought_delta === 1, 'thought count')
assert(snap.cancelSampleCount === 1, 'cancel sample')

console.log('smoke-ws-stream-slo: OK')
