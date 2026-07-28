import path from 'node:path'
import { buildManagerMetricsDashboard } from '../graph/core/runtime/metricsAggregate'
import { buildAgentRegistry } from '../graph/core/agent/agentRegistry'
import { aggregateManagerSli } from '../graph/core/runtime/sliAggregate'
import { isPolicyCanaryEnabled, policyCanaryPercent } from '../graph/core/evolution/policyCanary'
import { promptCanaryPercent, plannerRulesCanaryPercent } from '../graph/core/evolution/artifactCanary'
import { isEvolutionAutoExperimentEnabled } from '../graph/core/evolution/evolutionExperiments'

import { aggregateTokensByTier } from '../graph/core/agent/capabilityTier'
import { resolveTokenAccounting } from '../graph/core/runtime/runBudget'
import { getBackpressureSnapshot } from '../graph/core/runtime/backpressure'

const WORKER_AGENT_PHASES = new Set([
  'db',
  'rag',
  'code',
  'crawler',
  'admin',
  'multimodal',
  'music',
  'video',
  'clean',
  'report'
])

function resolveMetricAgent(rec: Record<string, unknown>): string | null {
  const direct = String(rec?.agent || '').trim()
  if (direct) return direct
  const extra = rec?.extra
  if (extra && typeof extra === 'object') {
    const fromExtra = String((extra as Record<string, unknown>).agent || '').trim()
    if (fromExtra) return fromExtra
  }
  const phase = String(rec?.phase || '').trim()
  if (WORKER_AGENT_PHASES.has(phase)) return phase
  return null
}

