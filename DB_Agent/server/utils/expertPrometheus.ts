/**
 * E1：把 JSON metrics.sli 暴露为 Prometheus text（与 Manager prometheus.get 同构）。
 * 各专家复用：gauge 名带 agent 前缀，便于 scrape 与告警。
 */
export function escPromLabel(v: string): string {
  return String(v || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

export function promLine(name: string, value: number, labels?: Record<string, string>): string {
  const parts = labels
    ? Object.entries(labels)
        .filter(([, val]) => val !== undefined && val !== '')
        .map(([k, val]) => `${k}="${escPromLabel(String(val))}"`)
        .join(',')
    : ''
  const suffix = parts ? `{${parts}}` : ''
  const num = Number.isFinite(value) ? value : 0
  return `${name}${suffix} ${num}`
}

export type ExpertPromInput = {
  /** 指标前缀，如 db_agent / rag_agent */
  prefix: string
  /** 进程存活（scrape 成功即 1） */
  up?: boolean
  sli?: Record<string, unknown> | null
  /** 扁平额外 gauges：name → number */
  extraGauges?: Record<string, number>
  /** error code 直方图 */
  errorCodes?: Record<string, number>
}

export function buildExpertPrometheusText(input: ExpertPromInput): string {
  const p = String(input.prefix || 'agent').replace(/[^a-zA-Z0-9_]/g, '_')
  const out: string[] = []
  const up = input.up === false ? 0 : 1
  out.push(`# HELP ${p}_up Expert process scrape target`)
  out.push(`# TYPE ${p}_up gauge`)
  out.push(promLine(`${p}_up`, up))

  const sli = input.sli && typeof input.sli === 'object' ? input.sli : {}
  const numKeys = [
    'p95Ms',
    'p50Ms',
    'samples',
    'sampleCount',
    'failRate',
    'refusalRate',
    'emptyEvidenceRate',
    'retrieveP95Ms',
    'retrieveP50Ms',
    'overallP95Ms',
    'toolErrorRate',
    'pendingWaitP95Ms',
    'okRate',
    'errorRate',
    'queueDepth'
  ]
  for (const k of numKeys) {
    const v = Number((sli as Record<string, unknown>)[k])
    if (!Number.isFinite(v)) continue
    const metric = `${p}_sli_${k.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')}`
    out.push(`# HELP ${metric} Expert SLI ${k}`)
    out.push(`# TYPE ${metric} gauge`)
    out.push(promLine(metric, v))
  }

  const codes =
    input.errorCodes ||
    ((sli as { errorCodes?: Record<string, number> }).errorCodes &&
    typeof (sli as { errorCodes?: unknown }).errorCodes === 'object'
      ? ((sli as { errorCodes: Record<string, number> }).errorCodes)
      : undefined)
  if (codes) {
    for (const [code, n] of Object.entries(codes)) {
      const c = Number(n)
      if (!Number.isFinite(c)) continue
      out.push(`# HELP ${p}_error_code_total Expert error_code counts`)
      out.push(`# TYPE ${p}_error_code_total gauge`)
      out.push(promLine(`${p}_error_code_total`, c, { code: String(code) }))
    }
  }

  if (input.extraGauges) {
    for (const [name, val] of Object.entries(input.extraGauges)) {
      const n = Number(val)
      if (!Number.isFinite(n)) continue
      const metric = `${p}_${String(name).replace(/[^a-zA-Z0-9_]/g, '_')}`
      out.push(`# HELP ${metric} Expert extra gauge`)
      out.push(`# TYPE ${metric} gauge`)
      out.push(promLine(metric, n))
    }
  }

  return out.join('\n') + '\n'
}
