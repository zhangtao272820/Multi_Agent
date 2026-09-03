/**
 * SLI → Prometheus 文本行（纯函数，供 endpoint 与廉价 smoke）。
 */

export type SliPrometheusLineFn = (name: string, value: number, labels?: Record<string, string>) => string

/** 追加厚度分桶、估算 USD 等只读成本序列 */
export function appendSliCostThicknessPrometheusLines(
  out: string[],
  sli: Record<string, unknown> | null | undefined,
  line: SliPrometheusLineFn
): void {
  if (!sli || typeof sli !== 'object') return

  const byTh = sli.routeByThickness as Record<string, number> | undefined
  if (byTh && typeof byTh === 'object') {
    for (const [thickness, n] of Object.entries(byTh)) {
      const th = String(thickness || '').trim()
      if (!th) continue
      const count = Number(n) || 0
      out.push('# HELP manager_sli_route_by_thickness Route authority samples by orchestrationThickness')
      out.push('# TYPE manager_sli_route_by_thickness gauge')
      out.push(line('manager_sli_route_by_thickness', count, { thickness: th }))
    }
  }

  const usd = Number(sli.totalEstimatedUsd ?? NaN)
  if (Number.isFinite(usd) && usd > 0) {
    out.push('# HELP manager_sli_estimated_usd Estimated USD sum in SLI metrics window')
    out.push('# TYPE manager_sli_estimated_usd gauge')
    out.push(line('manager_sli_estimated_usd', usd))
  }
}
