/**
 * Phase III：上下文 turnKind / clarifyKind + anchor 瘦身 smoke（纯函数，无 LLM）。
 */
import { HumanMessage } from '@langchain/core/messages'
import {
  buildSessionIntentAnchor,
  formatSessionAnchorBlock,
  sessionIntentAnchorFromMeta
} from '../../../server/graph/core/memory/multiTurnIntent'
import { mockIntentClassifyForTest } from '../../../server/graph/llm/intentClassifyLlm'
import {
  formatTurnScopeRouterHint,
  resolveTurnRoutingScope
} from '../../../server/graph/core/routing/turnScope'
import type { TurnScopeLlmResult } from '../../../server/graph/llm/turnScopeLlm'
import { parseOrchestratorPayloadForTest } from '../../../server/graph/llm/taskOrchestrator'
import { buildTurnScopePayload } from '../../../server/utils/route/managerTurnScopePayload'
import { shouldSuppressPlanLinterClarify } from '../../../server/graph/core/plan/clarifySuppress'
import { buildOutputFollowupNarrowHistory } from '../../../server/graph/core/output/outputFollowupHistory'
import { shouldClearClarifyForSingleSourceRag } from '../../../server/graph/orchestrate/orchestratorInvariants'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const outputFollowupLlm: TurnScopeLlmResult = {
  mode: 'current_only',
  turnKind: 'output_followup',
  clarifyKind: 'output_disambiguation',
  directChitchatSynth: false,
  confidence: 0.88,
  rationale: '用户对上轮知识库比对结果消歧'
}

const followupQ = '请问知识库中相关服务比对，同上面是环境指标还是指标汇总对比'
const scope = resolveTurnRoutingScope({
  messages: [
    new HumanMessage('知识库查失能老人服务比对并汇总'),
    new HumanMessage(followupQ)
  ],
  lastUser: followupQ,
  turnScopeLlm: outputFollowupLlm,
  sessionAnchor: buildSessionIntentAnchor(
    { ...mockIntentClassifyForTest(), primaryIntent: 'rag', dataSources: ['rag'], suggestedAgents: ['rag', 'db', 'admin'] },
    '知识库服务比对',
    ['rag']
  )
})
assert(scope.turnKind === 'output_followup', 'output_followup turnKind')
assert(scope.mode === 'current_only', 'output_followup maps current_only')
const followupHint = formatTurnScopeRouterHint(scope)
assert(followupHint.includes('主题锚定'), 'output_followup hint requires topic anchor')
assert(followupHint.includes('session_anchor'), 'output_followup hint references session_anchor')
assert(scope.clarifyKind === 'output_disambiguation', 'output disambiguation clarifyKind')
assert(formatTurnScopeRouterHint(scope).includes('输出追问'), 'hint mentions output followup')

const anchor = buildSessionIntentAnchor(mockIntentClassifyForTest(), '查库任务', ['db'])
assert(anchor.primaryPlane === 'db', 'primaryPlane from classify')
assert(anchor.lastExecutedAgents?.includes('db'), 'lastExecutedAgents stored')
const block = formatSessionAnchorBlock(anchor)
assert(!block.includes('suggestedAgents'), 'anchor block omits cap list')
assert(block.includes('lastExecutedAgents=db'), 'anchor block shows executed agents')

const legacyMeta = {
  sessionIntentAnchor: {
    primaryIntent: 'multi',
    planShortcut: 'none',
    suggestedAgents: ['rag', 'db', 'admin'],
    isDbAnchored: true,
    isMulti: true,
    updatedAt: new Date().toISOString()
  }
}
const legacy = sessionIntentAnchorFromMeta(legacyMeta)
assert(legacy?.primaryIntent === 'multi', 'legacy anchor still parses')

const orch = parseOrchestratorPayloadForTest(
  {
    turnScopeMode: 'current_only',
    clarifyKind: 'output_disambiguation',
    needsClarify: true,
    dataSources: ['rag'],
    suggestedAgents: ['rag'],
    allowedAgents: ['rag'],
    clauses: [{ id: 'c1', text: '说明上轮服务比对指环境指标还是指标汇总', agents: ['rag'] }],
    routedQuery: followupQ,
    confidence: 0.85
  },
  followupQ
)
assert(orch?.needsClarify === false, 'output_disambiguation forces needsClarify false')
assert(orch?.clarifyKind === 'output_disambiguation', 'clarifyKind preserved')
assert(orch?.allowedAgents.includes('rag'), 'rag-only cap')

const slotLlm: TurnScopeLlmResult = {
  mode: 'current_only',
  turnKind: 'new_task',
  clarifyKind: 'slot',
  directChitchatSynth: false,
  confidence: 0.8,
  rationale: '缺区域对象'
}
const slotScope = resolveTurnRoutingScope({
  messages: [new HumanMessage('查老人')],
  lastUser: '查老人',
  turnScopeLlm: slotLlm
})
assert(slotScope.clarifyKind === 'slot', 'slot clarifyKind from llm')

const tsPayload = buildTurnScopePayload('current_only', 'output_followup')
assert(tsPayload.narrow_output_followup === true, 'turn_scope payload narrow flag')
assert(tsPayload.suppress_history === false, 'output_followup allows narrow history')

const msgs = [
  { role: 'user', content: '知识库查服务比对' },
  { role: 'assistant', content: '上轮比对结果：环境指标与汇总指标两套口径…' },
  { role: 'user', content: followupQ }
]
const ragHist = buildOutputFollowupNarrowHistory(msgs, followupQ)
assert(ragHist.length === 1 && ragHist[0]?.role === 'assistant', 'rag narrow history one assistant')
assert(ragHist[0]?.content.includes('环境指标'), 'rag history is prior assistant')

assert(
  shouldSuppressPlanLinterClarify({ turnKind: 'output_followup', clarifyKind: 'output_disambiguation', needsClarify: false }),
  'plan linter clarify suppressed for output_followup'
)

assert(
  shouldClearClarifyForSingleSourceRag({
    planShortcut: 'rag_only',
    taskIntent: 'document_retrieval',
    allowedAgents: ['rag'],
    intent: 'rag'
  }),
  'single-source rag clears clarify'
)
assert(
  !shouldClearClarifyForSingleSourceRag({
    planShortcut: 'none',
    allowedAgents: ['rag', 'db'],
    intent: 'multi'
  }),
  'multi-plane does not clear clarify'
)

console.log('smoke-context-clarify: OK')
