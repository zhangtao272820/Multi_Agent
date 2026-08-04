import { agentPgQuery } from './agentPgClient'
import {
  isPostgresStorageEnabled,
  resolveStorageBackend,
  shouldWritePostgres
} from './storageBackend'
import { normalizeTenantId } from './tenantScope'

export type RouteStatRow = {
  contextKey: string
  path: string
  trials: number
  successes: number
  empty: number
  avgMs: number
  tenantId?: string
}

export function resolveDbRouteStorageBackend(env: NodeJS.ProcessEnv = process.env) {
  return resolveStorageBackend(env.DB_AGENT_STORAGE_BACKEND, 'file')
}

const routeCacheByTenant = new Map<string, RouteStatRow[]>()

export async function hydrateDbRouteStatsCache(tenantId?: string): Promise<void> {
  const tid = normalizeTenantId(tenantId)
  const res = await agentPgQuery<{
    context_key: string
    path: string
    trials: number
    successes: number
    empty_count: number
    avg_ms: number
  }>(`SELECT context_key, path, trials, successes, empty_count, avg_ms FROM db_route_stats WHERE tenant_id = $1`, [
    tid
  ])
  if (!res) {
    routeCacheByTenant.set(tid, [])
    return
  }
  routeCacheByTenant.set(
    tid,
    res.rows.map((r) => ({
      contextKey: r.context_key,
      path: r.path,
      trials: r.trials,
      successes: r.successes,
      empty: r.empty_count,
      avgMs: r.avg_ms,
      tenantId: tid
    }))
  )
}

export function readDbRouteStatsSync(tenantId?: string): RouteStatRow[] {
  const tid = normalizeTenantId(tenantId)
  const cache = routeCacheByTenant.get(tid)
  if (cache) return [...cache]
  return []
}

export async function upsertDbRouteStat(row: RouteStatRow): Promise<void> {
  const tid = normalizeTenantId(row.tenantId)
  const withTenant = { ...row, tenantId: tid }
  const backend = resolveDbRouteStorageBackend()
  if (shouldWritePostgres(backend)) {
    await agentPgQuery(
      `INSERT INTO db_route_stats (context_key, path, trials, successes, empty_count, avg_ms, updated_at, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
       ON CONFLICT (tenant_id, context_key, path) DO UPDATE SET
         trials = EXCLUDED.trials,
         successes = EXCLUDED.successes,
         empty_count = EXCLUDED.empty_count,
         avg_ms = EXCLUDED.avg_ms,
         updated_at = NOW()`,
      [withTenant.contextKey, withTenant.path, withTenant.trials, withTenant.successes, withTenant.empty, withTenant.avgMs, tid]
    )
  }
  let cache = routeCacheByTenant.get(tid)
  if (!cache) cache = []
  const key = `${withTenant.contextKey}|${withTenant.path}`
  const idx = cache.findIndex((r) => `${r.contextKey}|${r.path}` === key)
  if (idx >= 0) cache[idx] = withTenant
  else cache.push(withTenant)
  routeCacheByTenant.set(tid, cache)
}

export async function replaceDbRouteStats(rows: RouteStatRow[], tenantId?: string): Promise<void> {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveDbRouteStorageBackend()
  if (shouldWritePostgres(backend)) {
    await agentPgQuery(`DELETE FROM db_route_stats WHERE tenant_id = $1`, [tid])
    for (const row of rows) {
      await upsertDbRouteStat({ ...row, tenantId: tid })
    }
    routeCacheByTenant.set(tid, rows.map((r) => ({ ...r, tenantId: tid })))
    return
  }
  routeCacheByTenant.set(
    tid,
    rows.map((r) => ({ ...r, tenantId: tid }))
  )
}

export async function clearDbRouteStats(tenantId?: string): Promise<void> {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveDbRouteStorageBackend()
  if (shouldWritePostgres(backend)) {
    await agentPgQuery(`DELETE FROM db_route_stats WHERE tenant_id = $1`, [tid])
  }
  routeCacheByTenant.set(tid, [])
}

export function shouldUseDbRoutePg(): boolean {
  return isPostgresStorageEnabled(resolveDbRouteStorageBackend())
}
