/**
 * 路由/Planner 修复回归：图一纯 DB 问句 + 图二 RAG+DB+Web 复合问句（无 LLM）
 * 本文件断言 classic invariants / probe 锚定；显式关闭 LLM-First。
 */
process.env.MANAGER_LLM_FIRST_ROUTE = '0'

import { applyOrchestratorInvariants } from '../../../server/graph/orchestrate/orchestratorInvariants'
import { parseOrchestratorForTest } from '../../../server/graph/llm/taskOrchestrator'
import {
  inferDbAnchorFromProbe,
  mergeDataSourcesWithClauses
} from '../../../server/graph/core/probe/probeRoutingAnchor'
import {
  shouldSkipLegacyPlanShortcuts,
  isUnifiedRoutingActive
} from '../../../server/graph/orchestrate/unifiedRouting'
import {
  shouldUseDbOnlyShortcut,
  buildDbOnlyShortcutPlan
} from '../../../server/graph/core/plan/planShortcuts'
import {
  buildTopologyBlueprintFromCap,
  materializeStepsFromBlueprint
} from '../../../server/graph/llm/planBlueprintLlm'
import { reconcileIntentClassifyDataPlane } from '../../../server/graph/orchestrate/routeOrchestration'
import { mockIntentClassifyForTest } from '../../../server/graph/llm/intentClassifyLlm'
import { resolveTurnRoutingScope } from '../../../server/graph/core/routing/turnScope'
import { HumanMessage } from '@langchain/core/messages'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

// —— 图一：纯 DB 人口统计（无「数据库」关键词，probe 命中业务表）——
const simpleDbUser = '查询河西区70-79岁老人性别分布'
const pollutedClassify = mockIntentClassifyForTest({
  primaryIntent: 'multi',
  isMulti: true,
  suggestedAgents: ['rag', 'db', 'crawler', 'clean', 'code', 'visualize'],
  isDbAnchored: false,
  needsWeb: false,
  explicitWantsVisualize: false,
  planShortcut: 'none',
  dataSources: ['rag'],
  requiresAgentPipeline: true
})

const anchored = inferDbAnchorFromProbe({
  classify: pollutedClassify,
  probe: { db: { matched: true, tables: ['person_info'] }, rag: { hits: 5 } },
  clauses: [{ id: 'c1', text: simpleDbUser, agents: [] }]
})
assert(anchored.isDbAnchored === true, 'probe anchors db for demographic query')
assert(anchored.planShortcut === 'db_only', 'single db gets db_only shortcut')
assert(anchored.dataSources?.join(',') === 'db', 'dataSources coalesced to db')

const unifiedMeta = {
  unifiedOrchestrator: true,
  intentClassify: anchored,
  intentClassifyMode: 'orchestrator'
}
assert(isUnifiedRoutingActive({ meta: unifiedMeta }), 'unified routing active')
assert(!shouldSkipLegacyPlanShortcuts({ meta: unifiedMeta }), 'db_only allows plan shortcuts under unified orchestrator')

assert(
  shouldUseDbOnlyShortcut({
    intent: 'multi',
    question: simpleDbUser,
    userMessage: simpleDbUser,
    allowedAgents: ['rag', 'db', 'crawler', 'clean', 'code', 'visualize'],
    routerLlmAllowed: ['db'],
    probe: { db: { matched: true, tables: ['person_info'] } },
    intentClassify: anchored
  }),
  'db-only shortcut despite polluted cap'
)
const dbPlan = buildDbOnlyShortcutPlan({ intent: 'db', question: simpleDbUser, userMessage: simpleDbUser })
assert(dbPlan.length === 1 && dbPlan[0]?.agent === 'db', 'simple db plan is single step')

// —— 图二：RAG + DB + Web 复合，不得丢 RAG ——
const compoundUser =
  '知识库查养老机构服务规范要点，数据库查老人总数和性别分布，再从公开网站查2025年养老行业平均床位费参考，汇总对比并出图。'

const compoundRaw = {
  turnScopeMode: 'current_only' as const,
  directChitchatSynth: false,
  coalescedTask: compoundUser,
  clauses: [
    { id: 'c1', text: '知识库查养老机构服务规范要点', agents: ['rag'] as const },
    { id: 'c2', text: '数据库查老人总数和性别分布', agents: ['db'] as const },
    { id: 'c3', text: '从公开网站查2025年养老行业平均床位费参考', agents: ['crawler'] as const },
    { id: 'c4', text: '汇总对比并出图', agents: ['code', 'visualize'] as const }
  ],
  timeHints: [],
  subjectHints: [],
  fieldHints: [],
  wantsVisualize: true,
  wantsReport: false,
  dataSources: ['db', 'crawler'] as const,
  primaryIntent: 'multi' as const,
  isMulti: true,
  suggestedAgents: ['db', 'crawler', 'clean', 'code', 'visualize'] as const,
  isDbAnchored: true,
  needsAdmin: false,
  needsWeb: true,
  explicitWantsReport: false,
  explicitWantsVisualize: true,
  planShortcut: 'none' as const,
  requiresAgentPipeline: true,
  allowChatWebDirect: false,
  intent: 'multi' as const,
  allowedAgents: ['db', 'crawler', 'clean', 'code', 'visualize'] as const,
  routedQuery: compoundUser,
  needsWebSearch: true,
  needsClarify: false,
  confidence: 0.82,
  rationale: '三源对比出图'
}

