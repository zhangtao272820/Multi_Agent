/**
 * multi 空 plan 兜底：优先原 intent / 最近失败 evidence agent，禁止无依据默认 db。
 */

const PLAN_AGENTS = new Set([
  'db',
  'rag',
  'code',
  'crawler',
  'gui',
  'admin',
  'visualize',
  'report',
  'clean',
  'multimodal',
  'music',
  'video'
])

export type EmptyPlanAgent =
  | 'db'
  | 'rag'
  | 'code'
  | 'crawler'
  | 'gui'
  | 'admin'
  | 'visualize'
  | 'report'
  | 'clean'
  | 'multimodal'
  | 'music'
  | 'video'

function asPlanAgent(raw: unknown): EmptyPlanAgent | null {
  const a = String(raw || '').trim().toLowerCase()
  if (!a || a === 'multi') return null
  if (!PLAN_AGENTS.has(a)) return null
  return a as EmptyPlanAgent
}

/** 从 intent / 失败 evidence 推导空 plan 默认 step agent */
export function resolveEmptyPlanFallbackAgent(state: {
  intent?: unknown
  evidence?: unknown[]
}): EmptyPlanAgent {
  const fromIntent = asPlanAgent(state.intent)
  if (fromIntent) return fromIntent

  const evidence = Array.isArray(state.evidence) ? state.evidence : []
  for (let i = evidence.length - 1; i >= 0; i--) {
    const e = evidence[i]
    if (!e || typeof e !== 'object') continue
    const row = e as {
      kind?: string
      agent?: string
      failed?: boolean
      agentResult?: { ok?: boolean }
    }
    const failed = row.failed === true || row.agentResult?.ok === false
    if (!failed) continue
    const fromEvidence = asPlanAgent(row.agent) || asPlanAgent(row.kind)
    if (fromEvidence) return fromEvidence
  }

  return 'db'
}
