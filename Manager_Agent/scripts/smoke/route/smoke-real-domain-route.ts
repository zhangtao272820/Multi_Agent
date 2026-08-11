/**
 * 真实域路由用例 · doc/真实域路由测试用例.md
 * 结构回归（离线）+ 强路由策略 + 可选 LLM 联机（smoke:pro-understand / smoke:route-matrix-orchestrate）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capFloorFromPuStackMeta, buildOrchestratorBundleFromPuStack } from '../../../server/graph/orchestrate/puStackOrchestratorAuthority'
import { buildBlueprintFromPuStackDispatch } from '../../../server/graph/llm/planBlueprintLlm'
import { sortAgentsByPipelineOrder } from '../../../server/graph/core/routing/clauses'
import { applyOrchestratorInvariants } from '../../../server/graph/orchestrate/orchestratorInvariants'
import { resolveOrchestratorPipeline } from '../../../server/graph/orchestrate/orchestratorPipeline'
import { buildProbeAnchoredOrchestratorFallback, parseOrchestratorPayloadForTest, parseOrchestratorTextForTest } from '../../../server/graph/llm/taskOrchestrator'
import { resolveTurnRoutingScope } from '../../../server/graph/core/routing/turnScope'
import { lintOrchestratorBundle, orchestratorLintSeverity } from '../../../server/graph/orchestrate/orchestratorStructuralLint'
import { normalizeProPuStackUnifiedRaw } from '../../../server/graph/core/proPuStack'
import {
  isProStrongRouteEnabled,
  isOrchestratorBlueprintReady,
  shouldMaterializePlanFromBlueprint,
  shouldPuStackBypassOrchestratorLlm
} from '../../../server/graph/core/routing/proRoutePolicy'
import { isLlmFirstRouteEnabled } from '../../../server/graph/orchestrate/unifiedRouting'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.MANAGER_ROUTE_MODE ??= 'convergence'
process.env.MANAGER_PRO_MODE ??= 'strong'
process.env.MANAGER_EVOLUTION_MODE ??= 'convergence'

process.env.MANAGER_LLM_FIRST_ROUTE ??= '1'
process.env.MANAGER_PLAN_RULE_FALLBACK ??= '0'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

type CaseSpec = {
  id: string
  draft: Array<{ agent: string; scopedUserLanguage: string }>
  meta: Record<string, unknown>
  expectCap: string[]
  userTask: string
  minBlueprintSteps?: number
}

const CASES: CaseSpec[] = [
  // E — 复杂 multi
  {
    id: 'E1',
    userTask: '知识库查失能老人护理员配比，数据库查张三血压血糖，对比分析并出图',
    draft: [
      { agent: 'rag', scopedUserLanguage: '查失能老人护理员配比标准' },
      { agent: 'db', scopedUserLanguage: '查张三血压和血糖记录' }
    ],
    meta: { requiresAgentPipelineHint: true, wantsVisualizeHint: true, taskShape: 'multi_source_parallel' },
    expectCap: ['rag', 'db', 'clean', 'code', 'visualize']
  },
  {
    id: 'E2',
    userTask: '知识库查高龄津贴标准，数据库查河西区 70–79 岁性别分布，写对比报告',
    draft: [
      { agent: 'rag', scopedUserLanguage: '查高龄津贴标准' },
      { agent: 'db', scopedUserLanguage: '查河西区 70–79 岁性别分布' }
    ],
    meta: { requiresAgentPipelineHint: true, wantsReportHint: true, taskShape: 'multi_source_parallel' },
    expectCap: ['rag', 'db', 'report']
  },
  {
    id: 'E3',
    userTask: '足底压力检测一共多少次，按时间做趋势图',
    draft: [{ agent: 'db', scopedUserLanguage: '足底压力检测次数与按时间趋势' }],
    meta: { requiresAgentPipelineHint: true, wantsVisualizeHint: true, taskShape: 'linear_pipeline' },
    expectCap: ['db', 'code', 'visualize']
  },
  {
    id: 'E4',
    userTask:
      '知识库查失能老人护理员配比，数据库查王建国的慢性病检测记录，对比分析并出图。并告诉我坐地铁从天津西站到天津站大概多久',
    draft: [
      { agent: 'rag', scopedUserLanguage: '查失能老人护理员配比标准' },
      { agent: 'db', scopedUserLanguage: '查王建国的慢性病检测记录' },
      { agent: 'admin', scopedUserLanguage: '坐地铁从天津西站到天津站大概多久' }
    ],
    meta: {
      requiresAgentPipelineHint: true,
      wantsVisualizeHint: true,
      wantsAdminHint: true,
      taskShape: 'multi_source_parallel',
      inferredDataSources: [
        { plane: 'rag', confidence: 0.8, inferReason: '文档' },
        { plane: 'db', confidence: 0.8, inferReason: '记录' },
        { plane: 'admin', confidence: 0.75, inferReason: '路线' }
      ]
    },
    expectCap: ['rag', 'db', 'admin', 'code', 'visualize']
  },
  // A — 单步 DB（doc/真实域路由测试用例.md A1–A5）
  {
    id: 'A1',
    userTask: '老人一共有多少人',
    draft: [{ agent: 'db', scopedUserLanguage: '统计老人总人数' }],
    meta: {
      dataPlaneTaskIntent: 'structured_query',
      dataPlanePrimaryPlane: 'db',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.8
    },
    expectCap: ['db']
  },
  {
    id: 'A2',
    userTask: '查王建国的慢性病检测记录',
    draft: [{ agent: 'db', scopedUserLanguage: '查王建国的慢性病检测记录' }],
    meta: {
      dataPlaneTaskIntent: 'structured_query',
      dataPlanePrimaryPlane: 'db',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.8
    },
    expectCap: ['db']
  },
  {
    id: 'A3',
    userTask: '林雨欣做过几次足底压力检测',
    draft: [{ agent: 'db', scopedUserLanguage: '林雨欣做过几次足底压力检测' }],
    meta: {
      dataPlaneTaskIntent: 'structured_query',
      dataPlanePrimaryPlane: 'db',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.85,
      /** 期望数据面主表（协议层断言用；路由 cap 仍为 db） */
      expectFootMainTable: 'remote_activity_foot_log'
    },
    expectCap: ['db']
  },
  {
    id: 'A4',
    userTask: '河西区 70 到 79 岁老人男女各多少人',
    draft: [{ agent: 'db', scopedUserLanguage: '河西区 70 到 79 岁老人男女各多少人' }],
    meta: {
      dataPlaneTaskIntent: 'structured_query',
      dataPlanePrimaryPlane: 'db',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.8
    },
    expectCap: ['db']
  },
  {
    id: 'A5',
    userTask: '龙奶奶的基本信息和联系方式',
    draft: [{ agent: 'db', scopedUserLanguage: '查询龙奶奶的基本信息与联系方式' }],
    meta: {
      dataPlaneTaskIntent: 'structured_query',
      dataPlanePrimaryPlane: 'db',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.8
    },
    expectCap: ['db']
  },
  // B — 单步 RAG（doc B1–B6）
  {
    id: 'B1',
    userTask: '失能老人护理员配比标准是多少',
    draft: [{ agent: 'rag', scopedUserLanguage: '失能老人护理员配比标准' }],
    meta: {
      dataPlaneTaskIntent: 'document_retrieval',
      dataPlanePrimaryPlane: 'rag',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.8
    },
    expectCap: ['rag']
  },
  {
    id: 'B2',
    userTask: '高龄津贴和失能老人补贴标准分别是什么',
    draft: [{ agent: 'rag', scopedUserLanguage: '高龄津贴和失能老人补贴标准' }],
    meta: {
      dataPlaneTaskIntent: 'document_retrieval',
      dataPlanePrimaryPlane: 'rag',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.8
    },
    expectCap: ['rag']
  },
  {
    id: 'B3',
    userTask: '半失能老人护理有哪些要求',
    draft: [{ agent: 'rag', scopedUserLanguage: '半失能老人护理要求' }],
    meta: {
      dataPlaneTaskIntent: 'document_retrieval',
      dataPlanePrimaryPlane: 'rag',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.8
    },
    expectCap: ['rag']
  },
  {
    id: 'B4',
    userTask: '压疮护理要求和口腔护理频次分别是多少',
    draft: [{ agent: 'rag', scopedUserLanguage: '压疮护理要求和口腔护理频次' }],
    meta: {
      dataPlaneTaskIntent: 'document_retrieval',
      dataPlanePrimaryPlane: 'rag',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.8
    },
    expectCap: ['rag']
  },
  {
    id: 'B5',
    userTask: '我的月收入和支出情况怎么样',
    draft: [{ agent: 'rag', scopedUserLanguage: '个人月收入与支出' }],
    meta: { dataPlaneTaskIntent: 'document_retrieval', dataPlanePrimaryPlane: 'rag' },
    expectCap: ['rag']
  },
  {
    id: 'B6',
    userTask: '请引用养老机构服务规范里关于专业人员配备的原文',
    draft: [{ agent: 'rag', scopedUserLanguage: '养老机构服务规范专业人员配备原文' }],
    meta: {
      dataPlaneTaskIntent: 'document_retrieval',
      dataPlanePrimaryPlane: 'rag',
      dataPlaneClarifyRisk: 'low',
      dataPlaneConfidence: 0.8
    },
    expectCap: ['rag']
  },
  // C — Admin
  {
    id: 'C1',
    userTask: '帮我订明天下午 3 点的项目评审会',
    draft: [{ agent: 'admin', scopedUserLanguage: '订明天下午3点项目评审会' }],
    meta: { taskShape: 'action_only', wantsAdminHint: true },
    expectCap: ['admin']
  },
  {
    id: 'C2',
    userTask: '今天天津天气怎么样',
    draft: [{ agent: 'admin', scopedUserLanguage: '查今天天津天气' }],
    meta: { taskShape: 'action_only', wantsAdminHint: true },
    expectCap: ['admin']
  },
  {
    id: 'C3',
    userTask: '坐地铁从天津西站到天津站大概多久',
    draft: [{ agent: 'admin', scopedUserLanguage: '坐地铁从天津西站到天津站大概多久' }],
    meta: { taskShape: 'action_only', wantsAdminHint: true },
    expectCap: ['admin']
  },
  // D — 隐式数据源
  {
    id: 'D1',
    userTask: '统计各区域老人人数，按人数从高到低排',
    draft: [{ agent: 'db', scopedUserLanguage: '各区域老人人数统计并降序' }],
    meta: { dataPlaneTaskIntent: 'structured_query', dataPlanePrimaryPlane: 'db' },
    expectCap: ['db']
  },
  {
    id: 'D2',
    userTask: '失能老人补贴标准是多少',
    draft: [{ agent: 'rag', scopedUserLanguage: '失能老人补贴标准' }],
    meta: { dataPlaneTaskIntent: 'document_retrieval', dataPlanePrimaryPlane: 'rag' },
    expectCap: ['rag']
  },
  {
    id: 'D3',
    userTask: '情绪识别仪检测记录有多少条',
    draft: [{ agent: 'db', scopedUserLanguage: '情绪识别仪检测记录条数' }],
    meta: { dataPlaneTaskIntent: 'structured_query', dataPlanePrimaryPlane: 'db' },
    expectCap: ['db']
  }
]

