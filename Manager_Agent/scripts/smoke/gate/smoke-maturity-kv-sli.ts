/**
 * Phase F：KV 卫生 + maturity SLI（不调 LLM）。
 */
import {
  isKvHostileLeadingClock,
  stabilizePromptPrefix,
  stableJsonStringify
} from '../../../server/graph/core/runtime/contextKvHygiene'
import { buildMaturitySliSnapshot } from '../../../server/graph/core/runtime/maturitySli'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-maturity-kv-sli] ${msg}`)
}

console.log('smoke-maturity-kv-sli: start')

{
  const raw = '当前时间：2026-09-09 11:00:01\n你是总管助手。'
  assert(isKvHostileLeadingClock(raw) === true, 'detect clock')
  const fixed = stabilizePromptPrefix(raw)
  assert(fixed.startsWith('你是总管助手'), 'prefix stable')
  assert(fixed.includes('时钟注记'), 'clock moved')
}

{
  const a = stableJsonStringify({ b: 1, a: 2 })
  const b = stableJsonStringify({ a: 2, b: 1 })
  assert(a === b, 'stable key order')
}

{
  const sli = buildMaturitySliSnapshot({
    stepStatuses: [{ status: 'success' }, { status: 'replan' }, { status: 'failed' }],
    briefAttachedCount: 1,
    specialistRoundsUsed: [1, 2, 2],
    localReplanCount: 1,
    raceEnabled: false
  })
  assert(sli.stepsTotal === 3, 'total')
  assert(sli.stepsAccepted === 1, 'accepted')
  assert(sli.stepsReplan === 1, 'replan')
  assert(sli.raceEnabled === false, 'race off')
  assert(sli.specialistRoundsP95 >= 2, 'p95')
}

console.log('smoke-maturity-kv-sli: ok')
