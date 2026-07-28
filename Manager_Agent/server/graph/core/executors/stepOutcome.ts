import type { Step } from '../../../utils/shared/taskPlan'
import type { AgentResult } from '../../../utils/agents/types'
import { buildSpecialistHandoffFromStep, attachRawSnippetForEvidence } from '../../../utils/agents/specialistHandoff'
import type { StepRunRecord } from '../agent/agentRunner'
import type { AgentStepOutcome } from './types'

export function applyAgentStepOutcome(input: {
  outcome: AgentStepOutcome
  stepId: string
  agent: Step['agent']
  byId: Record<string, StepRunRecord>
  out: Record<string, string>
  evidences: Array<Record<string, unknown>>
  clarifyQuestions: string[]
}) {
  const { outcome, stepId, agent, byId, out, evidences, clarifyQuestions } = input
  const ar = (outcome.meta as { agentResult?: AgentResult } | undefined)?.agentResult
  const handoff = buildSpecialistHandoffFromStep({
    agent: String(agent),
    stepId,
    ok: outcome.ok,
    output: outcome.output,
    error: outcome.ok ? undefined : outcome.error,
    agentResult: ar,
    evidence: outcome.evidence || null
  })

  if (outcome.ok) {
    out[agent] = outcome.output
    byId[stepId] = {
      id: stepId,
      agent,
      query: outcome.query,
      output: outcome.output,
      status: 'ok',
      parsed: outcome.parsed,
      meta: outcome.meta,
      handoff
    }
    if (outcome.evidence) {
      evidences.push({
        ...outcome.evidence,
        stepId,
        agent,
        handoff,
        ...(handoff.rawRef
          ? { rawSnippet: attachRawSnippetForEvidence(String(outcome.output || '')) }
          : {})
      })
    } else {
      evidences.push({
        kind: 'handoff',
        stepId,
        agent,
        handoff,
        rawSnippet: attachRawSnippetForEvidence(String(outcome.output || ''))
      })
    }
    if (ar && typeof ar === 'object') {
      evidences.push({ kind: 'agent_result', agent, stepId, agentResult: ar, handoff })
    }
    if (outcome.clarifyQuestions?.length) clarifyQuestions.push(...outcome.clarifyQuestions)
  } else {
    byId[stepId] = {
      id: stepId,
      agent,
      query: outcome.query,
      output: outcome.output,
      status: 'error',
      error: outcome.error,
      handoff,
      meta: outcome.meta
    }
    // 失败结果也写入 out，供 synth / 流式门控识别（勿把 preamble 当成功）
    if (String(agent) === 'admin' && String(outcome.output || '').trim()) {
      out[agent] = String(outcome.output)
    }
    evidences.push({
      kind: 'error',
      stepId,
      agent,
      query: outcome.query,
      error: outcome.error,
      handoff,
      ...(ar?.needs_clarify ? { needs_clarify: true } : {})
    })
    if (outcome.clarifyQuestions?.length) {
      clarifyQuestions.push(...outcome.clarifyQuestions)
    } else if (ar?.needs_clarify && Array.isArray(ar.clarify_questions) && ar.clarify_questions.length) {
      clarifyQuestions.push(...ar.clarify_questions.map((q) => String(q || '').trim()).filter(Boolean))
    } else if (ar?.needs_clarify && String(outcome.output || '').trim()) {
      clarifyQuestions.push(String(outcome.output).trim().slice(0, 240))
    }
  }
}
