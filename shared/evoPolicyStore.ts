/**
 * evo_policy_versions：shadow / active / rollback 事务化版本库（按租户隔离；_global_ 为审核后基线）
 */

import { agentPgQuery } from './agentPgClient'
import { GLOBAL_BASELINE_TENANT_ID, normalizeTenantId } from './tenantScope'

export type EvoPolicyStatus = 'shadow' | 'active' | 'rolled_back' | 'global_candidate' | 'discarded'

export type EvoPolicyRow = {
  agent: string
  stage: string
  version: number
  status: EvoPolicyStatus
  payload: Record<string, unknown>
  promoted_at?: string | null
  tenantId?: string
}

function nextVersion(rows: { version: number }[]): number {
  const max = rows.reduce((m, r) => Math.max(m, Number(r.version) || 0), 0)
  return max + 1
}

export async function listActiveTenantIds(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const set = new Set<string>([normalizeTenantId(undefined, env)])
  const res = await agentPgQuery<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM mgr_sessions
     UNION
     SELECT DISTINCT tenant_id FROM mgr_memory_entries
     UNION
     SELECT DISTINCT tenant_id FROM evo_policy_versions`,
    [],
    env
  ).catch(() => null)
  for (const r of res?.rows ?? []) {
    const tid = String(r.tenant_id || '').trim()
    if (tid && tid !== GLOBAL_BASELINE_TENANT_ID) set.add(tid)
  }
  return [...set]
}

export async function writeEvoShadowPolicy(
  agent: string,
  stage: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  tenantId?: string
): Promise<EvoPolicyRow | null> {
  const tid = normalizeTenantId(tenantId ?? (payload as { tenantId?: string }).tenantId, env)
  const existing = await agentPgQuery<{ version: number }>(
    `SELECT version FROM evo_policy_versions
     WHERE tenant_id = $1 AND agent = $2 AND stage = $3 AND status = 'shadow'
     ORDER BY version DESC LIMIT 1`,
    [tid, agent, stage],
    env
  )
  const version = nextVersion(existing?.rows ?? [])
  await agentPgQuery(
    `UPDATE evo_policy_versions SET status = 'rolled_back'
     WHERE tenant_id = $1 AND agent = $2 AND stage = $3 AND status = 'shadow'`,
    [tid, agent, stage],
    env
  )
  const res = await agentPgQuery<{ version: number }>(
    `INSERT INTO evo_policy_versions (tenant_id, agent, stage, version, status, payload)
     VALUES ($1, $2, $3, $4, 'shadow', $5)
     RETURNING version`,
    [tid, agent, stage, version, JSON.stringify({ ...payload, tenantId: tid })],
    env
  )
  if (!res?.rows?.[0]) return null
  return { agent, stage, version, status: 'shadow', payload, tenantId: tid }
}

export async function getEvoActivePolicy(
  agent: string,
  stage: string,
  env: NodeJS.ProcessEnv = process.env,
  tenantId?: string
): Promise<EvoPolicyRow | null> {
  const tid = normalizeTenantId(tenantId, env)
  for (const scope of [tid, GLOBAL_BASELINE_TENANT_ID]) {
    const res = await agentPgQuery<{
      version: number
      status: EvoPolicyStatus
      payload: Record<string, unknown>
      promoted_at: string | null
      tenant_id: string
    }>(
      `SELECT version, status, payload, promoted_at, tenant_id FROM evo_policy_versions
       WHERE tenant_id = $1 AND agent = $2 AND stage = $3 AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
      [scope, agent, stage],
      env
    )
    const row = res?.rows?.[0]
    if (row) {
      return {
        agent,
        stage,
        version: row.version,
        status: row.status,
        payload: row.payload,
        promoted_at: row.promoted_at,
        tenantId: row.tenant_id
      }
    }
  }
  return null
}

