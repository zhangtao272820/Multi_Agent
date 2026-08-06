/**
 * 红线 smoke：missingSlots / 低 confidence 不得强制 needsClarify；routeConfidenceRaw 旁路可观测。
 * 无 LLM。
 */
import { parseOrchestratorPayloadForTest } from '../../../server/graph/llm/taskOrchestrator'
import { applyOrchestratorInvariants } from '../../../server/graph/orchestrate/orchestratorInvariants'
import { resolveTurnRoutingScope } from '../../../server/graph/core/routing/turnScope'
import { HumanMessage } from '@langchain/core/messages'
import {
  buildSessionIntentAnchor,
  formatSessionAnchorBlock
} from '../../../server/graph/core/memory/multiTurnIntent'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const proceedBase = {
  turnScopeMode: 'current_only' as const,
  clauses: [{ id: 'c1', text: '统计老人总人数', agents: ['db'] as const, confidence: 0.9 }],
  timeHints: [],
  subjectHints: [],
  fieldHints: [],
  missingSlots: [{ name: 'optional_time', reason: '用户未给时间段（可选）' }],
  filledSlots: [{ name: 'metric', value: '人数', evidence: 'user' as const }],
  dataSources: ['db'] as const,
  primaryIntent: 'db' as const,
  isMulti: false,
  suggestedAgents: ['db'] as const,
  isDbAnchored: true,
  needsAdmin: false,
  needsWeb: false,
  explicitWantsReport: false,
  explicitWantsVisualize: false,
  planShortcut: 'db_only' as const,
  requiresAgentPipeline: false,
  allowChatWebDirect: true,
  intent: 'db' as const,
  allowedAgents: ['db'] as const,
  routedQuery: '老人一共有多少人',
  needsWebSearch: false,
  needsClarify: false,
  clarifyKind: 'none' as const,
  confidence: 0.2,
  rationale: '可执行单源；缺槽仅观测'
}

const bundle = parseOrchestratorPayloadForTest(proceedBase, proceedBase.routedQuery)
assert(bundle, 'parse proceed fixture with missingSlots')
assert(bundle!.needsClarify === false, 'missingSlots must NOT force needsClarify')
assert(bundle!.raw.missingSlots?.length === 1, 'missingSlots preserved')
assert(bundle!.raw.filledSlots?.length === 1, 'filledSlots preserved')
assert(typeof bundle!.raw.confidenceRaw === 'number' && bundle!.raw.confidenceRaw <= 0.25, 'confidenceRaw kept low')
assert(Number(bundle!.raw.confidence) >= 0.35, 'route confidence still floored for board')

const scope = resolveTurnRoutingScope({
  messages: [new HumanMessage(proceedBase.routedQuery)],
  turnScopeLlm: { mode: 'current_only', directChitchatSynth: false, confidence: 0.9, rationale: 'ok' }
})
const decision = applyOrchestratorInvariants({ bundle: bundle!, turnScope: scope })
assert(decision.needsClarify === false, 'invariants must not force clarify from missingSlots')
assert(Number(decision.metaPatch.routeConfidence) >= 0.35, 'routeConfidence floored')
assert(Number(decision.metaPatch.routeConfidenceRaw) <= 0.25, 'routeConfidenceRaw is raw')
assert(Number(decision.metaPatch.missingSlotCount) === 1, 'missingSlotCount telemetry')
assert(Number(decision.metaPatch.filledSlotCount) === 1, 'filledSlotCount telemetry')

const explicitClarify = parseOrchestratorPayloadForTest(
  {
    ...proceedBase,
    missingSlots: [],
    needsClarify: true,
    clarifyKind: 'slot' as const,
    clarifyQuestions: ['请补充要查的指标'],
    confidence: 0.8,
    routedQuery: '查一下对象'
  },
  '查一下对象'
)
assert(explicitClarify?.needsClarify === true, 'explicit LLM needsClarify still honored')

const anchor = buildSessionIntentAnchor(
  decision.intentClassify,
  decision.coalescedTask,
  ['db'],
  decision.raw.filledSlots
)
assert(anchor.filledSlots?.length === 1, 'anchor stores filledSlots')
const block = formatSessionAnchorBlock(anchor)
assert(block.includes('不得因缺槽二次澄清'), 'anchor block warns against second clarify')
assert(block.includes('filledSlots='), 'anchor block shows slots')

console.log('smoke: slot-grounding-no-force-clarify ok')
