/**
 * 平面库存覆盖再判 · 离线结构回归（不拉真实 LLM）
 * 合成库存名，禁止绑测试域专名；验证 db→rag / rag→db / multi 不翻面门禁。
 */
import {
  applyPlaneCoverageRewrite,
  catalogsHaveInventory,
  gatePlaneCoverageFlip,
  singleDataPlaneFromCap
} from '../../../server/graph/llm/planeCoverageRejudgeLlm'
import { parseOrchestratorPayloadForTest } from '../../../server/graph/llm/taskOrchestrator'
import { resolveOrchestratorPipeline } from '../../../server/graph/orchestrate/orchestratorPipeline'
import { resolveTurnRoutingScope } from '../../../server/graph/core/routing/turnScope'
import { HumanMessage } from '@langchain/core/messages'

process.env.MANAGER_ROUTE_MODE ??= 'convergence'
process.env.MANAGER_PRO_MODE ??= 'strong'
process.env.MANAGER_LLM_FIRST_ROUTE ??= '1'
process.env.MANAGER_PLANE_COVERAGE_REJUDGE ??= '1'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

assert(singleDataPlaneFromCap(['db']) === 'db', 'single db')
assert(singleDataPlaneFromCap(['rag']) === 'rag', 'single rag')
assert(singleDataPlaneFromCap(['db', 'code', 'visualize']) === 'db', 'db pipeline still single data plane')
assert(singleDataPlaneFromCap(['db', 'rag']) === null, 'dual data plane')
assert(singleDataPlaneFromCap(['db', 'crawler']) === null, 'crawler blocks flip')
assert(singleDataPlaneFromCap(['admin']) === null, 'admin-only')

assert(
  gatePlaneCoverageFlip('db', {
    dbCanAnswer: false,
    ragCanAnswer: true,
    preferredPlane: 'rag',
    confidence: 0.9,
    rationale: 'doc inventory covers'
  }) === 'rag',
  'db→rag when inventory supports'
)
assert(
  gatePlaneCoverageFlip('db', {
    dbCanAnswer: true,
    ragCanAnswer: true,
    preferredPlane: 'rag',
    confidence: 0.9,
    rationale: 'both can'
  }) === null,
  'no flip when dbCanAnswer'
)
assert(
  gatePlaneCoverageFlip('db', {
    dbCanAnswer: false,
    ragCanAnswer: true,
    preferredPlane: 'rag',
    confidence: 0.5,
    rationale: 'low'
  }) === null,
  'confidence below threshold'
)
assert(
  gatePlaneCoverageFlip('rag', {
    dbCanAnswer: true,
    ragCanAnswer: false,
    preferredPlane: 'db',
    confidence: 0.88,
    rationale: 'tables cover'
  }) === 'db',
  'rag→db when inventory supports'
)

assert(
  catalogsHaveInventory({
    db: { tableInventory: ['orders', 'customers'] },
    rag: { docInventory: [] }
  }),
  'table inventory counts'
)
assert(
  catalogsHaveInventory({
    db: { tableInventory: [] },
    rag: { docInventory: ['refund_policy.md'] }
  }),
  'doc inventory counts'
)
assert(!catalogsHaveInventory({ db: {}, rag: {} }), 'empty catalogs skip')

const wrongDb = parseOrchestratorPayloadForTest(
  {
    clauses: [{ id: 'c1', text: '查询本月收支概况', agents: ['db'] }],
    dataSources: ['db'],
    taskIntent: 'structured_query',
    allowedAgents: ['db'],
    suggestedAgents: ['db'],
    isDbAnchored: true,
    planShortcut: 'db_only',
    intent: 'db',
    primaryIntent: 'db',
    routedQuery: '本月收支概况如何'
  },
  '本月收支概况如何'
)
assert(wrongDb, 'parse wrong-db bundle')
const flipped = applyPlaneCoverageRewrite(wrongDb!, 'db', 'rag', '本月收支概况如何', 'doc covers')
assert(flipped.allowedAgents.includes('rag') && !flipped.allowedAgents.includes('db'), 'rewrite cap to rag')
assert(flipped.planBlueprint?.steps?.some((s) => s.agent === 'rag'), 'blueprint follows rag')
assert(!flipped.planBlueprint?.steps?.some((s) => s.agent === 'db'), 'blueprint drops db')
assert(flipped.intentClassify.isDbAnchored === false, 'isDbAnchored cleared')
assert((flipped.intentClassify.dataSources || []).includes('rag'), 'dataSources rag')

