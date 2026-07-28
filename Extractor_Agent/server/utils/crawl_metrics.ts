/**
 * 采集路径观测：通道命中率、质量门禁、空结果率。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type CrawlChannel = 'http' | 'browser' | 'mcp' | 'skill' | 'unknown'

export type CrawlMetricEvent = {
  target_site?: string
  content_type?: string
  channel?: CrawlChannel
  ok: boolean
  empty?: boolean
  quality_passed?: boolean
  retry_triggered?: boolean
  ms?: number
  task?: string
  status?: string
  reason?: string
}

export type ExtractRunMeta = {
  target_site?: string
  content_type?: string
  primary_channel: CrawlChannel
  route_reason?: string
  quality_passed?: boolean
  item_count?: number
  retry_triggered?: boolean
  status?: string
  needs_clarification?: boolean
  seed_first?: boolean
  manager_seed_count?: number
  serp_fallback?: boolean
  cloud_scrape_calls?: number
  channel_trace_count?: number
  extract_path?: string
  llm_extract_calls?: number
  template_hit?: boolean
  patch_hit?: boolean
  patch_id?: string
}

const counters: Record<string, number> = {}
let lastRunMeta: ExtractRunMeta | null = null

function dataDir() {
  const dir = join(process.cwd(), '.data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function metricsFile() {
  return join(dataDir(), 'extractor-query-metrics.jsonl')
}

export function setRunMeta(meta: ExtractRunMeta | null) {
  lastRunMeta = meta
}

export function getRunMeta() {
  return lastRunMeta
}

export function inferPrimaryChannel(stats: any): CrawlChannel {
  const events = Array.isArray(stats?._events) ? stats._events : []
  const counts: Record<string, number> = {}
  for (const e of events) {
    if (e?.status !== 'ok') continue
    const ch = String(e?.channel ?? 'unknown')
    counts[ch] = (counts[ch] || 0) + 1
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const top = ranked[0]?.[0]
  if (top === 'http' || top === 'browser' || top === 'mcp' || top === 'skill') return top
  return 'unknown'
}

export function inferRouteReason(stats: any, retry?: any): string | undefined {
  const log = Array.isArray(stats?._routeLog) ? stats._routeLog : []
  const first = log[0]
  if (first?.reason) return String(first.reason)
  if (retry?.retryChannel && retry.retryChannel !== 'none') return `retry_${retry.retryChannel}`
  return undefined
}

export function buildExtractRunMeta(result: any): ExtractRunMeta {
  const stats = result?.stats ?? {}
  const tp = result?.taskPlan ?? {}
  const runMeta = result?.meta ?? {}
  const status = String(result?.status ?? '')
  const needsClarification = status === 'needs_clarification'
  const channelTrace = Array.isArray(stats?._channelTrace) ? stats._channelTrace : []
  return {
    target_site: tp.targetSite ? String(tp.targetSite) : undefined,
    content_type: tp.contentType ? String(tp.contentType) : undefined,
    primary_channel: inferPrimaryChannel(stats),
    route_reason: inferRouteReason(stats, result?.retry),
    quality_passed: Boolean(result?.quality?.passed),
    item_count: Array.isArray(result?.items) ? result.items.length : 0,
    retry_triggered: Boolean(result?.retry?.triggered),
    status,
    needs_clarification: needsClarification,
    seed_first: Boolean(runMeta.seed_first),
    manager_seed_count: Number(runMeta.manager_seed_count ?? 0) || undefined,
    serp_fallback: Boolean(runMeta.serp_fallback),
    cloud_scrape_calls:
      Number(runMeta.cloud_scrape_calls ?? 0) ||
      channelTrace.filter((e: any) => e?.channel === 'mcp').length ||
      undefined,
    channel_trace_count: channelTrace.length || undefined,
    extract_path: runMeta.extract_path ? String(runMeta.extract_path) : undefined,
    llm_extract_calls: Number(runMeta.llm_extract_calls ?? 0) || undefined,
    template_hit: runMeta.template_hit === true ? true : undefined,
    patch_hit: runMeta.patch_hit === true ? true : undefined,
    patch_id: runMeta.patch_id ? String(runMeta.patch_id) : undefined,
  }
}

export function recordCrawlMetric(ev: CrawlMetricEvent) {
  const key = `${ev.target_site || 'generic'}:${ev.channel || 'unknown'}:${ev.ok ? 'ok' : 'fail'}${ev.empty ? ':empty' : ''}${ev.quality_passed === false ? ':quality_fail' : ''}`
  counters[key] = (counters[key] || 0) + 1
  try {
    const line = JSON.stringify({ ...ev, at: new Date().toISOString() })
    appendFileSync(metricsFile(), `${line}\n`, 'utf8')
  } catch {
    /* 观测失败不影响主链路 */
  }
}

export function getCrawlMetricCounters() {
  return { ...counters }
}

export function readRecentCrawlMetrics(limit = 50): Array<CrawlMetricEvent & { at?: string }> {
  try {
    const file = metricsFile()
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as CrawlMetricEvent & { at?: string }
        } catch {
          return null
        }
      })
      .filter(Boolean) as Array<CrawlMetricEvent & { at?: string }>
  } catch {
    return []
  }
}

export function aggregateCrawlMetrics(recent: Array<CrawlMetricEvent & { at?: string }>) {
  let total = 0
  let ok = 0
  let empty = 0
  let qualityFail = 0
  let retry = 0
  const byChannel: Record<string, number> = {}
  const bySite: Record<string, number> = {}
  for (const row of recent) {
    total++
    if (row.ok) ok++
    if (row.empty) empty++
    if (row.quality_passed === false) qualityFail++
    if (row.retry_triggered) retry++
    const ch = row.channel || 'unknown'
    byChannel[ch] = (byChannel[ch] || 0) + 1
    const site = row.target_site || 'generic'
    bySite[site] = (bySite[site] || 0) + 1
  }
  return {
    total,
    ok,
    empty,
    qualityFail,
    retry,
    okRate: total ? ok / total : 0,
    byChannel,
    bySite,
  }
}

/** E2：与 DB/RAG 同形的 SLI，供 Manager experts.extractor 消费 */
export function getExtractorSliSummary(limit = 80) {
  const recent = readRecentCrawlMetrics(limit)
  const agg = aggregateCrawlMetrics(recent)
  const msVals = recent.map((r) => Number(r.ms || 0)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  const p95Ms = msVals.length ? msVals[Math.min(msVals.length - 1, Math.floor(msVals.length * 0.95))] : null
  const p50Ms = msVals.length ? msVals[Math.min(msVals.length - 1, Math.floor(msVals.length * 0.5))] : null
  const errorCodes: Record<string, number> = {}
  for (const row of recent) {
    if (row.ok) continue
    const code = String(row.reason || row.status || 'fail').slice(0, 64) || 'fail'
    errorCodes[code] = (errorCodes[code] || 0) + 1
  }
  return {
    p95Ms,
    p50Ms,
    sampleCount: agg.total,
    okRate: agg.okRate,
    emptyRate: agg.total ? agg.empty / agg.total : 0,
    errorCodes,
  }
}
