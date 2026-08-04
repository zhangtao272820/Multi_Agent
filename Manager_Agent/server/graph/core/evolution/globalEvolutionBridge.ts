/**
 * 进化双轨：从多租户重复假设生成脱敏 global_candidate，供平台人工审核合入 _global_
 * 候选须附带「多租户已晋升且无近期 rollback」证据。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery } from '#agent-shared/agentPgClient'
import { GLOBAL_BASELINE_TENANT_ID, normalizeTenantId, tenantPolicyDir } from '#agent-shared/tenantScope'
import { listActiveTenantIds, upsertEvoPolicyVersion } from '#agent-shared/evoPolicyStore'

const PII_PATTERNS = [
  /\b\d{11}\b/g, // phone-ish
  /\b[\w.+-]+@[\w.-]+\.\w+\b/gi,
  /\b(?:\d{15}|\d{18}|\d{17}[\dXx])\b/g
]

export function sanitizeEvolutionText(text: string): string {
  let s = String(text || '')
  for (const re of PII_PATTERNS) s = s.replace(re, '[REDACTED]')
  // strip long hex / ids
  s = s.replace(/\b[a-f0-9]{24,}\b/gi, '[ID]')
  return s.trim().slice(0, 800)
}

export function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload || {})) {
    if (typeof v === 'string') out[k] = sanitizeEvolutionText(v)
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? sanitizeEvolutionText(x) : x)).slice(0, 20)
    else if (v && typeof v === 'object') out[k] = sanitizePayload(v as Record<string, unknown>)
    else out[k] = v
  }
  // drop tenant-specific keys
  delete out.tenantId
  delete out.tenant_id
  delete out.userId
  delete out.sessionId
  delete out.user
  return out
}

async function readHypotheses(policyDir: string): Promise<Array<{ statement: string; artifact?: string; confidence?: number }>> {
  const raw = await fs.readFile(path.join(policyDir, 'manager-evolution-hypotheses.jsonl'), 'utf8').catch(() => '')
  if (!raw.trim()) return []
  const out: Array<{ statement: string; artifact?: string; confidence?: number }> = []
  for (const line of raw.split('\n').filter(Boolean).slice(-80)) {
    try {
      const o = JSON.parse(line)
      const statement = String(o?.statement || '').trim()
      if (statement.length >= 12) {
        out.push({
          statement,
          artifact: o.artifact ? String(o.artifact) : undefined,
          confidence: Number(o.confidence || 0)
        })
      }
    } catch {
      /* skip */
    }
  }
  return out
}

function normKey(s: string) {
  return sanitizeEvolutionText(s).toLowerCase().replace(/\s+/g, '').slice(0, 120)
}

function rollbackLookbackMs() {
  const days = Number(process.env.MANAGER_EVOLUTION_GLOBAL_ROLLBACK_LOOKBACK_DAYS ?? 14)
  const d = Number.isFinite(days) && days >= 1 ? Math.min(90, days) : 14
  return d * 24 * 60 * 60 * 1000
}

export type TenantPromotionEvidence = {
  tenantId: string
  promoted: boolean
  recentRollback: boolean
  lastPromotedAt?: string
  lastRollbackAt?: string
}

