/**
 * 协作姿态合同（Ask / Plan / Agent / Debug）
 * 与 workbenchMode（对话|专业）正交：姿态约束允许动作集与停点。
 * 确定性门禁；禁止用关键词表猜测用户要哪一姿态。
 */

export type CollaborationPosture = 'ask' | 'plan' | 'agent' | 'debug'

/** 会产生外部写副作用的专才（姿态 Ask/Debug 默认禁） */
export const POSTURE_WRITE_AGENTS = new Set(['admin', 'gui'])

const POSTURE_SET = new Set<CollaborationPosture>(['ask', 'plan', 'agent', 'debug'])

export function parseCollaborationPosture(raw: unknown): CollaborationPosture | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (POSTURE_SET.has(s as CollaborationPosture)) return s as CollaborationPosture
  return null
}

/**
 * 解析本轮姿态。缺省 agent。
 * 权威顺序：meta.collaborationPosture → clientContext.collaborationPosture
 * （不含编排 LLM suggestedPosture，避免覆盖用户显式选择）
 */
export function resolveCollaborationPosture(meta?: unknown): CollaborationPosture {
  if (!meta || typeof meta !== 'object') return 'agent'
  const m = meta as Record<string, unknown>
  const fromMeta = parseCollaborationPosture(m.collaborationPosture)
  if (fromMeta) return fromMeta
  const ctx =
    m.clientContext && typeof m.clientContext === 'object' && !Array.isArray(m.clientContext)
      ? (m.clientContext as Record<string, unknown>)
      : null
  const fromCtx = parseCollaborationPosture(ctx?.collaborationPosture)
  if (fromCtx) return fromCtx
  return 'agent'
}

/** 用户是否显式选定姿态（工作台 / clientContext） */
export function hasExplicitCollaborationPosture(meta?: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false
  const m = meta as Record<string, unknown>
  if (parseCollaborationPosture(m.collaborationPosture)) return true
  const ctx =
    m.clientContext && typeof m.clientContext === 'object' && !Array.isArray(m.clientContext)
      ? (m.clientContext as Record<string, unknown>)
      : null
  return Boolean(parseCollaborationPosture(ctx?.collaborationPosture))
}

/**
 * 有效姿态：用户显式 > 编排 suggestedPosture（仅当用户未选）> agent。
 * 用于门禁 / 只读过滤；不回写用户 collaborationPosture 字段。
 */
export function resolveEffectiveCollaborationPosture(meta?: unknown): CollaborationPosture {
  if (hasExplicitCollaborationPosture(meta)) return resolveCollaborationPosture(meta)
  if (!meta || typeof meta !== 'object') return 'agent'
  const m = meta as Record<string, unknown>
  const suggested =
    parseCollaborationPosture(m.suggestedPosture) || parseCollaborationPosture(m.suggested_posture)
  return suggested || 'agent'
}

export function postureForcesReadOnly(posture: CollaborationPosture): boolean {
  return posture === 'ask' || posture === 'debug'
}

export function postureBlocksWriteSideEffects(posture: CollaborationPosture): boolean {
  return posture === 'ask' || posture === 'debug'
}

/** Plan 姿态：未确认前强制走 plan_preview（覆盖低风险免审） */
export function postureRequiresPlanPreview(posture: CollaborationPosture, meta?: Record<string, unknown>): boolean {
  if (posture !== 'plan') return false
  if (Boolean(meta?.planConfirmed)) return false
  if (Boolean(meta?.planPreviewCancelled)) return false
  return true
}

/** Ask/Debug：从 allowedAgents 中剔除写副作用专才 */
export function filterAgentsForPosture(agents: string[], posture: CollaborationPosture): string[] {
  if (!postureBlocksWriteSideEffects(posture)) return agents
  return agents.filter((a) => !POSTURE_WRITE_AGENTS.has(String(a || '').toLowerCase()))
}

export type DebugObservationRef = {
  stepId?: string
  agent?: string
  status?: string
  summary?: string
}

/**
 * Debug 重验所需的 Step Observation（或等价结构化回执）。
 * 来源：meta.debugObservations / lastStepRecords / stepRecords / clientContext
 */
export function collectDebugObservations(meta?: unknown): DebugObservationRef[] {
  if (!meta || typeof meta !== 'object') return []
  const m = meta as Record<string, unknown>
  const bags: unknown[] = [
    m.debugObservations,
    m.lastStepRecords,
    m.stepRecords,
    m.lastRunStepRecords
  ]
  const ctx =
    m.clientContext && typeof m.clientContext === 'object' && !Array.isArray(m.clientContext)
      ? (m.clientContext as Record<string, unknown>)
      : null
  if (ctx) {
    bags.push(ctx.debugObservations, ctx.lastStepRecords, ctx.stepRecords)
  }
  const out: DebugObservationRef[] = []
  for (const bag of bags) {
    if (!Array.isArray(bag)) continue
    for (const row of bag) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const stepId = String(r.stepId ?? r.id ?? '').trim()
      const agent = String(r.agent ?? '').trim()
      const status = String(r.status ?? '').trim()
      const summary = String(r.summary ?? r.output ?? r.error ?? '').trim()
      if (!stepId && !agent && !summary) continue
      out.push({
        ...(stepId ? { stepId } : {}),
        ...(agent ? { agent } : {}),
        ...(status ? { status } : {}),
        ...(summary ? { summary: summary.slice(0, 240) } : {})
      })
    }
  }
  return out
}

export function hasDebugObservations(meta?: unknown): boolean {
  return collectDebugObservations(meta).length > 0
}

/**
 * Debug：禁止无 Observation 的空猜全图重跑。
 * 有 Observation → 允许只读重验；无 → 应短路。
 */
export function postureAllowsDebugRerun(posture: CollaborationPosture, meta?: unknown): boolean {
  if (posture !== 'debug') return true
  return hasDebugObservations(meta)
}

export type PostureActionKind = 'read' | 'plan_preview' | 'write_admin' | 'write_gui' | 'code_edit_apply'

export function assertPostureAllows(
  posture: CollaborationPosture,
  action: PostureActionKind,
  meta?: unknown
): { ok: true } | { ok: false; reason: string } {
  if (action === 'write_admin' || action === 'write_gui' || action === 'code_edit_apply') {
    if (postureBlocksWriteSideEffects(posture)) {
      return {
        ok: false,
        reason:
          posture === 'ask'
            ? 'Ask 姿态为只读探查，禁止写操作'
            : 'Debug 姿态默认只读重验；写操作请切 Agent 并走人批'
      }
    }
  }
  if (posture === 'plan' && action !== 'plan_preview' && action !== 'read') {
    const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
    if (!Boolean(m.planConfirmed)) {
      return { ok: false, reason: 'Plan 姿态：批准前不可实质执行' }
    }
  }
  if (posture === 'debug' && !hasDebugObservations(meta) && action !== 'read') {
    return { ok: false, reason: 'Debug 需要本轮/上轮 Step Observation，禁止空猜全图重跑' }
  }
  return { ok: true }
}

export function postureLabelZh(posture: CollaborationPosture): string {
  return ({ ask: 'Ask', plan: 'Plan', agent: 'Agent', debug: 'Debug' } as const)[posture]
}
