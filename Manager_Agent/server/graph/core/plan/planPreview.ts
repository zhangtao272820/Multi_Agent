import type { Step } from '../../../utils/shared/taskPlan'
import {
  postureRequiresPlanPreview,
  resolveCollaborationPosture
} from '../../../utils/platform/collaborationPosture'
import {
  planGateRequiresPreview,
  resolveRiskExecutionPolicy,
  gateCopy
} from '../policy/riskExecutionPolicy'
import { rolloutHit } from '../evolution/featureRollout'
import { getEffectivePlanSteps } from '../plan'
import { planAgentLabel } from '../runtime/phaseLabels'
import { buildRoutePlanCardFromState, type RoutePlanCardPayload } from '../routing/routePlanCard'
import { llmUpgradeRequiresPlanPreview } from './planUpgrade'
import { resolveAdminAutoConfirmDecision } from '../executors/autoConfirmAudit'

export type PlanPreviewStepItem = {
  id: string
  agent: string
  agentLabel: string
  query: string
  order: number
  enabled: boolean
  optional?: boolean
  /** U5：本步人审 vs 自动确认预告 */
  confirmMode?: 'hitl' | 'auto_confirm' | 'none'
  confirmReason?: string
}

/** 分层 Approve：auto 跳过预览 · plan 步数达标才预览 · strict 强制预览 */
export type PlanApproveTier = 'auto' | 'plan' | 'strict'

const WRITE_SIDE_AGENTS = new Set(['admin', 'gui'])

/** MANAGER_PLAN_PREVIEW: 0 关 | 1 全开 | auto（默认，按分层 Approve） */
export function isPlanPreviewEnabled(sessionId?: string): boolean {
  const raw = String(process.env.MANAGER_PLAN_PREVIEW ?? 'auto').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  return rolloutHit('MANAGER_PLAN_PREVIEW_PCT', sessionId, 100)
}

export function planPreviewMinSteps(): number {
  const n = Number(process.env.MANAGER_PLAN_PREVIEW_MIN_STEPS ?? '3')
  return Number.isFinite(n) && n >= 2 ? Math.min(12, Math.floor(n)) : 3
}

export function planHasWriteSideEffects(steps: Step[]): boolean {
  return (Array.isArray(steps) ? steps : []).some((s) => WRITE_SIDE_AGENTS.has(String(s?.agent || '').toLowerCase()))
}

/**
 * 依 worldModel 风险 / 写副作用 / 步数解析 Approve 档位（确定性，非关键词路由）。
 * - strict：写副作用或高风险 → 强制 Plan Mode
 * - auto：低风险且仅只读专家、步数未达阈值 → 跳过预览（快路径）
 * - plan：默认，步数达标才预览
 */
export function resolvePlanApproveTier(state: {
  intent?: string
  meta?: Record<string, unknown>
  plan?: Step[]
  taskPlan?: { steps?: Step[] }
}): PlanApproveTier {
  const steps = getEffectivePlanSteps(state as any)
  const risk = Number(state.meta?.worldModelRisk ?? state.meta?.worldModel?.risk ?? 0)
  const posture = String(state.meta?.worldModelPosture || state.meta?.worldModel?.posture || '')
  const writeSide = planHasWriteSideEffects(steps)
  if (writeSide || risk >= 0.65 || posture === 'clarify_first') return 'strict'
  const readOnlyAgents = new Set(['db', 'rag', 'code', 'clean', 'visualize', 'report', 'crawler', 'multimodal'])
  const allReadOnly = steps.length > 0 && steps.every((s) => readOnlyAgents.has(String(s.agent || '').toLowerCase()))
  const min = planPreviewMinSteps()
  if (allReadOnly && risk < 0.4 && steps.length < min) return 'auto'
  if (allReadOnly && risk < 0.35 && steps.length <= min && posture === 'aggressive') return 'auto'
  return 'plan'
}

export function shouldRequirePlanPreview(state: {
  intent?: string
  meta?: Record<string, unknown>
  plan?: Step[]
  taskPlan?: { steps?: Step[] }
}): boolean {
  if (!isPlanPreviewEnabled(String(state.meta?.sessionId || ''))) return false
  if (Boolean(state.meta?.planConfirmed)) return false
  if (Boolean(state.meta?.planPreviewCancelled)) return false

  const posture = resolveCollaborationPosture(state.meta)
  /** Plan 姿态：有计划步即强制预览（覆盖低风险免审）；可覆盖非 multi 的多步计划 */
  if (postureRequiresPlanPreview(posture, state.meta)) {
    const steps = getEffectivePlanSteps(state as any)
    return steps.length >= 1
  }

  /** B1：编排 LLM 升档信号与现有门禁求或 */
  if (llmUpgradeRequiresPlanPreview(state)) return true

  if (String(state.intent || '') !== 'multi') return false

  const previewMode = String(process.env.MANAGER_PLAN_PREVIEW ?? 'auto').trim().toLowerCase()
  if (previewMode === '1' || previewMode === 'true' || previewMode === 'on') return true

  const steps = getEffectivePlanSteps(state as any)
  const writeSide = planHasWriteSideEffects(steps)
  const sec =
    state.meta?.security && typeof state.meta.security === 'object'
      ? (state.meta.security as { riskLevel?: string }).riskLevel
      : undefined
  const riskDecision = resolveRiskExecutionPolicy({
    actionKind: writeSide
      ? 'admin_write'
      : steps.length > 1
        ? 'multi_aggregate'
        : 'readonly',
    meta: state.meta,
    securityRiskLevel: (sec as 'low' | 'medium' | 'high' | undefined) || undefined,
    worldModelRisk: Number(state.meta?.worldModelRisk ?? 0),
    planHasWriteSideEffects: writeSide,
    intent: state.intent
  })
  if (planGateRequiresPreview(riskDecision) && riskDecision.planGate === 'force_confirm' && steps.length >= 1) {
    return true
  }

  const tier = resolvePlanApproveTier(state)
  if (tier === 'strict') return steps.length >= 1
  if (tier === 'auto') return false
  const min = planPreviewMinSteps()
  return steps.length >= min
}