async function readExperimentEvidence(
  policyDir: string,
  artifact: string,
  statementKey: string
): Promise<{ promoted: boolean; recentRollback: boolean; lastPromotedAt?: string; lastRollbackAt?: string }> {
  const raw = await fs.readFile(path.join(policyDir, 'manager-evolution-experiments.jsonl'), 'utf8').catch(() => '')
  if (!raw.trim()) return { promoted: false, recentRollback: false }
  const lookback = Date.now() - rollbackLookbackMs()
  let promoted = false
  let recentRollback = false
  let lastPromotedAt: string | undefined
  let lastRollbackAt: string | undefined
  for (const line of raw.split('\n').filter(Boolean).slice(-200)) {
    try {
      const o = JSON.parse(line)
      const art = String(o?.artifact || '')
      if (art && art !== artifact) continue
      const rationaleKey = normKey(String(o?.rationale || o?.statement || ''))
      // 允许同 artifact 的实验证据；若有 rationale 则优先匹配假设
      if (rationaleKey && statementKey && rationaleKey !== statementKey && !rationaleKey.includes(statementKey.slice(0, 40))) {
        continue
      }
      const status = String(o?.status || '')
      const ts = String(o?.closedAt || o?.ts || o?.createdAt || '')
      const t = Date.parse(ts)
      if (status === 'promoted') {
        promoted = true
        if (!lastPromotedAt || (Number.isFinite(t) && t >= (Date.parse(lastPromotedAt) || 0))) lastPromotedAt = ts
      }
      if (status === 'rolled_back' && Number.isFinite(t) && t >= lookback) {
        recentRollback = true
        if (!lastRollbackAt || t >= (Date.parse(lastRollbackAt) || 0)) lastRollbackAt = ts
      }
    } catch {
      /* skip */
    }
  }
  return { promoted, recentRollback, lastPromotedAt, lastRollbackAt }
}

/** 汇总多租户晋升证据（供 HITL 审核） */
export async function collectGlobalCandidateEvidence(
  dataRoot: string,
  tenantIds: string[],
  artifact: string,
  statement: string
): Promise<{
  tenantsPromoted: string[]
  tenantsWithRecentRollback: string[]
  perTenant: TenantPromotionEvidence[]
  eligible: boolean
}> {
  const key = normKey(statement)
  const perTenant: TenantPromotionEvidence[] = []
  for (const tid of tenantIds) {
    const dir = tenantPolicyDir(dataRoot, tid)
    const ev = await readExperimentEvidence(dir, artifact, key)
    perTenant.push({
      tenantId: tid,
      promoted: ev.promoted,
      recentRollback: ev.recentRollback,
      lastPromotedAt: ev.lastPromotedAt,
      lastRollbackAt: ev.lastRollbackAt
    })
  }
  const tenantsPromoted = perTenant.filter((p) => p.promoted && !p.recentRollback).map((p) => p.tenantId)
  const tenantsWithRecentRollback = perTenant.filter((p) => p.recentRollback).map((p) => p.tenantId)
  const minTenants = Math.max(2, Number(process.env.MANAGER_EVOLUTION_GLOBAL_MIN_TENANTS ?? 2) || 2)
  const eligible = tenantsPromoted.length >= minTenants && tenantsWithRecentRollback.length === 0
  return { tenantsPromoted, tenantsWithRecentRollback, perTenant, eligible }
}

