/**
 * E4：诚实延迟基线 — 本地同步 noop + 微任务计时，产出相对 ms（禁止编造百分比）。
 */
function measure(label: string, fn: () => void, rounds = 200): number {
  const t0 = performance.now()
  for (let i = 0; i < rounds; i++) fn()
  const ms = performance.now() - t0
  console.log(`[latency-baseline] ${label}: ${ms.toFixed(2)}ms / ${rounds} rounds → ${(ms / rounds).toFixed(4)}ms/op`)
  return ms
}

const a = measure('sync_noop', () => {
  void (1 + 1)
})
const b = measure('json_roundtrip_1kb', () => {
  const o = { q: 'x'.repeat(200), n: 42, ok: true }
  JSON.parse(JSON.stringify(o))
})
const ratio = a > 0 ? (b / a).toFixed(2) : 'n/a'
console.log(`[latency-baseline] relative json_roundtrip/noop ≈ ${ratio}x (local only; not production SLO)`)

const BASELINE_MAX_RATIO = Number(process.env.LATENCY_BASELINE_MAX_RATIO || '50')
if (Number.isFinite(BASELINE_MAX_RATIO) && BASELINE_MAX_RATIO > 0) {
  const r = b / Math.max(a, 0.001)
  if (r > BASELINE_MAX_RATIO) {
    throw new Error(`json_roundtrip/noop ratio ${r.toFixed(2)} exceeds ${BASELINE_MAX_RATIO}`)
  }
}

console.log('smoke-latency-baseline: ok')
