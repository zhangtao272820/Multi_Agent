/**
 * 经验召回策略：联邦门控开启时，默认只召回用户已确认（👍）写入的经验。
 * 写入侧 SSOT：`shared/experienceBridgeContract.ts`（规范化 / source / PG 门禁）。
 */
import { isFederationFeedbackGated } from './artifactFeedbackPolicy'

export function isExperienceRecallConfirmedOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = String(env.EXPERIENCE_RECALL_CONFIRMED_ONLY ?? '').trim()
  if (explicit === '1' || explicit.toLowerCase() === 'true') return true
  if (explicit === '0' || explicit.toLowerCase() === 'false') return false
  return isFederationFeedbackGated(env)
}

/** jsonl 经验行是否可用于召回（无 PG status 列时的兜底） */
export function isConfirmedExperienceRow(row: {
  source?: string
  userConfirmed?: boolean
  status?: string
}): boolean {
  if (row.userConfirmed === true) return true
  if (String(row.status || '').trim() === 'confirmed') return true
  const src = String(row.source || '').trim()
  if (!src) return false
  if (src.includes('shadow')) return false
  return (
    src.includes('feedback') ||
    src.includes('federation') ||
    src.includes('manager_finalize_sync') ||
    src.includes('manager_feedback_confirmed') ||
    src.includes('confirmed')
  )
}
