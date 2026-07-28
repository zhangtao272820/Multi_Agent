/**
 * A2 专才摘要交接回归：不拉 LLM / 外部 Agent。
 */
import {
  attachRawSnippetForEvidence,
  buildSpecialistHandoffFromStep,
  formatHandoffForParentContext,
  formatHandoffsFromEvidence,
  parentContextLooksIsolated
} from '../../../server/utils/agents/specialistHandoff'
import { applyAgentStepOutcome } from '../../../server/graph/core/executors/stepOutcome'
import type { StepRunRecord } from '../../../server/graph/core/agent/agentRunner'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const longRaw = `SELECT * FROM huge_table WHERE id IN (${Array.from({ length: 200 }, (_, i) => i).join(',')}) — ` + 'x'.repeat(2000)

const handoff = buildSpecialistHandoffFromStep({
  agent: 'db',
  stepId: 's1',
  ok: true,
  output: longRaw,
  agentResult: {
    ok: true,
    agent: 'db',
    answer: longRaw,
    sources: [{ type: 'sql', ref: 'person_basic' }, { type: 'table', ref: 't_person' }]
  },
  evidence: { kind: 'db', query: '查人数' }
})

assert(handoff.summary.length <= 600, 'summary respects handoff budget')
assert(!handoff.summary.includes('x'.repeat(500)), 'summary does not embed long raw')
assert(handoff.evidenceRefs.some((r) => r.includes('sql:') || r.includes('table:')), 'has evidence refs')
assert(handoff.confidence > 0.5, 'ok step has decent confidence')
assert(handoff.rawRef === 'step:s1', 'rawRef points to step')
assert(!handoff.failure, 'success has no failure')

const failed = buildSpecialistHandoffFromStep({
  agent: 'crawler',
  stepId: 's2',
  ok: false,
  error: 'timeout',
  output: ''
})
assert(failed.failure?.code, 'failed has failure code')
assert(failed.confidence < 0.5, 'failed confidence low')

const parentBlock = formatHandoffForParentContext('db', handoff)
assert(parentBlock.includes('[HANDOFF:db]'), 'parent block tagged')
assert(parentBlock.includes('证据指针'), 'parent has refs')
assert(!/置信度/.test(parentBlock), 'parent handoff omits confidence by default')
assert(!parentBlock.includes('x'.repeat(400)), 'parent block excludes long raw padding')
assert(parentContextLooksIsolated(parentBlock), 'parent context isolated')
const parentWithConf = formatHandoffForParentContext('db', handoff, { includeConfidence: true })
assert(/置信度/.test(parentWithConf), 'opt-in confidence still available')

const byId: Record<string, StepRunRecord> = {}
const out: Record<string, string> = {}
const evidences: Array<Record<string, unknown>> = []
const clarifyQuestions: string[] = []
applyAgentStepOutcome({
  outcome: {
    ok: true,
    agent: 'rag',
    output: '制度原文：' + '条款'.repeat(400),
    query: '查考勤制度',
    meta: {
      agentResult: {
        ok: true,
        agent: 'rag',
        answer: '制度原文：' + '条款'.repeat(400),
        sources: [{ type: 'doc', ref: 'kb/attendance' }]
      }
    },
    evidence: { kind: 'rag', query: '查考勤制度' }
  },
  stepId: 'rag1',
  agent: 'rag',
  byId,
  out,
  evidences,
  clarifyQuestions
})

assert(byId.rag1?.handoff?.summary, 'step record has handoff')
assert(
  String(byId.rag1.handoff!.summary).length <= 601,
  'stored handoff summary respects budget'
)
assert(
  evidences.some((e) => e.handoff && (e.handoff as { summary?: string }).summary),
  'evidence carries handoff'
)
const synthHandoffs = formatHandoffsFromEvidence(evidences)
assert(synthHandoffs.includes('[HANDOFF:rag]'), 'synth gets handoff block')
assert(synthHandoffs.length < 2000, 'synth handoff block stays compact')
const ragFull = '制度原文：' + '条款'.repeat(400)
assert(ragFull.length > 800, 'fixture raw is long')
assert(
  String(byId.rag1.handoff!.summary).length < ragFull.length,
  'handoff summary shorter than raw answer'
)
assert(!synthHandoffs.includes(ragFull), 'synth handoff omits full raw body')

const rawStore = attachRawSnippetForEvidence(longRaw)
assert(rawStore.length > 100 && rawStore.length <= 12001, 'raw snippet capped for optional expand')

/** B4：db / rag / code 总管侧 handoff 合同同构 */
for (const agent of ['db', 'rag', 'code'] as const) {
  const h = buildSpecialistHandoffFromStep({
    agent,
    stepId: `${agent}_b4`,
    ok: true,
    output: `${agent} 结论摘要`,
    agentResult: {
      ok: true,
      agent,
      answer: `${agent} 全文` + 'y'.repeat(900),
      handoff: { summary: `${agent} 短交接`, evidenceRefs: [`${agent}:ref`], confidence: 0.82 }
    }
  })
  assert(h.summary.includes('短交接') || h.summary.includes(agent), `${agent} handoff summary`)
  assert(h.summary.length <= 601, `${agent} handoff budget`)
  assert(h.evidenceRefs.length >= 1, `${agent} has refs`)
  assert(!h.summary.includes('y'.repeat(200)), `${agent} omits long raw`)
}

console.log('smoke-specialist-handoff: ok')
