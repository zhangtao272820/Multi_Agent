/**
 * Agent Memory Policy 统一写入/召回 API（存储可换、契约不变）
 */

import { agentPgQuery } from './agentPgClient'
import { AMP_EXPERIENCE_SUCCESS_THRESHOLD } from './agentMemoryPolicy'
import { rankRecallCandidates, type RecallCandidate } from './agentMemoryRecall'
import { resolveUserKey, type UserKeyInput } from './resolveUserKey'
import { isPostgresStorageEnabled, resolveStorageBackend } from './storageBackend'

export type MemoryAgent = 'manager' | 'db' | 'rag' | 'admin'

export type MemoryEventType =
  | 'session_turn'
  | 'working'
  | 'experience'
  | 'learning_signal'
  | 'semantic'
  | 'reflection'
  | 'user_preference'

export type MemoryEvent = {
  type: MemoryEventType
  agent: MemoryAgent
  userKey?: string
  sessionId?: string
  successScore?: number
  payload: Record<string, unknown>
}

export type RecallScope = {
  agent: MemoryAgent
  userKey?: string
  sessionId?: string
  query?: string
  types?: MemoryEventType[]
  limit?: number
}

function resolveAgentBackend(agent: MemoryAgent, env: NodeJS.ProcessEnv): ReturnType<typeof resolveStorageBackend> {
  if (agent === 'manager') return resolveStorageBackend(env.MANAGER_STORAGE_BACKEND, 'file')
  if (agent === 'db') return resolveStorageBackend(env.DB_AGENT_STORAGE_BACKEND, 'file')
  if (agent === 'rag') return resolveStorageBackend(env.RAG_AGENT_STORAGE_BACKEND, 'file')
  return 'file'
}

export function resolveMemoryUserKey(input: UserKeyInput): string {
  return resolveUserKey(input)
}

export function shouldWriteExperience(successScore?: number): boolean {
  const score = Number(successScore ?? 0)
  return Number.isFinite(score) && score >= AMP_EXPERIENCE_SUCCESS_THRESHOLD
}

/** 统一写入门槛 + PG 路由（各 Agent 适配器可再包一层） */
export async function recordMemory(
  event: MemoryEvent,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ok: boolean; reason?: string }> {
  if (event.type === 'experience' && !shouldWriteExperience(event.successScore)) {
    return { ok: false, reason: 'below_experience_threshold' }
  }

  const backend = resolveAgentBackend(event.agent, env)
  if (!isPostgresStorageEnabled(backend)) {
    return { ok: true, reason: 'file_backend_delegated' }
  }

  if (event.agent === 'manager' && (event.type === 'experience' || event.type === 'working' || event.type === 'semantic' || event.type === 'reflection')) {
    const ts = String(event.payload.ts || new Date().toISOString())
    await agentPgQuery(
      `INSERT INTO mgr_memory_entries (ts, entry_type, payload) VALUES ($1, $2, $3)`,
      [ts, event.type, JSON.stringify(event.payload)],
      env
    )
    return { ok: true }
  }

  if (event.agent === 'db' && event.type === 'experience') {
    const p = event.payload
    await agentPgQuery(
      `INSERT INTO db_query_experience (ts, question_norm, path, data_domain, tables, hint)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        String(p.ts || new Date().toISOString()),
        String(p.question_norm || ''),
        p.path ?? null,
        p.data_domain ?? null,
        p.tables ? JSON.stringify(p.tables) : null,
        String(p.hint || '')
      ],
      env
    )
    return { ok: true }
  }

  if (event.type === 'user_preference' && event.agent === 'db') {
    const userKey = event.userKey || resolveUserKey({ sessionId: event.sessionId })
    await agentPgQuery(
      `INSERT INTO db_user_preferences (user_key, payload, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [userKey, JSON.stringify(event.payload)],
      env
    )
    return { ok: true }
  }

  if (event.type === 'user_preference' && event.agent === 'manager') {
    const userKey = event.userKey || resolveUserKey({ sessionId: event.sessionId })
    await agentPgQuery(
      `INSERT INTO mgr_user_profiles (user_key, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [userKey, JSON.stringify(event.payload)],
      env
    )
    return { ok: true }
  }

  return { ok: true, reason: 'no_pg_route' }
}

/** 统一召回：Manager experience PG + 混合排序 */
export async function recallMemory(
  scope: RecallScope,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ items: Array<Record<string, unknown>>; ranked?: ReturnType<typeof rankRecallCandidates> }> {
  const limit = Math.max(1, Math.min(20, scope.limit ?? 4))
  const backend = resolveAgentBackend(scope.agent, env)

  if (scope.agent === 'manager' && isPostgresStorageEnabled(backend)) {
    const types = scope.types?.length ? scope.types : (['experience'] as MemoryEventType[])
    const res = await agentPgQuery<{ entry_type: string; ts: string; payload: Record<string, unknown> }>(
      `SELECT entry_type, ts, payload FROM mgr_memory_entries
       WHERE entry_type = ANY($1)
       ORDER BY ts DESC LIMIT $2`,
      [types, Math.min(200, limit * 20)],
      env
    )
    const rows = res?.rows ?? []
    const candidates: RecallCandidate[] = rows.map((r) => ({
      text: String(r.payload.user || r.payload.explanation || r.payload.intent || ''),
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      successScore: Number(r.payload.successScore ?? r.payload.success_score ?? 0.72),
      scenarioKey: String(r.payload.scenarioKey || '')
    }))
    const ranked = scope.query ? rankRecallCandidates(scope.query, candidates, { limit }) : []
    const items = (scope.query ? ranked : rows.map((r) => ({ ...r.payload, type: r.entry_type, ts: r.ts }))).slice(0, limit)
    return { items, ranked: scope.query ? ranked : undefined }
  }

  if (scope.agent === 'db' && isPostgresStorageEnabled(backend)) {
    const q = String(scope.query || '').trim().slice(0, 120)
    const res = await agentPgQuery<{ ts: string; question_norm: string; hint: string }>(
      q
        ? `SELECT ts, question_norm, hint FROM db_query_experience
           WHERE question_norm ILIKE $1 OR hint ILIKE $1
           ORDER BY ts DESC LIMIT $2`
        : `SELECT ts, question_norm, hint FROM db_query_experience ORDER BY ts DESC LIMIT $1`,
      q ? [`%${q.slice(0, 40)}%`, limit] : [limit],
      env
    )
    return { items: (res?.rows ?? []).map((r) => ({ ...r })) }
  }

  return { items: [] }
}
