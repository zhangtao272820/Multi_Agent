/**
 * P0-E：GUI vs 爬虫路由结构 smoke（无 LLM 调用）
 * 含 prompt 契约：边界/网页执行模式文案须区分「点击→gui」与「有 URL≠crawl_direct」。
 */
import {
  applyWebExecutionModeToRoute,
  formatWebExecutionModeSystemPrompt
} from '../../../server/utils/search/managerWebExecutionModeLlm'
import { agentsForWebExecutionHeuristic } from '../../../server/utils/gui/managerGuiAgentAvailability'
import { isCrawlerRequireSerpEnabled } from '../../../server/utils/crawler/managerCrawlerSerpEnhance'
import { applyOrchestratorWebRoutePatch } from '../../../server/graph/orchestrate/orchestratorWebExecutionAlign'
import {
  formatAgentBoundaryPrompt,
  formatGuiCrawlerDisambiguationPrompt
} from '../../../server/graph/orchestrate/unifiedRouting'

process.env.LOBSTER_AGENT_WS_URL = 'ws://localhost:13108/_ws'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const g1 = '去百度搜索 LangGraph 并打开第一个结果'
const g2 = '打开百度搜索「Python 教程」，提取第一条结果'
const guiMode = {
  mode: 'gui' as const,
  primaryAgent: 'gui' as const,
  needsWebSearch: false,
  serpSummaryEnough: false,
  confidence: 0.92,
  rationale: 'browser open first result'
}

const allowed = agentsForWebExecutionHeuristic(['crawler'], {
  agents: [{ agent: 'gui', status: 'healthy' }]
})
assert(allowed.includes('gui'), 'heuristic must include gui')

const routed = applyWebExecutionModeToRoute({
  intent: 'crawler',
  allowedAgents: allowed,
  llmNeedsWebSearch: true,
  mode: guiMode
})
assert(routed.intent === 'gui', `G1 intent must be gui: ${routed.intent}`)
assert(routed.allowedAgents.includes('gui'), `G1 allowed must include gui: ${routed.allowedAgents.join(',')}`)
assert(!routed.allowedAgents.includes('crawler'), `G1 must not keep crawler: ${routed.allowedAgents.join(',')}`)
assert(routed.llmNeedsWebSearch === false, 'gui mode needsWebSearch false')

const g2Mode = {
  mode: 'gui' as const,
  primaryAgent: 'gui' as const,
  needsWebSearch: false,
  serpSummaryEnough: false,
  confidence: 0.91,
  rationale: 'baidu search and extract first in browser'
}
const g2Routed = applyWebExecutionModeToRoute({
  intent: 'multi',
  allowedAgents: ['crawler'],
  llmNeedsWebSearch: true,
  mode: g2Mode
})
assert(g2Routed.intent === 'gui', `G2 intent must be gui: ${g2Routed.intent}`)
assert(g2Routed.allowedAgents.includes('gui'), 'G2 allowed must include gui')
assert(!g2Routed.allowedAgents.includes('crawler'), 'G2 must not keep crawler')
assert(g2Routed.llmNeedsWebSearch === false, 'G2 gui mode needsWebSearch false')
void g2

const crawlMode = applyWebExecutionModeToRoute({
  intent: 'multi',
  allowedAgents: ['db', 'crawler'],
  llmNeedsWebSearch: true,
  mode: {
    mode: 'search_then_crawl',
    primaryAgent: 'crawler',
    needsWebSearch: true,
    serpSummaryEnough: false,
    confidence: 0.9
  }
})
assert(crawlMode.allowedAgents.includes('crawler'), 'crawl mode keeps crawler')
assert(!crawlMode.allowedAgents.includes('gui'), 'crawl mode strips gui')

assert(isCrawlerRequireSerpEnabled(), 'MANAGER_CRAWLER_REQUIRE_SERP default on')

const g3 = '打开 https://www.runoob.com/ ，点击第一个教程链接并提取标题'
const orchPatched = applyOrchestratorWebRoutePatch({
  userTask: g3,
  webExecutionMode: guiMode,
  decision: {
    intent: 'multi',
    allowedAgents: ['crawler'],
    needsWebSearch: true,
    clauses: [{ id: 'c1', text: g3, agents: ['crawler'] }],
    intentClassify: {
      confidence: 0.8,
      rationale: 'smoke',
      suggestedAgents: ['crawler'],
      needsWeb: true,
      dataSources: ['crawler'],
      isMulti: false,
      isDbAnchored: false,
      needsAdmin: false,
      allowChatWebDirect: false,
      planShortcut: 'none',
    },
    coalescedTask: g3,
    routedQuery: g3,
    constraints: {},
    planBlueprint: {
      steps: [{ agent: 'crawler', queryFocus: g3 }],
      rationale: 'smoke',
      confidence: 0.8,
    },
    needsClarify: false,
    clarifyQuestions: [],
    metaPatch: {},
    raw: {} as any,
    directChitchatSynth: false,
    turnScopeMode: 'current_only',
    clarifyKind: undefined,
  },
})
assert(orchPatched.intent === 'gui', `orchestrator patch G3 intent=gui: ${orchPatched.intent}`)
assert(orchPatched.allowedAgents.includes('gui'), 'orchestrator patch includes gui')
assert(!orchPatched.allowedAgents.includes('crawler'), 'orchestrator patch strips crawler')
assert(orchPatched.needsWebSearch === false, 'orchestrator patch needsWebSearch false')
assert(orchPatched.planBlueprint?.steps?.[0]?.agent === 'gui', 'orchestrator patch blueprint gui')

const boundary = formatAgentBoundaryPrompt()
assert(!/需登录填表的浏览器交互/.test(boundary), 'boundary must not narrow gui to login/form only')
assert(boundary.includes('打开站点') || boundary.includes('点选'), 'boundary mentions open/click gui scope')
const guiVsCrawl = formatGuiCrawlerDisambiguationPrompt()
assert(guiVsCrawl.includes('禁止') && guiVsCrawl.includes('gui'), 'gui vs crawler disambiguation present')
assert(guiVsCrawl.includes('crawl_direct') || guiVsCrawl.includes('有 URL'), 'disambiguation: URL ≠ crawl_direct')

const webModeSys = formatWebExecutionModeSystemPrompt()
assert(webModeSys.includes('必须 gui') || webModeSys.includes('必须用 gui'), 'webMode: click tasks must gui')
assert(webModeSys.includes('crawl_direct') && webModeSys.includes('不是 crawl_direct'), 'webMode: URL+click ≠ crawl_direct')
assert(webModeSys.includes('search_then_crawl') && /禁止/.test(webModeSys), 'webMode forbids search_then_crawl for click')

console.log(`smoke-gui-vs-crawler-route ok (${g1.slice(0, 12)}…)`)