/** 多租户重复出现的假设 → evo_global_candidates(pending)；须有晋升证据 */
export async function maybeProposeGlobalCandidates(dataRoot: string): Promise<{ proposed: number; skippedNoEvidence: number }> {
  if (String(process.env.MANAGER_EVOLUTION_GLOBAL_PROPOSE ?? '1').trim() === '0') {
    return { proposed: 0, skippedNoEvidence: 0 }
  }
  const tenants = await listActiveTenantIds()
  const counts = new Map<string, { statement: string; artifact: string; tenants: Set<string>; conf: number }>()

  for (const tid of tenants.slice(0, 48)) {
    const dir = tenantPolicyDir(dataRoot, tid)
    const hyps = await readHypotheses(dir)
    for (const h of hyps) {
      const key = normKey(h.statement)
      if (!key) continue
      const cur = counts.get(key) || {
        statement: sanitizeEvolutionText(h.statement),
        artifact: String(h.artifact || 'prompt_patches'),
        tenants: new Set<string>(),
        conf: 0
      }
      cur.tenants.add(tid)
      cur.conf = Math.max(cur.conf, Number(h.confidence || 0))
      counts.set(key, cur)
    }
  }

  const minTenants = Math.max(2, Number(process.env.MANAGER_EVOLUTION_GLOBAL_MIN_TENANTS ?? 2) || 2)
  let proposed = 0
  let skippedNoEvidence = 0
  for (const item of counts.values()) {
    if (item.tenants.size < minTenants) continue
    const tenantList = [...item.tenants].slice(0, 12)
    const evidence = await collectGlobalCandidateEvidence(dataRoot, tenantList, item.artifact, item.statement)
    if (!evidence.eligible) {
      skippedNoEvidence += 1
      continue
    }

    const payload = sanitizePayload({
      statement: item.statement,
      artifact: item.artifact,
      sourceTenants: tenantList,
      confidence: item.conf,
      evidence: {
        tenantsPromoted: evidence.tenantsPromoted,
        tenantsWithRecentRollback: evidence.tenantsWithRecentRollback,
        perTenant: evidence.perTenant.slice(0, 12),
        eligible: true,
        collectedAt: new Date().toISOString()
      }
    })
    const sourceTenant = evidence.tenantsPromoted[0] || tenantList[0] || 'default'
    const existing = await agentPgQuery<{ id: string }>(
      `SELECT id FROM evo_global_candidates
       WHERE status = 'pending' AND sanitized_payload->>'statement' = $1
       LIMIT 1`,
      [item.statement]
    ).catch(() => null)
    if (existing?.rows?.length) continue

    await agentPgQuery(
      `INSERT INTO evo_global_candidates
        (source_tenant_id, agent, stage, sanitized_payload, status)
       VALUES ($1,'manager',$2,$3::jsonb,'pending')`,
      [sourceTenant, item.artifact, JSON.stringify(payload)]
    ).catch(() => undefined)

    await upsertEvoPolicyVersion({
      tenantId: sourceTenant,
      agent: 'manager',
      stage: `global_candidate:${item.artifact}`,
      version: Date.now() % 1_000_000_000,
      status: 'global_candidate',
      payload
    }).catch(() => undefined)

    proposed += 1
    if (proposed >= 20) break
  }
  return { proposed, skippedNoEvidence }
}

export async function listGlobalCandidates(status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending') {
  const res = await agentPgQuery<{
    id: string
    source_tenant_id: string
    agent: string
    stage: string
    sanitized_payload: Record<string, unknown>
    status: string
    reviewer: string | null
    review_note: string | null
    created_at: string
    reviewed_at: string | null
  }>(
    status === 'all'
      ? `SELECT * FROM evo_global_candidates ORDER BY created_at DESC LIMIT 100`
      : `SELECT * FROM evo_global_candidates WHERE status = $1 ORDER BY created_at DESC LIMIT 100`,
    status === 'all' ? [] : [status]
  ).catch(() => null)
  return res?.rows ?? []
}

export async function reviewGlobalCandidate(input: {
  id: number | string
  decision: 'approved' | 'rejected'
  reviewer: string
  note?: string
}): Promise<{ ok: boolean; reason?: string }> {
  const id = Number(input.id)
  if (!Number.isFinite(id)) return { ok: false, reason: 'bad_id' }
  const row = await agentPgQuery<{
    id: string
    agent: string
    stage: string
    sanitized_payload: Record<string, unknown>
    status: string
  }>(`SELECT id, agent, stage, sanitized_payload, status FROM evo_global_candidates WHERE id = $1`, [id]).catch(
    () => null
  )
  const cur = row?.rows?.[0]
  if (!cur) return { ok: false, reason: 'not_found' }
  if (cur.status !== 'pending') return { ok: false, reason: 'not_pending' }

  await agentPgQuery(
    `UPDATE evo_global_candidates
     SET status = $2, reviewer = $3, review_note = $4, reviewed_at = NOW()
     WHERE id = $1`,
    [id, input.decision, input.reviewer.slice(0, 128), (input.note || '').slice(0, 500)]
  )

  if (input.decision === 'approved') {
    const version = Math.floor(Date.now() / 1000)
    await upsertEvoPolicyVersion({
      tenantId: GLOBAL_BASELINE_TENANT_ID,
      agent: String(cur.agent || 'manager'),
      stage: String(cur.stage || 'baseline'),
      version,
      status: 'active',
      payload: sanitizePayload(cur.sanitized_payload || {}),
      promotedAt: new Date().toISOString()
    })
  }
  return { ok: true }
}

export { GLOBAL_BASELINE_TENANT_ID, normalizeTenantId }