const compoundBundle = parseOrchestratorForTest(compoundRaw)
assert(compoundBundle, 'compound fixture parses')

const compoundScope = resolveTurnRoutingScope({
  messages: [new HumanMessage(compoundUser)],
  turnScopeLlm: { mode: 'current_only', directChitchatSynth: false, confidence: 0.9, rationale: '单轮' }
})

const compoundDecision = applyOrchestratorInvariants({
  bundle: compoundBundle!,
  turnScope: compoundScope,
  state: {
    meta: {},
    probe: {
      db: { matched: true, tables: ['person_info'] },
      rag: { hits: 3 }
    }
  }
})

assert(compoundDecision.allowedAgents.includes('rag'), `rag must stay in cap: ${compoundDecision.allowedAgents.join('→')}`)
assert(compoundDecision.allowedAgents.includes('db'), 'db in cap')
assert(compoundDecision.allowedAgents.includes('crawler'), 'crawler in cap')
assert(
  (compoundDecision.intentClassify.dataSources || []).includes('rag'),
  'dataSources includes rag after clause merge'
)

const blueprint = compoundDecision.planBlueprint ?? buildTopologyBlueprintFromCap({
  allowedAgents: compoundDecision.allowedAgents,
  clauses: compoundDecision.clauses,
  userTask: compoundUser,
  constraints: { wantsVisualize: true, wantsReport: false, timeHints: [], subjectHints: [], fieldHints: [] }
})
assert(blueprint?.steps?.some((s) => s.agent === 'rag'), 'blueprint has rag step')

const steps = materializeStepsFromBlueprint(blueprint!, (agent, focus) => `${agent}:${focus}`)
const ragStep = steps.find((s) => s.agent === 'rag')
const dbStep = steps.find((s) => s.agent === 'db')
assert(ragStep && !ragStep.query.includes(compoundUser.slice(0, 40)), 'rag step uses clause not full user text')
assert(dbStep && dbStep.query.includes('老人'), 'db step scoped to db clause')

const reconciled = reconcileIntentClassifyDataPlane(
  {
    ...compoundRaw,
    suggestedAgents: [...compoundRaw.suggestedAgents],
    dataSources: [...compoundRaw.dataSources]
  } as any,
  compoundRaw.clauses as any
)
assert((reconciled.dataSources || []).includes('rag'), 'reconcile restores rag from clauses')

const merged = mergeDataSourcesWithClauses(
  mockIntentClassifyForTest({ dataSources: ['db', 'crawler'], isDbAnchored: true }),
  compoundRaw.clauses as any
)
assert(merged.dataSources?.includes('rag'), 'mergeDataSourcesWithClauses adds rag')

// 单源 rag_only：编排误标 needsClarify 须被不变量清掉
const ragClarifyRaw = {
  turnScopeMode: 'current_only' as const,
  coalescedTask: '文档事实问句',
  clauses: [{ id: 'c1', text: '文档事实问句', agents: ['rag'] as const }],
  dataSources: ['rag'] as const,
  primaryIntent: 'rag' as const,
  isMulti: false,
  suggestedAgents: ['rag'] as const,
  isDbAnchored: false,
  planShortcut: 'rag_only' as const,
  taskIntent: 'document_retrieval' as const,
  intent: 'rag' as const,
  allowedAgents: ['rag'] as const,
  routedQuery: '文档事实问句',
  needsClarify: true,
  clarifyKind: 'slot' as const,
  clarifyQuestions: ['缺月份？', '数据来源？'],
  requiresAgentPipeline: false,
  allowChatWebDirect: true,
  confidence: 0.8,
  rationale: 'fixture'
}
const ragClarifyBundle = parseOrchestratorForTest(ragClarifyRaw)
assert(ragClarifyBundle, 'rag clarify fixture parses')
const ragClarifyDecision = applyOrchestratorInvariants({
  bundle: ragClarifyBundle!,
  turnScope: resolveTurnRoutingScope({
    messages: [new HumanMessage('文档事实问句')],
    turnScopeLlm: { mode: 'current_only', directChitchatSynth: false, confidence: 0.9, rationale: '单轮' }
  })
})
assert(ragClarifyDecision.needsClarify === false, 'single-source rag clears needsClarify')
assert(ragClarifyDecision.metaPatch.needsClarify === false, 'metaPatch clears needsClarify')
assert(
  !((ragClarifyDecision.clarifyQuestions || []) as string[]).length,
  'clarifyQuestions cleared'
)

console.log('smoke-routing-planner-fix: OK')
