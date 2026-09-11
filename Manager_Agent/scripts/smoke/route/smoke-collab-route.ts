/**
 * 协作型路由结构回归 · doc/真实域路由测试用例.md §H
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capFloorFromPuStackMeta } from '../../../server/graph/orchestrate/puStackOrchestratorAuthority'
import { buildBlueprintFromPuStackDispatch } from '../../../server/graph/llm/planBlueprintLlm'
import { sortAgentsByPipelineOrder } from '../../../server/graph/core/routing/clauses'
import { isLlmFirstRouteEnabled, shouldSkipPlanRuleFallback } from '../../../server/graph/orchestrate/unifiedRouting'
import { shouldPuStackBypassOrchestratorLlm } from '../../../server/graph/core/routing/proRoutePolicy'
import { applyOrchestratorInvariants } from '../../../server/graph/orchestrate/orchestratorInvariants'
import { buildOrchestratorBundleFromClassify } from '../../../server/graph/llm/taskOrchestrator'
import { reconcileIntentClassifyDataPlane } from '../../../server/graph/orchestrate/routeOrchestration'
import { resolveTurnRoutingScope } from '../../../server/graph/core/routing/turnScope'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.MANAGER_ROUTE_MODE ??= 'convergence'
process.env.MANAGER_PRO_MODE ??= 'strong'
process.env.MANAGER_LLM_FIRST_ROUTE ??= '1'
process.env.MANAGER_PLAN_RULE_FALLBACK ??= '0'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

assert(isLlmFirstRouteEnabled(), 'LLM-First 默认开启')
assert(shouldSkipPlanRuleFallback({ meta: { unifiedOrchestrator: true } }), '禁用 Planner 规则兜底')
assert(
  !shouldPuStackBypassOrchestratorLlm({
    stepDispatchDraft: [
      { agent: 'rag', scopedUserLanguage: 'a', clauseIds: ['c1'] },
      { agent: 'crawler', scopedUserLanguage: 'b', clauseIds: ['c2'] }
    ]
  }),
  'LLM-First 不 bypass 编排 LLM'
)

type CollabCase = {
  id: string
  userTask: string
  draft: Array<{ agent: string; scopedUserLanguage: string }>
  expectAgents: string[]
  meta?: Record<string, unknown>
}

const COLLAB: CollabCase[] = [
  {
    id: 'H1',
    userTask: '对照知识库护理员配比标准，网上查最新民政部相关通知，汇总对比',
    draft: [
      { agent: 'rag', scopedUserLanguage: '查知识库护理员配比标准' },
      { agent: 'crawler', scopedUserLanguage: '网上查最新民政部相关通知' }
    ],
    expectAgents: ['rag', 'crawler', 'code', 'report'],
    meta: { requiresAgentPipelineHint: true, wantsReportHint: true, taskShape: 'multi_source_parallel' }
  },
  {
    id: 'H2',
    userTask: '查数据库里张三的血压记录，并对照知识库里的正常范围标准',
    draft: [
      { agent: 'db', scopedUserLanguage: '查张三血压记录' },
      { agent: 'rag', scopedUserLanguage: '查知识库血压正常范围标准' }
    ],
    expectAgents: ['db', 'rag', 'code'],
    meta: { taskShape: 'multi_source_parallel', requiresAgentPipelineHint: true }
  },
  {
    id: 'H3',
    userTask: '识图提取体检报告关键指标，并对照知识库里的护理规范原文',
    draft: [
      { agent: 'multimodal', scopedUserLanguage: '识图提取体检报告关键指标' },
      { agent: 'rag', scopedUserLanguage: '查知识库护理规范原文' }
    ],
    expectAgents: ['multimodal', 'rag'],
    meta: {
      taskShape: 'multi_source_parallel',
      inferredDataSources: [
        { plane: 'multimodal', confidence: 0.85, inferReason: '附件识图' },
        { plane: 'rag', confidence: 0.8, inferReason: '规范原文' }
      ]
    }
  },
  {
    id: 'H4',
    userTask: '知识库查失能补贴标准，数据库查河西区老人人数，查天津今日天气，写综合简报',
    draft: [
      { agent: 'rag', scopedUserLanguage: '查失能补贴标准' },
      { agent: 'db', scopedUserLanguage: '查河西区老人人数' },
      { agent: 'admin', scopedUserLanguage: '查天津今日天气预报' }
    ],
    expectAgents: ['rag', 'db', 'admin', 'report'],
    meta: { requiresAgentPipelineHint: true, wantsReportHint: true, wantsAdminHint: true, taskShape: 'multi_source_parallel' }
  },
  {
    id: 'H5',
    userTask: '查林婉清足底压力检测次数并出趋势图，同时帮我订明天下午三点的复查提醒',
    draft: [
      { agent: 'db', scopedUserLanguage: '查林婉清足底压力检测次数与趋势' },
      { agent: 'admin', scopedUserLanguage: '订明天下午三点复查提醒' }
    ],
    expectAgents: ['db', 'code', 'visualize', 'admin'],
    meta: { requiresAgentPipelineHint: true, wantsVisualizeHint: true, wantsAdminHint: true, taskShape: 'multi_source_parallel' }
  },
  {
    id: 'H6',
    userTask: '根据上传的菜品图片估算热量，查个人月收入文档看是否超支',
    draft: [
      { agent: 'multimodal', scopedUserLanguage: '识图估算菜品热量' },
      { agent: 'rag', scopedUserLanguage: '查个人月收入与支出文档' }
    ],
    expectAgents: ['multimodal', 'rag'],
    meta: {
      taskShape: 'multi_source_parallel',
      inferredDataSources: [
        { plane: 'multimodal', confidence: 0.88, inferReason: '菜品图片' },
        { plane: 'rag', confidence: 0.82, inferReason: '个人月收入.txt' }
      ]
    }
  }
]

for (const c of COLLAB) {
  const meta = {
    ...c.meta,
    stepDispatchDraft: c.draft.map((d, i) => ({ ...d, clauseIds: [`c${i + 1}`] }))
  }
  const cap = sortAgentsByPipelineOrder(capFloorFromPuStackMeta(meta, null))
  for (const a of c.expectAgents) {
    assert(cap.includes(a as typeof cap[number]), `${c.id}: cap floor missing ${a}`)
  }
  const bp = buildBlueprintFromPuStackDispatch({
    allowedAgents: cap.map(String),
    stepDispatchDraft: meta.stepDispatchDraft as Array<{ agent: string; scopedUserLanguage: string }>,
    userTask: c.userTask
  })
  assert(bp && bp.steps.length >= c.expectAgents.filter((a) => !['clean', 'code'].includes(a)).length, `${c.id}: blueprint steps`)
  const bpAgents = new Set(bp!.steps.map((s) => String(s.agent)))
  for (const a of c.expectAgents) {
    if (['clean', 'code'].includes(a)) continue
    assert(bpAgents.has(a), `${c.id}: blueprint missing ${a}`)
  }
  if (c.id === 'H3' || c.id === 'H6') {
    const mm = bp!.steps.find((s) => String(s.agent) === 'multimodal')
    const rag = bp!.steps.find((s) => String(s.agent) === 'rag')
    assert(mm && rag, `${c.id}: multimodal+rag steps`)
    const deps = Array.isArray((rag as { dependsOn?: string[] }).dependsOn)
      ? (rag as { dependsOn: string[] }).dependsOn.map(String)
      : []
    const mmId = String((mm as { id?: string }).id || '')
    // 若蓝图显式 dependsOn，须挂 multimodal；否则执行期 applyMultimodalHandoff 仍可注入
    if (deps.length && mmId) {
      assert(
        deps.includes(mmId) || deps.some((d) => /multimodal|s_mm/i.test(d)),
        `${c.id}: rag dependsOn multimodal when deps present`
      )
    }
  }
  console.log(`collab route ok: ${c.id} → ${cap.join(' → ')}`)
}

// LLM-First invariants：信任编排 cap，不删 crawler
const h1Turn = resolveTurnRoutingScope({ messages: [], lastUser: COLLAB[0]!.userTask })
const h1Bundle = buildOrchestratorBundleFromClassify({
  classify: reconcileIntentClassifyDataPlane({
    primaryIntent: 'multi',
    isMulti: true,
    suggestedAgents: ['rag', 'crawler', 'code', 'report'],
    isDbAnchored: false,
    needsAdmin: false,
    needsWeb: true,
    explicitWantsReport: true,
    explicitWantsVisualize: false,
    planShortcut: 'none',
    dataSources: ['rag', 'crawler'],
    requiresAgentPipeline: true,
    allowChatWebDirect: false,
    confidence: 0.86,
    rationale: 'H1 mock'
  }),
  lastUser: COLLAB[0]!.userTask,
  turnScopeMode: h1Turn.mode
})
const h1Decision = applyOrchestratorInvariants({
  bundle: h1Bundle,
  turnScope: h1Turn,
  state: { meta: { unifiedOrchestrator: true } }
})
assert(h1Decision.allowedAgents.includes('rag'), 'H1 llm-first keeps rag')
assert(h1Decision.allowedAgents.includes('crawler'), 'H1 llm-first keeps crawler')
assert(!h1Decision.allowedAgents.includes('admin'), 'H1 no spurious admin')

console.log('smoke: collab-route ok')
