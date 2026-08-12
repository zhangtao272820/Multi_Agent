/**
 * 记忆重要性评分（规则优先；可选 LLM 由调用方注入）。
 * 用于写入 payload.importance 与召回排序。
 */

export type ImportanceSignals = {
  successScore?: number
  entryType?: string
  hitlConfirmed?: boolean
  userExplicitPreference?: boolean
  chitchat?: boolean
  feedbackScore?: number
}

/** 0..1 */
export function scoreMemoryImportance(signals: ImportanceSignals): number {
  if (signals.chitchat) return 0.15
  if (signals.userExplicitPreference) return 0.95
  if (signals.hitlConfirmed) return 0.88
  const success = Number(signals.successScore)
  const fb = Number(signals.feedbackScore)
  let base = 0.45
  if (Number.isFinite(success)) {
    base = Math.max(base, Math.min(0.92, 0.35 + success * 0.55))
  }
  if (Number.isFinite(fb) && fb > 0) {
    base = Math.max(base, Math.min(0.9, 0.4 + fb * 0.5))
  }
  const t = String(signals.entryType || '').toLowerCase()
  if (t === 'semantic') base = Math.max(base, 0.7)
  if (t === 'reflection') base = Math.max(base, 0.55)
  if (t === 'user_preference') base = Math.max(base, 0.9)
  return Math.round(Math.max(0, Math.min(1, base)) * 1000) / 1000
}

/** 召回分：importance × timeDecay（与 success 并列时由 blend 吸收） */
export function importanceWeightedScore(importance: number, timeDecay: number, baseScore: number): number {
  const imp = Math.max(0, Math.min(1, Number(importance) || 0.5))
  const decay = Math.max(0, Math.min(1, Number(timeDecay) || 1))
  const base = Math.max(0, Number(baseScore) || 0)
  return base * (0.65 + 0.35 * imp) * (0.5 + 0.5 * decay)
}
