/** N3：从 manager-metrics.jsonl / nlu 指标聚合最小 SLI */

import { resolveMetricRowUsd } from '#agent-shared/sliCostEstimate'
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
  /** Wave6：路由权威链过程 SLI（非对外假 QPS） */
  routeAuthoritySamples: number
  routeSingleSourceRate: number | null
  routeTrueMultiRate: number | null
  routeCommitmentClearRate: number | null
  /** Phase0 成熟化：审查 skip / 路由 LLM 次数 */
  routeSkipAlignRate: number | null
  routeSkipPlaneRate: number | null
  routeAvgLlmCalls: number | null
  routeByThickness: Record<string, number>
  /** metrics 窗口内 usd 合计（有则导出 Prometheus） */
  totalEstimatedUsd: number
}

export function aggregateManagerSli(
  metricRows: Array<Record<string, unknown>>,
  nluRows: Array<Record<string, unknown>> = [],
  hitlRows: Array<{ payload?: Record<string, unknown>; ts?: string }> = [],
  env: NodeJS.ProcessEnv = process.env
): ManagerSliSnapshot {
  const runIds = new Set<string>()
  const latencies: number[] = []
  const byPhaseLatencies: Record<string, number[]> = {}
  let expertAttempts = 0
  let expertErrors = 0
  const errorsByCode: Record<string, number> = {}
  let totalTokens = 0
  let totalEstimatedUsd = 0
  let evidenceGateFailures = 0
  let routeAuthoritySamples = 0
  let routeSingleSource = 0
  let routeTrueMulti = 0
  let routeClear = 0
  let skipAlign = 0
  let skipPlane = 0
  let llmCallsSum = 0
  let llmCallsN = 0
  const routeByThickness: Record<string, number> = {}

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
    const rowUsd = resolveMetricRowUsd(
      { usd: raw?.usd, tokens: raw?.tokens },
      env
    )
    if (rowUsd > 0) totalEstimatedUsd += rowUsd

    const phase = String(raw?.phase || '')
    if (phase === 'evidence_gate' && raw?.ok === false) {
      evidenceGateFailures += 1
    }
    if (phase === 'route_authority') {
      routeAuthoritySamples += 1
      const extra = (raw?.extra && typeof raw.extra === 'object' ? raw.extra : raw) as Record<string, unknown>
      if (extra.singleSourcePassthrough === true) routeSingleSource += 1
      if (extra.trueMulti === true) routeTrueMulti += 1
      if (String(extra.sourceCommitment || '') === 'clear') routeClear += 1
      const skips =
        extra.routeSkips && typeof extra.routeSkips === 'object'
          ? (extra.routeSkips as Record<string, unknown>)
          : null
      if (skips?.align === true) skipAlign += 1
      if (skips?.plane === true) skipPlane += 1
      const calls = Number(extra.routeLlmCalls)
      if (Number.isFinite(calls) && calls >= 0) {
        llmCallsSum += calls
        llmCallsN += 1
      }
      const th = String(extra.orchestrationThickness || 'unknown').trim() || 'unknown'
      routeByThickness[th] = (routeByThickness[th] || 0) + 1
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
    evidenceGateFailures,
    routeAuthoritySamples,
    routeSingleSourceRate: routeAuthoritySamples
      ? Math.round((routeSingleSource / routeAuthoritySamples) * 1000) / 1000
      : null,
    routeTrueMultiRate: routeAuthoritySamples
      ? Math.round((routeTrueMulti / routeAuthoritySamples) * 1000) / 1000
      : null,
    routeCommitmentClearRate: routeAuthoritySamples
      ? Math.round((routeClear / routeAuthoritySamples) * 1000) / 1000
      : null,
    routeSkipAlignRate: routeAuthoritySamples
      ? Math.round((skipAlign / routeAuthoritySamples) * 1000) / 1000
      : null,
    routeSkipPlaneRate: routeAuthoritySamples
      ? Math.round((skipPlane / routeAuthoritySamples) * 1000) / 1000
      : null,
    routeAvgLlmCalls: llmCallsN
      ? Math.round((llmCallsSum / llmCallsN) * 100) / 100
      : null,
    routeByThickness,
    totalEstimatedUsd: Math.round(totalEstimatedUsd * 10000) / 10000
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