assert(isLlmFirstRouteEnabled(), 'LLM-First 默认开启')
assert(isProStrongRouteEnabled(), 'convergence 默认强路由开启')
assert(!shouldMaterializePlanFromBlueprint({ intent: 'multi', meta: {} }), '无蓝图时不跳过 Planner LLM')
assert(
  shouldMaterializePlanFromBlueprint({
    intent: 'multi',
    meta: {
      unifiedOrchestrator: true,
      planBlueprint: {
        steps: [
          { agent: 'rag', queryFocus: '配比' },
          { agent: 'db', queryFocus: '记录' },
          { agent: 'admin', queryFocus: '路线' }
        ],
        confidence: 0.82
      }
    }
  }),
  'orchestrator 蓝图就绪时可材料化'
)
if (!isLlmFirstRouteEnabled()) {
  assert(
    isOrchestratorBlueprintReady({
      orchestratorJudgeAccept: false,
      unifiedOrchestrator: true,
      planBlueprint: { steps: [{ agent: 'db', queryFocus: 'x' }], confidence: 0.9 }
    }) === false,
    'judge reject 不材料化'
  )
}

for (const c of CASES) {
  const meta = {
    ...c.meta,
    stepDispatchDraft: c.draft.map((d, i) => ({ ...d, clauseIds: [`c${i + 1}`] }))
  }
  const cap = sortAgentsByPipelineOrder(capFloorFromPuStackMeta(meta, null))
  for (const a of c.expectCap) {
    assert(cap.includes(a as typeof cap[number]), `${c.id}: cap missing ${a}`)
  }
  const extraPipeline = cap.filter((a) => !c.expectCap.includes(String(a)))
  if (c.expectCap.length === 1 && !c.meta.requiresAgentPipelineHint) {
    assert(!extraPipeline.includes('clean'), `${c.id}: 单源不应含 clean`)
    assert(cap.length === 1, `${c.id}: 单源 cap 长度应为 1，实际 ${cap.join(',')}`)
  }
  if (c.id === 'A3') {
    assert(
      String((c.meta as { expectFootMainTable?: string }).expectFootMainTable || '') === 'remote_activity_foot_log',
      'A3: 足底主表须为 remote_activity_foot_log（选表交 DB 自举，总管不得锁 measure_log）'
    )
  }
  if (c.expectCap.length >= 3 || c.minBlueprintSteps) {
    const bp = buildBlueprintFromPuStackDispatch({
      allowedAgents: cap.map(String),
      stepDispatchDraft: meta.stepDispatchDraft as Array<{ agent: string; scopedUserLanguage: string }>,
      userTask: c.userTask
    })
    const minSteps = c.minBlueprintSteps ?? c.expectCap.length
    assert(bp && bp.steps.length >= minSteps, `${c.id}: blueprint steps`)
    const bpAgents = bp!.steps.map((s) => String(s.agent))
    for (const a of c.expectCap) assert(bpAgents.includes(a), `${c.id}: blueprint missing ${a}`)
  }
  console.log(`real-domain route ok: ${c.id} → ${cap.join(' → ')}`)
}

