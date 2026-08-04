/**
 * 门 1 · 学习信号准入：失败/闲聊/基建噪声默认不进策略进化；
 * 隐式负向可记惩罚但不单独发起晋升。
 */

export type LearnEligibilityInput = {
  failureCategory?: string | null
  intent?: string | null
  needsClarify?: boolean
  signalSource?: 'run' | 'explicit_feedback' | 'implicit' | string | null
  implicitKind?: 'user_cancel' | 'new_chat_interrupt' | 'human_reject' | 'retry_penalty' | string | null
  firstPassSuccess?: boolean
  compositeScore?: number | null
  feedbackScore?: number | null
  /** 同类 clarify 失败浓度（0..1）；仅 clarify_needed 放行时使用 */
  clarifyConcentration?: number | null
}

export type LearnEligibilityDecision = {
  /** 可驱动 shadow / 假设 / 晋升侧学习 */
  eligibleForEvolution: boolean
  /** 可写入路由 Bandit 奖励（含负向惩罚） */
  eligibleForBandit: boolean
  /** 该失败类别是否允许生成进化假设 */
  eligibleForHypothesis: boolean
  reason: string
  /** 正样本权重（晋升侧）；隐式负向为 0 */
  weight: number
}

/** 可进入策略进化假设的失败归因类 */
export const EVOLUTION_HYPOTHESIS_CATEGORIES = new Set([
  'route_error',
  'plan_error',
  'evidence_gap',
  'search_gap',
  'synthesis_error',
  'verification_gap'
])

/** 基建/边界类：只告警，不改 Prompt/路由阈值 */
export const OPS_ONLY_CATEGORIES = new Set(['tool_failure', 'timeout', 'policy_boundary'])

const CHITCHAT_INTENTS = new Set([
  'chitchat',
  'chitchat_only',
  'off_topic',
  'interrupted',
  'smalltalk',
  '闲聊'
])

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function normalizeIntent(intent?: string | null) {
  return String(intent || '')
    .trim()
    .toLowerCase()
}

function normalizeCategory(cat?: string | null) {
  return String(cat || '')
    .trim()
    .toLowerCase() || 'unclear'
}

export function isChitchatOrOffTopicIntent(intent?: string | null) {
  const i = normalizeIntent(intent)
  if (!i) return false
  if (CHITCHAT_INTENTS.has(i)) return true
  return i.includes('chitchat') || i.includes('off_topic')
}

export function isFailureCategoryEvolutionEligible(
  category?: string | null,
  opts?: { clarifyConcentration?: number | null }
): boolean {
  const cat = normalizeCategory(category)
  if (EVOLUTION_HYPOTHESIS_CATEGORIES.has(cat)) return true
  if (cat === 'clarify_needed') {
    const c = Number(opts?.clarifyConcentration ?? 0)
    return Number.isFinite(c) && c >= 0.4
  }
  return false
}

/**
 * 评估单条学习信号是否可进进化 / Bandit。
 * 原则：隐式负向只惩罚，不单独发起晋升（eligibleForEvolution=false）。
 */
export function evaluateLearnEligibility(input: LearnEligibilityInput): LearnEligibilityDecision {
  const cat = normalizeCategory(input.failureCategory)
  const intent = normalizeIntent(input.intent)
  const source = String(input.signalSource || 'run').trim()
  const implicitKind = String(input.implicitKind || '').trim()

  if (isChitchatOrOffTopicIntent(intent)) {
    return {
      eligibleForEvolution: false,
      eligibleForBandit: false,
      eligibleForHypothesis: false,
      reason: 'off_topic_or_chitchat',
      weight: 0
    }
  }

  if (implicitKind === 'user_cancel' || implicitKind === 'new_chat_interrupt') {
    return {
      eligibleForEvolution: false,
      eligibleForBandit: false,
      eligibleForHypothesis: false,
      reason: `implicit_${implicitKind || 'cancel'}`,
      weight: 0
    }
  }

  if (OPS_ONLY_CATEGORIES.has(cat)) {
    return {
      eligibleForEvolution: false,
      eligibleForBandit: false,
      eligibleForHypothesis: false,
      reason: `ops_only_${cat}`,
      weight: 0
    }
  }

  if (source === 'implicit' || implicitKind === 'human_reject' || implicitKind === 'retry_penalty') {
    return {
      eligibleForEvolution: false,
      eligibleForBandit: true,
      eligibleForHypothesis: false,
      reason: `implicit_penalty_${implicitKind || 'generic'}`,
      weight: 0
    }
  }

  if (input.needsClarify || cat === 'clarify_needed') {
    const conc = Number(input.clarifyConcentration ?? 0)
    const highConc = Number.isFinite(conc) && conc >= 0.4
    return {
      eligibleForEvolution: highConc,
      eligibleForBandit: false,
      eligibleForHypothesis: highConc,
      reason: highConc ? 'clarify_high_concentration' : 'clarify_default_block',
      weight: 0
    }
  }

  const hypoOk = isFailureCategoryEvolutionEligible(cat, {
    clarifyConcentration: input.clarifyConcentration
  })

  const fb = input.feedbackScore
  const explicitPositive =
    source === 'explicit_feedback' && fb != null && Number.isFinite(Number(fb)) && Number(fb) >= 0.7
  const strongSuccess =
    Boolean(input.firstPassSuccess) &&
    Number(input.compositeScore ?? 0) >= 0.72 &&
    (cat === 'success' || !cat || cat === 'unclear')

  if (explicitPositive || strongSuccess) {
    const weight = clamp01(
      0.85 +
        (explicitPositive ? 0.15 : 0) +
        (input.firstPassSuccess ? 0.05 : 0) +
        Math.max(0, Number(input.compositeScore ?? 0) - 0.72)
    )
    return {
      eligibleForEvolution: true,
      eligibleForBandit: true,
      eligibleForHypothesis: false,
      reason: explicitPositive ? 'explicit_positive' : 'strong_first_pass',
      weight: Math.min(1, Math.round(weight * 1000) / 1000)
    }
  }

  if (hypoOk) {
    return {
      eligibleForEvolution: true,
      eligibleForBandit: true,
      eligibleForHypothesis: true,
      reason: `failure_${cat}`,
      weight: 0.35
    }
  }

  if (cat === 'success') {
    return {
      eligibleForEvolution: true,
      eligibleForBandit: true,
      eligibleForHypothesis: false,
      reason: 'success_run',
      weight: Number(input.compositeScore ?? 0) >= 0.65 ? 0.55 : 0.25
    }
  }

  return {
    eligibleForEvolution: false,
    eligibleForBandit: false,
    eligibleForHypothesis: false,
    reason: `blocked_${cat || 'unknown'}`,
    weight: 0
  }
}

/** 过滤失败洞察：仅保留可假设类别（clarify 需浓度） */
export function filterInsightsForEvolution<
  T extends { category: string; count: number },
  B extends { samples: number; failures: T[]; fixSuggestions?: Array<{ category: string }> }
>(insights: B): B {
  const samples = Math.max(1, Number(insights.samples) || 1)
  const failures = (insights.failures || []).filter((f) => {
    const conc = f.count / samples
    return isFailureCategoryEvolutionEligible(f.category, { clarifyConcentration: conc })
  })
  const allowed = new Set(failures.map((f) => f.category))
  const fixSuggestions = (insights.fixSuggestions || []).filter((b) => allowed.has(String(b.category || '')))
  return { ...insights, failures, fixSuggestions }
}
