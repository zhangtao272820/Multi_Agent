/**
 * 引擎选型冒烟：Recipe · hard_guard · resolveEngineFromTaskSpec（网页默认 Stagehand）
 */
import assert from 'node:assert/strict'
import {
  matchSiteRecipe,
  recipePreferredEngine,
  siteHintsForPrompt,
  stagehandHintsForPrompt,
} from '../server/services/siteRecipes'
import { selectEngineForTask, engineFallbackChain, requiresClassicEngine } from '../server/services/engineSelector'
import {
  resolveEngineFromTaskSpec,
  buildEngineChainFromPick,
} from '../server/services/lobsterTaskSpec'
import { formatStagehandModelName } from '../server/utils/lobster_env'

assert(matchSiteRecipe('打开百度', 'https://www.baidu.com/')?.id === 'baidu', 'baidu recipe')
assert(recipePreferredEngine('填表', 'https://ant.design/components/form-cn') === 'stagehand', 'antd→stagehand')
assert(recipePreferredEngine('点教程', 'https://www.runoob.com/') === 'stagehand', 'runoob→stagehand')
assert(siteHintsForPrompt('test', 'https://www.runoob.com/').length > 0, 'runoob hints')
assert(stagehandHintsForPrompt('test', 'https://ant.design/').includes('Stagehand') || stagehandHintsForPrompt('test', 'https://ant.design/').length > 0, 'stagehand hints')

assert(selectEngineForTask('B站播放视频') === 'classic', 'video→classic')
assert(
  selectEngineForTask('打开 bilibili 点赞', 'https://www.bilibili.com/video/BV1') === 'classic',
  'bili engagement→classic',
)
assert(requiresClassicEngine('搜索后观看 5 秒', 'https://www.bilibili.com/'), 'watch on bili requires classic')
assert(selectEngineForTask('登录 OA 填表') === 'stagehand', 'web default stagehand (no form regex)')
assert(selectEngineForTask('百度搜索') === 'stagehand', 'search→stagehand default')

const baiduVideo = selectEngineForTask('B站播放', 'https://www.baidu.com/')
assert(baiduVideo === 'classic', 'video keyword wins on baidu host')

assert(recipePreferredEngine('搜索 Python', 'https://www.baidu.com/') === 'stagehand', 'baidu recipe stagehand')
assert(selectEngineForTask('搜索 Python', 'https://www.baidu.com/') === 'stagehand', 'baidu select stagehand')

assert(engineFallbackChain('stagehand')[0] === 'stagehand', 'stagehand chain primary')
assert(engineFallbackChain('stagehand').length === 1, 'stagehand chain is single-engine')
assert(!engineFallbackChain('stagehand').includes('mcp'), 'no mcp auto-fallback')
assert(!engineFallbackChain('stagehand').includes('classic'), 'no classic auto-fallback')
assert(engineFallbackChain('mcp').length === 1, 'mcp forced is single')
assert(engineFallbackChain('classic').length === 1, 'classic forced is single')

const softPick = resolveEngineFromTaskSpec({
  task: '百度搜 Python',
  startUrl: 'https://www.baidu.com/',
  spec: {
    canonical_task: '百度搜 Python',
    engine_hint: 'auto',
    task_kind: 'search',
    confidence: 0.85,
    source: 'llm',
    rationale: 'soft',
    browser_profile: 'managed',
    needs_login: false,
    explicitly_avoid_login: false,
    plan_steps: [],
    goals: {},
  } as any,
})
assert(softPick.engine === 'stagehand', 'search task_kind → stagehand')
assert(softPick.source !== 'forced', 'llm hint is soft')
assert(buildEngineChainFromPick(softPick).length === 1, 'soft pick is stagehand-only chain')

const softMcp = resolveEngineFromTaskSpec({
  task: '打开网页',
  startUrl: 'https://www.runoob.com/',
  spec: {
    canonical_task: '打开网页',
    engine_hint: 'mcp',
    task_kind: 'navigate',
    confidence: 0.9,
    source: 'llm',
    rationale: 'soft mcp ignored',
    browser_profile: 'managed',
    needs_login: false,
    explicitly_avoid_login: false,
    plan_steps: [],
    goals: {},
  } as any,
})
assert(softMcp.engine === 'stagehand', 'soft llm mcp → stagehand for web')
assert(buildEngineChainFromPick(softMcp).length === 1, 'web soft mcp still chain len 1')

const navPick = resolveEngineFromTaskSpec({
  task: '打开 runoob 点第一个教程',
  startUrl: 'https://www.runoob.com/',
  spec: {
    canonical_task: '打开 runoob 点第一个教程',
    engine_hint: 'auto',
    task_kind: 'navigate',
    confidence: 0.9,
    source: 'llm',
    rationale: 'C1',
    browser_profile: 'managed',
    needs_login: false,
    explicitly_avoid_login: false,
    plan_steps: [],
    goals: { must_leave_start: true },
  } as any,
})
assert(navPick.engine === 'stagehand', 'navigate → stagehand')
assert(buildEngineChainFromPick(navPick).length === 1, 'C1 chain length 1')

const forcedPick = resolveEngineFromTaskSpec({
  task: 'x',
  engineHint: 'classic',
})
assert(forcedPick.source === 'forced', 'caller engineHint is forced')
assert(buildEngineChainFromPick(forcedPick).length === 1, 'forced chain has no fallback')

assert(formatStagehandModelName('qwen3.5-flash') === 'openai/qwen3.5-flash', 'stagehand model prefix')
assert(formatStagehandModelName('openai/gpt-4o') === 'openai/gpt-4o', 'stagehand model passthrough')
assert(formatStagehandModelName('qwen-plus-2025-04-28') === 'openai/qwen-plus', 'dated plus → qwen-plus')

console.log('smoke-engine-classifier: PASS')
