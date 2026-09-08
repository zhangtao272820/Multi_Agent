/**
 * Phase 10：从 mgr_memory_entries 回填 Tool Memory + db_query_experience
 */

import { agentPgQuery, isAgentPgConfigured } from './agentPgClient'
import { isAgentToolSuccess, shouldSyncDbExperience, shouldSyncRagExperience, shouldSyncAdminExperience } from './agentOutcomePolicy'
import { syncDbExperienceFromManagerRun } from './dbExperienceBridge'
import { syncRagExperienceFromManagerRun } from './ragExperienceBridge'
import { syncAdminExperienceFromManagerRun } from './adminExperienceBridge'
import { recordToolMemoryEvent } from './toolMemoryStore'

export function isMemoryBackfillEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_MEMORY_BACKFILL_JOB ?? '1').trim() !== '0'
}

type ExperiencePayload = Record<string, unknown>

function parsePlanAgents(payload: ExperiencePayload): string[] {
  const path = payload.path
  if (Array.isArray(path)) {
    return path.map((x) => String(x ?? '').trim()).filter(Boolean)
  }
  return []
}

/** 历史 experience 无 results 文本时的推断 */
export function inferToolSuccessFromExperience(payload: ExperiencePayload, agentName: string): boolean {
  const successScore = Number(payload.successScore ?? payload.success_score ?? 0)
  const placeholder =
    successScore >= 0.8 ? 'historical experience backfill placeholder' : String(payload.user || '').slice(0, 80)
  return isAgentToolSuccess({
    agentName,
    resultText: placeholder,
    successScore,
    needsClarify: Boolean(payload.needsClarify),
    failureCategory: String(payload.failureCategory || payload.failure_category || ''),
    probeDbMatched: Boolean(payload.probeDbMatched ?? payload.probe_db_matched),
    probeRagHits: Number(payload.probeRagHits ?? payload.probe_rag_hits ?? 0) || 0
  })
}

export async function rebuildToolMemoryFromExperiences(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { dryRun?: boolean; maxRows?: number }
): Promise<{ scanned: number; recorded: number; agents: Record<string, { trials: number; successes: number }> }> {
  if (!isAgentPgConfigured()) return { scanned: 0, recorded: 0, agents: {} }

  const maxRows = Math.max(1, Math.min(5000, opts?.maxRows ?? 800))
  const res = await agentPgQuery<{ payload: ExperiencePayload; tenant_id: string }>(
    `SELECT payload, tenant_id FROM mgr_memory_entries
     WHERE entry_type = 'experience'
     ORDER BY ts ASC
     LIMIT $1`,
    [maxRows],
    env
  )
  const rows = res?.rows ?? []
  const agents: Record<string, { trials: number; successes: number }> = {}

  if (!opts?.dryRun) {
    await agentPgQuery(`DELETE FROM mgr_tool_memory`, [], env)
  }

  let recorded = 0
  for (const row of rows) {
    const payload = row.payload ?? {}
    const planAgents = parsePlanAgents(payload)
    if (!planAgents.length) continue
    const scenarioKey = String(payload.scenarioKey || payload.scenario_key || '__global__').slice(0, 128)
    const durationMs = Number(payload.durationMs || payload.duration_ms || 0) || 0
    const msPerAgent = Math.round(durationMs / Math.max(1, planAgents.length))
    const failureCategory = String(payload.failureCategory || payload.failure_category || '')
    const tenantId = String(
      row.tenant_id || payload.tenantId || payload.tenant_id || 'default'
    ).trim() || 'default'

    for (const agentName of planAgents) {
      const ok = inferToolSuccessFromExperience(payload, agentName)
      if (!opts?.dryRun) {
        await recordToolMemoryEvent(
          {
            tenantId,
            agent: 'manager',
            toolName: agentName,
            contextKey: scenarioKey,
            ok,
            ms: msPerAgent,
            error: ok ? undefined : failureCategory || 'backfill_inferred_fail',
            metadata: { source: 'memory_backfill_job' }
          },
          env
        )
      }
      recorded += 1
      const key = agentName
      if (!agents[key]) agents[key] = { trials: 0, successes: 0 }
      agents[key].trials += 1
      if (ok) agents[key].successes += 1
    }
  }

  return { scanned: rows.length, recorded, agents }
}

export async function backfillDbExperienceFromExperiences(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { dryRun?: boolean; maxRows?: number }
): Promise<{ scanned: number; synced: number; skipped: number }> {
  if (!isAgentPgConfigured()) return { scanned: 0, synced: 0, skipped: 0 }

  const maxRows = Math.max(1, Math.min(5000, opts?.maxRows ?? 800))
  const res = await agentPgQuery<{ payload: ExperiencePayload }>(
    `SELECT payload FROM mgr_memory_entries
     WHERE entry_type = 'experience'
     ORDER BY ts ASC
     LIMIT $1`,
    [maxRows],
    env
  )
  const rows = res?.rows ?? []
  let synced = 0
  let skipped = 0

  for (const row of rows) {
    const payload = row.payload ?? {}
    const planAgents = parsePlanAgents(payload)
    const question = String(payload.user || payload.question || '').trim()
    if (!question) {
      skipped += 1
      continue
    }

    const outcome = {
      successScore: Number(payload.successScore ?? 0),
      needsClarify: Boolean(payload.needsClarify),
      failureCategory: String(payload.failureCategory || ''),
      planAgents,
      results: { db: inferToolSuccessFromExperience(payload, 'db') ? question.slice(0, 200) : '' },
      probeDbMatched: Boolean(payload.probeDbMatched),
      probeRagHits: Number(payload.probeRagHits ?? 0) || 0
    }

    if (!shouldSyncDbExperience(outcome)) {
      skipped += 1
      continue
    }
    if (opts?.dryRun) {
      synced += 1
      continue
    }

    const r = await syncDbExperienceFromManagerRun({
      ...outcome,
      question,
      dataDomain: String(process.env.DB_AGENT_DOMAIN || 'general')
    }, env)
    if (r.synced) synced += 1
    else skipped += 1
  }

  return { scanned: rows.length, synced, skipped }
}

