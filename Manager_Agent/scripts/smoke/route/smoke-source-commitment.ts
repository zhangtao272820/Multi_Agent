/**
 * 意图清晰度契约离线 smoke + 可选联机（有 OPENAI_API_KEY 且未 SKIP 才跑）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  coerceSourceCommitment,
  shouldClarifyForAmbiguousCommitment,
  shouldClarifyForNoInventoryCoverage,
  shouldLockPlaneCoverageFlip,
  shouldSkipAdminApiCrawlerRematerialize,
  sourceCommitmentFromRaw,
  formatSourceCommitmentPromptRule
} from '../../../server/graph/orchestrate/sourceCommitment'
import { rematerializeWeatherCrawlerMisbind, rematerializeWeatherCrawlerPlanSteps } from '../../../server/graph/orchestrate/weatherAdminBoundary'
import { rematerializeMapCrawlerPlanSteps } from '../../../server/graph/orchestrate/mapAdminBoundary'
import {
  isClearSolePlaneNoWeb,
  stripUnboundCrawlerArtifacts
} from '../../../server/graph/orchestrate/stripUnboundCrawler'
import { enforceWebCommitmentOnAlign } from '../../../server/graph/llm/userIntentAlignLlm'
import { assembleOrchestratorSystemPrompt } from '../../../server/graph/llm/orchestratorPromptProfiles'
import { parseOrchestratorPayloadForTest } from '../../../server/graph/llm/taskOrchestrator'
import { findPromptHygieneViolations } from '../../../agent-repo-shared/promptHygiene'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-source-commitment] ${msg}`)
}

assert(coerceSourceCommitment('clear') === 'clear', 'coerce clear')
assert(coerceSourceCommitment('AMBIGUOUS') === 'ambiguous', 'coerce ambiguous')
assert(coerceSourceCommitment('x') === 'none', 'coerce fallback none')

const clearDb = sourceCommitmentFromRaw({
  sourceCommitment: 'clear',
  committedPlanes: ['db']
})
assert(shouldLockPlaneCoverageFlip(clearDb), 'clear db locks flip')
assert(!shouldSkipAdminApiCrawlerRematerialize(clearDb), 'clear db does not skip weather')

const clearWeb = sourceCommitmentFromRaw({
  sourceCommitment: 'clear',
  committedPlanes: ['crawler'],
  webFetchKind: 'general_page'
})
assert(shouldSkipAdminApiCrawlerRematerialize(clearWeb), 'clear crawler skips weather rematerialize')

const amb = sourceCommitmentFromRaw({ sourceCommitment: 'ambiguous' })
assert(shouldClarifyForAmbiguousCommitment(amb), 'ambiguous clarifies')

assert(
  shouldClarifyForNoInventoryCoverage({
    slice: clearDb,
    proposedPlane: 'db',
    dbCanAnswer: false,
    ragCanAnswer: true
  }),
  'clear db no inventory → clarify even if rag can answer'
)

const rule = formatSourceCommitmentPromptRule()
assert(rule.includes('sourceCommitment'), 'prompt rule mentions field')
assert(rule.includes('ambiguous'), 'prompt rule mentions ambiguous')
assert(findPromptHygieneViolations(rule).length === 0, 'commitment rule hygiene clean')

const sys = assembleOrchestratorSystemPrompt({})
assert(sys.includes('sourceCommitment'), 'system prompt mounts commitment rule')
assert(sys.includes('意图清晰度'), 'system prompt has clarity section')

const classifyStub = {
  dataSources: ['crawler'],
  primaryIntent: 'crawler',
  isMulti: false,
  suggestedAgents: ['crawler'],
  isDbAnchored: false,
  needsAdmin: false,
  needsWeb: true,
  explicitWantsReport: false,
  explicitWantsVisualize: false,
  planShortcut: 'none',
  requiresAgentPipeline: false,
  allowChatWebDirect: true,
  confidence: 0.8,
  rationale: 'test'
} as any

const webWeather = rematerializeWeatherCrawlerMisbind({
  allowedAgents: ['crawler'] as any,
  clauses: [{ id: 'c1', text: '联网搜索天津今天天气怎么样', agents: ['crawler'] }] as any,
  classify: classifyStub,
  planBlueprint: {
    rationale: '',
    steps: [{ agent: 'crawler', queryFocus: '联网搜索天津今天天气' }],
    confidence: 0.8
  } as any,
  needsWebSearch: true,
  sourceCommitmentRaw: {
    sourceCommitment: 'clear',
    committedPlanes: ['crawler'],
    webFetchKind: 'general_page'
  }
})
assert(!webWeather.changed, 'clear web weather must not rematerialize to admin')
assert(webWeather.allowedAgents.map(String).includes('crawler'), 'keeps crawler')

const defaultWeather = rematerializeWeatherCrawlerMisbind({
  allowedAgents: ['crawler'] as any,
  clauses: [{ id: 'c1', text: '今天天津天气怎么样', agents: ['crawler'] }] as any,
  classify: { ...classifyStub },
  planBlueprint: {
    rationale: '',
    steps: [{ agent: 'crawler', queryFocus: '今天天津天气怎么样' }],
    confidence: 0.8
  } as any,
  needsWebSearch: true,
  sourceCommitmentRaw: { sourceCommitment: 'none', committedPlanes: [], webFetchKind: 'none' }
})
assert(defaultWeather.changed, 'default weather rematerializes crawler→admin')
assert(defaultWeather.allowedAgents.map(String).includes('admin'), 'default weather → admin')
assert(!defaultWeather.allowedAgents.map(String).includes('crawler'), 'default weather strips crawler')

// Plan 出口与编排侧同一谓词：清晰公网锁时不得改绑 admin
const lockedPlan = [
  { id: 's1', agent: 'crawler', query: '联网搜索天津今天天气怎么样' }
]
const planKeep = rematerializeWeatherCrawlerPlanSteps(lockedPlan, {
  sourceCommitment: 'clear',
  committedPlanes: ['crawler'],
  webFetchKind: 'general_page'
})
assert(planKeep[0]!.agent === 'crawler', 'plan exit keeps crawler under web lock')
const planFlip = rematerializeWeatherCrawlerPlanSteps(lockedPlan, {
  sourceCommitment: 'none',
  webFetchKind: 'none'
})
assert(planFlip[0]!.agent === 'admin', 'plan exit rematerializes weather crawler→admin without lock')
const mapKeep = rematerializeMapCrawlerPlanSteps(
  [{ id: 's1', agent: 'crawler', query: '网上查天津西站到天津站地铁多久' }],
  { sourceCommitment: 'clear', committedPlanes: ['crawler'], webFetchKind: 'general_page' }
)
assert(mapKeep[0]!.agent === 'crawler', 'plan exit map keeps crawler under web lock')

// ambiguous 不得 skip align/planeCoverage
assert(
  !isClearSolePlaneNoWeb({
    allowedAgents: ['db'],
    planShortcut: 'db_only',
    sourceCommitmentRaw: { sourceCommitment: 'ambiguous' }
  }),
  'ambiguous must not skip post-orch LLM'
)
assert(
  isClearSolePlaneNoWeb({
    allowedAgents: ['db'],
    planShortcut: 'db_only',
    sourceCommitmentRaw: { sourceCommitment: 'clear', committedPlanes: ['db'] }
  }),
  'clear db_only may skip'
)

// strip：幽灵蓝图 crawler 剥掉；composite 确认则保留
const ghostStrip = stripUnboundCrawlerArtifacts({
  allowedAgents: ['rag', 'db', 'crawler', 'report'] as any,
  clauses: [
    { id: 'c1', text: '知识库查高龄津贴', agents: ['rag'] },
    { id: 'c2', text: '数据库查性别分布', agents: ['db'] }
  ] as any,
  classify: { ...classifyStub, needsWeb: true, dataSources: ['rag', 'db', 'crawler'] },
  planBlueprint: {
    rationale: '',
    confidence: 0.7,
    steps: [
      { agent: 'rag', queryFocus: '津贴' },
      { agent: 'crawler', queryFocus: '整段用户原话' },
      { agent: 'report', queryFocus: '报告' }
    ]
  } as any,
  sourceCommitmentRaw: { sourceCommitment: 'clear', committedPlanes: ['rag', 'db'], webFetchKind: 'none' }
})
assert(ghostStrip.changed, 'E2 ghost strip changes')
assert(!ghostStrip.allowedAgents.map(String).includes('crawler'), 'E2 ghost strips crawler')
assert(!(ghostStrip.planBlueprint?.steps ?? []).some((s) => s.agent === 'crawler'), 'E2 ghost strips bp crawler')

const compositeKeep = stripUnboundCrawlerArtifacts({
  allowedAgents: ['db', 'crawler', 'report'] as any,
  clauses: [{ id: 'c1', text: '查库内记录', agents: ['db'] }] as any,
  classify: { ...classifyStub, needsWeb: true, dataSources: ['db', 'crawler'] },
  planBlueprint: null,
  sourceCommitmentRaw: { sourceCommitment: 'clear', committedPlanes: ['db'], webFetchKind: 'none' },
  compositeDataWebRoute: true
})
assert(!compositeKeep.changed, 'compositeDataWebRoute keeps crawler without clause bind')
assert(compositeKeep.allowedAgents.map(String).includes('crawler'), 'composite keep crawler')

// Align 硬闸：不得把公网锁改成 admin
const alignLocked = enforceWebCommitmentOnAlign(
  {
    allowedAgents: ['crawler'],
    clauses: [{ id: 'c1', text: '联网搜天津天气', agents: ['crawler'] }],
    intentClassify: classifyStub,
    raw: {
      sourceCommitment: 'clear',
      committedPlanes: ['crawler'],
      webFetchKind: 'general_page'
    },
    coalescedTask: '联网搜天津天气',
    routedQuery: '联网搜天津天气'
  } as any,
  {
    allowedAgents: ['admin'],
    clauses: [{ id: 'c1', text: '联网搜天津天气', agents: ['admin'] }],
    dataSources: [],
    isDbAnchored: false,
    needsAdmin: true,
    needsWeb: false,
    rationale: 'bad flip'
  }
)
assert(alignLocked.allowedAgents.includes('crawler'), 'align enforce keeps crawler')
assert(alignLocked.needsWeb === true, 'align enforce needsWeb')
assert(
  alignLocked.clauses.some((c) => (c.agents ?? []).includes('crawler')),
  'align enforce restores crawler clause'
)

const ambBundle = parseOrchestratorPayloadForTest(
  {
    clauses: [{ id: 'c1', text: '老人怎么样啊帮我看看', agents: [] }],
    allowedAgents: ['db'],
    suggestedAgents: ['db'],
    routedQuery: '老人怎么样啊帮我看看',
    sourceCommitment: 'ambiguous',
    committedPlanes: [],
    dataSources: ['db'],
    primaryIntent: 'db',
    intent: 'db',
    isMulti: false,
    planShortcut: 'db_only'
  },
  '老人怎么样啊帮我看看'
)
assert(ambBundle, 'ambiguous payload parses')
assert(ambBundle!.needsClarify === true, 'ambiguous → needsClarify')
assert(ambBundle!.clarifyKind === 'plane', 'ambiguous → plane')

const stackSrc = fs.readFileSync(
  path.join(repoRoot, 'server/graph/core/proPuStack/stackInfer.ts'),
  'utf8'
)
assert(!stackSrc.includes('护理员配比'), 'stackInfer no 护理员配比')
assert(!stackSrc.includes('民政部'), 'stackInfer no 民政部')

const goldenPath = path.join(repoRoot, 'eval/golden-real-domain-route.json')
assert(fs.existsSync(goldenPath), 'golden-real-domain-route.json exists')

console.log('smoke-source-commitment: offline ok')

const apiKey = String(process.env.OPENAI_API_KEY ?? '').trim()
const skipLlm = String(process.env.MANAGER_SMOKE_SKIP_LLM ?? '') === '1'
if (!apiKey || skipLlm) {
  console.log('smoke-source-commitment: skip live (no OPENAI_API_KEY or MANAGER_SMOKE_SKIP_LLM=1)')
  console.log('smoke-source-commitment: ok')
  process.exit(0)
}

// 联机：复用 pro-understand 同款 ChatOpenAI 薄封装，抽检 A1/B1/C3 + 天气对照
const { ChatOpenAI } = await import('@langchain/openai')
const { resolveTaskOrchestrationByLlm } = await import(
  '../../../server/graph/llm/taskOrchestrator/resolve'
)
const { applyOrchestratorInvariants } = await import(
  '../../../server/graph/orchestrate/orchestratorInvariants'
)

process.env.MANAGER_ROUTE_MODE ??= 'convergence'
process.env.MANAGER_LLM_FIRST_ROUTE ??= '1'
process.env.MANAGER_PRO_MODE ??= 'strong'

const modelName = String(process.env.MANAGER_MODEL_ROUTE ?? process.env.OPENAI_MODEL ?? 'qwen-plus').trim()
const baseURL = String(process.env.OPENAI_BASE_URL ?? '').trim() || undefined
const llm = new ChatOpenAI({
  model: modelName,
  apiKey,
  configuration: baseURL ? { baseURL } : undefined,
  temperature: 0
})
const llmInvoke = async (_role: string, _state: unknown, messages: unknown) => {
  const res = await llm.invoke(messages as any)
  return { text: String((res as any)?.content ?? '') }
}

const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as {
  cases: Array<{ id: string; user: string; expectCap: string[] }>
}

const liveCases: Array<{
  id: string
  user: string
  mustInclude?: string[]
  mustExclude?: string[]
  expectClarify?: boolean
}> = [
  ...golden.cases
    .filter((c) => ['A1', 'B1', 'C3'].includes(c.id))
    .map((c) => ({ id: c.id, user: c.user, mustInclude: c.expectCap })),
  {
    id: 'SC_WEB_WEATHER',
    user: '请联网搜索一下天津今天的天气情况',
    mustInclude: ['crawler'],
    mustExclude: ['admin']
  },
  {
    id: 'SC_DEFAULT_WEATHER',
    user: '今天天津天气怎么样',
    mustInclude: ['admin'],
    mustExclude: ['crawler']
  },
  { id: 'SC_AMBIGUOUS', user: '老人怎么样', expectClarify: true }
]

const strict = String(process.env.MANAGER_LIVE_ROUTE_STRICT ?? '1') !== '0'
let fails = 0

for (const c of liveCases) {
  const orch = await resolveTaskOrchestrationByLlm({
    messages: [],
    lastUser: c.user,
    routingContext: c.user,
    llmInvoke: llmInvoke as any,
    state: { meta: {} }
  })
  if (!orch.bundle) {
    console.warn(`live ${c.id}: orchestrator null`)
    fails += 1
    continue
  }
  const decision = applyOrchestratorInvariants({
    bundle: orch.bundle,
    turnScope: { lastOnly: c.user, routingContext: c.user, mode: 'current_only' } as any,
    state: { meta: {} }
  })
  const cap = decision.allowedAgents.map(String)
  if (c.expectClarify) {
    if (!decision.needsClarify) {
      console.warn(`live ${c.id}: expected clarify, got cap=${cap.join(',')}`)
      fails += 1
    } else console.log(`live ${c.id}: clarify ok`)
    continue
  }
  const missing = (c.mustInclude ?? []).filter((a) => !cap.includes(a))
  const banned = (c.mustExclude ?? []).filter((a) => cap.includes(a))
  if (missing.length || banned.length) {
    console.warn(
      `live ${c.id}: cap=[${cap.join(',')}] missing=${missing.join('|')} banned=${banned.join('|')}`
    )
    fails += 1
  } else console.log(`live ${c.id}: ok cap=[${cap.join(',')}]`)
}

if (fails > 0 && strict) throw new Error(`smoke-source-commitment live fails=${fails}`)
if (fails > 0) console.warn(`smoke-source-commitment: live soft fails=${fails}`)
console.log('smoke-source-commitment: ok')
