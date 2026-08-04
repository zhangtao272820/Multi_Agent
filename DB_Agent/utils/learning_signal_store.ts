import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentPgQuery } from '#agent-shared/agentPgClient'
import {
  isPostgresStorageEnabled,
  resolveStorageBackend,
  shouldWriteFile,
  shouldWritePostgres
} from '#agent-shared/storageBackend'
import { normalizeTenantId, tenantPolicyDir } from '#agent-shared/tenantScope'

export type DbLearningSignalRow = {
  ts: string
  question: string
  question_norm: string
  path?: string
  ok: boolean
  empty?: boolean
  data_domain?: string
  intent?: string
  tables?: string[]
  ms?: number
  reason?: string
  feedback?: number
  tenantId?: string
}

const signalsCacheByTenant = new Map<string, DbLearningSignalRow[]>()

function dataDir(tenantId?: string) {
  const base = join(process.cwd(), '.data')
  const dir = tenantPolicyDir(base, normalizeTenantId(tenantId))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function signalsFilePath(tenantId?: string) {
  return join(dataDir(tenantId), 'db-learning-signals.jsonl')
}

export function resolveDbStorageBackend(env: NodeJS.ProcessEnv = process.env) {
  return resolveStorageBackend(env.DB_AGENT_STORAGE_BACKEND, 'file')
}

function appendSignalToFile(row: DbLearningSignalRow): void {
  try {
    appendFileSync(signalsFilePath(row.tenantId), `${JSON.stringify(row)}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

async function appendSignalToPg(row: DbLearningSignalRow): Promise<boolean> {
  const tid = normalizeTenantId(row.tenantId)
  const res = await agentPgQuery(
    `INSERT INTO db_learning_signals
      (ts, question, question_norm, path, ok, empty, data_domain, intent, tables, ms, reason, feedback, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      row.ts,
      row.question,
      row.question_norm,
      row.path ?? null,
      row.ok,
      row.empty ?? null,
      row.data_domain ?? null,
      row.intent ?? null,
      row.tables ? JSON.stringify(row.tables) : null,
      row.ms ?? null,
      row.reason ?? null,
      row.feedback ?? null,
      tid
    ]
  )
  return Boolean(res)
}

/** 双写 learning signal：file / postgres / dual */
export async function persistDbLearningSignal(row: DbLearningSignalRow): Promise<void> {
  const tid = normalizeTenantId(row.tenantId)
  const withTenant = { ...row, tenantId: tid }
  const backend = resolveDbStorageBackend()

  if (shouldWritePostgres(backend)) {
    try {
      await appendSignalToPg(withTenant)
    } catch {
      /* fallback to file if dual */
    }
  }

  if (shouldWriteFile(backend)) {
    appendSignalToFile(withTenant)
  }
  let cache = signalsCacheByTenant.get(tid)
  if (!cache) cache = []
  cache.push(withTenant)
  if (cache.length > 1000) cache = cache.slice(-800)
  signalsCacheByTenant.set(tid, cache)
}

function readJsonlLines<T>(file: string, maxLines = 400): T[] {
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    const slice = lines.slice(-maxLines)
    const out: T[] = []
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        /* skip */
      }
    }
    return out
  } catch {
    return []
  }
}

async function readSignalsFromPg(maxLines = 400, tenantId?: string): Promise<DbLearningSignalRow[] | null> {
  const tid = normalizeTenantId(tenantId)
  const res = await agentPgQuery<{
    ts: string
    question: string
    question_norm: string
    path: string | null
    ok: boolean
    empty: boolean | null
    data_domain: string | null
    intent: string | null
    tables: string[] | null
    ms: number | null
    reason: string | null
    feedback: number | null
  }>(
    `SELECT ts, question, question_norm, path, ok, empty, data_domain, intent, tables, ms, reason, feedback
     FROM db_learning_signals
     WHERE tenant_id = $1
     ORDER BY id DESC
     LIMIT $2`,
    [tid, maxLines]
  )
  if (!res) return null
  return res.rows.reverse().map((r) => ({
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    question: r.question,
    question_norm: r.question_norm,
    path: r.path ?? undefined,
    ok: r.ok,
    empty: r.empty ?? undefined,
    data_domain: r.data_domain ?? undefined,
    intent: r.intent ?? undefined,
    tables: Array.isArray(r.tables) ? r.tables : undefined,
    ms: r.ms ?? undefined,
    reason: r.reason ?? undefined,
    feedback: r.feedback ?? undefined,
    tenantId: tid
  }))
}

/** 读取 learning signals：PG 优先（postgres/dual），失败回退 jsonl */
export async function readDbLearningSignalsAsync(maxLines = 400, tenantId?: string): Promise<DbLearningSignalRow[]> {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveDbStorageBackend()
  if (isPostgresStorageEnabled(backend)) {
    const pg = await readSignalsFromPg(maxLines, tid)
    if (pg?.length) return pg
    if (backend === 'postgres' && pg) return pg
  }
  return readJsonlLines<DbLearningSignalRow>(signalsFilePath(tid), maxLines)
}

export async function hydrateDbSignalsCache(maxLines = 800, tenantId?: string): Promise<void> {
  const tid = normalizeTenantId(tenantId)
  signalsCacheByTenant.set(tid, await readDbLearningSignalsAsync(maxLines, tid))
}

/** 同步读取：postgres 模式用启动预热缓存，否则读 jsonl */
export function readDbLearningSignalsSync(maxLines = 400, tenantId?: string): DbLearningSignalRow[] {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveDbStorageBackend()
  const cache = signalsCacheByTenant.get(tid)
  if (isPostgresStorageEnabled(backend) && cache?.length) {
    return cache.slice(-maxLines)
  }
  return readJsonlLines<DbLearningSignalRow>(signalsFilePath(tid), maxLines)
}

export async function getDbMemoryStatus(): Promise<{
  backend: ReturnType<typeof resolveDbStorageBackend>
  pgConfigured: boolean
  pgReachable: boolean
}> {
  const backend = resolveDbStorageBackend()
  const { isAgentPgConfigured, pingAgentPg } = await import('#agent-shared/agentPgClient')
  const pgConfigured = isAgentPgConfigured()
  let pgReachable = false
  if (pgConfigured && isPostgresStorageEnabled(backend)) {
    pgReachable = await pingAgentPg()
  }
  return { backend, pgConfigured, pgReachable }
}
