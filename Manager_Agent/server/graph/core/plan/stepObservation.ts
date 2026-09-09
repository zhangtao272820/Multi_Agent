/**
 * 步完成 Observation 结构信号（专才返回体 / handoff，非用户原话）。
 * 供 localReplan 优先用字段判定，正文子串仅作兜底。
 */
import type { AgentResult, SpecialistHandoff } from '../../../utils/agents/types'
import {
  classifyStepObservationFailure,
  type ObservationFailureKind
} from './localReplan'

export type StepObservationSignals = {
  emptyEvidence: boolean
  protocolMalformed: boolean
  observationKind: ObservationFailureKind
}

function structuredEmptyEvidence(ar?: AgentResult | null): boolean | null {
  if (!ar || !ar.structured || typeof ar.structured !== 'object') return null
  const s = ar.structured as Record<string, unknown>
  if (typeof s.empty === 'boolean') return s.empty
  if (typeof s.empty_result === 'boolean') return s.empty_result
  if (typeof s.row_count === 'number') return Number(s.row_count) === 0
  if (typeof s.rows === 'object' && Array.isArray(s.rows) && s.rows.length === 0) return true
  if (typeof s.hit_count === 'number') return Number(s.hit_count) === 0
  if (typeof s.hits === 'number') return Number(s.hits) === 0
  if (Array.isArray(s.citations) && s.citations.length === 0 && ar.ok === true) {
    // 有答案但无引用时不强制 empty；仅当明确无命中标记
    if (s.no_hit === true || s.no_hits === true) return true
  }
  if (s.no_hit === true || s.no_hits === true) return true
  return null
}

function structuredProtocolMalformed(ar?: AgentResult | null): boolean {
  if (!ar) return false
  const code = String(ar.error_code || '').toLowerCase()
  if (code.includes('protocol') || code.includes('malformed') || code === 'bad_response') return true
  const s = ar.structured
  if (s && typeof s === 'object' && (s as { protocol_malformed?: boolean }).protocol_malformed === true) {
    return true
  }
  return false
}

/**
 * 从 AgentResult / handoff 派生 empty / malformed，再交给 classify（结构优先）。
 */
export function deriveStepObservationSignals(input: {
  agent?: string
  status?: string
  output?: string
  error?: string
  agentResult?: AgentResult | null
  handoff?: SpecialistHandoff | null
}): StepObservationSignals {
  const ar = input.agentResult || null
  const handoff = input.handoff || ar?.handoff || null

  let emptyEvidence = false
  let hasStructuredEvidence = false
  const fromStruct = structuredEmptyEvidence(ar)
  if (fromStruct === true) emptyEvidence = true
  else if (fromStruct === false) {
    emptyEvidence = false
    hasStructuredEvidence = true
  } else if (ar?.needs_clarify === true && !String(ar.answer || '').trim()) emptyEvidence = true
  else if (handoff?.failure?.code) {
    const code = String(handoff.failure.code).toLowerCase()
    if (code.includes('empty') || code.includes('no_hit') || code.includes('no_rows')) {
      emptyEvidence = true
    }
  }

  const protocolMalformed =
    structuredProtocolMalformed(ar) ||
    String(handoff?.failure?.code || '')
      .toLowerCase()
      .includes('protocol')

  const observationKind = classifyStepObservationFailure({
    status: input.status,
    output: input.output,
    error: input.error || handoff?.failure?.message,
    agent: input.agent,
    emptyEvidence,
    protocolMalformed,
    hasStructuredEvidence
  })

  return { emptyEvidence, protocolMalformed, observationKind }
}
