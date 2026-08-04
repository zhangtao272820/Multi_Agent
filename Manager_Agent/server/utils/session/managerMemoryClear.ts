/**
 * Manager 记忆/进化清除（PG + 文件 fallback）— 必须带 tenantId
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery } from '#agent-shared/agentPgClient'
import { isPostgresStorageEnabled, resolveStorageBackend } from '#agent-shared/storageBackend'
import { normalizeTenantId, requireTenantId, ScopeRequiredError } from '#agent-shared/tenantScope'
import { clearActivePromptPatches } from '../../graph/core/evolution/promptPatches'
import { resolveManagerPolicyDir } from './managerPolicyDir'

export type MemoryClearScope = 'experience' | 'summaries' | 'evolution' | 'all'

function pgEnabled() {
  return isPostgresStorageEnabled(resolveStorageBackend(process.env.MANAGER_STORAGE_BACKEND, 'file'))
}

function resolveClearTenant(tenantId?: string): string {
  try {
    return requireTenantId(tenantId)
  } catch (e) {
    if (e instanceof ScopeRequiredError) throw e
    return normalizeTenantId(tenantId)
  }
}

export async function clearManagerExperience(tenantId?: string): Promise<{ removed: number; tenantId: string }> {
  const tid = resolveClearTenant(tenantId)
  let removed = 0
  const dir = resolveManagerPolicyDir(tid)

  if (pgEnabled()) {
    const exp = await agentPgQuery<{ n: string }>(
      `WITH d AS (
         DELETE FROM mgr_memory_entries
         WHERE entry_type = 'experience' AND tenant_id = $1
         RETURNING 1
       ) SELECT COUNT(*)::text AS n FROM d`,
      [tid]
    )
    removed += Number(exp?.rows?.[0]?.n) || 0
    await agentPgQuery(`DELETE FROM mgr_memory_embeddings WHERE entry_type = 'experience' AND tenant_id = $1`, [
      tid
    ]).catch(() => undefined)
  }

  const memJsonl = path.join(dir, 'manager-memory.jsonl')
  const raw = await fs.readFile(memJsonl, 'utf8').catch(() => '')
  if (raw.trim()) {
    const kept: string[] = []
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const obj = JSON.parse(s)
        if (obj?.type === 'experience') {
          removed += 1
          continue
        }
        kept.push(JSON.stringify(obj))
      } catch {
        kept.push(s)
      }
    }
    await fs.writeFile(memJsonl, kept.length ? `${kept.join('\n')}\n` : '', 'utf8').catch(() => undefined)
  }

  await fs.unlink(path.join(dir, 'manager-policy.json')).catch(() => undefined)
  return { removed, tenantId: tid }
}

export async function clearManagerSummaries(
  tenantId?: string,
  sessionIds?: string[]
): Promise<{ cleared: number; tenantId: string }> {
  const tid = resolveClearTenant(tenantId)
  let cleared = 0
  if (pgEnabled()) {
    if (sessionIds?.length) {
      const res = await agentPgQuery<{ n: string }>(
        `WITH d AS (
           DELETE FROM mgr_session_summaries s
           USING mgr_sessions m
           WHERE s.session_id = m.id
             AND m.tenant_id = $1
             AND s.session_id = ANY($2::varchar[])
           RETURNING 1
         ) SELECT COUNT(*)::text AS n FROM d`,
        [tid, sessionIds]
      )
      cleared = Number(res?.rows?.[0]?.n) || 0
    } else {
      const res = await agentPgQuery<{ n: string }>(
        `WITH d AS (
           DELETE FROM mgr_session_summaries s
           USING mgr_sessions m
           WHERE s.session_id = m.id AND m.tenant_id = $1
           RETURNING 1
         ) SELECT COUNT(*)::text AS n FROM d`,
        [tid]
      )
      cleared = Number(res?.rows?.[0]?.n) || 0
    }
  }
  return { cleared, tenantId: tid }
}

export async function clearManagerEvolution(tenantId?: string): Promise<{ ok: true; tenantId: string }> {
  const tid = resolveClearTenant(tenantId)
  const dir = resolveManagerPolicyDir(tid)
  if (pgEnabled()) {
    await agentPgQuery(`DELETE FROM evo_policy_versions WHERE tenant_id = $1`, [tid]).catch(() => undefined)
    await agentPgQuery(`DELETE FROM evo_audit_runs WHERE tenant_id = $1`, [tid]).catch(() => undefined)
    await agentPgQuery(`DELETE FROM evo_curator_state WHERE tenant_id = $1`, [tid]).catch(() => undefined)
  }
  await clearActivePromptPatches(dir).catch(() => undefined)
  for (const name of [
    'manager-prompt-patches.json',
    'manager-prompt-patches.shadow.json',
    'manager-planner-rules.json',
    'manager-planner-rules.shadow.json'
  ]) {
    await fs.unlink(path.join(dir, name)).catch(() => undefined)
  }
  return { ok: true, tenantId: tid }
}

export async function clearManagerMemory(
  scope: MemoryClearScope,
  opts?: { tenantId?: string; sessionIds?: string[] }
) {
  const tenantId = opts?.tenantId
  const sessionIds = opts?.sessionIds
  if (scope === 'experience') return { scope, ...(await clearManagerExperience(tenantId)) }
  if (scope === 'summaries') return { scope, ...(await clearManagerSummaries(tenantId, sessionIds)) }
  if (scope === 'evolution') return { scope, ...(await clearManagerEvolution(tenantId)) }
  const exp = await clearManagerExperience(tenantId)
  const summaries = await clearManagerSummaries(tenantId, sessionIds)
  const evo = await clearManagerEvolution(tenantId)
  const tid = exp.tenantId
  if (pgEnabled()) {
    await agentPgQuery(
      `DELETE FROM mgr_memory_entries
       WHERE tenant_id = $1 AND entry_type IN ('semantic', 'reflection', 'working')`,
      [tid]
    ).catch(() => undefined)
    await agentPgQuery(`DELETE FROM mgr_memory_embeddings WHERE tenant_id = $1`, [tid]).catch(() => undefined)
  }
  return { scope, ...exp, ...summaries, evolution: evo }
}

async function postAgentReset(baseUrl: string, scope: string, tenantId?: string) {
  const token = String(process.env.CLAWHIVE_INTERNAL_TOKEN || '').trim()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['x-clawhive-internal-token'] = token
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/learning/reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ scope, tenant_id: tenantId }),
      signal: AbortSignal.timeout(12_000)
    })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}

/** 编排模式下顺带清 DB/RAG 学习与进化（不影响 RAG 文档向量库） */
export async function clearSubAgentLearning(scope: 'learning' | 'all' = 'all', tenantId?: string) {
  const dbUrl = String(process.env.DB_AGENT_HTTP_URL || 'http://localhost:13101')
  const ragUrl = String(process.env.RAG_AGENT_HTTP_URL || 'http://localhost:13102')
  const resetScope = scope === 'all' ? 'all' : 'learning'
  const [db, rag] = await Promise.all([
    postAgentReset(dbUrl, resetScope, tenantId),
    postAgentReset(ragUrl, resetScope, tenantId)
  ])
  return { db, rag }
}