const keepMulti = parseOrchestratorPayloadForTest(
  {
    clauses: [
      { id: 'c1', text: '查文档标准', agents: ['rag'] },
      { id: 'c2', text: '查库内记录', agents: ['db'] }
    ],
    dataSources: ['rag', 'db'],
    allowedAgents: ['rag', 'db', 'code'],
    suggestedAgents: ['rag', 'db', 'code'],
    intent: 'multi',
    primaryIntent: 'multi',
    routedQuery: '对照文档与库表'
  },
  '对照文档与库表'
)
assert(singleDataPlaneFromCap(keepMulti!.allowedAgents) === null, 'multi not single')

/** 管线接入：mock LLM 在误选 db 后由 plane_cover 翻到 rag */
const userTask = '我的月度账单明细情况怎么样'
const turnScope = resolveTurnRoutingScope({
  messages: [new HumanMessage(userTask)],
  lastUser: userTask
})

function sysText(messages: unknown[]): string {
  const flat = JSON.stringify(messages ?? [])
  return flat
}

const mockLlm = async (_stage: string, _state: unknown, messages: unknown[]) => {
  const blob = sysText(messages)
  if (blob.includes('库存覆盖审查器') || blob.includes('preferredPlane')) {
    return {
      text: JSON.stringify({
        dbCanAnswer: false,
        ragCanAnswer: true,
        preferredPlane: 'rag',
        confidence: 0.92,
        rationale: 'doc inventory covers monthly statement; no finance tables'
      })
    }
  }
  if (blob.includes('用户末轮对齐审查器') || blob.includes('待审查编排')) {
    return {
      text: JSON.stringify({
        allowedAgents: ['db'],
        clauses: [{ id: 'c1', text: userTask, agents: ['db'] }],
        dataSources: ['db'],
        isDbAnchored: true,
        needsAdmin: false,
        needsWeb: false,
        rationale: '个人情况→db'
      })
    }
  }
  // 默认：编排 / web-align 等其它调用
  if (blob.includes('webExecution') || blob.includes('WebExecution') || blob.includes('composite')) {
    return {
      text: JSON.stringify({
        accept: true,
        webExecutionMode: 'none',
        confidence: 0.9,
        rationale: 'no web'
      })
    }
  }
  return {
    text: JSON.stringify({
      turnScopeMode: 'current_only',
      clauses: [{ id: 'c1', text: userTask, agents: ['db'] }],
      dataSources: ['db'],
      taskIntent: 'structured_query',
      allowedAgents: ['db'],
      suggestedAgents: ['db'],
      isDbAnchored: true,
      planShortcut: 'db_only',
      intent: 'db',
      primaryIntent: 'db',
      routedQuery: userTask,
      needsClarify: false,
      needsWeb: false,
      needsWebSearch: false,
      planBlueprint: {
        rationale: '误选 db',
        steps: [{ agent: 'db', queryFocus: userTask }],
        confidence: 0.7
      },
      confidence: 0.7,
      rationale: '误判 structured_query'
    })
  }
}

const pipe = await resolveOrchestratorPipeline({
  messages: [new HumanMessage(userTask)],
  lastUser: userTask,
  routingContext: '',
  turnScope,
  probe: {
    db: {
      matched: false,
      tables: [],
      tableInventory: ['person_info', 'health_log', 'orders_meta']
    },
    rag: {
      hits: 1,
      hasDocs: true,
      docInventory: ['monthly_statement.md', 'refund_policy.md'],
      sources: ['monthly_statement.md']
    }
  } as any,
  llmInvoke: mockLlm as any,
  state: { meta: {} }
})

assert(pipe.source.includes('plane_cover'), `source has plane_cover got=${pipe.source}`)
assert(
  pipe.decision.allowedAgents.includes('rag') && !pipe.decision.allowedAgents.includes('db'),
  `cap flipped to rag got=${pipe.decision.allowedAgents.join(',')}`
)
assert(
  pipe.decision.planBlueprint?.steps?.some((s) => s.agent === 'rag'),
  'pipeline blueprint rag'
)

console.log('smoke-plane-coverage-rejudge: ok')
