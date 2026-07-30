/**
 * P6 GUI 升级冒烟：经验回读、crawler→gui 回流、超时/重试
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const managerRoot = path.resolve(here, '../../..')
const repoRoot = path.resolve(managerRoot, '..')

import {
  formatGuiExperienceBlock,
  isGuiExperienceReadEnabled,
  recallGuiExperience,
} from '#agent-shared/guiExperienceRetrieve'
import {
  buildGuiHandoffStep,
  buildGuiHandoffTask,
  isGuiCrawlerHandoffEnabled,
  shouldInjectGuiAfterCrawler
} from '../../../server/graph/core/agent/guiCrawlerHandoff'
import { getGuiAutomationAddon } from '../../../server/graph/core/evolution/playbookPrompts'
import {
  isGuiEngineRetryEnabled,
  nextGuiEngineHintForRetry,
  resolveGuiTimeoutMs,
} from '../../../server/graph/core/executors/guiExecutor'
import { LOBSTER_GUI_PROGRESS_LIMITS } from '#agent-shared/lobsterGuiProgressContract'

assert(fs.existsSync(path.join(managerRoot, 'skills/gui_automation/skill.md')), 'gui_automation skill exists')
assert(fs.existsSync(path.join(repoRoot, 'shared/guiExperienceRetrieve.ts')), 'guiExperienceRetrieve exists')

const addon = getGuiAutomationAddon()
assert(addon.includes('操作 vs 检索') || addon.includes('何时不用 gui'), 'gui automation addon loads Route section')
assert(addon.includes('gui 步骤'), 'gui automation addon loads Planner section')

assert(isGuiExperienceReadEnabled(), 'gui experience read enabled by default')
assert(formatGuiExperienceBlock([]) === '', 'empty gui experience block')

const handoff = buildGuiHandoffStep({
  crawlerTask: '打开 https://example.com 登录',
  crawlerStepId: 's1',
  existingSteps: [{ id: 's1', agent: 'crawler', query: 'test' }]
})
assert(handoff?.agent === 'gui', 'handoff step is gui')
assert(handoff?.dependsOn?.includes('s1'), 'handoff depends on crawler')

assert(!buildGuiHandoffStep({
  crawlerTask: 'x',
  crawlerStepId: 's1',
  existingSteps: [
    { id: 's1', agent: 'crawler', query: 'a' },
    { id: 's2', agent: 'gui', query: 'b' }
  ]
}), 'no duplicate gui handoff')

assert(
  shouldInjectGuiAfterCrawler({
    routeSuggestion: 'gui',
    allowedAgents: ['crawler', 'gui'],
    existingSteps: [{ id: 's1', agent: 'crawler', query: 'a' }],
    env: { ...process.env, LOBSTER_AGENT_WS_URL: 'ws://localhost:13108/_ws', MANAGER_GUI_CRAWLER_HANDOFF: '1' }
  }),
  'inject when gui configured'
)

assert(buildGuiHandoffTask('抓取列表').includes('浏览器'), 'handoff task mentions browser')

const formMs = resolveGuiTimeoutMs(60_000, '登录 OA 填表')
assert(formMs >= 360_000, 'form timeout tier')

const videoMs = resolveGuiTimeoutMs(60_000, 'B站播放视频')
assert(videoMs >= 480_000, 'video timeout tier')

assert(nextGuiEngineHintForRetry('auto') === undefined, 'auto：no mcp cascade')
assert(nextGuiEngineHintForRetry('stagehand') === undefined, 'stagehand：no classic cascade')
assert(nextGuiEngineHintForRetry('mcp') === undefined, 'mcp：no stagehand cascade')
assert(isGuiEngineRetryEnabled({}), 'engine retry default on')
assert(LOBSTER_GUI_PROGRESS_LIMITS.maxThinkingLines === 12, 'thinking cap 12')

assert(isGuiCrawlerHandoffEnabled(), 'crawler handoff enabled by default')

const rows = await recallGuiExperience('百度搜索测试', { limit: 1 })
assert(Array.isArray(rows), 'recall returns array')

console.log('smoke-gui-upgrade: PASS')
