/**
 * Agent Memory Policy 统一写入/召回 API（存储可换、契约不变）
 * 多租户：tenantId 贯穿读写；fail-closed 时缺 scope 拒绝召回。
 */

import { agentPgQuery, isAgentPgConfigured } from './agentPgClient'
import { AMP_EXPERIENCE_SUCCESS_THRESHOLD } from './agentMemoryPolicy'
import { rankRecallCandidates, type RecallCandidate } from './agentMemoryRecall'
import { scoreMemoryImportance } from './memoryImportance'
import { resolveUserKey, type UserKeyInput } from './resolveUserKey'
import { isPostgresStorageEnabled, resolveStorageBackend } from './storageBackend'
import { normalizeTenantId, requireTenantId, ScopeRequiredError } from './tenantScope'

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
  /** 鉴权派生；缺省时按 fail-closed / default 规则解析 */
  tenantId?: string
  userKey?: string
  sessionId?: string
  successScore?: number
  payload: Record<string, unknown>
}

export type RecallScope = {
  agent: MemoryAgent
  tenantId?: string
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

function resolveEventTenantId(event: { tenantId?: string; payload?: Record<string, unknown> }, env: NodeJS.ProcessEnv): string {
  const fromEvent = event.tenantId ?? event.payload?.tenantId ?? event.payload?.tenant_id
  return requireTenantId(fromEvent, env)
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

  let tenantId: string
  try {
    tenantId = resolveEventTenantId(event, env)
  } catch (e) {
    if (e instanceof ScopeRequiredError) return { ok: false, reason: 'tenant_scope_required' }
    throw e
  }

  if (event.agent === 'manager' && (event.type === 'experience' || event.type === 'working' || event.type === 'semantic' || event.type === 'reflection')) {
    const ts = String(event.payload.ts || new Date().toISOString())
    const userId = String(event.userKey || event.payload.userId || event.payload.user_id || '').trim() || null
    const importance =
      typeof event.payload.importance === 'number'
        ? event.payload.importance
        : scoreMemoryImportance({
            successScore: event.successScore ?? Number(event.payload.successScore),
            entryType: event.type,
            hitlConfirmed: Boolean(event.payload.hitlConfirmed || event.payload.hitl_confirmed),
            userExplicitPreference: Boolean(event.payload.userExplicitPreference),
            chitchat: Boolean(event.payload.chitchat),
            feedbackScore: Number(event.payload.feedbackScore ?? event.payload.feedback_score),
          })
    await agentPgQuery(
      `INSERT INTO mgr_memory_entries (ts, entry_type, payload, tenant_id, user_id) VALUES ($1, $2, $3, $4, $5)`,
      [ts, event.type, JSON.stringify({ ...event.payload, tenantId, importance }), tenantId, userId],
      env
    )
    return { ok: true }
  }

  if (event.agent === 'db' && event.type === 'experience') {
    const p = event.payload
    await agentPgQuery(
      `INSERT INTO db_query_experience
        (ts, question_norm, path, data_domain, tables, hint, tenant_id, source, source_plane)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        String(p.ts || new Date().toISOString()),
        String(p.question_norm || ''),
        p.path ?? null,
        p.data_domain ?? null,
        p.tables ? JSON.stringify(p.tables) : null,
        String(p.hint || ''),
        tenantId,
        p.source ? String(p.source) : null,
        String(p.source_plane || p.sourcePlane || 'standalone')
      ],
      env
    )
    return { ok: true }
  }

  if (event.type === 'user_preference' && event.agent === 'db') {
    const userKey = event.userKey || resolveUserKey({ sessionId: event.sessionId })
    await agentPgQuery(
      `INSERT INTO db_user_preferences (user_key, payload, tenant_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         tenant_id = EXCLUDED.tenant_id,
         updated_at = NOW()`,
      [userKey, JSON.stringify(event.payload), tenantId],
      env
    )
    return { ok: true }
  }

  if (event.type === 'user_preference' && event.agent === 'manager') {
    const userKey = event.userKey || resolveUserKey({ sessionId: event.sessionId })
    await agentPgQuery(
      `INSERT INTO mgr_user_profiles (user_key, payload, tenant_id, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (user_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         tenant_id = EXCLUDED.tenant_id,
         updated_at = NOW()`,
      [userKey, JSON.stringify(event.payload), tenantId],
      env
    )
    return { ok: true }
  }

  return { ok: true, reason: 'no_pg_route' }
}

/** 统一召回：Manager experience PG + 混合排序（强制 tenant 过滤） */
export async function recallMemory(
  scope: RecallScope,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ items: Array<Record<string, unknown>>; ranked?: ReturnType<typeof rankRecallCandidates> }> {
  const limit = Math.max(1, Math.min(20, scope.limit ?? 4))
  const backend = resolveAgentBackend(scope.agent, env)

  let tenantId: string
  try {
    tenantId = requireTenantId(scope.tenantId, env)
  } catch {
    return { items: [] }
  }

  if (scope.agent === 'manager' && isPostgresStorageEnabled(backend)) {
    const types = scope.types?.length ? scope.types : (['experience'] as MemoryEventType[])
    const res = await agentPgQuery<{
      id: string
      entry_type: string
      ts: string
      payload: Record<string, unknown>
    }>(
      `SELECT id, entry_type, ts, payload FROM mgr_memory_entries
       WHERE tenant_id = $1 AND entry_type = ANY($2)
         AND COALESCE(payload->>'deleted_at', '') = ''
       ORDER BY ts DESC LIMIT $3`,
      [tenantId, types, Math.min(200, limit * 20)],
      env
    )
    const rows = res?.rows ?? []
    const candidates: RecallCandidate[] = rows.map((r) => ({
      text: String(r.payload.user || r.payload.explanation || r.payload.intent || r.payload.fact || ''),
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      successScore: Number(r.payload.successScore ?? r.payload.success_score ?? 0.72),
      scenarioKey: String(r.payload.scenarioKey || ''),
      importance: Number(r.payload.importance ?? 0.5),
      memoryId: Number(r.id),
    }))
    const ranked = scope.query ? rankRecallCandidates(scope.query, candidates, { limit }) : []
    const items = (
      scope.query ? ranked : rows.map((r) => ({ ...r.payload, type: r.entry_type, ts: r.ts, memoryId: Number(r.id) }))
    ).slice(0, limit)
    return { items, ranked: scope.query ? ranked : undefined }
  }

  if (scope.agent === 'db' && isPostgresStorageEnabled(backend)) {
    const q = String(scope.query || '').trim().slice(0, 120)
    const res = await agentPgQuery<{ ts: string; question_norm: string; hint: string }>(
      q
        ? `SELECT ts, question_norm, hint FROM db_query_experience
           WHERE tenant_id = $1 AND (question_norm ILIKE $2 OR hint ILIKE $2)
           ORDER BY ts DESC LIMIT $3`
        : `SELECT ts, question_norm, hint FROM db_query_experience
           WHERE tenant_id = $1 ORDER BY ts DESC LIMIT $2`,
      q ? [tenantId, `%${q.slice(0, 40)}%`, limit] : [tenantId, limit],
      env
    )
    return { items: (res?.rows ?? []).map((r) => ({ ...r })) }
  }

  return { items: [] }
}

export type ForgetMemoryOpts = {
  tenantId?: string
  memoryId?: number | string
  /** 按 user_id + 文本子串软删 */
  userKey?: string
  query?: string
  limit?: number
}

/** 显式 forget：软删除 payload.deleted_at；召回自动过滤 */
export async function forgetMemory(
  opts: ForgetMemoryOpts,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ok: boolean; forgotten: number; reason?: string }> {
  if (!isAgentPgConfigured(env)) {
    return { ok: false, forgotten: 0, reason: 'pg_not_configured' }
  }
  let tenantId: string
  try {
    tenantId = requireTenantId(opts.tenantId, env)
  } catch (e) {
    if (e instanceof ScopeRequiredError) return { ok: false, forgotten: 0, reason: 'tenant_scope_required' }
    throw e
  }

  const now = new Date().toISOString()
  const mid = opts.memoryId != null && String(opts.memoryId).trim() !== '' ? Number(opts.memoryId) : NaN
  if (Number.isFinite(mid) && mid > 0) {
    const res = await agentPgQuery(
      `UPDATE mgr_memory_entries
       SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{deleted_at}', to_jsonb($3::text), true)
       WHERE id = $1 AND tenant_id = $2
         AND COALESCE(payload->>'deleted_at', '') = ''`,
      [mid, tenantId, now],
      env
    )
    const n = Number((res as { rowCount?: number } | null)?.rowCount ?? 0)
    return { ok: n > 0, forgotten: n, reason: n > 0 ? undefined : 'not_found' }
  }

  const userKey = String(opts.userKey || '').trim()
  const q = String(opts.query || '').trim().slice(0, 80)
  if (!userKey && !q) {
    return { ok: false, forgotten: 0, reason: 'memory_id_or_query_required' }
  }
  const lim = Math.max(1, Math.min(50, Number(opts.limit ?? 10)))
  const res = await agentPgQuery(
    `UPDATE mgr_memory_entries
     SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{deleted_at}', to_jsonb($4::text), true)
     WHERE id IN (
       SELECT id FROM mgr_memory_entries
       WHERE tenant_id = $1
         AND COALESCE(payload->>'deleted_at', '') = ''
         AND ($2 = '' OR user_id = $2 OR payload->>'userId' = $2 OR payload->>'user_key' = $2)
         AND ($3 = '' OR payload::text ILIKE '%' || $3 || '%')
       ORDER BY ts DESC
       LIMIT $5
     )`,
    [tenantId, userKey, q, now, lim],
    env
  )
  const n = Number((res as { rowCount?: number } | null)?.rowCount ?? 0)
  return { ok: true, forgotten: n }
}

export { normalizeTenantId, requireTenantId, ScopeRequiredError }
export { scoreMemoryImportance } from './memoryImportance'
