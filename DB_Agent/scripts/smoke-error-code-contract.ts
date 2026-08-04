/**
 * J1：DB error_code / clarify / empty 契约离线 smoke（无 MySQL）。
 * 验收：空结果与澄清不得粉饰 ok；resolveDbErrorCode 可测。
 */
import { buildDbAgentResult, resolveDbErrorCode } from '../server/utils/agent_result'
import { inferCausalFailureTag } from '../utils/route/failureTags'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

// resolveDbErrorCode
assert(resolveDbErrorCode({ needs_clarification: true }) === 'needs_clarify', 'clarify code')
assert(resolveDbErrorCode({ empty: true }) === 'empty_result', 'empty code')
assert(
  resolveDbErrorCode({ fail_reason: 'no_schema_ground' }) === 'schema_miss',
  'schema_miss from reason',
)
assert(resolveDbErrorCode({ fail_reason: 'timeout_upstream' }) === 'timeout', 'timeout')
assert(resolveDbErrorCode({ fail_reason: 'weird_fail' }) === 'business', 'business fallback')
assert(resolveDbErrorCode({ empty: false, fail_reason: 'ok' }) === undefined, 'ok has no code')

// buildDbAgentResult：空结果不得 ok
{
  const empty = buildDbAgentResult({
    answer: '没有查到相关记录',
    empty: true,
    reason: 'empty_result',
  })
  assert(empty.ok === false, 'empty must not ok')
  assert(empty.error_code === 'empty_result', 'empty error_code')
}

{
  const clarify = buildDbAgentResult({
    answer: '请问要查哪个地区？',
    empty: false,
    reason: 'needs_clarification',
    needs_clarification: true,
    clarification_question: '请问要查哪个地区？',
  })
  assert(clarify.ok === false, 'clarify must not ok')
  assert(clarify.error_code === 'needs_clarify', 'clarify error_code')
  assert(clarify.needs_clarify === true, 'needs_clarify flag')
  assert(clarify.clarify_questions?.[0]?.includes('地区'), 'clarify question kept')
}

{
  const schema = buildDbAgentResult({
    answer: '当前库缺少对应表结构',
    empty: true,
    reason: 'no_schema_ground',
    error_code: 'schema_miss',
  })
  assert(schema.ok === false && schema.error_code === 'schema_miss', 'explicit schema_miss')
}

{
  const ok = buildDbAgentResult({
    answer: '本月共 12 人',
    empty: false,
    reason: 'ok',
  })
  assert(ok.ok === true, 'success ok')
  assert(!ok.error_code, 'success no error_code')
}

// failureTags：空结果因果标签
assert(
  inferCausalFailureTag({ path: 'sql_direct', empty: true }) === 'empty_result',
  'causal empty_result',
)
assert(
  inferCausalFailureTag({ path: 'sql_direct', empty: false, reason: 'ok' }) === null,
  'non-empty no causal tag',
)

console.log('smoke-error-code-contract: OK')
