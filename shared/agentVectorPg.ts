/**
 * pgvector 经验向量读写（Manager / DB）
 */

import { agentPgQuery } from './agentPgClient'

export const PGVECTOR_DIM = 1536

export function isPgVectorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_VECTOR_BACKEND ?? env.DB_VECTOR_BACKEND ?? 'pgvector').trim().toLowerCase() !== 'json'
}

function vecLiteral(values: number[]): string {
  const nums = values.slice(0, PGVECTOR_DIM).map((x) => Number(x) || 0)
  while (nums.length < PGVECTOR_DIM) nums.push(0)
  return `[${nums.join(',')}]`
}

export async function upsertMgrEmbeddingVector(
  memoryKey: string,
  embedding: number[],
  meta: { userKey?: string; entryType?: string; metadata?: Record<string, unknown>; tenantId?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!isPgVectorEnabled(env) || !embedding?.length) return
  const { normalizeTenantId } = await import('./tenantScope')
  const tenantId = normalizeTenantId(meta.tenantId ?? meta.metadata?.tenantId, env)
  await agentPgQuery(
    `INSERT INTO mgr_memory_embeddings (memory_key, user_key, entry_type, embedding, embedding_vec, metadata, ts, tenant_id)
     VALUES ($1, $2, $3, $4, $5::vector, $6, NOW(), $7)
     ON CONFLICT (memory_key) DO UPDATE SET
       embedding = EXCLUDED.embedding,
       embedding_vec = EXCLUDED.embedding_vec,
       metadata = EXCLUDED.metadata,
       tenant_id = EXCLUDED.tenant_id,
       ts = NOW()`,
    [
      memoryKey,
      meta.userKey || '__global__',
      meta.entryType || 'experience',
      JSON.stringify(embedding),
      vecLiteral(embedding),
      JSON.stringify({ ...(meta.metadata ?? {}), tenantId }),
      tenantId
    ],
    env
  )
}

export async function searchMgrEmbeddingsByVector(
  queryEmbedding: number[],
  limit = 4,
  env: NodeJS.ProcessEnv = process.env,
  tenantId?: string
): Promise<Array<{ memory_key: string; score: number; metadata: Record<string, unknown> }>> {
  if (!isPgVectorEnabled(env) || !queryEmbedding?.length) return []
  const { normalizeTenantId } = await import('./tenantScope')
  const tid = normalizeTenantId(tenantId, env)
  const res = await agentPgQuery<{ memory_key: string; score: number; metadata: Record<string, unknown> }>(
    `SELECT memory_key, 1 - (embedding_vec <=> $1::vector) AS score, metadata
     FROM mgr_memory_embeddings
     WHERE tenant_id = $2 AND embedding_vec IS NOT NULL
     ORDER BY embedding_vec <=> $1::vector
     LIMIT $3`,
    [vecLiteral(queryEmbedding), tid, limit],
    env
  )
  return res?.rows ?? []
}

export async function upsertDbExperienceVector(
  row: {
    experienceKey: string
    questionNorm: string
    hint: string
    path?: string
    dataDomain?: string
    embedding: number[]
    metadata?: Record<string, unknown>
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!isPgVectorEnabled(env) || !row.embedding?.length) return
  await agentPgQuery(
    `INSERT INTO db_experience_vectors
     (experience_key, question_norm, hint, path, data_domain, embedding_vec, metadata, ts)
     VALUES ($1,$2,$3,$4,$5,$6::vector,$7,NOW())
     ON CONFLICT (experience_key) DO UPDATE SET
       hint = EXCLUDED.hint,
       embedding_vec = EXCLUDED.embedding_vec,
       metadata = EXCLUDED.metadata,
       ts = NOW()`,
    [
      row.experienceKey,
      row.questionNorm,
      row.hint,
      row.path ?? null,
      row.dataDomain ?? null,
      vecLiteral(row.embedding),
      JSON.stringify(row.metadata ?? {})
    ],
    env
  )
}

export async function searchDbExperienceByVector(
  queryEmbedding: number[],
  limit = 3,
  env: NodeJS.ProcessEnv = process.env
): Promise<Array<{ question_norm: string; hint: string; score: number }>> {
  if (!isPgVectorEnabled(env) || !queryEmbedding?.length) return []
  const res = await agentPgQuery<{ question_norm: string; hint: string; score: number }>(
    `SELECT question_norm, hint, 1 - (embedding_vec <=> $1::vector) AS score
     FROM db_experience_vectors
     ORDER BY embedding_vec <=> $1::vector
     LIMIT $2`,
    [vecLiteral(queryEmbedding), limit],
    env
  )
  return res?.rows ?? []
}

/** 清空 DB 经验向量 PG 表（换 embedding 模型后需重建索引时调用）。 */
export async function clearDbExperienceVectorsPg(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isPgVectorEnabled(env)) return
  await agentPgQuery('TRUNCATE TABLE db_experience_vectors RESTART IDENTITY', [], env)
}

/** 清空 Manager 经验向量 PG 表。 */
export async function clearMgrMemoryEmbeddingsPg(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isPgVectorEnabled(env)) return
  await agentPgQuery('TRUNCATE TABLE mgr_memory_embeddings RESTART IDENTITY', [], env)
}

export async function queryFederatedUserContext(
  userKey: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, unknown> | null> {
  const res = await agentPgQuery<{ user_key: string; db_preferences: Record<string, unknown>; db_updated_at: string }>(
    `SELECT user_key, db_preferences, db_updated_at FROM shared_user_context_view WHERE user_key = $1`,
    [userKey],
    env
  )
  return (res?.rows?.[0] as unknown as Record<string, unknown>) ?? null
}
