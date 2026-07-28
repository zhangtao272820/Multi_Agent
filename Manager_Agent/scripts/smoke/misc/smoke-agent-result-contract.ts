/**
 * G1：AgentResult 出站契约执法 smoke（无 LLM / 无 Docker / 不跨专家包）。
 */
import {
  enforceAgentResultContract,
  validateAgentResultShape,
  isContractEnforcedAgent
} from '../../../agent-repo-shared/agentResultContract'
import { coalesceAgentResult } from '../../../server/utils/agents/agentResult'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

{
  const bad = enforceAgentResultContract({ ok: false, agent: 'db' })
  assert(bad.error_code === 'business', 'missing error_code → business')
  assert(
    (bad.structured as { contract_violation?: string })?.contract_violation === 'missing_error_code',
    'tags contract_violation'
  )
}

{
  const ok = enforceAgentResultContract({
    ok: false,
    agent: 'rag',
    error_code: 'timeout',
    latency_ms: 42
  })
  assert(ok.error_code === 'timeout' && ok.latency_ms === 42, 'keeps explicit failure code')
}

{
  const merged = coalesceAgentResult(
    { ok: false, agent: 'rag', answer: 'x' },
    { ok: false, agent: 'rag', answer: 'fallback' }
  )
  assert(merged.error_code === 'business', 'manager coalesce enforces failure code')
}

{
  const v = validateAgentResultShape({ ok: true, agent: 'db' })
  assert(v.length === 0, 'valid ok shape')
  const v2 = validateAgentResultShape({ ok: false, agent: 'db' })
  assert(v2.some((x) => x.field === 'error_code'), 'validator catches missing code')
}

{
  assert(isContractEnforcedAgent('db'), 'db enforced')
  assert(isContractEnforcedAgent('rag'), 'rag enforced')
  assert(!isContractEnforcedAgent(''), 'empty not enforced')
}

console.log('smoke-agent-result-contract: ok')