const requiredAb = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6']
for (const id of requiredAb) {
  assert(CASES.some((c) => c.id === id), `missing required case ${id}`)
}
console.log(`real-domain route ok: A1–A5 / B1–B6 coverage (${requiredAb.length})`)


// E4 强路由：编排 LLM 必须参与（mock），不得 pu_stack_authority 短路
const e4User =
  '知识库查失能老人护理员配比，数据库查王建国的慢性病检测记录，对比分析并出图。并告诉我坐地铁从天津西站到天津站大概多久'
const e4Meta = {
  taskShape: 'multi_source_parallel',
  requiresAgentPipelineHint: true,
  wantsVisualizeHint: true,
  wantsAdminHint: true,
  inferredDataSources: [
    { plane: 'rag', confidence: 0.82, inferReason: '查失能老人护理员配比标准' },
    { plane: 'db', confidence: 0.85, inferReason: '查王建国的慢性病检测记录' },
    { plane: 'admin', confidence: 0.78, inferReason: '坐地铁从天津西站到天津站大概多久' }
  ],
  stepDispatchDraft: [
    { agent: 'rag', scopedUserLanguage: '查失能老人护理员配比标准', clauseIds: ['c1'] },
    { agent: 'db', scopedUserLanguage: '查王建国的慢性病检测记录', clauseIds: ['c2'] },
    { agent: 'admin', scopedUserLanguage: '坐地铁从天津西站到天津站大概多久', clauseIds: ['c3'] }
  ]
}
const e4TurnScope = resolveTurnRoutingScope({ messages: [], lastUser: e4User })
const e4Seed = buildOrchestratorBundleFromPuStack({
  lastUser: e4User,
  turnScope: e4TurnScope,
  meta: e4Meta,
  probe: { db: { matched: true, tables: ['person_info'] }, rag: { hits: 2 } }
})
assert(e4Seed, 'E4 seed bundle')
assert(!shouldPuStackBypassOrchestratorLlm(e4Meta), 'E4 强路由不 bypass 编排 LLM')

