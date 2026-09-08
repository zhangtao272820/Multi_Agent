/**
 * Memory Fold：归档会话 → 结构化 semantic/work 记忆（按租户隔离）
 */

import { agentPgQuery } from './agentPgClient'
import { recordMemory } from './agentMemoryApi'
import { requireTenantId, ScopeRequiredError } from './tenantScope'

export function isMemoryFoldEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_MEMORY_FOLD_JOB ?? '1').trim() !== '0'
}

function foldBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MGR_MEMORY_FOLD_BATCH ?? 20)
  return Number.isFinite(n) && n >= 1 ? Math.min(100, Math.floor(n)) : 20
}

function summarizeTurns(turns: Array<{ role: string; content: string }>): string {
  const users = turns.filter((t) => t.role === 'user').map((t) => t.content.trim()).filter(Boolean)
  const assistants = turns.filter((t) => t.role === 'assistant').map((t) => t.content.trim()).filter(Boolean)
  const goal = users[0]?.slice(0, 120) || '（无用户目标）'
  const outcome = assistants[assistants.length - 1]?.slice(0, 200) || '（无助手结论）'
  return `目标：${goal}；结论：${outcome}`
}

function resolveFoldTenantId(raw: unknown, env: NodeJS.ProcessEnv): string | null {
  try {
    return requireTenantId(raw, env)
  } catch (e) {
    if (e instanceof ScopeRequiredError) return null
    throw e
  }
}

export async function runMemoryFoldJob(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { tenantId?: string }
): Promise<{
  scanned: number
  folded: number
  skipped: number
}> {
  if (!isMemoryFoldEnabled(env)) return { scanned: 0, folded: 0, skipped: 0 }

  const tenantFilter = opts?.tenantId != null ? resolveFoldTenantId(opts.tenantId, env) : null
  // 显式传入但 fail-closed 失败 → 不扫全库
  if (opts?.tenantId != null && !tenantFilter) return { scanned: 0, folded: 0, skipped: 0 }

  const batch = foldBatchSize(env)

  const candidates = await agentPgQuery<{ session_id: string; tenant_id: string }>(
    tenantFilter
      ? `SELECT DISTINCT a.session_id, COALESCE(NULLIF(s.tenant_id, ''), $2) AS tenant_id
         FROM mgr_session_turns_archive a
         LEFT JOIN mgr_sessions s ON s.id = a.session_id
         LEFT JOIN mgr_session_fold_state f ON f.session_id = a.session_id
         WHERE f.session_id IS NULL
           AND COALESCE(NULLIF(s.tenant_id, ''), $2) = $2
         LIMIT $1`
      : `SELECT DISTINCT a.session_id, COALESCE(NULLIF(s.tenant_id, ''), 'default') AS tenant_id
         FROM mgr_session_turns_archive a
         LEFT JOIN mgr_sessions s ON s.id = a.session_id
         LEFT JOIN mgr_session_fold_state f ON f.session_id = a.session_id
         WHERE f.session_id IS NULL
         LIMIT $1`,
    tenantFilter ? [batch, tenantFilter] : [batch],
    env
  )
  const sessionRows = (candidates?.rows ?? []).filter((r) => r.session_id)
  if (!sessionRows.length) return { scanned: 0, folded: 0, skipped: 0 }

  let folded = 0
  let skipped = 0

  for (const row of sessionRows) {
    const sessionId = String(row.session_id)
    const sessionTenant = resolveFoldTenantId(row.tenant_id || tenantFilter || 'default', env)
    if (!sessionTenant) {
      skipped += 1
      continue
    }

    const [turnsRes, summaryRes] = await Promise.all([
      agentPgQuery<{ role: string; content: string; turn_index: number }>(
        `SELECT role, content, turn_index FROM mgr_session_turns_archive
         WHERE session_id = $1 ORDER BY turn_index ASC`,
        [sessionId],
        env
      ),
      agentPgQuery<{ summary: string; source: string }>(
        `SELECT summary, source FROM mgr_session_summaries WHERE session_id = $1`,
        [sessionId],
        env
      )
    ])

    const turns = (turnsRes?.rows ?? []).map((r) => ({
      role: r.role,
      content: String(r.content ?? '')
    }))
    if (!turns.length) {
      skipped += 1
      continue
    }

    const summaryRow = summaryRes?.rows?.[0]
    const foldSummary = summaryRow?.summary?.trim()
      ? summaryRow.summary.trim().slice(0, 2000)
      : summarizeTurns(turns)
    const source = summaryRow?.summary ? String(summaryRow.source || 'summary') : 'archive'

    const recorded = await recordMemory(
      {
        type: 'semantic',
        agent: 'manager',
        tenantId: sessionTenant,
        successScore: 0.75,
        payload: {
          scenarioKey: `fold:${sessionId.slice(0, 32)}`,
          intent: 'session_fold',
          fact: foldSummary,
          confidence: 0.72,
          source: 'memory_fold_job',
          sessionId,
          turnCount: turns.length,
          foldSource: source,
          tenantId: sessionTenant
        }
      },
      env
    )
    if (!recorded.ok && recorded.reason === 'tenant_scope_required') {
      skipped += 1
      continue
    }

    await agentPgQuery(
      `INSERT INTO mgr_session_fold_state (session_id, fold_summary, turn_count, source, tenant_id, folded_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         fold_summary = EXCLUDED.fold_summary,
         turn_count = EXCLUDED.turn_count,
         source = EXCLUDED.source,
         tenant_id = EXCLUDED.tenant_id,
         folded_at = NOW()`,
      [
        sessionId,
        foldSummary.slice(0, 4000),
        turns.length,
        source === 'llm' ? 'llm' : source === 'summary' ? 'summary' : 'archive',
        sessionTenant
      ],
      env
    )

    folded += 1
  }

  return { scanned: sessionRows.length, folded, skipped }
}
