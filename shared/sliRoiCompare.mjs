/**
 * SLI ROI 对照：前后窗口 routeAvgLlmCalls / P95（纯结构，不调 LLM）。
 */

export function compareSliRoi(before, after) {
  const bLlm = Number(before?.routeAvgLlmCalls ?? NaN)
  const aLlm = Number(after?.routeAvgLlmCalls ?? NaN)
  const bP95 = Number(before?.p95LatencyMs ?? NaN)
  const aP95 = Number(after?.p95LatencyMs ?? NaN)
  const llmDelta =
    Number.isFinite(bLlm) && Number.isFinite(aLlm) ? Math.round((aLlm - bLlm) * 100) / 100 : null
  const p95Delta =
    Number.isFinite(bP95) && Number.isFinite(aP95) ? Math.round(aP95 - bP95) : null
  const skipBefore = Number(before?.routeSkipAlignRate ?? NaN)
  const skipAfter = Number(after?.routeSkipAlignRate ?? NaN)
  return {
    routeAvgLlmCalls: { before: bLlm, after: aLlm, delta: llmDelta },
    p95LatencyMs: { before: bP95, after: aP95, delta: p95Delta },
    routeSkipAlignRate: { before: skipBefore, after: skipAfter },
    improved:
      (llmDelta != null && llmDelta < 0) || (p95Delta != null && p95Delta < 0) || false
  }
}

export function formatSliRoiReport(roi) {
  const lines = ['# SLI ROI 对照', '']
  lines.push(
    `- routeAvgLlmCalls: ${roi.routeAvgLlmCalls.before} → ${roi.routeAvgLlmCalls.after} (Δ ${roi.routeAvgLlmCalls.delta ?? 'n/a'})`
  )
  lines.push(
    `- p95LatencyMs: ${roi.p95LatencyMs.before} → ${roi.p95LatencyMs.after} (Δ ${roi.p95LatencyMs.delta ?? 'n/a'})`
  )
  lines.push(
    `- routeSkipAlignRate: ${roi.routeSkipAlignRate.before} → ${roi.routeSkipAlignRate.after}`
  )
  lines.push(`- improved: ${roi.improved}`)
  return lines.join('\n')
}