const mockOrchJson = {
  turnScopeMode: 'current_only',
  coalescedTask: e4User,
  clauses: [
    { id: 'c1', text: '查失能老人护理员配比标准', agents: ['rag'] },
    { id: 'c2', text: '查王建国的慢性病检测记录', agents: ['db'] },
    { id: 'c3', text: '坐地铁从天津西站到天津站大概多久', agents: ['admin'] }
  ],
  dataSources: ['rag', 'db'],
  suggestedAgents: ['rag', 'db', 'admin', 'clean', 'code', 'visualize'],
  allowedAgents: ['rag', 'db', 'admin', 'clean', 'code', 'visualize'],
  isDbAnchored: true,
  needsAdmin: true,
  needsWeb: false,
  isMulti: true,
  requiresAgentPipeline: true,
  planShortcut: 'none',
  intent: 'multi',
  primaryIntent: 'multi',
  routedQuery: e4User,
  wantsVisualize: true,
  explicitWantsVisualize: true,
  confidence: 0.88,
  rationale: '三源对比出图+出行'
}

let orchCalls = 0
const e4PipelineStrong = await resolveOrchestratorPipeline({
  messages: [],
  lastUser: e4User,
  routingContext: e4User,
  turnScope: e4TurnScope,
  probe: { db: { matched: true }, rag: { hits: 2 } },
  llmInvoke: async () => {
    orchCalls += 1
    return { text: JSON.stringify(mockOrchJson) }
  },
  state: { meta: e4Meta, probe: { db: { matched: true }, rag: { hits: 2 } } },
  seedBundle: e4Seed
})
assert(orchCalls >= 1, 'E4 LLM-First 须调用编排 LLM')
assert(e4PipelineStrong.source !== 'pu_stack_authority', `E4 source=${e4PipelineStrong.source}`)
for (const a of ['rag', 'db', 'admin']) {
  assert(
    e4PipelineStrong.decision.allowedAgents.includes(a as typeof e4PipelineStrong.decision.allowedAgents[number]),
    `E4 strong cap missing ${a}`
  )
}
console.log(`real-domain route ok: E4 strong pipeline → ${e4PipelineStrong.decision.allowedAgents.join(' → ')}`)

