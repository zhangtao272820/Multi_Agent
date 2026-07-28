/**
 * N5：admin auto_confirm_risky 决策与审计（可离线测）。
 * 主路径仍走写闸 + risk policy；本模块只解释 reason 并落盘。
 */
import {
  isAdminReadOnlyOrchestrationStep,
  isAdminWriteGateEnabled,
  isAutonomousRunMeta,
  isRiskyAdminQuery,
  resolveAdminAutoConfirm
} from '../db/writeGate'
import type { ManagerMetricEntryInput } from '../runtime/observabilitySchema'

export type AutoConfirmAuditReason =
  | 'gate_off'
  | 'allowRiskyWrites'
  | 'read_only_step'
  | 'non_risky_query'
  | 'policy_denied'
  | 'blocked_writes'
  | 'autonomous_block'
  | 'default_deny'

export type AdminAutoConfirmDecision = {
  autoConfirm: boolean
  reason: AutoConfirmAuditReason
}

export function resolveAdminAutoConfirmDecision(
  state: { meta?: unknown } | null | undefined,
  stepQuery?: string
): AdminAutoConfirmDecision {
  if (!isAdminWriteGateEnabled()) {
    return { autoConfirm: true, reason: 'gate_off' }
  }
  const meta = state?.meta as Record<string, unknown> | undefined
  if (meta?.allowRiskyWrites === true) {
    return { autoConfirm: true, reason: 'allowRiskyWrites' }
  }
  if (isAutonomousRunMeta(meta)) {
    return { autoConfirm: false, reason: 'autonomous_block' }
  }
  if (meta?.blockAdminWrites === true) {
    return { autoConfirm: false, reason: 'blocked_writes' }
  }
  const q = String(stepQuery || '').trim()
  const autoConfirm = resolveAdminAutoConfirm(state, stepQuery)
  if (!autoConfirm) {
    return { autoConfirm: false, reason: 'policy_denied' }
  }
  if (q && isAdminReadOnlyOrchestrationStep(q)) {
    return { autoConfirm: true, reason: 'read_only_step' }
  }
  if (q && !isRiskyAdminQuery(q)) {
    return { autoConfirm: true, reason: 'non_risky_query' }
  }
  return { autoConfirm: true, reason: 'non_risky_query' }
}

export type AutoConfirmAuditEntry = {
  runId: string
  trace_id?: string
  step?: string
  reason: AutoConfirmAuditReason
  autoConfirm: true
}

/** 校验审计必填字段（smoke 用） */
export function assertAutoConfirmAuditEntry(entry: Partial<AutoConfirmAuditEntry>): AutoConfirmAuditEntry {
  const runId = String(entry.runId || '').trim()
  if (!runId) throw new Error('auto_confirm audit: runId required')
  if (entry.autoConfirm !== true) throw new Error('auto_confirm audit: only when autoConfirm=true')
  const reason = entry.reason
  if (!reason) throw new Error('auto_confirm audit: reason required')
  return {
    runId,
    trace_id: String(entry.trace_id || runId).trim() || runId,
    step: String(entry.step || '').trim() || undefined,
    reason,
    autoConfirm: true
  }
}

/** 转为 metrics jsonl 条目 */
export function buildAutoConfirmAuditMetric(entry: AutoConfirmAuditEntry): ManagerMetricEntryInput {
  const ok = assertAutoConfirmAuditEntry(entry)
  return {
    runId: ok.runId,
    trace_id: ok.trace_id,
    phase: 'auto_confirm_audit',
    ms: 0,
    ok: true,
    agent: 'admin',
    extra: {
      auto_confirm_risky: true,
      reason: ok.reason,
      ...(ok.step ? { step: ok.step } : {})
    }
  }
}
