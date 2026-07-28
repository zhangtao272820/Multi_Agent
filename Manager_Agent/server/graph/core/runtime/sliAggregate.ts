/** N3：从 manager-metrics.jsonl / nlu 指标聚合最小 SLI */

import type { NormalizedManagerMetricEntry } from './observabilitySchema'
import { resolveMetricAgentFromEntry } from './observabilitySchema'

function p95(nums: number[]): number {
  const sorted = nums.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))] ?? 0
}

export type ManagerSliSnapshot = {
  runs: number
  totalRequests: number
  p95LatencyMs: number
  p95ByPhase: Record<string, number>
  expertErrorRate: number | null
  expertErrorsByCode: Record<string, number>
  totalTokens: number
  hitlWaitMsP95: number | null
  hitlDecisionCount: number
  evidenceRejectionRate: number | null
  evidenceGateFailures: number
}

export function aggregateManagerSli(
  metricRows: Array<Record<string, unknown>>,
  nluRows: Array<Record<string, unknown>> = [],
  hitlRows: Array<{ payload?: Record<string, unknown>; ts?: string }> = []
): ManagerSliSnapshot {
  const runIds = new Set<string>()
  const latencies: number[] = []
  const byPhaseLatencies: Record<string, number[]> = {}
  let expertAttempts = 0
  let expertErrors = 0
  const errorsByCode: Record<string, number> = {}
  let totalTokens = 0
  let evidenceGateFailures = 0

  for (const raw of metricRows) {
    const runId = String(raw?.runId ?? '').trim()
    if (runId) runIds.add(runId)
    const ms = Number(raw?.ms ?? 0)
    if (Number.isFinite(ms) && ms > 0) {
      latencies.push(ms)
      const phase = String(raw?.phase || 'unknown')
      if (!byPhaseLatencies[phase]) byPhaseLatencies[phase] = []
      byPhaseLatencies[phase].push(ms)
    }
    const tok = Number(raw?.tokens ?? 0)
    if (Number.isFinite(tok) && tok > 0) totalTokens += tok

    const phase = String(raw?.phase || '')
    if (phase === 'evidence_gate' && raw?.ok === false) {
      evidenceGateFailures += 1
    }

    const agent = resolveMetricAgentFromEntry({
      agent: typeof raw?.agent === 'string' ? raw.agent : undefined,
      phase,
      extra: raw?.extra as Record<string, unknown> | undefined
    })
    const isWorker = Boolean(agent) || ['db', 'rag', 'code', 'crawler', 'gui', 'admin'].includes(phase)
    if (!isWorker) continue
    if (typeof raw?.ok !== 'boolean') continue
    expertAttempts += 1
    if (!raw.ok) {
      expertErrors += 1
      const code = String(raw?.error_code || 'unknown')
      errorsByCode[code] = (errorsByCode[code] || 0) + 1
    }
  }

  const p95ByPhase: Record<string, number> = {}
  for (const [phase, nums] of Object.entries(byPhaseLatencies)) {
    p95ByPhase[phase] = Math.round(p95(nums))
  }

  const hitlWaits: number[] = []
  for (const h of hitlRows) {
    const wait = Number((h.payload as Record<string, unknown> | undefined)?.waitMs ?? (h.payload as Record<string, unknown> | undefined)?.wait_ms)
    if (Number.isFinite(wait) && wait > 0) hitlWaits.push(wait)
  }

  const nluTotal = nluRows.length
  const needsClarify = nluRows.filter((r) => r?.needsClarify === true).length
  const evidenceRejectionRate =
    evidenceGateFailures > 0 && runIds.size > 0
      ? Math.round((evidenceGateFailures / runIds.size) * 1000) / 1000
      : nluTotal > 0
        ? Math.round((needsClarify / nluTotal) * 1000) / 1000
        : null

  return {
    runs: runIds.size,
    totalRequests: metricRows.length,
    p95LatencyMs: Math.round(p95(latencies)),
    p95ByPhase,
    expertErrorRate: expertAttempts ? Math.round((expertErrors / expertAttempts) * 1000) / 1000 : null,
    expertErrorsByCode: errorsByCode,
    totalTokens,
    hitlWaitMsP95: hitlWaits.length ? Math.round(p95(hitlWaits)) : null,
    hitlDecisionCount: hitlRows.length,
    evidenceRejectionRate,
    evidenceGateFailures
  }
}

export function normalizeMetricRowsFromJsonl(lines: Array<Record<string, unknown>>): NormalizedManagerMetricEntry[] {
  return lines.map((raw) => ({
    runId: String(raw?.runId ?? ''),
    trace_id: String(raw?.trace_id ?? raw?.runId ?? ''),
    phase: String(raw?.phase ?? 'unknown'),
    ms: Number(raw?.ms ?? 0),
    ok: typeof raw?.ok === 'boolean' ? raw.ok : undefined,
    agent: typeof raw?.agent === 'string' ? raw.agent : undefined,
    error_code: typeof raw?.error_code === 'string' ? raw.error_code : undefined,
    tokens: typeof raw?.tokens === 'number' ? raw.tokens : undefined,
    ts: String(raw?.ts ?? '')
  }))
}