// E4：编排 LLM 失败须直接报错，禁止 PU seed 兜底
let e4FailCalls = 0
let e4Threw = false
try {
  await resolveOrchestratorPipeline({
    messages: [],
    lastUser: e4User,
    routingContext: e4User,
    turnScope: e4TurnScope,
    probe: { db: { matched: true }, rag: { hits: 2 } },
    llmInvoke: async () => {
      e4FailCalls += 1
      return { text: 'not-json' }
    },
    state: { meta: e4Meta, probe: { db: { matched: true }, rag: { hits: 2 } } },
    seedBundle: e4Seed
  })
} catch (e) {
  e4Threw = true
  assert(String(e instanceof Error ? e.message : e).includes('orchestrator_llm_exhausted'), 'E4 fail must throw exhausted')
}
assert(e4Threw, 'E4 invalid LLM must not fallback')
assert(e4FailCalls >= 1, 'E4 fail still invokes orchestrator LLM')
console.log('real-domain route ok: E4 no pu_seed_recovery fallback')

// markdown 代码块 JSON 须可解析
const e4FenceParsed = parseOrchestratorTextForTest(
  '```json\n' + JSON.stringify(mockOrchJson) + '\n```',
  e4User
)
assert(e4FenceParsed?.allowedAgents.includes('admin'), 'fence JSON keeps admin')
console.log('real-domain route ok: orchestrator markdown fence parse')

// A5 类：LLM 显式 null（timeRange/planBlueprint/rationale 等）不得拖垮 schema
const a5User = '帮我查一下龙奶奶的基本信息和联系方式'
const a5NullParsed = parseOrchestratorPayloadForTest(
  {
    turnScopeMode: 'current_only',
    coalescedTask: null,
    timeRange: null,
    planBlueprint: null,
    rationale: null,
    upgradeReason: null,
    taskForm: null,
    sourceCommitment: 'clear',
    committedPlanes: ['db'],
    webFetchKind: null,
    adminCapabilityHints: null,
    clarifyQuestions: [null, '补一句'],
    timeHints: [null, ''],
    subjectHints: null,
    fieldHints: null,
    clauses: [
      { id: 'c1', text: '龙奶奶的基本信息和联系方式', agents: ['db'], layer: null, taskForm: null }
    ],
    dataSources: ['db'],
    primaryIntent: 'db',
    intent: 'db',
    suggestedAgents: ['db'],
    allowedAgents: ['db'],
    isDbAnchored: true,
    isMulti: false,
    planShortcut: 'db_only',
    routedQuery: null,
    needsClarify: false,
    confidence: null
  },
  a5User
)
assert(a5NullParsed, 'A5 null-fields payload must parse')
assert(a5NullParsed!.allowedAgents.includes('db'), 'A5 keeps db')
assert(String(a5NullParsed!.routedQuery).includes('龙奶奶'), 'A5 routedQuery falls back to user')
assert(a5NullParsed!.needsClarify !== true, 'A5 clear db should not clarify')
console.log('real-domain route ok: A5 null-field schema scrub')

