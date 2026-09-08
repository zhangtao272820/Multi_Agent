/**
 * 记忆 + 进化 Ops 一键验收
 * 用法：
 *   $env:AGENT_DATABASE_URL='postgresql://postgres:postgres@localhost:15432/clawhive'
 *   $env:MANAGER_OPS_TOKEN='...'   # 可选，有则测 Ops 接口
 *   cd Manager_Agent && npx tsx ../scripts/smoke-evolution-ops.ts
 */

import { pingAgentPg, agentPgQuery } from '../shared/agentPgClient'
import { queryMemoryPgStats } from '../shared/memoryDashboard'
import { queryToolMemoryTop } from '../shared/toolMemoryStore'
import { fetchEvolutionHubSummary } from '../Manager_Agent/server/utils/evolutionHub'

const MANAGER_URL = String(process.env.MANAGER_AGENT_HTTP_URL || 'http://localhost:13106').replace(/\/$/, '')
const DB_URL = String(process.env.DB_AGENT_HTTP_URL || 'http://localhost:13101').replace(/\/$/, '')
const RAG_URL = String(process.env.RAG_AGENT_HTTP_URL || 'http://localhost:13102').replace(/\/$/, '')

type Check = { id: string; ok: boolean; detail?: string; optional?: boolean }

const checks: Check[] = []

function record(id: string, ok: boolean, detail?: string, optional = false) {
  checks.push({ id, ok, detail, optional })
  const mark = ok ? 'OK' : optional ? 'WARN' : 'FAIL'
  console.log(`  [${mark}] ${id}${detail ? `: ${detail}` : ''}`)
}

async function fetchReady(url: string, service: string, optional = false) {
  try {
    const res = await fetch(`${url}/api/ready`, { signal: AbortSignal.timeout(8_000) })
    const j = (await res.json()) as { ready?: boolean; memory?: { pgReachable?: boolean }; detail?: string }
    record(`${service}_ready`, Boolean(j.ready), j.detail || JSON.stringify(j.memory ?? {}), optional)
    return j
  } catch (e) {
    record(`${service}_ready`, false, String((e as Error).message || e), optional)
    return null
  }
}

async function postOps(action: string) {
  const token = String(process.env.MANAGER_OPS_TOKEN || '').trim()
  if (!token) {
    record(`ops_${action}`, true, 'skipped (no MANAGER_OPS_TOKEN)', true)
    return null
  }
  try {
    const res = await fetch(`${MANAGER_URL}/api/manager/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-manager-ops-token': token },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(30_000)
    })
    const j = await res.json()
    record(`ops_${action}`, res.ok && j?.ok !== false, res.ok ? `HTTP ${res.status}` : `HTTP ${res.status}`)
    return j
  } catch (e) {
    record(`ops_${action}`, false, String((e as Error).message || e))
    return null
  }
}

async function main() {
  console.log('smoke-evolution-ops: start\n')

  const pgOk = await pingAgentPg()
  record('pg_ping', pgOk)
  if (pgOk) {
    const stats = await queryMemoryPgStats()
    record(
      'pg_memory_stats',
      stats.pgReachable,
      `sessions=${stats.sessions} exp=${stats.memoryEntries.experience ?? 0} tool=${stats.toolMemoryRows}`
    )
    record('pg_tool_memory_table', stats.toolMemoryRows >= 0, `rows=${stats.toolMemoryRows}`)
    record('pg_skill_drafts_table', true, `drafts=${stats.skillDrafts}`)
    record('pg_fold_state', true, `folded=${stats.foldedSessions}`)
  }

  console.log('')
  await fetchReady(MANAGER_URL, 'manager')
  await fetchReady(DB_URL, 'db')
  await fetchReady(RAG_URL, 'rag', true)

  console.log('')
  if (pgOk) {
    const recent = await agentPgQuery<{ user: string; score: string; fail: string; ts: string }>(
      `SELECT
         left(payload->>'user', 80) AS user,
         payload->>'successScore' AS score,
         payload->>'failureCategory' AS fail,
         ts::text AS ts
       FROM mgr_memory_entries
       WHERE entry_type = 'experience'
       ORDER BY ts DESC LIMIT 5`
    )
    const rows = recent?.rows ?? []
    record('recent_experience', rows.length > 0, `count=${rows.length}`)
    for (const r of rows) {
      console.log(`    · [${r.ts}] score=${r.score} fail=${r.fail} | ${r.user}`)
    }

    const dbLike = await agentPgQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM mgr_memory_entries
       WHERE entry_type = 'experience'
         AND (payload->>'user' ILIKE '%数据库%' OR payload->>'user' ILIKE '%查询%'
              OR payload->'path' ? 'db')`
    )
    record('db_related_experience', Number(dbLike?.rows?.[0]?.n) > 0, `count=${dbLike?.rows?.[0]?.n ?? 0}`)
  }

  console.log('')
  const tools = await queryToolMemoryTop({ tenantId: 'default', limit: 6 })
  record('tool_memory_query', true, `rows=${tools.length}`)
  for (const t of tools) {
    console.log(`    · ${t.agent}/${t.toolName}: ${(t.successRate * 100).toFixed(0)}% (${t.successes}/${t.trials})`)
  }

  console.log('')
  try {
    const hub = await fetchEvolutionHubSummary()
    const coreOk = hub.agents.db.ok
    record(
      'evolution_hub',
      coreOk,
      `db=${hub.agents.db.ok} rag=${hub.agents.rag.ok} admin=${hub.agents.admin.ok}`,
      !hub.ok
    )
  } catch (e) {
    record('evolution_hub', false, String((e as Error).message || e), true)
  }

  console.log('')
  await postOps('memory_dashboard')
  await postOps('tool_memory_stats')
  await postOps('evolution_hub')

  const failed = checks.filter((c) => !c.ok && !c.optional)
  const warned = checks.filter((c) => !c.ok && c.optional)
  console.log(
    `\nsmoke-evolution-ops: ${failed.length ? 'FAILED' : 'OK'} (${checks.length} checks, ${failed.length} failures, ${warned.length} warnings)`
  )
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
