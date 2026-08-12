/**
 * 高置信 Skill draft 批量 promote（PG 优先，支持仅 PG 无文件 draft）
 * 默认关闭；skipVerify 仅在显式允许专家自动晋级且 EVO_ALLOW_UNVERIFIED_PROMOTE=1 时生效。
 */

import { isExpertAutoPromoteAllowed, isUnverifiedPromoteAllowed } from '#agent-shared/evolutionPromotePolicy'
import { verifyBeforePromote } from '#agent-shared/evolutionVerify'
import {
  listSkillDraftsFromPg,
  promoteSkillDraft,
  type SkillDraftPgRow
} from './skillDraftFromSuccess'

export function isSkillBatchPromoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_SKILL_BATCH_PROMOTE ?? '0').trim() === '1'
}

function defaultMinScore(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MGR_SKILL_BATCH_PROMOTE_MIN_SCORE ?? env.MGR_SKILL_AUTO_DRAFT_MIN_SCORE ?? 0.85)
  return Number.isFinite(n) && n >= 0.72 ? Math.min(0.99, n) : 0.85
}

function shouldVerify(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_SKILL_BATCH_PROMOTE_VERIFY ?? env.EVO_VERIFY_BEFORE_PROMOTE ?? '1').trim() !== '0'
}

/** skipVerify 仅双开：专家自动晋级 + 允许未校验晋级 */
export function canSkipSkillBatchVerify(
  requested: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!requested) return false
  return isExpertAutoPromoteAllowed(env) && isUnverifiedPromoteAllowed(env)
}

export async function promoteHighConfidenceSkillDrafts(
  opts?: {
    dryRun?: boolean
    minScore?: number
    maxCount?: number
    skipVerify?: boolean
    agent?: string
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  eligible: number
  promoted: number
  skipped: number
  failed: Array<{ skillId: string; reason: string }>
  promotedIds: string[]
  verify?: { ok: boolean; reason?: string }
}> {
  const failed: Array<{ skillId: string; reason: string }> = []
  const promotedIds: string[] = []

  if (!isSkillBatchPromoteEnabled(env)) {
    return { eligible: 0, promoted: 0, skipped: 0, failed: [{ skillId: '*', reason: 'disabled' }], promotedIds: [] }
  }

  const skipVerify = canSkipSkillBatchVerify(opts?.skipVerify, env)
  let verify: { ok: boolean; reason?: string } | undefined
  if (!skipVerify && shouldVerify(env)) {
    const v = await verifyBeforePromote('manager', env).catch(() => ({ ok: false, reason: 'verify_error' }))
    verify = { ok: v.ok, reason: v.reason }
    if (!v.ok) {
      return { eligible: 0, promoted: 0, skipped: 0, failed: [{ skillId: '*', reason: v.reason || 'verify_failed' }], promotedIds: [], verify }
    }
  }

  const minScore = opts?.minScore ?? defaultMinScore(env)
  const maxCount = Math.max(1, Math.min(100, opts?.maxCount ?? 50))
  let rows = await listSkillDraftsFromPg({ status: 'draft', minScore, limit: maxCount * 2 }, env)
  if (opts?.agent) {
    const agent = String(opts.agent).trim().toLowerCase()
    rows = rows.filter((r) => r.agent.toLowerCase() === agent)
  }

  // 同 skillId 去重（保留最高分第一条）
  const seen = new Set<string>()
  const unique: SkillDraftPgRow[] = []
  for (const row of rows) {
    if (seen.has(row.skillId)) continue
    seen.add(row.skillId)
    unique.push(row)
    if (unique.length >= maxCount) break
  }

  if (opts?.dryRun) {
    return {
      eligible: unique.length,
      promoted: unique.length,
      skipped: 0,
      failed: [],
      promotedIds: unique.map((r) => r.skillId),
      verify
    }
  }

  let promoted = 0
  let skipped = 0
  for (const row of unique) {
    try {
      await promoteSkillDraft(row.skillId, { markdown: row.markdown, syncPg: true })
      promoted += 1
      promotedIds.push(row.skillId)
    } catch (e) {
      skipped += 1
      failed.push({ skillId: row.skillId, reason: String((e as Error)?.message || e) })
    }
  }

  return { eligible: unique.length, promoted, skipped, failed, promotedIds, verify }
}
