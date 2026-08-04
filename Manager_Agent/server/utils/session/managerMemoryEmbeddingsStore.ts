import { agentPgQuery } from '#agent-shared/agentPgClient'
import { upsertMgrEmbeddingVector } from '#agent-shared/agentVectorPg'
import { isPostgresStorageEnabled, resolveStorageBackend, shouldWritePostgres } from '#agent-shared/storageBackend'

export type MemoryEmbeddingRow = {
  memoryKey: string
  userKey: string
  entryType: string
  embedding: number[]
  metadata?: Record<string, unknown>
  ts?: string
  tenantId?: string
}

export function resolveManagerStorageBackend(env: NodeJS.ProcessEnv = process.env) {
  return resolveStorageBackend(env.MANAGER_STORAGE_BACKEND, 'file')
}

export async function upsertManagerMemoryEmbedding(row: MemoryEmbeddingRow, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!shouldWritePostgres(resolveManagerStorageBackend(env))) return
  const { normalizeTenantId } = await import('#agent-shared/tenantScope')
  const tenantId = normalizeTenantId(row.tenantId ?? row.metadata?.tenantId, env)
  await agentPgQuery(
    `INSERT INTO mgr_memory_embeddings (memory_key, user_key, entry_type, embedding, metadata, ts, tenant_id)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7)
     ON CONFLICT (memory_key) DO UPDATE SET
       embedding = EXCLUDED.embedding,
       metadata = EXCLUDED.metadata,
       ts = EXCLUDED.ts,
       tenant_id = EXCLUDED.tenant_id`,
    [
      row.memoryKey,
      row.userKey || '__global__',
      row.entryType || 'experience',
      JSON.stringify(row.embedding),
      JSON.stringify({ ...(row.metadata ?? {}), tenantId }),
      row.ts ?? null,
      tenantId
    ],
    env
  )
  await upsertMgrEmbeddingVector(row.memoryKey, row.embedding, {
    userKey: row.userKey,
    entryType: row.entryType,
    metadata: row.metadata,
    tenantId
  }, env).catch(() => undefined)
}

export async function readManagerMemoryEmbeddings(
  userKey: string,
  max = 400,
  env: NodeJS.ProcessEnv = process.env,
  tenantId?: string
): Promise<MemoryEmbeddingRow[]> {
  if (!isPostgresStorageEnabled(resolveManagerStorageBackend(env))) return []
  const { normalizeTenantId } = await import('#agent-shared/tenantScope')
  const tid = normalizeTenantId(tenantId, env)
  const res = await agentPgQuery<{
    memory_key: string
    user_key: string
    entry_type: string
    embedding: number[]
    metadata: Record<string, unknown>
    ts: string
    tenant_id: string
  }>(
    `SELECT memory_key, user_key, entry_type, embedding, metadata, ts, tenant_id
     FROM mgr_memory_embeddings
     WHERE tenant_id = $1 AND (user_key = $2 OR user_key = '__global__')
     ORDER BY ts DESC LIMIT $3`,
    [tid, userKey || '__global__', max],
    env
  )
  return (res?.rows ?? []).map((r) => ({
    memoryKey: r.memory_key,
    userKey: r.user_key,
    entryType: r.entry_type,
    embedding: Array.isArray(r.embedding) ? r.embedding : [],
    metadata: r.metadata ?? {},
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    tenantId: r.tenant_id
  }))
}
