/**
 * 动手交叉路由契约（docs/动手Agent.md §6.5 X1–X5）：纯函数 / fixture，不发信不点网页。
 */
import {
  applyWebExecutionModeToRoute,
  formatWebExecutionModeSystemPrompt
} from '../../../server/utils/search/managerWebExecutionModeLlm'
import { agentsForWebExecutionHeuristic } from '../../../server/utils/gui/managerGuiAgentAvailability'
import { sortAgentsByPipelineOrder } from '../../../server/graph/core/routing/clauses'
import { capFloorFromPuStackMeta } from '../../../server/graph/orchestrate/puStackOrchestratorAuthority'
import { buildBlueprintFromPuStackDispatch } from '../../../server/graph/llm/planBlueprintLlm'
import { formatGuiCrawlerDisambiguationPrompt } from '../../../server/graph/orchestrate/unifiedRouting'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-hands-cross-route] ${msg}`)
}

console.log('smoke-hands-cross-route: start')

process.env.LOBSTER_AGENT_WS_URL ??= 'ws://localhost:13108/_ws'

// X1：查库 + 写信 → db + admin（可含 code/visualize 加工链）
{
  const meta = {
    taskShape: 'multi_source_parallel',
    requiresAgentPipelineHint: true,
    wantsAdminHint: true,
    stepDispatchDraft: [
      { agent: 'db', scopedUserLanguage: '查库人数', clauseIds: ['c1'] },
      { agent: 'admin', scopedUserLanguage: '写信告诉张三', clauseIds: ['c2'] }
    ]
  }
  const cap = sortAgentsByPipelineOrder(capFloorFromPuStackMeta(meta, null))
  assert(cap.includes('db'), 'X1 db')
  assert(cap.includes('admin'), 'X1 admin')
  const bp = buildBlueprintFromPuStackDispatch({
    allowedAgents: cap.map(String),
    stepDispatchDraft: meta.stepDispatchDraft,
    userTask: '查库人数，再写信告诉张三'
  })
  assert(bp?.steps.some((s) => s.agent === 'db'), 'X1 blueprint db')
  assert(bp?.steps.some((s) => s.agent === 'admin'), 'X1 blueprint admin')
}

// X2：表单填写 → gui
{
  const allowed = agentsForWebExecutionHeuristic(['crawler'], {
    agents: [{ agent: 'gui', status: 'healthy' }]
  })
  const routed = applyWebExecutionModeToRoute({
    intent: 'crawler',
    allowedAgents: allowed,
    llmNeedsWebSearch: true,
    mode: {
      mode: 'gui',
      primaryAgent: 'gui',
      needsWebSearch: false,
      serpSummaryEnough: false,
      confidence: 0.93,
      rationale: 'form fill w3school'
    }
  })
  assert(routed.intent === 'gui', 'X2 gui intent')
  assert(routed.allowedAgents.includes('gui'), 'X2 gui allowed')
  assert(!routed.allowedAgents.includes('crawler'), 'X2 no crawler')
}

// X3：代码怎么改更安全 / 先别改 → code inspect 形态（cap 含 code，非 gui）
{
  const meta = {
    stepDispatchDraft: [{ agent: 'code', scopedUserLanguage: '只读说明如何安全改代码', clauseIds: ['c1'] }]
  }
  const cap = sortAgentsByPipelineOrder(capFloorFromPuStackMeta(meta, null))
  assert(cap.includes('code'), 'X3 code')
  assert(!cap.includes('gui'), 'X3 no gui')
}

// X4 / X5：资讯问答 → search_chat，禁 gui
{
  const prompt = formatWebExecutionModeSystemPrompt()
  assert(/search_chat/.test(prompt), 'web mode prompt has search_chat')
  assert(/gui/.test(prompt), 'web mode prompt mentions gui')
  const disambig = formatGuiCrawlerDisambiguationPrompt()
  assert(disambig.length > 20, 'gui/crawler disambig present')

  for (const id of ['X4', 'X5'] as const) {
    const routed = applyWebExecutionModeToRoute({
      intent: 'multi',
      allowedAgents: ['gui', 'crawler'],
      llmNeedsWebSearch: true,
      mode: {
        mode: 'search_chat',
        primaryAgent: null,
        needsWebSearch: true,
        serpSummaryEnough: true,
        confidence: 0.9,
        rationale: id === 'X4' ? 'python learning advice' : 'bilibili course recommend'
      }
    })
    assert(!routed.allowedAgents.includes('gui'), `${id} bans gui`)
    assert(routed.allowedAgents.includes('crawler') || routed.llmNeedsWebSearch, `${id} keeps search path`)
    assert(String(routed.webExecutionMode?.mode || '') === 'search_chat', `${id} mode search_chat`)
  }
}

console.log('smoke-hands-cross-route: ok')
