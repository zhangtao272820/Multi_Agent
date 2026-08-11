/**
 * 总管 → DB/RAG 透传协议：
 * - 问句净化去掉 Planner 表名/SQL
 * - 出站不传 managerTask / manager_rag_task_json / x-manager-orchestrated
 * - 单源 probe 预判可 coalesce
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeSubAgentBusinessQuestion, resolveDbStepQuestionSync } from '../../../server/graph/core/db/dbStepQuestion'
import { buildRagRetrievalMessage } from '../../../server/graph/core/probe/retrieverPlan'
import { coalesceSimpleDbRoute, coalesceSimpleRagRoute } from '../../../server/graph/core/plan/planShortcuts'
import { formatDbPrefetchForPlanner } from '../../../server/graph/core/db/dbPrefetch'
import { formatRuntimeCatalogsForOrchestrator } from '../../../server/graph/core/probe/probeInterpretation'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

// —— 问句净化：去掉表名 / JOIN ——
const polluted =
  '在数据库中查询林婉清的足底压力测试记录，关联 remote_activity_foot_log 和 remote_activity_foot_measure_log 表，获取原始测试数据。'
const cleaned = sanitizeSubAgentBusinessQuestion(polluted)
assert(!/remote_activity_foot/.test(cleaned), `sanitize must drop foot table tokens, got: ${cleaned}`)
assert(!/\bJOIN\b/i.test(cleaned), 'sanitize must drop JOIN')
assert(/林婉清/.test(cleaned) && /足底/.test(cleaned), `sanitize must keep business NL: ${cleaned}`)

const single = resolveDbStepQuestionSync(
  '从数据库查询：林雨欣做过几次足底压力检测',
  '林雨欣做过几次足底压力检测',
  { intent: 'db' }
)
assert(single === '林雨欣做过几次足底压力检测' || single.includes('林雨欣'), `单步 db 用用户原话: ${single}`)
assert(!/remote_activity/.test(single), '单步问句不得含表名')

// A5：单源 db 即使有 queryFocus，仍用用户原话（对齐独立端）
const a5User = '龙奶奶的基本信息和联系方式'
const a5Single = resolveDbStepQuestionSync('查询龙奶奶的基本信息与联系方式', a5User, {
  intent: 'db',
  planBlueprint: { steps: [{ agent: 'db', queryFocus: '查询龙奶奶的基本信息与联系方式' }] },
  intentClassify: { planShortcut: 'db_only', primaryIntent: 'db' }
})
assert(a5Single === a5User, `A5 single-db must use user NL, got: ${a5Single}`)

const multiScoped = resolveDbStepQuestionSync(
  polluted,
  '在数据库中查询林婉清足底压力测试记录，汇总后生成报告',
  {
    intent: 'multi',
    planBlueprint: {
      steps: [{ agent: 'db', queryFocus: '查询林婉清足底压力测试记录' }]
    }
  }
)
assert(!/remote_activity|measure_log/.test(multiScoped), `多步 scoped 不得含表名: ${multiScoped}`)
assert(/林婉清|足底/.test(multiScoped), `多步须保留业务问句: ${multiScoped}`)

// —— RAG 透传：message = lean，无 sidecar ——
const ragBundle = buildRagRetrievalMessage('失能老人护理员配比标准是多少', '失能老人护理员配比标准是多少', {
  hits: 2,
  sources: ['养老机构服务规范.pdf'],
  snippets: ['护理员配比…']
})
assert(ragBundle.managerRagTask == null, 'RAG bundle must not attach managerRagTask')
assert(!String(ragBundle.message).includes('【检索任务】'), 'RAG message must not wrap retrieval template')
assert(String(ragBundle.message).includes('配比'), `RAG lean message: ${ragBundle.message}`)
assert(ragBundle.meta?.mode === 'passthrough', 'RAG meta mode passthrough')

// —— Planner 预取不下发表名 ——
const plannerHint = formatDbPrefetchForPlanner(
  {
    ok: true,
    ms: 12,
    question: '林雨欣足底压力',
    unified_task_plan: {
      hints: { suggested_tables: ['remote_activity_foot_log', 'remote_activity_foot_measure_log'] },
      entities: { names: ['林雨欣'] }
    }
  },
  { omitTableHints: true }
)
assert(!/remote_activity_foot/.test(plannerHint), `planner hint must omit tables: ${plannerHint}`)

// —— 单源 probe coalesce ——
const dbCoalesce = coalesceSimpleDbRoute({
  intent: 'multi',
  question: '林雨欣做过几次足底压力检测',
  userMessage: '林雨欣做过几次足底压力检测',
  allowedAgents: ['db', 'rag', 'clean'],
  probe: { db: { matched: true, tables: ['remote_activity_foot_log'] }, rag: { hits: 0 } },
  meta: { dataPlanePrimaryPlane: 'db' },
  intentClassify: {
    primaryIntent: 'db',
    isDbAnchored: true,
    planShortcut: 'db_only',
    confidence: 0.9,
    explicitWantsReport: false,
    explicitWantsVisualize: false,
    requiresAgentPipeline: false,
    isMulti: false,
    dataSources: ['db']
  } as any
})
assert(dbCoalesce?.intent === 'db' && dbCoalesce.allowedAgents[0] === 'db', 'probe-favor db must coalesce')

const ragCoalesce = coalesceSimpleRagRoute({
  intent: 'multi',
  question: '失能老人护理员配比标准是多少',
  userMessage: '失能老人护理员配比标准是多少',
  allowedAgents: ['rag', 'db', 'report'],
  probe: { db: { matched: false, tables: [] }, rag: { hits: 3, hasDocs: true } },
  meta: { dataPlanePrimaryPlane: 'rag' },
  intentClassify: {
    primaryIntent: 'rag',
    isDbAnchored: false,
    planShortcut: 'rag_only',
    confidence: 0.9,
    explicitWantsReport: false,
    explicitWantsVisualize: false,
    requiresAgentPipeline: false,
    isMulti: false,
    dataSources: ['rag']
  } as any
})
assert(ragCoalesce?.intent === 'rag' && ragCoalesce.allowedAgents[0] === 'rag', 'probe-favor rag must coalesce')

// —— 源码契约：出站客户端不得再发 sidecar / 编排头 ——
const root = path.resolve(__dirname, '../../..')
const dbClientSrc = readFileSync(path.join(root, 'server/utils/agents/dbClient.ts'), 'utf8')
const ragClientSrc = readFileSync(path.join(root, 'server/utils/agents/ragClient.ts'), 'utf8')
const dbExecSrc = readFileSync(path.join(root, 'server/graph/core/executors/dbExecutor.ts'), 'utf8')
assert(!/managerTask\s*\?:/.test(dbClientSrc), 'dbClient must not accept managerTask param')
assert(!/managerTask:/.test(dbClientSrc), 'dbClient must not send managerTask')
assert(!/MANAGER_ORCHESTRATED_HEADER/.test(dbClientSrc), 'dbClient must not set orchestrated header')
assert(!/managerRagTask\s*\?:/.test(ragClientSrc), 'ragClient must not accept managerRagTask')
assert(!/manager_rag_task_json/.test(ragClientSrc), 'ragClient must not send manager_rag_task_json')
assert(!/x-manager-orchestrated/.test(ragClientSrc), 'ragClient must not set x-manager-orchestrated')
assert(!/buildManagerDbTaskPayload/.test(dbExecSrc), 'dbExecutor must not build managerTask payload')
assert(!/managerTask:/.test(dbExecSrc), 'dbExecutor must not pass managerTask')

// —— 终答默认 chat-first（与独立文档助手 /api/chat 对齐）——
const ragPolicySrc = readFileSync(path.join(root, 'server/graph/core/rag/ragRetrievePolicy.ts'), 'utf8')
const ragExecSrc = readFileSync(path.join(root, 'server/graph/core/executors/ragExecute.ts'), 'utf8')
assert(
  /MANAGER_RAG_RETRIEVE_FIRST\s*\?\?\s*['"]0['"]/.test(ragPolicySrc),
  'retrieve-first default must be 0 (chat-first)'
)
assert(
  /isManagerRagRetrieveFirstEnabled\(\)/.test(ragExecSrc) &&
    /callRagAgent/.test(ragExecSrc),
  'ragExecute must gate facts fast-path and still call /api/chat via callRagAgent'
)
assert(
  ragExecSrc.indexOf('isManagerRagRetrieveFirstEnabled()') < ragExecSrc.indexOf('deps.callRagAgent'),
  'chat path must remain after retrieve-first gate'
)

const ragOrchSrc = readFileSync(
  path.resolve(root, '../RAG_Agent/server/utils/manager_orchestration.ts'),
  'utf8'
)
assert(
  !/x-trace-id/.test(ragOrchSrc) || !/headerValue\(headers,\s*"x-trace-id"\)/.test(ragOrchSrc),
  'RAG isManagerOrchestratedRequest must not treat x-trace-id alone as orchestrated'
)

const catalogs = formatRuntimeCatalogsForOrchestrator({
  db: {
    matched: true,
    tables: ['person_info'],
    tableInventory: ['person_info', 'health_log', 'dify_knowledge_doc']
  },
  rag: {
    hits: 0,
    hasDocs: true,
    sources: [],
    docInventory: ['规范.docx', '个人材料.txt']
  }
})
assert(/库存表：/.test(catalogs) && /person_info/.test(catalogs), 'db catalog shows inventory')
assert(!/dify_knowledge_doc/.test(catalogs), 'db inventory filters rag infra tables')
assert(/库存文档：/.test(catalogs) && /规范\.docx/.test(catalogs), 'rag catalog shows inventory')
assert(/本轮命中：无/.test(catalogs), 'empty hits still show inventory')

console.log('smoke: db/rag passthrough protocol ok')
