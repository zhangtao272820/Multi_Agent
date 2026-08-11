import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentPgQuery } from '#agent-shared/agentPgClient'
import {
  isPostgresStorageEnabled,
  resolveStorageBackend,
  shouldWriteFile,
  shouldWritePostgres
} from '#agent-shared/storageBackend'
import { isExperienceRecallConfirmedOnly, isConfirmedExperienceRow, shouldRecallExperienceForPlane } from '#agent-shared/experienceRecallPolicy'
import { normalizeTenantId, tenantPolicyDir } from '#agent-shared/tenantScope'

export type DbExperienceRow = {
  ts: string
  question_norm: string
  path?: string
  data_domain?: string
  blueprint_domain?: string
  tables?: string[]
  hint: string
  source?: string
  source_plane?: string
  userConfirmed?: boolean
  status?: string
  tenantId?: string
}

const experienceCacheByTenant = new Map<string, DbExperienceRow[]>()

function experienceFile(tenantId?: string) {
  const dir = tenantPolicyDir(join(process.cwd(), '.data'), normalizeTenantId(tenantId))
  return join(dir, 'db-query-experience.jsonl')
}

function resolveBackend() {
  return resolveStorageBackend(process.env.DB_AGENT_STORAGE_BACKEND, 'file')
}

function readJsonl<T>(file: string, max = 500): T[] {
  if (!existsSync(file)) return []
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-max)
      .map((l) => JSON.parse(l) as T)
  } catch {
    return []
  }
}

export async function hydrateDbExperienceCache(maxLines = 500, tenantId?: string): Promise<void> {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveBackend()
  if (isPostgresStorageEnabled(backend)) {
    const res = await agentPgQuery<{
      ts: string
      question_norm: string
      path: string | null
      data_domain: string | null
      tables: string[] | null
      hint: string
      source: string | null
      source_plane: string | null
    }>(
      `SELECT ts, question_norm, path, data_domain, tables, hint, source, source_plane
       FROM db_query_experience WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2`,
      [tid, maxLines]
    )
    if (res) {
      experienceCacheByTenant.set(
        tid,
        res.rows.reverse().map((r) => ({
          ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
          question_norm: r.question_norm,
          path: r.path ?? undefined,
          data_domain: r.data_domain ?? undefined,
          tables: Array.isArray(r.tables) ? r.tables : undefined,
          hint: r.hint,
          source: r.source ?? undefined,
          source_plane: r.source_plane ?? undefined,
          tenantId: tid
        }))
      )
      return
    }
  }
  experienceCacheByTenant.set(tid, readJsonl<DbExperienceRow>(experienceFile(tid), maxLines))
}

export function readDbExperienceSync(maxLines = 500, tenantId?: string): DbExperienceRow[] {
  const tid = normalizeTenantId(tenantId)
  const cache = experienceCacheByTenant.get(tid)
  if (cache?.length) return cache.slice(-maxLines)
  return readJsonl<DbExperienceRow>(experienceFile(tid), maxLines)
}

/** 召回专用：联邦门控 + 独立端排除 manager_orchestrated */
export function readDbExperienceForRecall(maxLines = 500, tenantId?: string): DbExperienceRow[] {
  const all = readDbExperienceSync(maxLines, tenantId)
  return all.filter((r) => {
    if (!shouldRecallExperienceForPlane('standalone', r)) return false
    if (!isExperienceRecallConfirmedOnly()) return true
    // 本地无 source 的旧行：放行；联邦源由 shouldRecall 已挡
    if (!r.source && !r.source_plane) return true
    return isConfirmedExperienceRow(r)
  })
}

export async function persistDbExperience(row: DbExperienceRow): Promise<void> {
  const tid = normalizeTenantId(row.tenantId)
  const withTenant = { ...row, tenantId: tid }
  const backend = resolveBackend()
  if (shouldWritePostgres(backend)) {
    await agentPgQuery(
      `INSERT INTO db_query_experience
        (ts, question_norm, path, data_domain, tables, hint, tenant_id, source, source_plane)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        withTenant.ts,
        withTenant.question_norm,
        withTenant.path ?? null,
        withTenant.data_domain ?? null,
        withTenant.tables ? JSON.stringify(withTenant.tables) : null,
        withTenant.hint,
        tid,
        withTenant.source ?? null,
        withTenant.source_plane ?? 'standalone'
      ]
    )
  }
  if (shouldWriteFile(backend)) {
    try {
      const dir = tenantPolicyDir(join(process.cwd(), '.data'), tid)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(experienceFile(tid), `${JSON.stringify(withTenant)}\n`, 'utf8')
    } catch {
      /* ignore */
    }
  }
  let cache = experienceCacheByTenant.get(tid)
  if (!cache) cache = []
  cache.push(withTenant)
  if (cache.length > 600) cache = cache.slice(-500)
  experienceCacheByTenant.set(tid, cache)
}
