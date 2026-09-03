/**
 * E1：爆炸半径（blast radius）— 过度代理的结构分级，不是 prompt 劝诫。
 *
 * t0 只读 / t1 可逆或 dry-run / t2 不可逆副作用（须 HITL confirm_token，除非显式代确认）
 */
export type BlastRadius = 't0' | 't1' | 't2'

export type BlastRadiusRiskTier = 'low' | 'medium' | 'high'

export type BlastRadiusActionKind =
  | 'readonly'
  | 'multi_aggregate'
  | 'admin_write'
  | 'gui_write'
  | 'db_write'
  | 'code_edit'
  | 'code_compute'

const RANK: Record<BlastRadius, number> = { t0: 0, t1: 1, t2: 2 }

export function isBlastRadius(v: unknown): v is BlastRadius {
  return v === 't0' || v === 't1' || v === 't2'
}

export function maxBlastRadius(a: BlastRadius, b: BlastRadius): BlastRadius {
  return RANK[a] >= RANK[b] ? a : b
}

/** 风险档 → 爆炸半径（与 riskExecutionPolicy 对齐） */
export function riskTierToBlastRadius(tier: BlastRadiusRiskTier | string): BlastRadius {
  const t = String(tier || '').toLowerCase()
  if (t === 'high') return 't2'
  if (t === 'medium') return 't1'
  return 't0'
}

export function actionKindToBlastRadius(kind: BlastRadiusActionKind | string): BlastRadius {
  const k = String(kind || '').toLowerCase()
  if (k === 'admin_write' || k === 'gui_write' || k === 'db_write') return 't2'
  if (k === 'code_edit') return 't1'
  if (k === 'multi_aggregate') return 't1'
  return 't0'
}

export function resolveBlastRadius(input: {
  agent?: string
  actionKind?: BlastRadiusActionKind | string
  riskTier?: BlastRadiusRiskTier | string
  readOnly?: boolean
  writeAllowed?: boolean
  /** code edit 仅预览 diff 时为 t1；真正落盘仍须 confirm */
  dryRun?: boolean
}): BlastRadius {
  if (input.readOnly) return 't0'
  const agent = String(input.agent || '').toLowerCase()
  let fromAgent: BlastRadius = 't0'
  if (agent === 'admin' || agent === 'gui') fromAgent = 't2'
  else if (agent === 'db') fromAgent = input.writeAllowed ? 't2' : 't0'
  else if (agent === 'code') fromAgent = input.writeAllowed ? 't1' : 't0'
  else if (['rag', 'crawler', 'clean', 'visualize', 'report', 'multimodal', 'music', 'video'].includes(agent)) {
    fromAgent = 't0'
  }

  const fromKind = input.actionKind ? actionKindToBlastRadius(input.actionKind) : 't0'
  const fromTier = input.riskTier ? riskTierToBlastRadius(input.riskTier) : 't0'
  let out = maxBlastRadius(fromAgent, maxBlastRadius(fromKind, fromTier))
  if (input.dryRun && out === 't2') out = 't1'
  return out
}

export function blastRadiusRequiresConfirm(radius: BlastRadius): boolean {
  return radius === 't2'
}

export type BlastRadiusGateResult =
  | { ok: true }
  | { ok: false; error_code: 'blast_radius_confirm_required'; reason: string; blast_radius: BlastRadius }

/**
 * T2 无 confirm_token 且未获可信代确认 → 禁止执行。
 * allow_t2_auto：仅 Manager 审计过的 auto_confirm_risky 路径可开。
 */
export function gateBlastRadiusExecution(input: {
  blast_radius: BlastRadius | string | null | undefined
  confirm_token?: string | null
  auto_confirm?: boolean
  allow_t2_auto?: boolean
}): BlastRadiusGateResult {
  const radius = isBlastRadius(input.blast_radius) ? input.blast_radius : 't0'
  if (!blastRadiusRequiresConfirm(radius)) return { ok: true }
  const token = String(input.confirm_token || '').trim()
  if (token) return { ok: true }
  if (input.auto_confirm && input.allow_t2_auto) return { ok: true }
  return {
    ok: false,
    error_code: 'blast_radius_confirm_required',
    blast_radius: radius,
    reason: 'T2 不可逆操作需要 HITL confirm_token（或审计代确认）；禁止静默执行'
  }
}

export function blastRadiusLabelZh(radius: BlastRadius): string {
  if (radius === 't2') return 'T2 不可逆'
  if (radius === 't1') return 'T1 可逆/试跑'
  return 'T0 只读'
}
