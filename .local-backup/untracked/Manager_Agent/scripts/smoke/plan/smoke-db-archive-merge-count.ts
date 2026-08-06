/**
 * A5 档案双 db 步合并 + 合法计数结论不当无数据（无 LLM）。
 */
import { normalizePlanSteps, mergeConsecutivePersonArchiveDbSteps } from '../../../server/graph/core/plan/build'
import {
  isDbNoData,
  textLooksLikeDbCountConclusion
} from '../../../server/graph/core/runtime/runtimePersistence'
import { applyAgentStepOutcome } from '../../../server/graph/core/executors/stepOutcome'
import type { StepRunRecord } from '../../../server/graph/core/agent/agentRunner'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

assert(textLooksLikeDbCountConclusion('林婉清 的足底压力检测次数：0 次。'), '0 次 is count conclusion')
assert(textLooksLikeDbCountConclusion('林婉清 的足底压力检测次数：3 次。'), '3 次 is count conclusion')
assert(!isDbNoData('林婉清 的足底压力检测次数：0 次。'), '0 次 must not be isDbNoData')

const twoDb = mergeConsecutivePersonArchiveDbSteps([
  { id: 'db1', agent: 'db', query: '查询 person_info 龙奶奶基本信息' },
  { id: 'db2', agent: 'db', query: '查询 person_emergency_contact 联系方式' },
  { id: 'code1', agent: 'code', query: '汇总', dependsOn: ['db2'] }
] as any)
assert(twoDb.filter((s) => s.agent === 'db').length === 1, 'archive twin db merged to one')
assert(twoDb.some((s) => s.agent === 'code'), 'code step kept')
const mergedQ = String(twoDb.find((s) => s.agent === 'db')?.query || '')
assert(/基本信息|person_info/.test(mergedQ) && /联系方式|emergency/.test(mergedQ), 'merged query keeps both focuses')

const normalized = normalizePlanSteps([
  { id: 'db1', agent: 'db', query: '龙奶奶的基本信息' },
  { id: 'db2', agent: 'db', query: '龙奶奶的联系方式' }
] as any)
assert(normalized.length === 1 && normalized[0]?.agent === 'db', 'normalizePlanSteps merges A5 twin db')

const byId: Record<string, StepRunRecord> = {}
const out: Record<string, string> = {}
const evidences: Array<Record<string, unknown>> = []
const clarifyQuestions: string[] = []
applyAgentStepOutcome({
  outcome: {
    ok: false,
    agent: 'db',
    output: '林婉清 的足底压力检测次数：0 次。',
    query: '林婉清做过几次足底压力检测',
    error: 'empty_result',
    evidence: { kind: 'db', empty: true, error_code: 'empty_result' }
  },
  stepId: 's1',
  agent: 'db',
  byId,
  out,
  evidences,
  clarifyQuestions
})
assert(out.db?.includes('0 次'), 'failed db still writes out for synth')
assert(evidences.some((e) => e.kind === 'db'), 'failed db keeps kind=db evidence')
assert(!evidences.some((e) => e.kind === 'error'), 'failed db with body must not only push kind=error')

console.log('smoke-db-archive-merge-count: ok')
