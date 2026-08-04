/**
 * 图级重试 / 局部修订：统一「步是否可复用」判定（SSOT）。
 * 与 StepRunStatus / UI StepStatusValue / Observation OK·FAIL·SKIP 对齐，不删旧字段。
 */
import type { Step } from '../../../utils/shared/taskPlan'
import type { StepRunRecord, StepRunStatus } from '../agent/agentRunner'
import { hasSuccessfulAdminWriteInRun } from '../output/criticEvidence'

const FAIL_STATUSES = new Set(['error', 'failed'])
const SKIP_STATUSES = new Set(['skipped', 'needs_replan'])
const OK_STATUSES = new Set(['ok', 'success', 'done', 'completed'])

export type StepReuseKind = 'reusable_ok' | 'failed' | 'skipped' | 'unknown'

export type StepReuseRecord = {
  id?: string
  agent?: string
  status?: string
  error?: string
  output?: string
  summary?: string
  query?: string
}

function normStatus(s: unknown): string {
  return String(s || '')
    .trim()
    .toLowerCase()
}

export function classifyStepReuseStatus(status: unknown): StepReuseKind {
  const st = normStatus(status)
  if (OK_STATUSES.has(st)) return 'reusable_ok'
  if (FAIL_STATUSES.has(st)) return 'failed'
  if (SKIP_STATUSES.has(st)) return 'skipped'
  return 'unknown'
}

/** 调度层：已完成（ok/skipped）的步不应再进 pending */
export function isStepTerminalForReuse(status: unknown): boolean {
  const kind = classifyStepReuseStatus(status)
  return kind === 'reusable_ok' || kind === 'skipped'
}

export function collectFailedStepIds(
  records: StepReuseRecord[] | null | undefined,
  forceIncludeAgents?: string[]
): string[] {
  const out: string[] = []
  const forceAgents = new Set((forceIncludeAgents || []).map((a) => String(a || '').trim()).filter(Boolean))
  for (const r of Array.isArray(records) ? records : []) {
    const id = String(r?.id || '').trim()
    if (!id) continue
    const kind = classifyStepReuseStatus(r?.status)
    const agent = String(r?.agent || '').trim()
    if (kind === 'failed' || forceAgents.has(agent)) out.push(id)
  }
  return [...new Set(out)]
}

function toStepRunStatus(kind: StepReuseKind, raw: unknown): StepRunStatus {
  if (kind === 'failed') return 'error'
  if (kind === 'skipped') return 'skipped'
  return 'ok'
}

/**
 * 从上一轮 lastStepRecords 恢复 byId，供图级 critic→multi 重入跳过已成功步。
 * forceRerunStepIds 中的步不 hydrate（允许定点重跑）。
 */
export function hydrateCompletedById(input: {
  plan: Array<{ id?: string; agent?: string; query?: string }>
  lastStepRecords?: StepReuseRecord[] | null
  results?: Record<string, unknown> | null
  evidence?: Array<Record<string, unknown>> | null
  forceRerunStepIds?: string[] | null
}): {
  byId: Record<string, StepRunRecord>
  reusedIds: string[]
  reasons: Record<string, string>
} {
  const plan = Array.isArray(input.plan) ? input.plan : []
  const records = Array.isArray(input.lastStepRecords) ? input.lastStepRecords : []
  const force = new Set(
    (Array.isArray(input.forceRerunStepIds) ? input.forceRerunStepIds : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
  )
  const byId: Record<string, StepRunRecord> = {}
  const reasons: Record<string, string> = {}
  const reusedIds: string[] = []

  const adminWriteOk = hasSuccessfulAdminWriteInRun({
    results: input.results,
    evidence: input.evidence
  })
  const results = input.results && typeof input.results === 'object' ? input.results : {}

  const recordById = new Map<string, StepReuseRecord>()
  const recordsByAgent = new Map<string, StepReuseRecord[]>()
  for (const r of records) {
    const id = String(r?.id || '').trim()
    const agent = String(r?.agent || '').trim()
    if (id) recordById.set(id, r)
    if (agent) {
      const bag = recordsByAgent.get(agent) || []
      bag.push(r)
      recordsByAgent.set(agent, bag)
    }
  }

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]!
    const stepId = String(step.id || `step_${i + 1}`).trim()
    if (!stepId || force.has(stepId)) continue
    const agent = String(step.agent || '').trim() as Step['agent']
    let rec = recordById.get(stepId)
    if (!rec && agent) {
      const bag = recordsByAgent.get(agent) || []
      // 同 agent 仅一步时按 agent 回填（plan id 漂移兜底）
      if (bag.length === 1) rec = bag[0]
    }
    if (!rec) continue

    const kind = classifyStepReuseStatus(rec.status)
    if (kind === 'failed' || kind === 'unknown') continue

    // 副作用：admin 写已成功 → 强制 reusable（即使记录异常也 skip）
    const sideEffectDone = agent === 'admin' && adminWriteOk
    if (!isStepTerminalForReuse(rec.status) && !sideEffectDone) continue

    const output =
      String(rec.output || rec.summary || '').trim() ||
      String((results as Record<string, unknown>)[agent] || '').trim()
    const status = sideEffectDone ? 'ok' : toStepRunStatus(kind, rec.status)
    byId[stepId] = {
      id: stepId,
      agent: agent || (String(rec.agent || 'rag') as Step['agent']),
      query: String(step.query || rec.query || '').trim(),
      output,
      status,
      error: rec.error ? String(rec.error).slice(0, 300) : undefined
    }
    reusedIds.push(stepId)
    reasons[stepId] = sideEffectDone
      ? 'side_effect_done'
      : kind === 'skipped'
        ? 'already_skipped_in_prior_attempt'
        : 'already_ok_in_prior_attempt'
  }

  // admin 写成功但 plan 里 admin 步无匹配记录：仍按 agent 锁死
  if (adminWriteOk) {
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i]!
      const stepId = String(step.id || `step_${i + 1}`).trim()
      if (!stepId || force.has(stepId) || byId[stepId]) continue
      if (String(step.agent || '') !== 'admin') continue
      const output = String((results as Record<string, unknown>).admin || '').trim()
      byId[stepId] = {
        id: stepId,
        agent: 'admin',
        query: String(step.query || '').trim(),
        output,
        status: 'ok'
      }
      reusedIds.push(stepId)
      reasons[stepId] = 'side_effect_done'
    }
  }

  return { byId, reusedIds, reasons }
}

/** optimizer/critic：有副作用成功时，是否应避免无差别全量 multi */
export function shouldPreferSynthOnlyAfterSideEffect(input: {
  results?: Record<string, unknown> | null
  evidence?: Array<Record<string, unknown>> | null
  lastStepRecords?: StepReuseRecord[] | null
  forceRerunStepIds?: string[] | null
}): { synthOnly: boolean; failedStepIds: string[] } {
  const adminWriteOk = hasSuccessfulAdminWriteInRun({
    results: input.results,
    evidence: input.evidence
  })
  if (!adminWriteOk) return { synthOnly: false, failedStepIds: [] }
  const forced = (Array.isArray(input.forceRerunStepIds) ? input.forceRerunStepIds : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
  const failed = collectFailedStepIds(input.lastStepRecords)
  const failedStepIds = [...new Set([...failed, ...forced])]
  if (failedStepIds.length > 0) return { synthOnly: false, failedStepIds }
  return { synthOnly: true, failedStepIds: [] }
}
