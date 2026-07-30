/**
 * 天气预报须走 admin（get_weather），禁止 crawler — 静态契约 + 对齐 LLM 提示 + 重绑
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatAdminCrawlerDisambiguationPrompt,
  formatAgentBoundaryPrompt
} from '../../../server/graph/orchestrate/unifiedRouting'
import {
  rematerializeWeatherCrawlerMisbind,
  rematerializeWeatherCrawlerPlanSteps,
  lintWeatherBoundToCrawler,
  textLooksLikeAdminWeatherCapability
} from '../../../server/graph/orchestrate/weatherAdminBoundary'
import {
  lintOrchestratorBundle,
  orchestratorLintSeverity
} from '../../../server/graph/orchestrate/orchestratorStructuralLint'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-weather-admin-route] ${msg}`)
}

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

const boundary = formatAgentBoundaryPrompt()
assert(boundary.includes('get_weather'), 'boundary mentions get_weather')
assert(boundary.includes('禁止') && boundary.includes('crawler'), 'boundary forbids crawler for weather')

const disambig = formatAdminCrawlerDisambiguationPrompt()
assert(disambig.includes('get_weather'), 'disambig mentions get_weather')

const adminCapSrc = readSource('shared/adminCapabilities.ts')
assert(adminCapSrc.includes('get_weather'), 'admin SSOT has get_weather')
assert(adminCapSrc.includes("intent: '天气'"), 'admin SSOT has weather intent group')

const orchSrc = readSource('Manager_Agent/server/graph/llm/orchestratorPromptProfiles.ts')
assert(orchSrc.includes('RAG+DB+天气+简报'), 'orchestrator has weather compound example')
assert(orchSrc.includes('gui_interact') || orchSrc.includes('ORCH_PACK:gui_interact'), 'orchestrator has gui_interact pack')

const alignSrc = readSource('Manager_Agent/server/graph/llm/userIntentAlignLlm.ts')
assert(alignSrc.includes('formatAdminCrawlerDisambiguationPrompt'), 'user intent align uses disambig prompt')
assert(alignSrc.includes('知识库查'), 'align forbids crawler mirror of KB/DB')

const judgeSrc = readSource('Manager_Agent/server/graph/llm/orchestratorJudgeLlm.ts')
assert(judgeSrc.includes('get_weather'), 'judge checks weather→admin')
assert(judgeSrc.includes('显式知识库') || judgeSrc.includes('知识库查'), 'judge forbids KB→crawler mirror')

assert(textLooksLikeAdminWeatherCapability('查一下天津明天的天气怎么样'), 'weather text detected')
assert(!textLooksLikeAdminWeatherCapability('民政部官网补贴政策网页正文'), 'policy web not weather')

// Planner 模板套话「从公开网页采集…」不得挡住天气重绑（线上失败根因）
const templatedWeather =
  '从公开网页采集与任务相关、可引用的客观信息：并查一下天津明天的天气怎么样'
assert(
  textLooksLikeAdminWeatherCapability(templatedWeather),
  `template+weather must count as admin weather: ${templatedWeather}`
)

const templatedFixed = rematerializeWeatherCrawlerMisbind({
  allowedAgents: ['rag', 'db', 'crawler', 'clean', 'code', 'admin', 'visualize', 'report'] as any,
  clauses: [
    { id: 'c1', text: '知识库查失能老人补贴和高龄津贴标准', agents: ['rag'] },
    { id: 'c2', text: '数据库查河西区70-79岁老人性别分布', agents: ['db'] },
    { id: 'c3', text: templatedWeather, agents: ['crawler'] },
    { id: 'c4', text: '写一份对比报告', agents: ['report'] }
  ] as any,
  classify: {
    dataSources: ['rag', 'db', 'crawler'],
    primaryIntent: 'multi',
    isMulti: true,
    suggestedAgents: ['rag', 'db', 'crawler', 'admin'],
    isDbAnchored: true,
    needsAdmin: true,
    needsWeb: true,
    explicitWantsReport: true,
    explicitWantsVisualize: false,
    planShortcut: 'none',
    requiresAgentPipeline: true,
    allowChatWebDirect: false,
    confidence: 0.8,
    rationale: 'test'
  } as any,
  planBlueprint: {
    rationale: 'ui',
    steps: [
      { agent: 'rag', queryFocus: '检索补贴标准' },
      { agent: 'db', queryFocus: '查性别分布' },
      { agent: 'crawler', queryFocus: templatedWeather },
      { agent: 'admin', queryFocus: '记录本次任务执行状态及天气查询结果（作为元数据归档）' },
      { agent: 'report', queryFocus: '撰写对比报告' }
    ]
  } as any,
  needsWebSearch: true
})
assert(templatedFixed.changed, 'templated weather rematerialize changes')
assert(!templatedFixed.allowedAgents.map(String).includes('crawler'), 'templated: drop crawler from cap')
assert(
  !(templatedFixed.planBlueprint?.steps ?? []).some((s) => String(s.agent) === 'crawler'),
  'templated: blueprint no crawler'
)
assert(
  (templatedFixed.planBlueprint?.steps ?? []).some(
    (s) => String(s.agent) === 'admin' && String(s.queryFocus || '').includes('天气')
  ),
  `templated: admin weather focus: ${JSON.stringify(templatedFixed.planBlueprint?.steps)}`
)
assert(
  !(templatedFixed.planBlueprint?.steps ?? []).some((s) =>
    String(s.queryFocus || '').includes('从公开网页采集')
  ),
  'templated: admin focus must drop crawler template noise'
)

// 计划步级硬闸：Planner 产出「搜索并获取天津明天的天气」crawler 步 → admin
const planFixed = rematerializeWeatherCrawlerPlanSteps([
  { id: 's1', agent: 'rag', query: '检索补贴标准' },
  { id: 's2', agent: 'db', query: '查性别分布' },
  { id: 's3', agent: 'crawler', query: '搜索并获取天津明天的天气信息' },
  { id: 's4', agent: 'admin', query: '记录本次任务执行状态及天气查询结果（作为元数据归档）' },
  { id: 's5', agent: 'report', query: '撰写对比报告' }
])
assert(
  !planFixed.some((s) => String(s.agent) === 'crawler'),
  `plan steps must drop weather crawler: ${JSON.stringify(planFixed)}`
)
assert(
  planFixed.some((s) => String(s.agent) === 'admin' && String(s.query).includes('天气')),
  `plan steps must keep weather admin: ${JSON.stringify(planFixed)}`
)
assert(
  !planFixed.some((s) => String(s.query || '').includes('元数据归档')),
  `shell admin should be dropped when weather admin exists: ${JSON.stringify(planFixed)}`
)

// 截图同构：rag + db + crawler(天气误绑) + report
const misboundClauses = [
  { id: 'c1', text: '知识库查失能老人补贴和高龄津贴标准', agents: ['rag' as const] },
  { id: 'c2', text: '数据库查询河西区70-79岁老人性别分布', agents: ['db' as const] },
  { id: 'c3', text: '查一下天津明天的天气怎么样', agents: ['crawler' as const] },
  { id: 'c4', text: '写一份对比报告', agents: ['report' as const] }
]
const misboundBp = {
  rationale: 'test',
  steps: [
    { agent: 'rag' as const, queryFocus: '检索补贴标准' },
    { agent: 'db' as const, queryFocus: '查河西区性别分布' },
    { agent: 'crawler' as const, queryFocus: '搜索并获取天津明天的天气情况' },
    { agent: 'admin' as const, queryFocus: '记录执行状态和天气结果到系统日志' },
    { agent: 'report' as const, queryFocus: '撰写对比报告' }
  ]
}

const lintBefore = lintWeatherBoundToCrawler({ clauses: misboundClauses, planBlueprint: misboundBp })
assert(lintBefore.length >= 1, `lint should flag weather→crawler: ${lintBefore.join(';')}`)
assert(lintBefore.some((i) => i.includes('get_weather') || i.includes('admin')), 'lint mentions admin/get_weather')

const fixed = rematerializeWeatherCrawlerMisbind({
  allowedAgents: ['rag', 'db', 'crawler', 'clean', 'code', 'admin', 'visualize', 'report'] as any,
  clauses: misboundClauses as any,
  classify: {
    dataSources: ['rag', 'db', 'crawler'],
    primaryIntent: 'multi',
    isMulti: true,
    suggestedAgents: ['rag', 'db', 'crawler', 'admin'],
    isDbAnchored: true,
    needsAdmin: true,
    needsWeb: true,
    explicitWantsReport: true,
    explicitWantsVisualize: false,
    planShortcut: 'none',
    requiresAgentPipeline: true,
    allowChatWebDirect: false,
    confidence: 0.8,
    rationale: 'test'
  } as any,
  planBlueprint: misboundBp as any,
  stepDispatchDraft: [
    { agent: 'rag', scopedUserLanguage: '知识库查补贴' },
    { agent: 'db', scopedUserLanguage: '数据库查性别分布' },
    { agent: 'crawler', scopedUserLanguage: '天津明天的天气怎么样' },
    { agent: 'admin', scopedUserLanguage: '记录执行状态' }
  ] as any,
  needsWebSearch: true
})

assert(fixed.changed, 'rematerialize should change')
assert(!fixed.allowedAgents.map(String).includes('crawler'), `cap must drop crawler: ${fixed.allowedAgents}`)
assert(fixed.allowedAgents.map(String).includes('admin'), 'cap must keep admin')
assert(fixed.classify.needsWeb === false, 'needsWeb false after weather rematerialize')
assert(!(fixed.classify.dataSources ?? []).includes('crawler'), 'dataSources drop crawler')
assert(fixed.needsWebSearch === false, 'needsWebSearch false')

const weatherClause = fixed.clauses.find((c) => String(c.text).includes('天气'))
assert(weatherClause?.agents?.includes('admin' as any), `weather clause→admin: ${JSON.stringify(weatherClause)}`)
assert(!weatherClause?.agents?.includes('crawler' as any), 'weather clause no crawler')

assert(
  !(fixed.planBlueprint?.steps ?? []).some((s) => String(s.agent) === 'crawler'),
  `blueprint no crawler: ${JSON.stringify(fixed.planBlueprint?.steps)}`
)
const adminWeatherStep = (fixed.planBlueprint?.steps ?? []).find(
  (s) => String(s.agent) === 'admin' && String(s.queryFocus || '').includes('天气')
)
assert(adminWeatherStep, `blueprint admin weather step: ${JSON.stringify(fixed.planBlueprint?.steps)}`)

const draftWeather = (fixed.stepDispatchDraft ?? []).find((d) =>
  String(d.scopedUserLanguage || '').includes('天气')
)
assert(String(draftWeather?.agent) === 'admin', `draft weather→admin: ${JSON.stringify(draftWeather)}`)

const lintAfter = lintOrchestratorBundle({
  userTask:
    '知识库查失能老人补贴和高龄津贴标准，数据库查询河西区70-79岁老人性别分布，写一份对比报告。并查一下天津明天的天气怎么样',
  allowedAgents: fixed.allowedAgents.map(String),
  clauses: fixed.clauses as any,
  classify: fixed.classify,
  planBlueprint: fixed.planBlueprint
})
assert(
  !lintAfter.some((i) => i.includes('须改 admin') || i.includes('天气预报语义')),
  `lint clean after fix: ${lintAfter.join(';')}`
)
assert(orchestratorLintSeverity(lintBefore) === 'fail', 'pre-fix lint is critical fail')

const invSrc = readSource('Manager_Agent/server/graph/orchestrate/orchestratorInvariants.ts')
assert(invSrc.includes('rematerializeWeatherCrawlerMisbind'), 'invariants wire rematerialize')

console.log('smoke-weather-admin-route: OK')
