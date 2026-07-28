/**
 * MCP verify + Docker 引擎链 smoke（无网络）
 * 含：status=error 非 infra 不可 retryable；Connection closed 可 retryable；browse 证据阻断回退
 */
import assert from 'node:assert/strict'
import {
  verifyLobsterRunResult,
  isLobsterRetryableFailure,
  isLobsterInfrastructureFailure,
  hasLobsterBrowseEvidence,
} from '../../shared/lobsterRunVerifyLite'
import { reorderChainForHeadlessMcpSidecar } from '../server/services/lobsterTaskSpec'
import { validateMcpBrowserAction, McpToolLoopTracker } from '../server/services/mcpComplexRecovery'

const task = '打开 https://www.baidu.com/ 搜索 Python 教程'

const verify = verifyLobsterRunResult({
  task,
  status: 'done',
  result: {
    answer: 'MCP 模式已达最大步数，请缩小任务范围或改用 classic 模式。',
    finalUrl: 'https://www.baidu.com/',
    failureType: 'incomplete_max_steps',
  },
})
assert.equal(verify.ok, false)
assert.equal(verify.reason, 'incomplete_max_steps')
assert.equal(
  isLobsterRetryableFailure({ status: 'done', result: {}, verify: { reason: verify.reason } }),
  true,
)

{
  // status=error alone 不再算 infra
  assert.equal(
    isLobsterInfrastructureFailure({ status: 'error', error: 'lobster_verify_incomplete_task_output' }),
    false,
    'status=error alone is not infra'
  )
  assert.equal(
    isLobsterRetryableFailure({
      status: 'error',
      error: 'lobster_verify_incomplete_task_output',
      result: { finalUrl: 'https://www.runoob.com/', answer: '页面：https://www.runoob.com/' },
      verify: { reason: 'error' },
    }),
    false,
    'error + browse evidence must not retry engines'
  )
  assert.equal(
    hasLobsterBrowseEvidence({ finalUrl: 'https://www.runoob.com/' }),
    true,
    'finalUrl is browse evidence'
  )
}

{
  // 真基建仍可回退
  assert.equal(
    isLobsterInfrastructureFailure({
      status: 'error',
      error: 'Connection closed: playwright_mcp_browser_unavailable',
    }),
    true,
    'Connection closed is infra'
  )
  assert.equal(
    isLobsterRetryableFailure({
      status: 'error',
      error: 'Connection closed: playwright_mcp_browser_unavailable',
      result: {},
      verify: { reason: 'browser_infra_unavailable' },
    }),
    true,
    'true infra remains retryable'
  )
}

{
  // error + salvage 后导航类可 verify pass
  const salvaged = verifyLobsterRunResult({
    task: '打开 https://www.runoob.com/ 并告诉我标题',
    status: 'error',
    error: 'lobster_all_engines_failed',
    result: {
      finalUrl: 'https://www.runoob.com/',
      answer: '标题：菜鸟教程\n链接：https://www.runoob.com/',
      pageTitle: '菜鸟教程',
    },
  })
  assert.equal(salvaged.ok, true, 'error+meaningful browse may verify ok')
}

process.env.LOBSTER_MCP_HEADLESS_SIDECAR = '1'
const chain = reorderChainForHeadlessMcpSidecar(['mcp', 'stagehand', 'classic'], task, 'https://www.baidu.com/')
assert.equal(chain[0], 'classic', 'baidu docker chain classic first')

assert.ok(validateMcpBrowserAction('browser_type', { text: 'hello' }), 'missing ref')
assert.equal(validateMcpBrowserAction('browser_type', { ref: 'e1', text: 'hello' }), null)

const loop = new McpToolLoopTracker()
loop.observeToolCall('browser_type', { ref: 'e1', text: 'a' }, 'https://www.baidu.com/')
loop.observeToolCall('browser_type', { ref: 'e1', text: 'a' }, 'https://www.baidu.com/')
loop.observeToolCall('browser_type', { ref: 'e1', text: 'a' }, 'https://www.baidu.com/')
const hit = loop.observeToolCall('browser_type', { ref: 'e1', text: 'a' }, 'https://www.baidu.com/')
assert.equal(hit.looped, true, 'tool loop detected')

console.log('[smoke-mcp-verify-fallback] OK')
