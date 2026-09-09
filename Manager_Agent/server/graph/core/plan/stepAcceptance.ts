/**
 * 步级 Acceptance Gate（Phase D）：成功步也验收；纯结构信号，不调 LLM。
 * 失败 → 交 Optimizer / localReplan（仍受 MANAGER_LOCAL_REPLAN_MAX）。
 */
import type { AgentResult } from '../../../utils/agents/types'
import { deriveStepObservationSignals } from './stepObservation'
import type { TaskBoardItem, TaskBoardStatus } from './taskBoard'

export type StepAcceptanceVerdict = {
  accepted: boolean
  reason: string
  /** 映射到任务板状态 */
  boardStatus: Extract<TaskBoardStatus, 'success' | 'failed' | 'replan'>
}

function structuredGaps(ar?: AgentResult | null): string[] {
  if (!ar?.structured || typeof ar.structured !== 'object') return []
  const g = (ar.structured as { gaps?: unknown }).gaps
  if (!Array.isArray(g)) return []
  return g.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
}

function selfCheckFailed(ar?: AgentResult | null): boolean {
  if (!ar?.structured || typeof ar.structured !== 'object') return false
  const sc = (ar.structured as { self_check?: unknown }).self_check
  if (sc === false) return true
  if (sc && typeof sc === 'object' && (sc as { ok?: boolean }).ok === false) return true
  return false
}

/**
 * 验收一步：status ok 仍可能因 empty / clarify / gaps / self_check 拒收。
 */
export function acceptStepResult(input: {
  agent?: string
  status?: string
  output?: string
  error?: string
  agentResult?: AgentResult | null
  optional?: boolean
}): StepAcceptanceVerdict {
  if (input.optional) {
    const st = String(input.status || '').toLowerCase()
    if (st === 'ok' || st === 'success' || st === 'skipped') {
      return { accepted: true, reason: 'optional', boardStatus: 'success' }
    }
  }

  const obs = deriveStepObservationSignals({
    agent: input.agent,
    status: input.status,
    output: input.output,
    error: input.error,
    agentResult: input.agentResult
  })

  if (obs.observationKind === 'error' || obs.observationKind === 'timeout') {
    return { accepted: false, reason: obs.observationKind, boardStatus: 'failed' }
  }
  if (obs.protocolMalformed || obs.observationKind === 'protocol_malformed') {
    return { accepted: false, reason: 'protocol_malformed', boardStatus: 'replan' }
  }
  if (obs.emptyEvidence || obs.observationKind === 'empty_evidence') {
    return { accepted: false, reason: 'empty_evidence', boardStatus: 'replan' }
  }

  const ar = input.agentResult || null
  if (ar?.needs_clarify === true) {
    return { accepted: false, reason: 'needs_clarify', boardStatus: 'replan' }
  }
  if (selfCheckFailed(ar)) {
    return { accepted: false, reason: 'self_check_failed', boardStatus: 'replan' }
  }
  const gaps = structuredGaps(ar)
  if (gaps.length) {
    return { accepted: false, reason: `gaps:${gaps[0]}`, boardStatus: 'replan' }
  }

  const st = String(input.status || '').toLowerCase()
  if (st === 'error' || st === 'failed') {
    return { accepted: false, reason: 'status_failed', boardStatus: 'failed' }
  }
  if (ar && ar.ok === false) {
    return { accepted: false, reason: String(ar.error_code || 'ok_false'), boardStatus: 'failed' }
  }

  return { accepted: true, reason: 'ok', boardStatus: 'success' }
}

/** 主链是否可收束：须 acceptance 通过（success/skipped）；failed 主链步仍算「完成但失败」供上层收束 */
export function taskBoardMainPathAccepted(board: TaskBoardItem[]): boolean {
  const main = board.filter((b) => !b.async && !b.optional)
  if (!main.length) {
    return board.every(
      (b) => b.status === 'success' || b.status === 'skipped' || b.optional || b.status === 'failed'
    )
  }
  return main.every(
    (b) => b.status === 'success' || b.status === 'skipped' || b.status === 'failed'
  )
}

/** 主链是否存在未验收（pending/running/replan） */
export function taskBoardHasOpenMainSteps(board: TaskBoardItem[]): boolean {
  return board
    .filter((b) => !b.async && !b.optional)
    .some((b) => b.status === 'pending' || b.status === 'running' || b.status === 'replan')
}