export async function backfillRagExperienceFromExperiences(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { dryRun?: boolean; maxRows?: number }
): Promise<{ scanned: number; synced: number; skipped: number }> {
  if (!isAgentPgConfigured()) return { scanned: 0, synced: 0, skipped: 0 }

  const maxRows = Math.max(1, Math.min(5000, opts?.maxRows ?? 800))
  const res = await agentPgQuery<{ payload: ExperiencePayload }>(
    `SELECT payload FROM mgr_memory_entries
     WHERE entry_type = 'experience'
     ORDER BY ts ASC
     LIMIT $1`,
    [maxRows],
    env
  )
  const rows = res?.rows ?? []
  let synced = 0
  let skipped = 0

  for (const row of rows) {
    const payload = row.payload ?? {}
    const planAgents = parsePlanAgents(payload)
    const question = String(payload.user || payload.question || '').trim()
    if (!question) {
      skipped += 1
      continue
    }

    const outcome = {
      successScore: Number(payload.successScore ?? 0),
      needsClarify: Boolean(payload.needsClarify),
      failureCategory: String(payload.failureCategory || ''),
      planAgents,
      results: (payload.results as Record<string, unknown>) || {
        rag: inferToolSuccessFromExperience(payload, 'rag') ? question.slice(0, 200) : ''
      },
      probeDbMatched: Boolean(payload.probeDbMatched),
      probeRagHits: Number(payload.probeRagHits ?? payload.probe_rag_hits ?? 0) || 0
    }

    if (!planAgents.map((a) => a.toLowerCase()).includes('rag')) {
      skipped += 1
      continue
    }
    if (!shouldSyncRagExperience(outcome)) {
      skipped += 1
      continue
    }
    if (opts?.dryRun) {
      synced += 1
      continue
    }

    const r = await syncRagExperienceFromManagerRun({ ...outcome, question, ragPath: 'document_query' }, env)
    if (r.synced) synced += 1
    else skipped += 1
  }

  return { scanned: rows.length, synced, skipped }
}

export async function backfillAdminExperienceFromExperiences(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { dryRun?: boolean; maxRows?: number }
): Promise<{ scanned: number; synced: number; skipped: number }> {
  if (!isAgentPgConfigured()) return { scanned: 0, synced: 0, skipped: 0 }

  const maxRows = Math.max(1, Math.min(5000, opts?.maxRows ?? 800))
  const res = await agentPgQuery<{ payload: ExperiencePayload }>(
    `SELECT payload FROM mgr_memory_entries
     WHERE entry_type = 'experience'
     ORDER BY ts ASC
     LIMIT $1`,
    [maxRows],
    env
  )
  const rows = res?.rows ?? []
  let synced = 0
  let skipped = 0

  for (const row of rows) {
    const payload = row.payload ?? {}
    const planAgents = parsePlanAgents(payload)
    const question = String(payload.user || payload.question || '').trim()
    if (!question) {
      skipped += 1
      continue
    }

    const outcome = {
      successScore: Number(payload.successScore ?? 0),
      needsClarify: Boolean(payload.needsClarify),
      failureCategory: String(payload.failureCategory || ''),
      planAgents,
      results: (payload.results as Record<string, unknown>) || {
        admin: inferToolSuccessFromExperience(payload, 'admin') ? question.slice(0, 200) : ''
      },
      probeDbMatched: Boolean(payload.probeDbMatched),
      probeRagHits: Number(payload.probeRagHits ?? 0) || 0
    }

    if (!planAgents.map((a) => a.toLowerCase()).includes('admin')) {
      skipped += 1
      continue
    }
    if (!shouldSyncAdminExperience(outcome)) {
      skipped += 1
      continue
    }
    if (opts?.dryRun) {
      synced += 1
      continue
    }

    const r = await syncAdminExperienceFromManagerRun(
      {
        ...outcome,
        question,
        scenarioKey: String(payload.scenarioKey || payload.scenario_key || ''),
        intent: String(payload.intent || '')
      },
      env
    )
    if (r.synced) synced += 1
    else skipped += 1
  }

  return { scanned: rows.length, synced, skipped }
}

export async function runMemoryBackfillJob(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { dryRun?: boolean; maxRows?: number }
): Promise<{
  toolMemory: Awaited<ReturnType<typeof rebuildToolMemoryFromExperiences>>
  dbExperience: Awaited<ReturnType<typeof backfillDbExperienceFromExperiences>>
  ragExperience: Awaited<ReturnType<typeof backfillRagExperienceFromExperiences>>
  adminExperience: Awaited<ReturnType<typeof backfillAdminExperienceFromExperiences>>
}> {
  if (!isMemoryBackfillEnabled(env)) {
    return {
      toolMemory: { scanned: 0, recorded: 0, agents: {} },
      dbExperience: { scanned: 0, synced: 0, skipped: 0 },
      ragExperience: { scanned: 0, synced: 0, skipped: 0 },
      adminExperience: { scanned: 0, synced: 0, skipped: 0 }
    }
  }
  const toolMemory = await rebuildToolMemoryFromExperiences(env, opts)
  const dbExperience = await backfillDbExperienceFromExperiences(env, opts)
  const ragExperience = await backfillRagExperienceFromExperiences(env, opts)
  const adminExperience = await backfillAdminExperienceFromExperiences(env, opts)
  return { toolMemory, dbExperience, ragExperience, adminExperience }
}
