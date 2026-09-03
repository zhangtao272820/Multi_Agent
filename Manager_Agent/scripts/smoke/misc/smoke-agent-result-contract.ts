/**
 * G1：AgentResult 出站契约执法 smoke（无 LLM / 无 Docker / 不跨专家包）。
 */
import {
  enforceAgentResultContract,
  validateAgentResultShape,
  isContractEnforcedAgent
} from '../../../agent-repo-shared/agentResultContract'
import { coalesceAgentResult, dbSourcesFromResult, wrapDbResult } from '../../../server/utils/agents/agentResult'
import {
  buildSpecialistHandoffFromStep,
  formatHandoffsFromEvidence
} from '../../../server/utils/agents/specialistHandoff'

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

{
  const sources = dbSourcesFromResult({
    answer: 'ok',
    empty: false,
    run_id: 'run-1',
    transport: 'ws'
  })
  assert(sources?.some((s) => s.type === 'sql' && s.ref === 'run-1'), 'keeps sql source')
  assert(!sources?.some((s) => String(s.ref).includes('transport:')), 'must not fake transport as table')
  const wrapped = wrapDbResult({ answer: 'ok', empty: false, transport: 'ws', run_id: 'run-1' }, 't1')
  assert(wrapped.structured?.transport === 'ws', 'transport stays in structured')
  assert(!(wrapped.sources || []).some((s) => s.type === 'table' && String(s.ref).startsWith('transport:')), 'no transport table source')
  const soft = wrapDbResult({ answer: '0 rows', empty: true, transport: 'http', reason: 'no_data' }, 't2')
  assert(soft.ok === true, 'soft empty wrap ok=true')
  assert(soft.error_code === 'empty_result' && soft.structured?.empty === true, 'soft empty keeps code')
}

{
  const telemetry =
    '根据查询找到30条相关记录。整体-压力平均值：13.22；整体-压力最大值：44.2；整体-重心坐标：248.89, 153.11；' +
    '左脚压力分布明细与右脚区域峰值列表……'.repeat(8)
  const handoff = buildSpecialistHandoffFromStep({
    agent: 'db',
    stepId: 's1',
    ok: false,
    output: telemetry,
    error: 'empty_result',
    agentResult: {
      ok: false,
      agent: 'db',
      answer: telemetry,
      error_code: 'empty_result'
    }
  })
  assert(handoff.failure?.code === 'empty_result', 'failure code from error_code')
  assert(!handoff.summary.includes('压力平均值'), 'failed handoff must not dump telemetry as summary')
  assert(!handoff.summary.includes('重心坐标'), 'failed handoff must not dump telemetry coords')
  assert(handoff.summary.length < 200, 'failed summary stays short')

  const block = formatHandoffsFromEvidence([
    { kind: 'error', agent: 'db', stepId: 's1', handoff }
  ])
  assert(block.includes('失败：'), 'error evidence formats failure line')
  assert(!block.includes('压力平均值'), 'error handoff block must not include telemetry body')
  assert(!block.includes('结论：'), 'error handoff uses failureOnly — no 结论 line with body')
}

{
  const okHandoff = buildSpecialistHandoffFromStep({
    agent: 'db',
    stepId: 's1',
    ok: true,
    output: '河西区70到79岁：男性5人，女性2人',
    agentResult: { ok: true, agent: 'db', answer: '河西区70到79岁：男性5人，女性2人' }
  })
  assert(okHandoff.summary.includes('男性5'), 'success handoff keeps short answer summary')
  assert(!okHandoff.failure, 'success has no failure')
}

{
  const q = '失能老人护理员配比标准是多少'
  const facts =
    '【RAG 检索事实】\n\n[事实1] 失能老人的护理员配比标准是1:3。也就是说，每三名失能老人配备一名护理人员。\n[来源] 养老机构服务规范.docx'
  const ragHandoff = buildSpecialistHandoffFromStep({
    agent: 'rag',
    stepId: 'step_rag',
    ok: true,
    output: facts,
    evidence: { kind: 'rag', query: q, citations: [{ source: '养老机构服务规范.docx', excerpt: '配比标准是1:3' }] },
    agentResult: {
      ok: true,
      agent: 'rag',
      // 旧契约污染：answer=问句
      answer: q,
      sources: [{ type: 'doc', ref: '养老机构服务规范.docx' }]
    }
  })
  assert(ragHandoff.summary.includes('1:3'), 'rag handoff must keep ratio from step output, not query')
  assert(!ragHandoff.summary.includes(q) || ragHandoff.summary.includes('1:3'), 'must not be query-only')
  assert(
    ragHandoff.evidenceRefs.some((r) => r.includes('1:3') || r.includes('养老机构')),
    'evidence refs keep citation'
  )
}

{
  // B1 chat 管线：专才 answer 含配比，handoff / userFacing 不得丢
  const chatAnswer =
    '全失能老人的护理员配比标准是 1:3，也就是说每位护理员最多照顾 3 位全失能老人。'
  const chatHandoff = buildSpecialistHandoffFromStep({
    agent: 'rag',
    stepId: 'step_rag',
    ok: true,
    output: chatAnswer,
    evidence: { kind: 'rag', query: '失能老人护理员配比标准是多少' },
    agentResult: {
      ok: true,
      agent: 'rag',
      answer: chatAnswer,
      sources: [{ type: 'doc', ref: '养老机构服务规范.docx' }]
    }
  })
  assert(chatHandoff.summary.includes('1:3'), 'chat-path handoff keeps 1:3 from /api/chat answer')
}

console.log('smoke-agent-result-contract: ok')
