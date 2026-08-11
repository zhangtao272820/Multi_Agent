import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentPgQuery } from '#agent-shared/agentPgClient'
import { shouldRecallExperienceForPlane } from '#agent-shared/experienceRecallPolicy'
import {
  isPostgresStorageEnabled,
  resolveStorageBackend,
  shouldWriteFile,
  shouldWritePostgres
} from '#agent-shared/storageBackend'
import { normalizeTenantId, tenantPolicyDir } from '#agent-shared/tenantScope'

export type RagLearningSignalRow = {
  question: string
  question_norm?: string
  score: number
  comment?: string
  path?: string
  source?: string
  source_plane?: string
  at: string
  tenantId?: string
}

const signalsCacheByTenant = new Map<string, RagLearningSignalRow[]>()

function dataDir(tenantId?: string) {
  const base = join(process.cwd(), '.data')
  const dir = tenantPolicyDir(base, normalizeTenantId(tenantId))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function signalsFilePath(tenantId?: string) {
  return join(dataDir(tenantId), 'rag-learning-signals.jsonl')
}

export function resolveRagStorageBackend(env: NodeJS.ProcessEnv = process.env) {
  return resolveStorageBackend(env.RAG_AGENT_STORAGE_BACKEND, 'file')
}

function readJsonlLines<T>(file: string, maxLines = 500): T[] {
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

function appendSignalToFile(row: RagLearningSignalRow): void {
  try {
    appendFileSync(signalsFilePath(row.tenantId), `${JSON.stringify(row)}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

async function appendSignalToPg(row: RagLearningSignalRow): Promise<boolean> {
  const tid = normalizeTenantId(row.tenantId)
  const res = await agentPgQuery(
    `INSERT INTO rag_learning_signals
      (at, question, question_norm, score, comment, path, source, tenant_id, source_plane)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.at,
      row.question,
      row.question_norm ?? null,
      row.score,
      row.comment ?? null,
      row.path ?? null,
      row.source ?? null,
      tid,
      row.source_plane ?? 'standalone'
    ]
  )
  return Boolean(res)
}

async function readSignalsFromPg(maxLines = 500, tenantId?: string): Promise<RagLearningSignalRow[] | null> {
  const tid = normalizeTenantId(tenantId)
  const res = await agentPgQuery<{
    at: string
    question: string
    question_norm: string | null
    score: number
    comment: string | null
    path: string | null
    source: string | null
    source_plane: string | null
  }>(
    `SELECT at, question, question_norm, score, comment, path, source, source_plane
     FROM rag_learning_signals
     WHERE tenant_id = $1
     ORDER BY id DESC
     LIMIT $2`,
    [tid, maxLines]
  )
  if (!res) return null
  return res.rows.reverse().map((r) => ({
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
    question: r.question,
    question_norm: r.question_norm ?? undefined,
    score: Number(r.score),
    comment: r.comment ?? undefined,
    path: r.path ?? undefined,
    source: r.source ?? undefined,
    source_plane: r.source_plane ?? undefined,
    tenantId: tid
  }))
}

export async function readRagLearningSignalsAsync(maxLines = 500, tenantId?: string): Promise<RagLearningSignalRow[]> {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveRagStorageBackend()
  if (isPostgresStorageEnabled(backend)) {
    const pg = await readSignalsFromPg(maxLines, tid)
    if (pg?.length) return pg
    if (backend === 'postgres' && pg) return pg
  }
  return readJsonlLines<RagLearningSignalRow>(signalsFilePath(tid), maxLines)
}

export async function hydrateRagSignalsCache(maxLines = 600, tenantId?: string): Promise<void> {
  const tid = normalizeTenantId(tenantId)
  signalsCacheByTenant.set(tid, await readRagLearningSignalsAsync(maxLines, tid))
}

export function invalidateRagSignalsCache(tenantId?: string): void {
  if (tenantId) signalsCacheByTenant.delete(normalizeTenantId(tenantId))
  else signalsCacheByTenant.clear()
}

export function readRagLearningSignalsSync(maxLines = 500, tenantId?: string): RagLearningSignalRow[] {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveRagStorageBackend()
  const cache = signalsCacheByTenant.get(tid)
  const rows =
    isPostgresStorageEnabled(backend) && cache?.length
      ? cache.slice(-maxLines)
      : readJsonlLines<RagLearningSignalRow>(signalsFilePath(tid), maxLines)
  return rows.filter((r) => shouldRecallExperienceForPlane('standalone', r))
}

export async function persistRagLearningSignal(row: RagLearningSignalRow): Promise<void> {
  const tid = normalizeTenantId(row.tenantId)
  const withTenant = { ...row, tenantId: tid }
  const backend = resolveRagStorageBackend()
  if (shouldWritePostgres(backend)) {
    try {
      await appendSignalToPg(withTenant)
    } catch {
      /* fallback */
    }
  }
  if (shouldWriteFile(backend)) {
    appendSignalToFile(withTenant)
  }
  let cache = signalsCacheByTenant.get(tid)
  if (!cache) cache = []
  cache.push(withTenant)
  if (cache.length > 800) cache = cache.slice(-600)
  signalsCacheByTenant.set(tid, cache)
}

export async function getRagMemoryStatus(): Promise<{
  backend: ReturnType<typeof resolveRagStorageBackend>
  pgConfigured: boolean
  pgReachable: boolean
}> {
  const backend = resolveRagStorageBackend()
  const { isAgentPgConfigured, pingAgentPg } = await import('#agent-shared/agentPgClient')
  const pgConfigured = isAgentPgConfigured()
  let pgReachable = false
  if (pgConfigured && isPostgresStorageEnabled(backend)) {
    pgReachable = await pingAgentPg()
  }
  return { backend, pgConfigured, pgReachable }
}