// LLM 常见字段：isDbAnchored 漏填但 clauses 含 db/admin 须保留
const e4ParseFix = parseOrchestratorPayloadForTest(
  {
    intent: 'multi',
    allowedAgents: ['rag', 'db', 'admin', 'code', 'visualize'],
    suggestedAgents: ['rag', 'db', 'admin'],
    isDbAnchored: false,
    needsAdmin: false,
    dataSources: ['rag'],
    clauses: [
      { id: 'c1', text: '查失能老人护理员配比标准', agents: ['rag'] },
      { id: 'c2', text: '查王建国的慢性病检测记录', agents: ['db'] },
      { id: 'c3', text: '坐地铁从天津西站到天津站大概多久', agents: ['admin'] }
    ],
    planBlueprint: {
      steps: [
        { agent: 'rag', focus: '查护理员配比标准' },
        { agent: 'db', focus: '查王建国慢性病记录' },
        { agent: 'admin', focus: '天津西站到天津站地铁时长' }
      ],
      confidence: 0.8
    },
    routedQuery: e4User,
    confidence: 0.8
  },
  e4User
)
assert(e4ParseFix?.allowedAgents.includes('db'), 'parse keeps db when in clauses')
assert(e4ParseFix?.allowedAgents.includes('admin'), 'parse keeps admin when in clauses')
assert(e4ParseFix?.planBlueprint?.steps?.length === 3, 'parse blueprint focus alias')
console.log('real-domain route ok: orchestrator parse db/admin repair')

// 快路径（MANAGER_PRO_MODE=fast + LLM_FIRST=0）仍可用
const savedStrong = process.env.MANAGER_PRO_STRONG_ROUTE
const savedLlmFirst = process.env.MANAGER_LLM_FIRST_ROUTE
const savedProMode = process.env.MANAGER_PRO_MODE
process.env.MANAGER_PRO_STRONG_ROUTE = '0'
process.env.MANAGER_LLM_FIRST_ROUTE = '0'
process.env.MANAGER_PRO_MODE = 'fast'
assert(shouldPuStackBypassOrchestratorLlm(e4Meta), 'fast path bypass when PRO_MODE=fast')
const e4Frozen = applyOrchestratorInvariants({
  bundle: e4Seed!,
  turnScope: e4TurnScope,
  state: { meta: e4Meta, probe: { db: { matched: true }, rag: { hits: 2 } } },
  routerCapBaseline: e4Seed!.allowedAgents,
  capPolicy: { mode: 'frozen' }
})
for (const a of ['rag', 'db', 'admin', 'code', 'visualize']) {
  assert(e4Frozen.allowedAgents.includes(a as typeof e4Frozen.allowedAgents[number]), `E4 frozen cap missing ${a}`)
}
let fastOrchCalls = 0
const e4PipelineFast = await resolveOrchestratorPipeline({
  messages: [],
  lastUser: e4User,
  routingContext: e4User,
  turnScope: e4TurnScope,
  probe: { db: { matched: true }, rag: { hits: 2 } },
  llmInvoke: async () => {
    fastOrchCalls += 1
    // finalize 的 web-execution align 可能仍调用；编排本体须走 pu_stack_authority
    return { text: JSON.stringify(mockOrchJson) }
  },
  state: { meta: e4Meta, probe: { db: { matched: true }, rag: { hits: 2 } } },
  seedBundle: e4Seed
})
assert(e4PipelineFast.source === 'pu_stack_authority', `E4 fast source=${e4PipelineFast.source}`)
assert(e4PipelineFast.source !== 'unified_llm', '快路径不得回落 unified_llm')
console.log(`real-domain route ok: E4 fast path source=${e4PipelineFast.source} (finalize_llm_calls=${fastOrchCalls})`)
process.env.MANAGER_PRO_STRONG_ROUTE = savedStrong ?? '1'
process.env.MANAGER_LLM_FIRST_ROUTE = savedLlmFirst ?? '1'
process.env.MANAGER_PRO_MODE = savedProMode ?? 'strong'