export default defineEventHandler(async () => {
  const policyDir = path.join(process.cwd(), '.data')
  const memJsonlPath = path.join(policyDir, 'manager-memory.jsonl')
  const memJsonPath = path.join(policyDir, 'manager-memory.json')
  const metJsonlPath = path.join(policyDir, 'manager-metrics.jsonl')
  const metJsonPath = path.join(policyDir, 'manager-metrics.json')
  const fs = await import('node:fs/promises')
  const readJson = async (p: string) => {
    try {
      const t = await fs.readFile(p, 'utf8')
      return t.trim() ? JSON.parse(t) : null
    } catch {
      return null
    }
  }
  const readJsonl = async (p: string, maxLines = 800) => {
    const t = await fs.readFile(p, 'utf8').catch(() => '')
    if (!t.trim()) return []
    const lines = t.split('\n').filter((l) => l.trim()).slice(-Math.max(1, maxLines))
    const out: any[] = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line))
      } catch {}
    }
    return out
  }

  const memJsonl = await readJsonl(memJsonlPath, 400)
  const memoryEntries = memJsonl.length ? memJsonl : (((await readJson(memJsonPath))?.history as any[]) ?? [])

  const metJsonl = await readJsonl(metJsonlPath, 1200)
  let metricEntries: any[] = metJsonl
  if (!metricEntries.length) {
    const obj = (await readJson(metJsonPath)) as any
    const runs = obj?.runs ? Object.keys(obj.runs) : []
    const out: any[] = []
    for (const id of runs) {
      const arr = Array.isArray(obj.runs[id]) ? obj.runs[id] : []
      for (const rec of arr) out.push({ runId: id, ...rec })
    }
    metricEntries = out
  }

  const runIds = new Set<string>()
  const phaseAgg: Record<string, { count: number; totalMs: number }> = {}
  let totalTokens = 0
  let totalUsd = 0
  const tokensByPhase: Record<string, number> = {}
  const tokensByAgent: Record<string, number> = {}
  const tokensByModel: Record<string, number> = {}
  const recentMetrics: Array<{
    ts?: string
    runId?: string
    phase?: string
    ms?: number
    tokens?: number
    usd?: number
    model?: string
  }> = []
  for (const rec of Array.isArray(metricEntries) ? metricEntries : []) {
    const runId = String(rec?.runId ?? '').trim()
    if (runId) runIds.add(runId)
    const k = String(rec?.phase || 'unknown')
    const ms = Number(rec?.ms || 0)
    if (!phaseAgg[k]) phaseAgg[k] = { count: 0, totalMs: 0 }
    phaseAgg[k].count += 1
    phaseAgg[k].totalMs += Number.isFinite(ms) ? ms : 0
    const tok = Number(rec?.tokens || 0)
    if (Number.isFinite(tok) && tok > 0) {
      totalTokens += tok
      tokensByPhase[k] = (tokensByPhase[k] || 0) + tok
      const agentBucket = resolveMetricAgent(rec as Record<string, unknown>)
      if (agentBucket) tokensByAgent[agentBucket] = (tokensByAgent[agentBucket] || 0) + tok
      const model = String(rec?.model || 'unknown').trim() || 'unknown'
      tokensByModel[model] = (tokensByModel[model] || 0) + tok
    }
    const usd = Number(rec?.usd || 0)
    if (Number.isFinite(usd) && usd > 0) totalUsd += usd
    recentMetrics.push({
      ts: typeof rec?.ts === 'string' ? rec.ts : undefined,
      runId: runId || undefined,
      phase: k,
      ms: Number.isFinite(ms) ? ms : undefined,
      tokens: Number.isFinite(tok) && tok > 0 ? tok : undefined,
      usd: Number.isFinite(usd) && usd > 0 ? usd : undefined,
      model: typeof rec?.model === 'string' ? rec.model : undefined
    })
  }
  const summary: Record<string, { count: number; avgMs: number }> = {}
  for (const [k, v] of Object.entries(phaseAgg)) {
    summary[k] = { count: v.count, avgMs: v.count ? Math.round(v.totalMs / v.count) : 0 }
  }
  recentMetrics.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))

  const dashboard = await buildManagerMetricsDashboard(policyDir).catch(() => null)
  const sli =
    dashboard?.sli ??
    aggregateManagerSli(
      (Array.isArray(metricEntries) ? metricEntries : []) as Array<Record<string, unknown>>,
      metJsonl.length ? metJsonl : []
    )

  let toolHealth: unknown = null
  try {
    const raw = await fs.readFile(path.join(policyDir, 'manager-tool-health.json'), 'utf8')
    toolHealth = JSON.parse(raw)
  } catch {}

  return {
    ok: true,
    runs: runIds.size,
    phases: summary,
    tokenSummary: {
      totalTokens,
      totalUsd: Math.round(totalUsd * 10000) / 10000,
      byPhase: tokensByPhase,
      byModel: tokensByModel,
      byAgent: tokensByAgent,
      byModelTier: aggregateTokensByTier(
        (Array.isArray(metricEntries) ? metricEntries : []).map((rec) => ({
          model: rec?.model,
          tokens: rec?.tokens
        }))
      ),
      /** E3：estimated=无账单；actual=有 usd；mixed=二者皆有 */
      tokenAccounting: resolveTokenAccounting(
        (Array.isArray(metricEntries) ? metricEntries : []) as Array<{
          tokens?: unknown
          usd?: unknown
          usageActual?: unknown
        }>
      )
    },
    recentMetrics: recentMetrics.slice(0, 60),
    memory: Array.isArray(memoryEntries) ? memoryEntries.slice(-20) : [],
    evolution: dashboard,
    agentRegistry: buildAgentRegistry(),
    toolHealth,
    policyCanary: {
      enabled: isPolicyCanaryEnabled(),
      percent: policyCanaryPercent()
    },
    promptCanary: {
      percent: promptCanaryPercent()
    },
    plannerRulesCanary: {
      percent: plannerRulesCanaryPercent()
    },
    evolutionAutoExperiment: isEvolutionAutoExperimentEnabled(),
    /** N3 最小 SLI：P95、专家错误率、HITL、拒答、Token；G2 背压 */
    sli: {
      ...sli,
      inflight: getBackpressureSnapshot().inflightRuns,
      queueDepth: getBackpressureSnapshot().queueDepth,
      inflightByExpert: getBackpressureSnapshot().inflightByExpert
    },
    /** R2/D2/A3：可选拉取专家本地 SLI；任一失败不影响主响应 */
    experts: await (async () => {
      async function fetchExpertSli(
        baseUrl: string
      ): Promise<{ sli?: Record<string, unknown>; capabilityAudit?: Record<string, unknown> } | undefined> {
        const root = String(baseUrl || '')
          .trim()
          .replace(/\/+$/, '')
        if (!root) return undefined
        try {
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), 1500)
          const res = await fetch(`${root}/api/metrics`, { signal: ctrl.signal }).catch(() => null)
          clearTimeout(t)
          if (!res?.ok) return undefined
          const body = (await res.json()) as {
            sli?: Record<string, unknown>
            capabilityAudit?: Record<string, unknown>
          }
          if (!body?.sli && !body?.capabilityAudit) return undefined
          return {
            ...(body.sli ? { sli: body.sli } : {}),
            ...(body.capabilityAudit ? { capabilityAudit: body.capabilityAudit } : {})
          }
        } catch {
          return undefined
        }
      }

      const ragUrl = String(process.env.RAG_AGENT_HTTP_URL || process.env.NUXT_RAG_AGENT_HTTP_URL || '').trim()
      const dbUrl = String(process.env.DB_AGENT_HTTP_URL || process.env.NUXT_DB_AGENT_HTTP_URL || '').trim()
      const adminUrl = String(
        process.env.AI_ADMIN_AGENT_HTTP_URL ||
          process.env.NUXT_AI_ADMIN_AGENT_HTTP_URL ||
          process.env.ADMIN_AGENT_HTTP_URL ||
          ''
      ).trim()
      const codeUrl = String(
        process.env.CODE_AGENT_HTTP_URL ||
          process.env.NUXT_CODE_AGENT_HTTP_URL ||
          (() => {
            const ws = String(process.env.CODE_AGENT_WS_URL || process.env.NUXT_CODE_AGENT_WS_URL || '').trim()
            if (!ws) return ''
            try {
              const u = new URL(ws)
              return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
            } catch {
              return ''
            }
          })()
      ).trim()
      const extractorUrl = String(
        process.env.EXTRACTOR_AGENT_HTTP_URL ||
          process.env.NUXT_EXTRACTOR_AGENT_HTTP_URL ||
          process.env.CRAWLER_AGENT_HTTP_URL ||
          process.env.NUXT_CRAWLER_AGENT_HTTP_URL ||
          ''
      ).trim()
      const lobsterUrl = String(
        process.env.LOBSTER_AGENT_HTTP_URL || process.env.NUXT_LOBSTER_AGENT_HTTP_URL || ''
      ).trim()

      const [rag, db, admin, code, extractor, lobster] = await Promise.all([
        fetchExpertSli(ragUrl),
        fetchExpertSli(dbUrl),
        fetchExpertSli(adminUrl),
        fetchExpertSli(codeUrl),
        fetchExpertSli(extractorUrl),
        fetchExpertSli(lobsterUrl)
      ])
      const out: Record<string, unknown> = {}
      if (rag) out.rag = rag
      if (db) out.db = db
      if (admin) out.admin = admin
      if (code) out.code = code
      if (extractor) out.extractor = extractor
      if (lobster) out.lobster = lobster
      return Object.keys(out).length ? out : undefined
    })()
  }
})
