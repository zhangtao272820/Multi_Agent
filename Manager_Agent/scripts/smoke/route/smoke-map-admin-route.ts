/**
 * 地图/出行须走 admin（get_travel_route），禁止 crawler — 契约重绑 + 提示对齐
 * 对应用户失败：帮我查一下坐地铁从天津西站到天津站大概多久 → crawler+admin 双步
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatAdminCrawlerDisambiguationPrompt,
  formatAgentBoundaryPrompt
} from '../../../server/graph/orchestrate/unifiedRouting'
import {
  rematerializeMapCrawlerMisbind,
  rematerializeMapCrawlerPlanSteps,
  lintMapBoundToCrawler,
  textLooksLikeAdminMapCapability
} from '../../../server/graph/orchestrate/mapAdminBoundary'
import {
  lintOrchestratorBundle,
  orchestratorLintSeverity
} from '../../../server/graph/orchestrate/orchestratorStructuralLint'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-map-admin-route] ${msg}`)
}

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

const A2 = '帮我查一下坐地铁从天津西站到天津站大概多久'

const boundary = formatAgentBoundaryPrompt()
assert(boundary.includes('get_travel_route') || boundary.includes('地图'), 'boundary mentions map/admin')
assert(boundary.includes('禁止') || boundary.includes('不是 crawler'), 'boundary distinguishes crawler')

const disambig = formatAdminCrawlerDisambiguationPrompt()
assert(disambig.includes('地铁') || disambig.includes('多久'), 'disambig mentions travel')
assert(disambig.includes('查一下'), 'disambig: 查一下 still admin')

const adminCapSrc = readSource('shared/adminCapabilities.ts')
assert(adminCapSrc.includes('get_travel_route'), 'admin SSOT has get_travel_route')
assert(adminCapSrc.includes('地铁'), 'admin SSOT has 地铁 routeTerm')

const alignSrc = readSource('Manager_Agent/server/graph/llm/userIntentAlignLlm.ts')
assert(alignSrc.includes('地铁') || alignSrc.includes('出行'), 'align mentions travel→admin')

const judgeSrc = readSource('Manager_Agent/server/graph/llm/orchestratorJudgeLlm.ts')
assert(judgeSrc.includes('get_travel_route') || judgeSrc.includes('地铁'), 'judge checks map→admin')

assert(textLooksLikeAdminMapCapability(A2), 'A2 map text detected')
assert(textLooksLikeAdminMapCapability('坐地铁从天津西站到天津站大概多久'), 'travel without 查一下')
assert(!textLooksLikeAdminMapCapability('民政部官网补贴政策网页正文'), 'policy web not map')

const templatedMap =
  '从公开网页采集与任务相关、可引用的客观信息：坐地铁从天津西站到天津站大概多久'
assert(
  textLooksLikeAdminMapCapability(templatedMap),
  `template+map must count as admin map: ${templatedMap}`
)

// 截图同构：crawler 模板步 + admin 出行步
const screenshotFixed = rematerializeMapCrawlerMisbind({
  allowedAgents: ['crawler', 'admin'] as any,
  clauses: [
    { id: 'c1', text: templatedMap, agents: ['crawler'] },
    { id: 'c2', text: A2, agents: ['admin'] }
  ] as any,
  classify: {
    dataSources: ['crawler'],
    primaryIntent: 'multi',
    isMulti: true,
    suggestedAgents: ['crawler', 'admin'],
    isDbAnchored: false,
    needsAdmin: true,
    needsWeb: true,
    explicitWantsReport: false,
    explicitWantsVisualize: false,
    planShortcut: 'none',
    requiresAgentPipeline: false,
    allowChatWebDirect: false,
    confidence: 0.8,
    rationale: 'test'
  } as any,
  planBlueprint: {
    rationale: 'ui',
    steps: [
      { agent: 'crawler', queryFocus: templatedMap },
      { agent: 'admin', queryFocus: '坐地铁从天津西站到天津站大概多久' }
    ]
  } as any,
  needsWebSearch: true
})
assert(screenshotFixed.changed, 'screenshot dual-step rematerialize changes')
assert(!screenshotFixed.allowedAgents.map(String).includes('crawler'), 'screenshot: drop crawler from cap')
assert(screenshotFixed.allowedAgents.map(String).includes('admin'), 'screenshot: keep admin')
assert(screenshotFixed.classify.needsWeb === false, 'screenshot: needsWeb false')
assert(
  !(screenshotFixed.planBlueprint?.steps ?? []).some((s) => String(s.agent) === 'crawler'),
  'screenshot: blueprint no crawler'
)
const adminSteps = (screenshotFixed.planBlueprint?.steps ?? []).filter((s) => String(s.agent) === 'admin')
assert(adminSteps.length === 1, `screenshot: single admin step, got ${adminSteps.length}: ${JSON.stringify(adminSteps)}`)
assert(
  !(screenshotFixed.planBlueprint?.steps ?? []).some((s) =>
    String(s.queryFocus || '').includes('从公开网页采集')
  ),
  'screenshot: admin focus must drop crawler template noise'
)

const planFixed = rematerializeMapCrawlerPlanSteps([
  { id: 's1', agent: 'crawler', query: templatedMap },
  { id: 's2', agent: 'admin', query: A2 }
])
assert(!planFixed.some((s) => String(s.agent) === 'crawler'), `plan steps drop map crawler: ${JSON.stringify(planFixed)}`)
assert(
  planFixed.filter((s) => String(s.agent) === 'admin').length === 1,
  `plan steps single admin: ${JSON.stringify(planFixed)}`
)

const lintBefore = lintMapBoundToCrawler({
  clauses: [{ id: 'c1', text: A2, agents: ['crawler'] }] as any,
  planBlueprint: {
    rationale: 't',
    steps: [{ agent: 'crawler', queryFocus: A2 }]
  } as any
})
assert(lintBefore.length >= 1, `lint should flag map→crawler: ${lintBefore.join(';')}`)
assert(lintBefore.some((i) => i.includes('get_travel_route') || i.includes('admin')), 'lint mentions admin')

const fixed = rematerializeMapCrawlerMisbind({
  allowedAgents: ['crawler', 'admin'] as any,
  clauses: [{ id: 'c1', text: A2, agents: ['crawler'] }] as any,
  classify: {
    dataSources: ['crawler'],
    primaryIntent: 'admin',
    isMulti: false,
    suggestedAgents: ['crawler', 'admin'],
    isDbAnchored: false,
    needsAdmin: true,
    needsWeb: true,
    explicitWantsReport: false,
    explicitWantsVisualize: false,
    planShortcut: 'admin_only',
    requiresAgentPipeline: false,
    allowChatWebDirect: false,
    confidence: 0.9,
    rationale: 'test'
  } as any,
  planBlueprint: {
    rationale: 't',
    steps: [{ agent: 'crawler', queryFocus: A2 }]
  } as any,
  stepDispatchDraft: [{ agent: 'crawler', scopedUserLanguage: A2 }] as any,
  needsWebSearch: true
})
assert(fixed.changed, 'A2 rematerialize changes')
assert(!fixed.allowedAgents.map(String).includes('crawler'), 'A2 cap drop crawler')
assert(fixed.needsWebSearch === false, 'A2 needsWebSearch false')
assert(fixed.clauses[0]?.agents?.includes('admin' as any), 'A2 clause→admin')
assert(String((fixed.stepDispatchDraft ?? [])[0]?.agent) === 'admin', 'A2 draft→admin')

const lintAfter = lintOrchestratorBundle({
  userTask: A2,
  allowedAgents: fixed.allowedAgents.map(String),
  clauses: fixed.clauses as any,
  classify: fixed.classify,
  planBlueprint: fixed.planBlueprint
})
assert(
  !lintAfter.some((i) => i.includes('地图/出行') || i.includes('get_travel_route')),
  `lint clean after fix: ${lintAfter.join(';')}`
)
assert(orchestratorLintSeverity(lintBefore) === 'fail', 'pre-fix lint is critical fail')

// 负例：真政策网页不得重绑
const policyKeep = rematerializeMapCrawlerMisbind({
  allowedAgents: ['crawler'] as any,
  clauses: [{ id: 'c1', text: '民政部官网最新地铁建设补贴政策网页正文', agents: ['crawler'] }] as any,
  classify: {
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
    allowChatWebDirect: false,
    confidence: 0.8,
    rationale: 'test'
  } as any,
  planBlueprint: {
    rationale: 't',
    steps: [{ agent: 'crawler', queryFocus: '民政部官网最新地铁建设补贴政策网页正文' }]
  } as any,
  needsWebSearch: true
})
assert(!policyKeep.changed, `policy web must keep crawler: ${JSON.stringify(policyKeep.planBlueprint?.steps)}`)
assert(policyKeep.allowedAgents.map(String).includes('crawler'), 'policy keep crawler cap')

const invSrc = readSource('Manager_Agent/server/graph/orchestrate/orchestratorInvariants.ts')
assert(invSrc.includes('rematerializeMapCrawlerMisbind'), 'invariants wire map rematerialize')
const pipeSrc = readSource('Manager_Agent/server/graph/orchestrate/orchestratorPipeline.ts')
assert(pipeSrc.includes('rematerializeMapCrawlerMisbind'), 'pipeline wire map rematerialize')

console.log('smoke-map-admin-route: OK')