const e4Lint = lintOrchestratorBundle({
  userTask: e4User,
  allowedAgents: [...e4Frozen.allowedAgents],
  clauses: e4Frozen.clauses,
  classify: e4Frozen.intentClassify,
  planBlueprint: e4Frozen.planBlueprint
})
assert(orchestratorLintSeverity(e4Lint) !== 'fail', `E4 lint fail: ${e4Lint.join('; ')}`)

// PU enum 结构修复（无用户原话正则）
const badPu = normalizeProPuStackUnifiedRaw({
  taskShape: 'multi-source-comparison-visualization+transportation-duration',
  taskIntent: '执行三源协同任务: 1) 提取护理配比政策依据; 2) 拉取指定患者临床检测数据',
  primaryPlane: 'hybrid',
  clarifyRisk: '三句主语实体明确，不存在范围歧义',
  requiresAgentPipeline: true,
  wantsVisualize: true,
  wantsAdmin: true,
  stepDispatchDraft: [
    { agent: 'rag', scopedUserLanguage: '知识库查失能老人护理员配比' },
    { agent: 'db', scopedUserLanguage: '数据库查王建国慢性病检测记录' },
    { agent: 'admin', scopedUserLanguage: '坐地铁从天津西站到天津站大概多久' }
  ],
  confidence: 0.85
})
assert(badPu.taskShape === 'multi_source_parallel', 'normalize taskShape')
assert(badPu.taskIntent === 'hybrid', 'normalize taskIntent')
assert(badPu.primaryPlane === 'db', 'normalize primaryPlane')
assert(badPu.clarifyRisk === 'none', 'normalize clarifyRisk')
assert(Array.isArray(badPu.stepDispatchDraft) && badPu.stepDispatchDraft.length >= 3, 'normalize draft')
console.log('real-domain route ok: pu-stack enum structural repair')

const probeFb = buildProbeAnchoredOrchestratorFallback({
  lastUser: e4User,
  turnScope: e4TurnScope,
  probe: { db: { matched: true, tables: ['remote_nursing_chronic'] }, rag: { hits: 3 } }
})
const savedLfProbe = process.env.MANAGER_LLM_FIRST_ROUTE
process.env.MANAGER_LLM_FIRST_ROUTE = '0'
const probeDecision = applyOrchestratorInvariants({
  bundle: probeFb,
  turnScope: e4TurnScope,
  state: { meta: {}, probe: { db: { matched: true }, rag: { hits: 3 } } },
  routerCapBaseline: probeFb.allowedAgents
})
process.env.MANAGER_LLM_FIRST_ROUTE = savedLfProbe ?? '1'
assert(
  probeDecision.allowedAgents.length <= 2 && probeDecision.allowedAgents.includes('db'),
  'legacy probe_fallback path (LLM-First 下不使用)'
)
console.log('real-domain route ok: probe_fallback legacy-only')

