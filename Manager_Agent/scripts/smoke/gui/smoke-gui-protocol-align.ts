/**
 * 总管 ↔ Lobster_Agent 协议对齐 smoke（纯函数，无网络）
 * 多引擎：显式 engineHint 透传；网页失败不再跨引擎 mcp/classic 级联
 */
import assert from 'node:assert/strict'
import {
  isDesktopGuiTask,
  parseGuiTaskHints,
} from '../../../server/graph/core/agent/guiTaskPayload'
import { LOBSTER_GUI_MCP_TOOLS } from '../../../../Lobster_Agent/server/mcp/lobsterGuiMcpSchema'
import {
  buildManagerTaskEnvelope,
  serializeManagerTaskEnvelope,
} from '#agent-shared/managerTaskEnvelope'
import {
  LOBSTER_GUI_PROGRESS_LIMITS,
  shouldForwardGuiThinking,
} from '#agent-shared/lobsterGuiProgressContract'
import {
  isGuiMcpFirstEnabled,
  nextGuiEngineHintForRetry,
} from '../../../server/graph/core/executors/guiExecutor'
import { buildEngineChainFromPick, resolveEngineFromTaskSpec } from '../../../../Lobster_Agent/server/services/lobsterTaskSpec'

assert(parseGuiTaskHints('引擎:desktop\n打开记事本').engineHint === 'desktop', 'desktop engine hint')
assert(parseGuiTaskHints('profile:user\n打开百度').browserProfile === 'user', 'browser profile hint')
assert(!parseGuiTaskHints('打开 https://www.runoob.com/ 点教程').engineHint, 'web task no forced hint')
assert(parseGuiTaskHints('引擎:classic\n打开百度').engineHint === 'classic', 'classic engine hint')
assert(parseGuiTaskHints('引擎:stagehand\n打开百度').engineHint === 'stagehand', 'stagehand engine hint')
assert(parseGuiTaskHints('引擎:mcp\n打开百度').engineHint === 'mcp', 'mcp engine hint')
assert(isDesktopGuiTask('打开记事本输入 Hello'), 'desktop task detect')
assert(!isDesktopGuiTask('打开百度', 'https://www.baidu.com'), 'url skips desktop')

const env = buildManagerTaskEnvelope({
  target_agent: 'gui',
  trace_id: 't1',
  session_id: 's1',
  utterance: '打开 runoob 搜索',
  payload: {
    kind: 'gui',
    data: {
      source: 'manager',
      task: '打开 runoob 搜索',
      browser_profile: 'managed',
      task_kind: 'navigate',
    },
  },
})
const ser = serializeManagerTaskEnvelope(env)
assert(ser.includes('browser_profile'), 'envelope has browser_profile')
assert(!ser.includes('"engineHint"') || !/"engineHint"\s*:\s*"(mcp|classic|stagehand)"/.test(ser), 'no forced legacy engine in default envelope')

assert(LOBSTER_GUI_MCP_TOOLS.some((t) => t.name === 'run_desktop_task'), 'run_desktop_task exported')
assert(LOBSTER_GUI_MCP_TOOLS.some((t) => t.name === 'run_browser_task'), 'run_browser_task exported')

assert(!isGuiMcpFirstEnabled({ MANAGER_GUI_MCP_FIRST: '0' }), 'MCP-first default off')
assert(nextGuiEngineHintForRetry('auto') === undefined, 'auto：no mcp cascade')
assert(nextGuiEngineHintForRetry('browser_use') === undefined, 'browser_use：no cascade')
assert(nextGuiEngineHintForRetry('mcp') === undefined, 'mcp：no cascade to stagehand')
assert(nextGuiEngineHintForRetry('stagehand') === undefined, 'stagehand：no cascade to classic')
assert(LOBSTER_GUI_PROGRESS_LIMITS.maxThinkingLines <= 12, 'progress ≤12')
assert(!shouldForwardGuiThinking('actualEngine=mcp'), 'filter engine truth noise')

const c1 = resolveEngineFromTaskSpec({
  task: '打开 https://www.runoob.com/ ，点击第一个教程链接并提取标题',
  startUrl: 'https://www.runoob.com/',
  spec: {
    canonical_task: '打开 runoob',
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
assert.equal(c1.engine, 'stagehand')
assert.equal(buildEngineChainFromPick(c1).length, 1, 'C1 chain length 1')

console.log('smoke-gui-protocol-align: PASS')
