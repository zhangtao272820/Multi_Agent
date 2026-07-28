/**
 * Code Agent 执行路径观测（进程内计数 + .data 落盘）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCodeAgentEnv } from './code_agent_env'

export type CodeQueryPath = 'compute' | 'inspect' | 'edit' | 'script' | 'full' | 'retrieve'

export type CodeQueryMetricEvent = {
  path: CodeQueryPath
  ok: boolean
  ms?: number
  question?: string
  from_manager?: boolean
  tool_calls?: number
  reason?: string
}

const counters: Record<string, number> = {}

function metricsFile() {
  const dir = join(process.cwd(), '.data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'code-query-metrics.jsonl')
}

export function recordCodeQueryMetric(ev: CodeQueryMetricEvent) {
  if (!getCodeAgentEnv().enableMetrics) return
  const key = `${ev.path}:${ev.ok ? 'ok' : 'fail'}`
  counters[key] = (counters[key] || 0) + 1
  if (!ev.ok && ev.reason) {
    const codeKey = `error_code:${String(ev.reason).slice(0, 64)}`
    counters[codeKey] = (counters[codeKey] || 0) + 1
  }
  try {
    const line = JSON.stringify({ ...ev, at: new Date().toISOString() })
    appendFileSync(metricsFile(), `${line}\n`, 'utf8')
  } catch {
    /* 观测失败不影响主链路 */
  }
}

export function getCodeQueryMetricCounters() {
  return { ...counters }
}

export function readRecentCodeMetrics(limit?: number): CodeQueryMetricEvent[] {
  const cap = limit ?? getCodeAgentEnv().metricsRecentLimit
  try {
    const file = metricsFile()
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    return lines
      .slice(-cap)
      .map((l) => {
        try {
          return JSON.parse(l) as CodeQueryMetricEvent
        } catch {
          return null
        }
      })
      .filter(Boolean) as CodeQueryMetricEvent[]
  } catch {
    return []
  }
}

function p95(vals: number[]): number | null {
  if (!vals.length) return null
  const sorted = [...vals].sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1))
  return sorted[idx]
}

/** §2.8.5：供 Manager experts.code 消费的 SLI */
export function getCodeSliSummary(limit?: number) {
  const recent = readRecentCodeMetrics(limit)
  const latencies = recent.map((r) => Number(r.ms) || 0).filter((n) => n > 0)
  const errorCodes: Record<string, number> = {}
  for (const [k, v] of Object.entries(counters)) {
    if (k.startsWith('error_code:')) errorCodes[k.slice('error_code:'.length)] = v
  }
  for (const r of recent) {
    if (!r.ok && r.reason) {
      const code = String(r.reason).slice(0, 64)
      if (errorCodes[code] == null) errorCodes[code] = 0
    }
  }
  const fails = recent.filter((r) => !r.ok).length
  const sorted = [...latencies].sort((a, b) => a - b)
  return {
    p95Ms: p95(latencies),
    p50Ms: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
    sampleCount: recent.length,
    failRate: recent.length ? fails / recent.length : 0,
    errorCodes,
    maxToolRounds: getCodeAgentEnv().maxToolRounds,
  }
}
