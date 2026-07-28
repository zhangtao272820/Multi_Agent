import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { resolveMetricAgent, type RunMetricRow } from './runObservability'

export function isManagerOtelExportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_OTEL_EXPORT ?? '').trim() === '1'
}

/** E1：默认开启 W3C traceparent 出站；设 MANAGER_OTEL_TRACEPARENT=0 可关 */
export function isManagerOtelTraceparentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.MANAGER_OTEL_TRACEPARENT ?? '1').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

/** W3C traceparent：由 runId/traceId 派生，便于下游 HTTP 透传 */
export function buildW3cTraceparent(traceId: string): string {
  const hex = String(traceId || '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toLowerCase()
  const tid = (hex + '0'.repeat(32)).slice(0, 32)
  const spanId = crypto.randomBytes(8).toString('hex')
  return `00-${tid}-${spanId}-01`
}

export type OtelSpanExport = {
  traceId: string
  spanId: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes?: Record<string, string | number>
}

export type OtelTraceExport = {
  traceId: string
  runId: string
  spans: OtelSpanExport[]
}

function toUnixNano(isoTs: string | undefined, fallbackMs: number): string {
  const ms = isoTs ? Date.parse(isoTs) : fallbackMs
  const safe = Number.isFinite(ms) ? ms : fallbackMs
  return String(Math.floor(safe * 1_000_000))
}

function spanIdFrom(runId: string, phase: string, idx: number): string {
  return crypto.createHash('sha256').update(`${runId}:${phase}:${idx}`).digest('hex').slice(0, 16)
}

export function buildOtelTracesFromMetrics(rows: RunMetricRow[], limit = 50): OtelTraceExport[] {
  const grouped = new Map<string, RunMetricRow[]>()
  for (const row of rows) {
    const runId = String(row.runId || '').trim()
    if (!runId) continue
    const bucket = grouped.get(runId) || []
    bucket.push(row)
    grouped.set(runId, bucket)
  }

  const traces: OtelTraceExport[] = []
  for (const [runId, recs] of grouped) {
    const sorted = [...recs].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
    let cursorMs = sorted.length && sorted[0]?.ts ? Date.parse(String(sorted[0].ts)) : Date.now()
    if (!Number.isFinite(cursorMs)) cursorMs = Date.now()

    const spans: OtelSpanExport[] = []
    sorted.forEach((rec, idx) => {
      const phase = String(rec.phase || 'unknown')
      const ms = Number(rec.ms || 0)
      const startMs = rec.ts ? Date.parse(String(rec.ts)) : cursorMs
      const safeStart = Number.isFinite(startMs) ? startMs : cursorMs
      const endMs = safeStart + (Number.isFinite(ms) && ms > 0 ? ms : 1)
      cursorMs = endMs
      const agent = resolveMetricAgent(rec)
      spans.push({
        traceId: runId.replace(/[^a-fA-F0-9]/g, '').toLowerCase().padEnd(32, '0').slice(0, 32),
        spanId: spanIdFrom(runId, phase, idx),
        name: agent ? `manager/${agent}:${phase}` : `manager/${phase}`,
        startTimeUnixNano: toUnixNano(rec.ts, safeStart),
        endTimeUnixNano: toUnixNano(undefined, endMs),
        attributes: {
          runId,
          phase,
          ...(agent ? { agent } : {}),
          ...(Number(rec.tokens) > 0 ? { tokens: Number(rec.tokens) } : {})
        }
      })
    })

    if (spans.length) {
      traces.push({
        traceId: spans[0]!.traceId,
        runId,
        spans
      })
    }
  }

  return traces.slice(-Math.max(1, limit))
}

export async function readRecentRunMetrics(dataDir?: string, maxLines = 4000): Promise<RunMetricRow[]> {
  const dir = dataDir || path.join(process.cwd(), '.data')
  const p = path.join(dir, 'manager-metrics.jsonl')
  try {
    const text = await fs.readFile(p, 'utf8')
    const lines = text.split('\n').filter((l) => l.trim()).slice(-maxLines)
    const out: RunMetricRow[] = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as RunMetricRow)
      } catch {}
    }
    return out
  } catch {
    return []
  }
}