export async function promoteEvoPolicy(
  agent: string,
  stage: string,
  opts?: { shadowPayload?: Record<string, unknown>; verifyOk?: boolean; tenantId?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ok: boolean; reason?: string; version?: number }> {
  if (opts?.verifyOk === false) {
    return { ok: false, reason: 'verify_failed' }
  }

  const tid = normalizeTenantId(opts?.tenantId, env)
  let payload = opts?.shadowPayload
  if (!payload) {
    const shadow = await agentPgQuery<{ version: number; payload: Record<string, unknown> }>(
      `SELECT version, payload FROM evo_policy_versions
       WHERE tenant_id = $1 AND agent = $2 AND stage = $3 AND status = 'shadow'
       ORDER BY version DESC LIMIT 1`,
      [tid, agent, stage],
      env
    )
    payload = shadow?.rows?.[0]?.payload
    if (!payload) return { ok: false, reason: 'no_shadow' }
  }

  const active = await agentPgQuery<{ version: number }>(
    `SELECT version FROM evo_policy_versions
     WHERE tenant_id = $1 AND agent = $2 AND stage = $3 AND status = 'active'
     ORDER BY version DESC LIMIT 1`,
    [tid, agent, stage],
    env
  )
  const version = nextVersion([...(active?.rows ?? []), { version: 0 }])

  await agentPgQuery(
    `UPDATE evo_policy_versions SET status = 'rolled_back', promoted_at = NOW()
     WHERE tenant_id = $1 AND agent = $2 AND stage = $3 AND status = 'active'`,
    [tid, agent, stage],
    env
  )
  await agentPgQuery(
    `UPDATE evo_policy_versions SET status = 'rolled_back'
     WHERE tenant_id = $1 AND agent = $2 AND stage = $3 AND status = 'shadow'`,
    [tid, agent, stage],
    env
  )
  const ins = await agentPgQuery<{ version: number }>(
    `INSERT INTO evo_policy_versions (tenant_id, agent, stage, version, status, payload, promoted_at)
     VALUES ($1, $2, $3, $4, 'active', $5, NOW())
     RETURNING version`,
    [tid, agent, stage, version, JSON.stringify(payload)],
    env
  )
  if (!ins?.rows?.[0]) return { ok: false, reason: 'insert_failed' }
  return { ok: true, version: ins.rows[0].version }
}

export async function rollbackEvoPolicy(
  agent: string,
  stage: string,
  env: NodeJS.ProcessEnv = process.env,
  tenantId?: string
): Promise<{ ok: boolean; reason?: string }> {
  const tid = normalizeTenantId(tenantId, env)
  const prev = await agentPgQuery<{ version: number; payload: Record<string, unknown> }>(
    `SELECT version, payload FROM evo_policy_versions
     WHERE tenant_id = $1 AND agent = $2 AND stage = $3 AND status = 'rolled_back'
     ORDER BY promoted_at DESC NULLS LAST, version DESC LIMIT 1`,
    [tid, agent, stage],
    env
  )
  const row = prev?.rows?.[0]
  if (!row) return { ok: false, reason: 'no_rollback_target' }

  await agentPgQuery(
    `UPDATE evo_policy_versions SET status = 'rolled_back', promoted_at = NOW()
     WHERE tenant_id = $1 AND agent = $2 AND stage = $3 AND status = 'active'`,
    [tid, agent, stage],
    env
  )
  await agentPgQuery(
    `INSERT INTO evo_policy_versions (tenant_id, agent, stage, version, status, payload, promoted_at)
     VALUES ($1, $2, $3, $4, 'active', $5, NOW())`,
    [tid, agent, stage, row.version + 1000, JSON.stringify(row.payload)],
    env
  )
  return { ok: true }
}

export async function listEvoPolicies(
  agent: string,
  env: NodeJS.ProcessEnv = process.env,
  tenantId?: string
): Promise<EvoPolicyRow[]> {
  const tid = normalizeTenantId(tenantId, env)
  const res = await agentPgQuery<{
    stage: string
    version: number
    status: EvoPolicyStatus
    payload: Record<string, unknown>
    promoted_at: string | null
  }>(
    `SELECT stage, version, status, payload, promoted_at FROM evo_policy_versions
     WHERE tenant_id = $1 AND agent = $2 AND status IN ('shadow', 'active')
     ORDER BY stage, version DESC`,
    [tid, agent],
    env
  )
  return (res?.rows ?? []).map((r) => ({
    agent,
    stage: r.stage,
    version: r.version,
    status: r.status,
    payload: r.payload,
    promoted_at: r.promoted_at,
    tenantId: tid
  }))
}

export async function upsertEvoPolicyVersion(
  input: {
    tenantId?: string
    agent: string
    stage: string
    version: number
    status: EvoPolicyStatus
    payload: Record<string, unknown>
    promotedAt?: string | null
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const tid = normalizeTenantId(input.tenantId, env)
  await agentPgQuery(
    `INSERT INTO evo_policy_versions (tenant_id, agent, stage, version, status, payload, promoted_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)
     ON CONFLICT (tenant_id, agent, stage, version) DO UPDATE SET
       status = EXCLUDED.status,
       payload = EXCLUDED.payload,
       promoted_at = EXCLUDED.promoted_at`,
    [
      tid,
      input.agent,
      input.stage,
      input.version,
      input.status,
      JSON.stringify(input.payload),
      input.promotedAt ?? null
    ],
    env
  ).catch(() => undefined)
}

export async function loadActiveEvoPolicy(
  agent: string,
  stage: string,
  tenantId?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ version: number; payload: Record<string, unknown>; tenantId: string } | null> {
  const row = await getEvoActivePolicy(agent, stage, env, tenantId)
  if (!row) return null
  return { version: row.version, payload: row.payload, tenantId: row.tenantId || normalizeTenantId(tenantId, env) }
}

export async function listEvoPoliciesForTenant(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Array<Record<string, unknown>>> {
  const tid = normalizeTenantId(tenantId, env)
  const res = await agentPgQuery<{
    id: string
    agent: string
    stage: string
    version: number
    status: string
    payload: Record<string, unknown>
    promoted_at: string | null
    created_at: string
  }>(
    `SELECT id, agent, stage, version, status, payload, promoted_at, created_at
     FROM evo_policy_versions WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT 100`,
    [tid],
    env
  ).catch(() => null)
  return (res?.rows ?? []).map((r) => ({ ...r, tenantId: tid }))
}
