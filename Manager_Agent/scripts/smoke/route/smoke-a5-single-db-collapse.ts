/**
 * A5：单源「基本信息+联系方式」过度拆分须折叠为一步 db。
 */
import { collapseSingleSourceSameAgentOrchestrator } from '../../../server/graph/llm/taskOrchestrator/parseCore'
import { lintOrchestratorBundle, orchestratorLintSeverity } from '../../../server/graph/orchestrate/orchestratorStructuralLint'
import { applyOrchestratorInvariants } from '../../../server/graph/orchestrate/orchestratorInvariants'
import { resolveTurnRoutingScope } from '../../../server/graph/core/routing/turnScope'
import type { TaskOrchestratorBundle } from '../../../server/graph/llm/taskOrchestrator'
import type { IntentClassifyResult } from '../../../server/graph/llm/intentClassifyLlm'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const q = '龙奶奶的基本信息和联系方式'

const classifyBase: IntentClassifyResult = {
  primaryIntent: 'multi',
  isMulti: true,
  suggestedAgents: ['db'],
  isDbAnchored: true,
  needsAdmin: false,
  needsWeb: false,
  explicitWantsReport: false,
  explicitWantsVisualize: false,
  planShortcut: 'none',
  dataSources: ['db'],
  requiresAgentPipeline: true,
  allowChatWebDirect: false,
  confidence: 0.8,
  rationale: 'split'
}

// —— normalize 折叠 ——
const raw: Record<string, unknown> = {
  coalescedTask: q,
  routedQuery: q,
  dataSources: ['db'],
  suggestedAgents: ['db'],
  allowedAgents: ['db'],
  isMulti: true,
  requiresAgentPipeline: true,
  planShortcut: 'none',
  intent: 'multi',
  primaryIntent: 'multi',
  isDbAnchored: true,
  explicitWantsReport: false,
  explicitWantsVisualize: false,
  clauses: [
    { id: 'c1', text: '查龙奶奶基本信息', agents: ['db'] },
    { id: 'c2', text: '查龙奶奶联系方式', agents: ['db'] }
  ],
  planBlueprint: {
    rationale: '拆档案与联系人',
    confidence: 0.8,
    steps: [
      { agent: 'db', queryFocus: '在 person_info 查龙奶奶基本信息', clauseIds: ['c1'] },
      { agent: 'db', queryFocus: '在 person_emergency_contact 查联系方式', clauseIds: ['c2'] }
    ]
  }
}

assert(collapseSingleSourceSameAgentOrchestrator(raw, q) === true, 'must collapse A5 over-split')
assert(Array.isArray(raw.clauses) && (raw.clauses as unknown[]).length === 1, 'clauses → 1')
const bp = raw.planBlueprint as { steps?: unknown[] }
assert(Array.isArray(bp.steps) && bp.steps.length === 1, 'blueprint steps → 1')
assert(raw.isMulti === false, 'isMulti false')
assert(raw.requiresAgentPipeline === false, 'pipeline false')
assert(raw.planShortcut === 'db_only', 'db_only')
assert(raw.intent === 'db', 'intent db')

// —— lint fail on uncollapsed ——
const lintIssues = lintOrchestratorBundle({
  userTask: q,
  allowedAgents: ['db'],
  clauses: [
    { id: 'c1', text: '基本信息', agents: ['db'] },
    { id: 'c2', text: '联系方式', agents: ['db'] }
  ],
  classify: classifyBase,
  planBlueprint: {
    rationale: 'x',
    confidence: 0.7,
    steps: [
      { agent: 'db', queryFocus: '基本信息' },
      { agent: 'db', queryFocus: '联系方式' }
    ]
  }
})
assert(
  lintIssues.some((i) => i.includes('须折叠为一步')),
  `lint must flag over-split: ${lintIssues.join(';')}`
)
assert(orchestratorLintSeverity(lintIssues) === 'fail', 'over-split lint severity fail')

// —— invariants 入口折叠 ——
process.env.MANAGER_LLM_FIRST_ROUTE ??= '1'
const bundle = {
  coalescedTask: q,
  routedQuery: q,
  clauses: [
    { id: 'c1', text: '查龙奶奶基本信息', agents: ['db'] },
    { id: 'c2', text: '查龙奶奶联系方式', agents: ['db'] }
  ],
  intentClassify: { ...classifyBase },
  constraints: { wantsReport: false, wantsVisualize: false },
  allowedAgents: ['db'],
  intent: 'multi',
  planBlueprint: {
    rationale: 'split',
    confidence: 0.8,
    steps: [
      { agent: 'db', queryFocus: 'person_info 基本信息' },
      { agent: 'db', queryFocus: 'emergency 联系方式' }
    ]
  },
  needsWebSearch: false,
  needsClarify: false,
  clarifyQuestions: [],
  raw: {
    coalescedTask: q,
    routedQuery: q,
    dataSources: ['db'],
    suggestedAgents: ['db'],
    allowedAgents: ['db'],
    isMulti: true,
    requiresAgentPipeline: true,
    planShortcut: 'none',
    intent: 'multi',
    primaryIntent: 'multi',
    isDbAnchored: true,
    explicitWantsReport: false,
    explicitWantsVisualize: false,
    clauses: [
      { id: 'c1', text: '查龙奶奶基本信息', agents: ['db'] },
      { id: 'c2', text: '查龙奶奶联系方式', agents: ['db'] }
    ],
    planBlueprint: {
      rationale: 'split',
      confidence: 0.8,
      steps: [
        { agent: 'db', queryFocus: 'person_info 基本信息' },
        { agent: 'db', queryFocus: 'emergency 联系方式' }
      ]
    }
  }
} as unknown as TaskOrchestratorBundle

const turnScope = resolveTurnRoutingScope({ messages: [], lastUser: q })
const decision = applyOrchestratorInvariants({
  bundle,
  turnScope,
  state: { meta: {}, probe: { db: { matched: true, tables: ['person_info', 'person_health_records'] } } }
})
assert(decision.allowedAgents.length === 1 && decision.allowedAgents[0] === 'db', 'cap=[db]')
assert(decision.clauses.length === 1, `invariants clauses=1 got ${decision.clauses.length}`)
assert(
  (decision.planBlueprint?.steps?.length ?? 0) === 1,
  `invariants blueprint steps=1 got ${decision.planBlueprint?.steps?.length}`
)
assert(decision.intentClassify.isMulti === false, 'classify isMulti false')
assert(String(decision.intentClassify.planShortcut) === 'db_only', 'classify db_only')

console.log('smoke: a5 single-db collapse ok')
