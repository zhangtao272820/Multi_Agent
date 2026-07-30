/**
 * P3-L5：Progress 契约 · MCP agentResult · 搜索抽取 verify
 */
import {
  guiScreenshotFingerprint,
  shouldForwardGuiThinking,
  hasStableGuiFinalPayload,
  searchTaskRequiresContentPayload,
  assertMcpGuiRunHasAgentResult,
  LOBSTER_GUI_PROGRESS_LIMITS,
} from '../../shared/lobsterGuiProgressContract'
import { verifyLobsterRunResult } from '../../shared/lobsterRunVerifyLite'
import { ensureLobsterGuiFinalPayload } from '../server/services/lobsterGuiFinalPayload'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

// --- progress contract ---
assert(LOBSTER_GUI_PROGRESS_LIMITS.maxThinkingLines === 12, 'thinking limit ≤12')
assert(LOBSTER_GUI_PROGRESS_LIMITS.pollIntervalMs === 400, 'poll interval')
const fp1 = guiScreenshotFingerprint('data:image/png;base64,aaaa', 'https://a')
const fp2 = guiScreenshotFingerprint('data:image/png;base64,aaaa', 'https://a')
const fp3 = guiScreenshotFingerprint('data:image/png;base64,bbbb', 'https://a')
assert(fp1 === fp2, 'same screenshot fp')
assert(fp1 !== fp3, 'diff screenshot fp')
assert(!shouldForwardGuiThinking('step_end {...}'), 'drop step_end')
assert(!shouldForwardGuiThinking('正在理解界面'), 'drop short vision')
assert(!shouldForwardGuiThinking('actualEngine=stagehand chain=[stagehand]'), 'drop actualEngine noise')
assert(!shouldForwardGuiThinking('[stagehand] verbose internals'), 'drop stagehand logger')
assert(!shouldForwardGuiThinking('引擎链：stagehand → mcp'), 'drop engine_chain noise')
assert(shouldForwardGuiThinking('百度直达搜索结果页'), 'keep useful log')
assert(shouldForwardGuiThinking('3 步：goto → click → extract'), 'keep plan milestone')

// --- MCP agentResult envelope ---
const mcpPayload = {
  run_id: 'r1',
  status: 'done',
  result: { task: 'x', finalUrl: 'https://www.baidu.com/s?wd=x', answer: 'ok enough text' },
  agentResult: { ok: true, agent: 'gui', answer: 'ok enough text' },
}
assert(assertMcpGuiRunHasAgentResult(mcpPayload), 'has agentResult')
assert(!assertMcpGuiRunHasAgentResult({ status: 'done', result: {} }), 'missing agentResult')

// --- ensure final payload from items ---
const ensured = ensureLobsterGuiFinalPayload(
  {
    task: '打开百度搜索 Python 教程，提取第一条结果',
    finalUrl: 'https://www.baidu.com/s?wd=Python',
    data: [
      {
        items: [{ title: 'Python 入门', url: 'https://example.com/py' }],
      },
    ],
  },
  '打开百度搜索 Python 教程，提取第一条结果',
)
assert(String(ensured.answer || '').includes('Python'), 'answer from items')
assert(hasStableGuiFinalPayload({ answer: String(ensured.answer), itemsCount: 1 }), 'stable final')

// --- search extract verify ---
assert(searchTaskRequiresContentPayload('打开百度搜索「Python」，提取第一条结果'), 'requires content')
assert(!searchTaskRequiresContentPayload('打开百度搜 LangGraph 并打开第一条'), 'open-first no extract force')

const onlyUrl = verifyLobsterRunResult({
  task: '打开百度搜索 Python 教程，提取第一条结果',
  status: 'done',
  result: { finalUrl: 'https://www.baidu.com/s?wd=Python', answer: '' },
})
assert(!onlyUrl.ok, 'extract fails on url-only')
assert(onlyUrl.reason === 'search_extract_empty' || onlyUrl.reason === 'incomplete_task_output', 'extract empty reason')

const withItems = verifyLobsterRunResult({
  task: '打开百度搜索 Python 教程，提取第一条结果',
  status: 'done',
  result: ensured,
})
assert(withItems.ok, 'extract ok with items+answer')

const openFirst = verifyLobsterRunResult({
  task: '打开百度搜 LangGraph 并打开第一条',
  status: 'done',
  result: { finalUrl: 'https://example.com/langgraph-doc', answer: '页面：https://example.com/langgraph-doc' },
})
assert(openFirst.ok, 'open-first ok with detail url')

console.log('smoke-gui-progress-contract: PASS')