// E2 截图回归：cap/蓝图幽灵 crawler（无公网子句）必须硬剥，不得进执行计划
{
  const e2User = '知识库查高龄津贴标准，数据库查河西区 70–79 岁性别分布，写对比报告'
  const e2Turn = resolveTurnRoutingScope({ messages: [], lastUser: e2User })
  const e2GhostBundle = parseOrchestratorPayloadForTest(
    {
      intent: 'multi',
      allowedAgents: ['rag', 'db', 'crawler', 'clean', 'code', 'report'],
      suggestedAgents: ['rag', 'db', 'crawler', 'clean', 'code', 'report'],
      isDbAnchored: true,
      needsWeb: true,
      dataSources: ['rag', 'db', 'crawler'],
      clauses: [
        { id: 'c1', text: '知识库查高龄津贴标准', agents: ['rag'] },
        { id: 'c2', text: '数据库查河西区 70–79 岁性别分布', agents: ['db'] },
        { id: 'c3', text: '写对比报告', agents: ['report'] }
      ],
      planBlueprint: {
        confidence: 0.7,
        steps: [
          { agent: 'rag', focus: '高龄津贴标准' },
          { agent: 'db', focus: '河西区 70–79 岁性别分布' },
          { agent: 'crawler', focus: e2User },
          { agent: 'clean', focus: '清洗' },
          { agent: 'code', focus: '计算' },
          { agent: 'report', focus: '对比报告' }
        ]
      },
      sourceCommitment: 'clear',
      committedPlanes: ['rag', 'db', 'report'],
      webFetchKind: 'none',
      routedQuery: e2User,
      confidence: 0.85
    },
    e2User
  )
  assert(e2GhostBundle, 'E2 ghost bundle parse')
  const e2Decision = applyOrchestratorInvariants({
    bundle: e2GhostBundle!,
    turnScope: e2Turn,
    state: { meta: {}, probe: { db: { matched: true }, rag: { hits: 2 } } },
    routerCapBaseline: e2GhostBundle!.allowedAgents
  })
  assert(!e2Decision.allowedAgents.includes('crawler' as any), `E2 must strip crawler cap: ${e2Decision.allowedAgents.join('→')}`)
  assert(
    !(e2Decision.planBlueprint?.steps ?? []).some((s) => String(s.agent) === 'crawler'),
    'E2 blueprint must not keep unbound crawler step'
  )
  assert(e2Decision.intentClassify.needsWeb !== true, 'E2 needsWeb cleared')
  let e2WebLlmCalls = 0
  const e2Pipe = await resolveOrchestratorPipeline({
    messages: [],
    lastUser: e2User,
    routingContext: e2User,
    turnScope: e2Turn,
    probe: { db: { matched: true }, rag: { hits: 2 } },
    llmInvoke: async () => {
      e2WebLlmCalls += 1
      return {
        text: JSON.stringify({
          intent: 'multi',
          allowedAgents: ['rag', 'db', 'crawler', 'report'],
          suggestedAgents: ['rag', 'db', 'crawler', 'report'],
          isDbAnchored: true,
          needsWeb: true,
          dataSources: ['rag', 'db', 'crawler'],
          clauses: e2GhostBundle!.clauses,
          planBlueprint: e2GhostBundle!.planBlueprint,
          sourceCommitment: 'clear',
          committedPlanes: ['rag', 'db', 'report'],
          webFetchKind: 'none',
          confidence: 0.85
        })
      }
    },
    state: {
      meta: {},
      probe: { db: { matched: true }, rag: { hits: 2 } },
      toolHealth: { agents: [{ agent: 'gui', status: 'ready' }, { agent: 'crawler', status: 'ready' }] }
    },
    seedBundle: e2GhostBundle
  })
  // 有 seed 且非 fast bypass 时仍走 unified；关键：finalize 不得因 gui=ready 再打网页 LLM 把 crawler 加回
  assert(!e2Pipe.decision.allowedAgents.includes('crawler' as any), `E2 pipeline strip crawler: ${e2Pipe.decision.allowedAgents.join('→')}`)
  assert(
    !(e2Pipe.decision.planBlueprint?.steps ?? []).some((s) => String(s.agent) === 'crawler'),
    'E2 pipeline blueprint no crawler'
  )
  console.log(`real-domain route ok: E2 strip unbound crawler (finalize_extra_llm≈${e2WebLlmCalls})`)
}

const goldenPath = path.join(__dirname, '../../..', 'eval', 'golden-real-domain-route.json')
assert(fs.existsSync(goldenPath), 'golden-real-domain-route.json exists')

const apiKey = String(process.env.OPENAI_API_KEY ?? '').trim()
if (apiKey && fs.existsSync(path.join(__dirname, '../../..', '.env'))) {
  console.log('real-domain: LLM 联机请运行 smoke:pro-understand 与 smoke:route-matrix-orchestrate')
}

console.log('smoke: real-domain-route ok')
