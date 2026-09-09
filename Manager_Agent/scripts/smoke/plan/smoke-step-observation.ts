/**
 * 步 Observation 结构信号契约（不调 LLM）。
 */
import { deriveStepObservationSignals } from '../../../server/graph/core/plan/stepObservation'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-step-observation] ${msg}`)
}

console.log('smoke-step-observation: start')

{
  const s = deriveStepObservationSignals({
    agent: 'db',
    status: 'ok',
    output: 'placeholder',
    agentResult: {
      ok: true,
      agent: 'db',
      answer: '无数据',
      structured: { row_count: 0, rows: [] }
    }
  })
  assert(s.emptyEvidence === true, 'row_count 0 → emptyEvidence')
  assert(s.observationKind === 'empty_evidence', 'kind empty_evidence')
}

{
  const s = deriveStepObservationSignals({
    agent: 'rag',
    status: 'ok',
    output: 'x',
    agentResult: {
      ok: true,
      agent: 'rag',
      answer: '',
      structured: { hit_count: 0, no_hits: true }
    }
  })
  assert(s.emptyEvidence === true, 'hit_count 0 → empty')
  assert(s.observationKind === 'empty_evidence', 'rag empty kind')
}

{
  const s = deriveStepObservationSignals({
    agent: 'db',
    status: 'error',
    error: 'timeout',
    output: '',
    agentResult: { ok: false, agent: 'db', error_code: 'timeout' }
  })
  assert(s.observationKind === 'error', 'status error → error kind')
}

{
  const s = deriveStepObservationSignals({
    agent: 'admin',
    status: 'ok',
    output: '{}',
    agentResult: {
      ok: false,
      agent: 'admin',
      error_code: 'protocol_malformed',
      structured: { protocol_malformed: true }
    }
  })
  assert(s.protocolMalformed === true, 'protocol malformed flag')
  assert(s.observationKind === 'protocol_malformed', 'protocol kind')
}

{
  const s = deriveStepObservationSignals({
    agent: 'db',
    status: 'ok',
    output: '查到 3 行',
    agentResult: {
      ok: true,
      agent: 'db',
      answer: '查到 3 行',
      structured: { row_count: 3, rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }
    }
  })
  assert(s.emptyEvidence === false, 'rows present not empty')
  assert(s.observationKind === null, 'success → no failure kind')
}

console.log('smoke-step-observation: ok')
