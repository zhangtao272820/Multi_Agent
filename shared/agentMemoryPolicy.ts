/**
 * Agent Memory Policy (AMP) — 跨 Agent 统一的记忆策略常量。
 * 存储可换、契约不变；各 Agent 通过 env 覆盖，默认与 docs/Agent记忆与存储数据库化升级方案.md §2.2 对齐。
 */

export const AMP_POLICY_VERSION = '2026-06-18-phase2-3'

/** 长期经验写入门槛（success_score 或等价正反馈） */
export const AMP_EXPERIENCE_SUCCESS_THRESHOLD = 0.72

/** 召回注入上限 */
export const AMP_RECALL_LIMITS = {
  managerExperience: 4,
  managerReflection: 3,
  dbExperienceBlockChars: 480,
  ragCrossProfileSegments: 2
} as const

/** 生命周期与 TTL */
export const AMP_TTL = {
  sessionTurnsMax: 200,
  conversationMaxTurns: 20,
  conversationRecentTurns: 12,
  workingMemoryDays: 7,
  ragSessionHours: 6,
  ragSessionMax: 200,
  experienceActiveMax: 180,
  experienceRetentionDays: 90,
  hitlCheckpointHours: 24
} as const

/** Wave6：召回时间衰减 λ/天（越大旧记忆掉分越快）；可用 AMP_RECALL_DECAY_LAMBDA 覆盖 */
export function ampRecallDecayLambdaPerDay(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AMP_RECALL_DECAY_LAMBDA ?? env.MANAGER_MEMORY_DECAY_LAMBDA ?? 0.09)
  if (!Number.isFinite(n) || n < 0) return 0.09
  return Math.min(1, n)
}

/** 写入策略标签（供 ops / ready 报告） */
export const AMP_WRITE_GATE = {
  sessionTurn: 'always_append',
  working: 'finalize_session_scoped',
  experience: `success_score>=${AMP_EXPERIENCE_SUCCESS_THRESHOLD}`,
  learningSignal: 'always_append',
  evolvedPatch: 'shadow_only'
} as const

/** 禁止写入（全平台，升级时须保留现有行为） */
export const AMP_FORBIDDEN_WRITES = [
  'tool_not_found_dirty_text',
  'empty_result_placeholder',
  'unconfirmed_hitl_intermediate'
] as const

export type AmpSummary = {
  version: string
  experienceThreshold: number
  recallLimits: typeof AMP_RECALL_LIMITS
  ttl: typeof AMP_TTL
}

export function getAmpSummary(): AmpSummary {
  return {
    version: AMP_POLICY_VERSION,
    experienceThreshold: AMP_EXPERIENCE_SUCCESS_THRESHOLD,
    recallLimits: AMP_RECALL_LIMITS,
    ttl: AMP_TTL
  }
}
