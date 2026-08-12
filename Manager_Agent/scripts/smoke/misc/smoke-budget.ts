/**
 * E3/F3：run 预算闸离线断言（不拉 LLM）+ usage 提取。
 */
import { checkRunBudget, readRunBudgetLimits, resolveTokenAccounting } from '../../../server/graph/core/runtime/runBudget'
import { createAgentRunTelemetry, precheckAgentStep } from '../../../server/graph/core/agent/agentRunner'
import { extractStepUsage } from '../../../server/graph/core/runtime/expertFailure'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

{
  const prevUsd = process.env.MANAGER_RUN_MAX_USD
  const prevTok = process.env.MANAGER_RUN_MAX_TOKENS
  process.env.MANAGER_RUN_MAX_USD = '0.01'
  process.env.MANAGER_RUN_MAX_TOKENS = '100'
  const limits = readRunBudgetLimits()
  assert(limits.maxUsd === 0.01, 'maxUsd parsed')
  assert(limits.maxTokens === 100, 'maxTokens parsed')
  const over = checkRunBudget({ usd: 0.02, tokens: 10 })
  assert(!over.ok && over.error_code === 'budget_exceeded', 'usd over budget')
  const overTok = checkRunBudget({ usd: 0, tokens: 200 })
  assert(!overTok.ok && overTok.error_code === 'budget_exceeded', 'token over budget')
  const ok = checkRunBudget({ usd: 0.005, tokens: 50 })
  assert(ok.ok, 'under budget ok')
  if (prevUsd === undefined) delete process.env.MANAGER_RUN_MAX_USD
  else process.env.MANAGER_RUN_MAX_USD = prevUsd
  if (prevTok === undefined) delete process.env.MANAGER_RUN_MAX_TOKENS
  else process.env.MANAGER_RUN_MAX_TOKENS = prevTok
}

{
  assert(resolveTokenAccounting([{ tokens: 10 }]) === 'estimated', 'tokens only = estimated')
  assert(resolveTokenAccounting([{ tokens: 10, usd: 0.01 }]) === 'actual', 'usd = actual')
  assert(
    resolveTokenAccounting([{ tokens: 10 }, { tokens: 5, usd: 0.01 }]) === 'mixed',
    'mixed accounting'
  )
}

{
  const fromUsage = extractStepUsage({
    agentResult: { usage: { tokens: 120, usd: 0.002, actual: true } }
  })
  assert(fromUsage.tokens === 120 && fromUsage.usd === 0.002 && fromUsage.actual === true, 'usage from agentResult')
  const estimated = extractStepUsage({}, 'x'.repeat(100))
  assert(estimated.tokens === 50 && estimated.actual === false, 'chars/2 estimated')
  const empty = extractStepUsage({}, 'short')
  assert(!empty.tokens, 'short text no estimate')
}

{
  const { normalizeLlmUsage, resolveAgentUsage } = await import('#agent-shared/agentUsage')
  const n = normalizeLlmUsage({ prompt_tokens: 10, completion_tokens: 20 })
  assert(n?.tokens === 30 && n.actual === true, 'normalize prompt+completion')
  const total = normalizeLlmUsage({ total_tokens: 99 })
  assert(total?.tokens === 99, 'normalize total_tokens')
  const est = resolveAgentUsage({ answerText: 'y'.repeat(80) })
  assert(est?.tokens === 40 && est.actual === false, 'resolve estimate')
  const prefer = resolveAgentUsage({
    llmUsage: { total_tokens: 12 },
    answerText: 'y'.repeat(80)
  })
  assert(prefer?.tokens === 12 && prefer.actual === true, 'prefer actual over estimate')
}

{
  process.env.MANAGER_RUN_MAX_TOKENS = '50'
  const telemetry = createAgentRunTelemetry({
    globalTimeoutMs: 60_000,
    timeLeftMs: () => 60_000
  })
  telemetry.addSpend({ tokens: 80 })
  const pre = precheckAgentStep({
    stepAgent: 'rag',
    stepId: 's1',
    agent: 'rag',
    effQuery: 'test',
    schedulerSkipAgents: [],
    schedulerDegradeOptionalAgents: [],
    telemetry
  })
  assert(pre.action === 'skip' && pre.policy === 'budget_exceeded', 'precheck skips on budget')
  delete process.env.MANAGER_RUN_MAX_TOKENS
}

{
  const { estimateTokensHeuristic, estimateTokensSync, clipToTokenBudget } = await import(
    '../../../agent-repo-shared/tokenEstimate'
  )
  const cjk = estimateTokensHeuristic('护理员配比标准是多少')
  assert(cjk >= 8 && cjk <= 20, `cjk heuristic tokens=${cjk}`)
  const ascii = estimateTokensHeuristic('abcdefghijklmnop') // 16 chars → ~4
  assert(ascii >= 3 && ascii <= 6, `ascii heuristic tokens=${ascii}`)
  const sync = estimateTokensSync('探视制度说明文档摘要')
  assert(sync.tokens >= 1 && (sync.accounting === 'estimated' || sync.accounting === 'tiktoken'), 'sync estimate')

  const long = '护理员配比'.repeat(80)
  const clipped = clipToTokenBudget(long, 20)
  assert(clipped.tokens <= 22, `clip under budget got ${clipped.tokens}`)
  assert(clipped.text.length < long.length, 'clip shortens text')

  const { clipRulesBlock, promptBudgetSnapshot, useTokenPromptBudget } = await import(
    '../../../server/graph/core/shared/promptBudget'
  )
  assert(useTokenPromptBudget(), 'token mode default on')
  const snap = promptBudgetSnapshot()
  assert(snap.rulesTokens > 0 && snap.tokenMode === true, 'snapshot token fields')
  const rules = clipRulesBlock('规则内容'.repeat(400))
  assert(rules.length < '规则内容'.repeat(400).length, 'rules clipped')
}

{
  const {
    buildCompactedHistoryWithStats,
    estimateConversationTokens,
    loadConversationBudgetConfig
  } = await import('../../../server/graph/core/runtime/conversationBudget')
  const turns = Array.from({ length: 16 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `轮次${i}：` + '护理员配比标准说明文档摘要内容'.repeat(12)
  }))
  const tok = estimateConversationTokens(turns)
  assert(tok.tokens > 50, `conversation tokens=${tok.tokens}`)
  const cfg = { ...loadConversationBudgetConfig(), recentTurns: 4, maxTurns: 20, summarizeEnabled: true }
  const stats = await buildCompactedHistoryWithStats({
    messages: turns,
    sanitize: (s) => s,
    cfg
  })
  assert(stats.fullTokens > stats.compactTokens, 'budget stats use tokenEstimate')
  assert(stats.tokenAccounting === 'estimated' || stats.tokenAccounting === 'tiktoken', 'accounting')
}

console.log('smoke-budget: ok')