export function buildPlanPreviewPayload(
  steps: Step[],
  runId?: string,
  previewId?: string,
  state?: { meta?: Record<string, unknown>; allowedAgents?: string[]; intent?: string }
) {
  const items: PlanPreviewStepItem[] = (Array.isArray(steps) ? steps : []).map((s, i) => {
    const agent = String(s.agent || '')
    const query = String(s.query || '').slice(0, 320)
    let confirmMode: PlanPreviewStepItem['confirmMode'] = 'none'
    let confirmReason: string | undefined
    const ag = agent.toLowerCase()
    if (ag === 'admin' || ag === 'gui') {
      const d = resolveAdminAutoConfirmDecision(state || null, query)
      confirmMode = d.autoConfirm ? 'auto_confirm' : 'hitl'
      confirmReason = d.reason
      // GUI 写操作默认倾向人审（无 allowRiskyWrites 时）
      if (ag === 'gui' && !(state?.meta as { allowRiskyWrites?: boolean } | undefined)?.allowRiskyWrites) {
        confirmMode = 'hitl'
        confirmReason = confirmReason || 'gui_default_hitl'
      }
    }
    return {
      id: String(s.id || `step_${i + 1}`),
      agent,
      agentLabel: planAgentLabel(agent),
      query,
      order: i,
      enabled: true,
      optional: Boolean((s as { optional?: boolean }).optional),
      confirmMode,
      confirmReason
    }
  })
  const routePlan = state ? buildRoutePlanCardFromState(state) : null
  const priorConstraints = String(state?.meta?.planConstraints || '').trim()
  const tier = resolvePlanApproveTier({
    intent: state?.intent,
    meta: state?.meta,
    plan: steps
  })
  const risk = Number(state?.meta?.worldModelRisk ?? 0)
  const writeSide = planHasWriteSideEffects(steps)
  const riskDecision = resolveRiskExecutionPolicy({
    actionKind: writeSide ? 'admin_write' : steps.length > 1 ? 'multi_aggregate' : 'readonly',
    meta: state?.meta,
    worldModelRisk: risk,
    planHasWriteSideEffects: writeSide,
    intent: state?.intent
  })
  return {
    previewId: previewId || '',
    runId: runId || '',
    steps: items,
    total: items.length,
    constraints: priorConstraints.slice(0, 500),
    approveTier: tier,
    riskScore: Number.isFinite(risk) ? Math.round(risk * 100) / 100 : 0,
    riskPolicy: riskDecision,
    hint:
      tier === 'strict' || riskDecision.planGate === 'force_confirm'
        ? `高风险 / 含写操作：${gateCopy('plan')}。请仔细核对每一步。`
        : `Plan Mode：可勾选步骤、编辑任务描述、补充约束；${gateCopy('plan')}（至少保留 1 步）。`,
    routePlan: routePlan as RoutePlanCardPayload | null
  }
}

/** 将确认卡回传的 steps 与原计划合并（保留 dependsOn / clauseIds 等） */
export function mergeConfirmedPlanSteps(
  original: Step[],
  confirmed: Array<Partial<Step> & { id?: string; agent?: string; query?: string; enabled?: boolean }>
): Step[] {
  const byId = new Map(original.map((s) => [String(s.id || ''), s]))
  const out: Step[] = []
  for (const raw of confirmed) {
    if (raw?.enabled === false) continue
    const id = String(raw?.id || '').trim()
    const base = id ? byId.get(id) : undefined
    const agent = String(raw?.agent || base?.agent || '').trim() as Step['agent']
    const query = String(raw?.query ?? base?.query ?? '').trim()
    if (!agent || !query) continue
    out.push({
      ...(base || {}),
      id: id || `${agent}_${out.length + 1}`,
      agent,
      query: query.slice(0, 2000),
      dependsOn: Array.isArray(raw?.dependsOn)
        ? (raw.dependsOn as string[])
        : base?.dependsOn,
      parallelGroup: raw?.parallelGroup || base?.parallelGroup,
      optional: base?.optional,
      clauseIds: base?.clauseIds,
      inputs: base?.inputs,
      mcpTool: base?.mcpTool
    })
  }
  return out
}
