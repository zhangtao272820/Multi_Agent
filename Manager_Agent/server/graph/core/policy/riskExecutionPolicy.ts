/**
 * A3：风险 → 执行策略表（免审 / dry-run / 必须人批）
 * 风险档由动作类型 + security.riskLevel 决定，禁止扫用户原话关键词。
 */
import type { CollaborationPosture } from '../../../utils/platform/collaborationPosture'
import {
  postureForcesReadOnly,
  resolveCollaborationPosture
} from '../../../utils/platform/collaborationPosture'
import { riskTierToBlastRadius } from '#agent-shared/blastRadius'

export type RiskActionKind =
  | 'readonly'
  | 'multi_aggregate'
  | 'admin_write'
  | 'gui_write'
  | 'db_write'
  | 'code_edit'

export type RiskTier = 'low' | 'medium' | 'high'

export type PlanGatePolicy = 'skip' | 'preview' | 'force_confirm'
export type ActionGatePolicy = 'none' | 'dry_run_then_confirm' | 'require_confirm'

export type RiskPolicyDecision = {
  tier: RiskTier
  /** E1：与 tier 对齐的爆炸半径（契约字段） */
  blast_radius: 't0' | 't1' | 't2'
  actionKind: RiskActionKind
  posture: CollaborationPosture
  planGate: PlanGatePolicy
  actionGate: ActionGatePolicy
  allowAutoConfirm: boolean
  preferDryRun: boolean
  reason: string
  decidedAt: string
}

export type RiskPolicyInput = {
  actionKind: RiskActionKind
  meta?: unknown
  securityRiskLevel?: 'low' | 'medium' | 'high'
  worldModelRisk?: number
  /** 计划是否含写副作用专才 */
  planHasWriteSideEffects?: boolean
  intent?: string
}

function securityTier(input: RiskPolicyInput): RiskTier {
  const sec = String(input.securityRiskLevel || '').toLowerCase()
  if (sec === 'high') return 'high'
  if (sec === 'medium') return 'medium'
  const wm = Number(input.worldModelRisk)
  if (Number.isFinite(wm) && wm >= 0.65) return 'high'
  if (Number.isFinite(wm) && wm >= 0.4) return 'medium'
  return 'low'
}

function actionBaseTier(kind: RiskActionKind): RiskTier {
  if (kind === 'admin_write' || kind === 'gui_write' || kind === 'db_write') return 'high'
  /** 代码落盘可先 dry-run（diff 预览）再人批，默认中档 */
  if (kind === 'code_edit') return 'medium'
  if (kind === 'multi_aggregate') return 'medium'
  return 'low'
}

function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  const rank = { low: 0, medium: 1, high: 2 }
  return rank[a] >= rank[b] ? a : b
}

function withBlast(decision: Omit<RiskPolicyDecision, 'blast_radius'>): RiskPolicyDecision {
  return { ...decision, blast_radius: riskTierToBlastRadius(decision.tier) }
}

/**
 * 统一策略表：输出可写入 meta.riskPolicyDecision 供审计。
 * Ask/Debug 姿态强制只读时，写动作仍标高档且禁 auto（调用方应先被姿态门禁拦住）。
 */
export function resolveRiskExecutionPolicy(input: RiskPolicyInput): RiskPolicyDecision {
  const posture = resolveCollaborationPosture(input.meta)
  const kind = input.actionKind
  let tier = maxTier(actionBaseTier(kind), securityTier(input))
  if (input.planHasWriteSideEffects && kind === 'multi_aggregate') {
    tier = maxTier(tier, 'high')
  }

  if (postureForcesReadOnly(posture) && kind !== 'readonly') {
    return withBlast({
      tier: 'high',
      actionKind: kind,
      posture,
      planGate: 'force_confirm',
      actionGate: 'require_confirm',
      allowAutoConfirm: false,
      preferDryRun: false,
      reason: `姿态 ${posture} 为只读合同，写/副作用路径禁止无保护 Auto`,
      decidedAt: new Date().toISOString()
    })
  }

  if (posture === 'plan') {
    return withBlast({
      tier: maxTier(tier, 'medium'),
      actionKind: kind,
      posture,
      planGate: 'force_confirm',
      actionGate:
        tier === 'high'
          ? 'require_confirm'
          : tier === 'medium' &&
              (kind === 'admin_write' || kind === 'gui_write' || kind === 'code_edit' || kind === 'db_write')
            ? 'dry_run_then_confirm'
            : kind === 'readonly'
              ? 'none'
              : 'require_confirm',
      allowAutoConfirm: false,
      preferDryRun: tier === 'medium' && (kind === 'admin_write' || kind === 'gui_write'),
      reason: 'Plan 姿态：批准前强制计划确认',
      decidedAt: new Date().toISOString()
    })
  }

  if (tier === 'low') {
    return withBlast({
      tier,
      actionKind: kind,
      posture,
      planGate: 'skip',
      actionGate: 'none',
      allowAutoConfirm: true,
      preferDryRun: false,
      reason: '低风险只读/快路径：计划免审',
      decidedAt: new Date().toISOString()
    })
  }

  if (tier === 'medium') {
    const writeish =
      kind === 'admin_write' || kind === 'gui_write' || kind === 'code_edit' || kind === 'db_write'
    return withBlast({
      tier,
      actionKind: kind,
      posture,
      planGate: 'preview',
      actionGate: writeish ? 'dry_run_then_confirm' : 'none',
      allowAutoConfirm: false,
      preferDryRun: writeish,
      reason: writeish ? '中风险写路径：先 dry-run 再人批' : '中风险多源汇总：计划预览',
      decidedAt: new Date().toISOString()
    })
  }

  return withBlast({
    tier: 'high',
    actionKind: kind,
    posture,
    planGate: 'force_confirm',
    actionGate: 'require_confirm',
    allowAutoConfirm: false,
    preferDryRun: false,
    reason: '高风险写/不可逆：强制 Plan 确认 + 必须人批，禁止 Auto',
    decidedAt: new Date().toISOString()
  })
}

export function inferActionKindFromAgent(
  agent: string,
  opts?: { readOnly?: boolean; isEdit?: boolean; writeAllowed?: boolean }
): RiskActionKind {
  const a = String(agent || '').toLowerCase()
  if (a === 'admin') return opts?.readOnly ? 'readonly' : 'admin_write'
  if (a === 'gui') return opts?.readOnly ? 'readonly' : 'gui_write'
  if (a === 'db') return opts?.writeAllowed && !opts?.readOnly ? 'db_write' : 'readonly'
  if (a === 'code' && opts?.isEdit) return 'code_edit'
  if (['rag', 'crawler', 'clean', 'visualize', 'report', 'multimodal', 'music', 'video'].includes(a)) {
    return 'readonly'
  }
  return 'readonly'
}

export function planGateRequiresPreview(decision: RiskPolicyDecision): boolean {
  return decision.planGate === 'preview' || decision.planGate === 'force_confirm'
}

export function gateCopy(kind: 'plan' | 'action' | 'dry_run'): string {
  if (kind === 'plan') return '确认后开始执行'
  if (kind === 'dry_run') return '试跑，未写入'
  return '确认后产生外部副作用'
}
