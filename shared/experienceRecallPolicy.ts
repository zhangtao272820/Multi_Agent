/**
 * 经验召回策略：联邦门控开启时，默认只召回用户已确认（👍）写入的经验。
 * 独立端（standalone）默认排除 manager_orchestrated 联邦源。
 * 写入侧 SSOT：`shared/experienceBridgeContract.ts`（规范化 / source / PG 门禁）。
 */
import { isFederationFeedbackGated } from './artifactFeedbackPolicy'

export type ExperienceRecallPlane = 'standalone' | 'orchestrated' | 'any'

export function isExperienceRecallConfirmedOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = String(env.EXPERIENCE_RECALL_CONFIRMED_ONLY ?? '').trim()
  if (explicit === '1' || explicit.toLowerCase() === 'true') return true
  if (explicit === '0' || explicit.toLowerCase() === 'false') return false
  return isFederationFeedbackGated(env)
}

/** 独立端是否排除总管联邦经验（默认排除） */
export function isStandaloneExcludeFederated(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = String(env.EXPERIENCE_STANDALONE_EXCLUDE_FEDERATED ?? '1').trim().toLowerCase()
  return !(explicit === '0' || explicit === 'false' || explicit === 'off' || explicit === 'no')
}

export function resolveExperienceSourcePlane(row: {
  source?: string
  source_plane?: string
  sourcePlane?: string
}): 'standalone' | 'manager_orchestrated' | 'unknown' {
  const plane = String(row.source_plane || row.sourcePlane || '')
    .trim()
    .toLowerCase()
  if (plane === 'manager_orchestrated' || plane === 'orchestrated') return 'manager_orchestrated'
  if (plane === 'standalone' || plane === 'local') return 'standalone'
  const src = String(row.source || '')
    .trim()
    .toLowerCase()
  if (
    src.includes('manager_finalize_sync') ||
    src.includes('manager_feedback_confirmed') ||
    src.includes('federation') ||
    src.startsWith('mgr_')
  ) {
    return 'manager_orchestrated'
  }
  if (!src) return 'unknown'
  return 'standalone'
}

/** 按调用平面过滤：独立端默认不吃总管联邦经验 */
export function shouldRecallExperienceForPlane(
  plane: ExperienceRecallPlane,
  row: { source?: string; source_plane?: string; sourcePlane?: string },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (plane === 'any' || plane === 'orchestrated') return true
  if (!isStandaloneExcludeFederated(env)) return true
  return resolveExperienceSourcePlane(row) !== 'manager_orchestrated'
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
