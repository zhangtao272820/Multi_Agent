/**
 * 经验召回策略：默认只召回用户点「有用」(👍) 写入的经验。
 * 重新生成 / 撤回 / 无用 / 自动 finalize / 忽略反馈 → 不得进召回。
 * 独立端（standalone）默认排除 manager_orchestrated 联邦源。
 * 写入侧 SSOT：`shared/experienceBridgeContract.ts`。
 */
import { isFederationFeedbackGated } from './artifactFeedbackPolicy'

export type ExperienceRecallPlane = 'standalone' | 'orchestrated' | 'any'

export function isExperienceRecallConfirmedOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = String(env.EXPERIENCE_RECALL_CONFIRMED_ONLY ?? '').trim()
  if (explicit === '1' || explicit.toLowerCase() === 'true') return true
  if (explicit === '0' || explicit.toLowerCase() === 'false') return false
  // 默认开启：只召回有用
  return true
}

/** RAG 向量经验：默认仅「有用」反馈才索引（检索成功不自动写） */
export function ragVectorExperienceRequireUseful(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.RAG_VECTOR_EXPERIENCE_REQUIRE_USEFUL ?? '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no'
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

function sourceLooksVoidedOrShadow(src: string): boolean {
  const s = src.toLowerCase()
  return s.startsWith('voided') || s.includes(':voided') || s.includes('|voided') || s.includes('shadow')
}

/**
 * 是否算「用户点有用」可召回经验。
 * 禁止：finalize 自动同步、黄金旁路、无用/撤回、裸 feedback 影子。
 */
export function isConfirmedExperienceRow(row: {
  source?: string
  userConfirmed?: boolean
  status?: string
}): boolean {
  if (row.userConfirmed === true) return true
  const src = String(row.source || '').trim()
  if (!src) return false
  if (sourceLooksVoidedOrShadow(src)) return false
  const low = src.toLowerCase()
  if (low.includes('useless') || low.includes('score:-1') || low.includes('score=-1')) return false
  if (low.includes('manager_feedback_confirmed')) return true
  if (low.includes('vanna_feedback')) return true
  if (/(^|[|_:-])useful([|_:-]|$)/i.test(src) || low.includes('score:1') || low.includes('score=1')) {
    return true
  }
  if (String(row.status || '').trim() === 'confirmed') {
    return (
      low.includes('feedback_confirmed') ||
      low.includes('useful') ||
      low.includes('vanna_feedback') ||
      row.userConfirmed === true
    )
  }
  return false
}

/** @deprecated 兼容旧调用 */
export function experienceRecallFollowsFederationGate(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFederationFeedbackGated(env)
}
