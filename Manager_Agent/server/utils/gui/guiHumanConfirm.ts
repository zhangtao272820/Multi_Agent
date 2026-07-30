import type { AgentResult } from '../agents/types'
import { detectLobsterSemanticBlock } from '#agent-shared/lobsterRunVerifyLite'
import { waitGuiConfirm } from './guiConfirmBridge'
import { gateCopy, resolveRiskExecutionPolicy } from '../../graph/core/policy/riskExecutionPolicy'

const GUI_SCREENSHOT_MAX_CHARS = 400_000

export function normalizeGuiScreenshotDataUrl(raw?: string | null): string | undefined {
  const s = String(raw || '').trim()
  if (!s.startsWith('data:image/')) return undefined
  if (s.length > GUI_SCREENSHOT_MAX_CHARS) return undefined
  return s
}

/** 从 Lobster MCP/WS 原始结果提取可展示的页面观测 */
export function extractGuiObservationFromRaw(raw: unknown): {
  screenshotDataUrl?: string
  pageUrl?: string
  lobsterRunId?: string
} {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const result = row.result && typeof row.result === 'object' ? (row.result as Record<string, unknown>) : row
  const screenshotRaw = String(
    row.screenshot_data_url ||
      row.screenshotDataUrl ||
      result.screenshotDataUrl ||
      result.screenshot_data_url ||
      ''
  ).trim()
  const pageUrl = String(
    row.page_url || row.pageUrl || result.finalUrl || result.url || row.finalUrl || ''
  ).trim()
  const lobsterRunId = String(row.run_id || row.runId || '').trim()
  return {
    screenshotDataUrl: normalizeGuiScreenshotDataUrl(screenshotRaw),
    pageUrl: pageUrl || undefined,
    lobsterRunId: lobsterRunId || undefined,
  }
}

export function buildGuiBlockedFinalMessage(input: {
  failureType: string
  task: string
  finalUrl?: string
  headlessMcp?: boolean
  alreadyHandoff?: boolean
}): string {
  const ft = String(input.failureType || 'need_human').trim().toLowerCase()
  const url = String(input.finalUrl || '').trim()
  const lines = [
    ft === 'captcha'
      ? '浏览器任务未完成：目标站点触发了验证码/人机校验（非 MCP 协议故障）。'
      : ft === 'need_login'
        ? '浏览器任务未完成：页面需要登录或授权。'
        : '浏览器任务未完成：站点拦截或需人工介入。',
    url ? `当前页面：${url}` : '',
    input.headlessMcp
      ? 'Docker 内 Playwright MCP 使用 **无头 Chrome**，百度等站点几乎必出验证码；总管「确认继续」**不能**代替您在浏览器里点验证码。'
      : '若需人工处理，请先在 Lobster 工作台（:13108）或 noVNC 浏览器中完成验证/登录，再重试。',
    input.alreadyHandoff
      ? '本轮已尝试过人工确认重试，不再重复弹窗；请换测试站点（如 G3 runoob）或改用有界面浏览器。'
      : '',
    '建议：测试 GUI 用 `打开 https://www.runoob.com/`；百度站内搜索请用 Lobster 独立工作台 + 有头模式/登录态。',
    `任务：${String(input.task || '').trim().slice(0, 240)}`,
  ]
  return lines.filter(Boolean).join('\n')
}

/** 未完成点击/抽取/导航（有截图仍可能失败）——禁止套用「站点拦截」文案 */
export function isGuiIncompleteFailure(code: string): boolean {
  const t = String(code || '').trim().toLowerCase()
  return (
    t === 'navigation_unverified' ||
    t === 'incomplete_task_output' ||
    t === 'search_no_results' ||
    t === 'search_extract_empty' ||
    t === 'empty_result' ||
    t === 'network' ||
    t === 'network_unreachable' ||
    t.startsWith('incomplete_')
  )
}

export function buildGuiNetworkFinalMessage(input: {
  task: string
  finalUrl?: string
}): string {
  const url = String(input.finalUrl || '').trim()
  return [
    '浏览器任务未完成：无法访问目标页面（域名解析或网络连接失败）。',
    url ? `目标页面：${url}` : '',
    '请检查容器/主机网络与 DNS；稍后重试，或在任务中加 `引擎:classic` 走 Lobster 本机有头浏览器。',
    `任务：${String(input.task || '').trim().slice(0, 240)}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildGuiIncompleteFinalMessage(input: {
  reason: string
  task: string
  finalUrl?: string
  hasScreenshot?: boolean
}): string {
  const reason = String(input.reason || 'incomplete_task_output').trim().toLowerCase()
  if (reason === 'network' || reason === 'network_unreachable') {
    return buildGuiNetworkFinalMessage({ task: input.task, finalUrl: input.finalUrl })
  }
  const url = String(input.finalUrl || '').trim()
  const head =
    reason === 'navigation_unverified'
      ? '浏览器任务未完成：仍停留在起始页，未完成点击/进入目标页。'
      : reason === 'search_no_results' || reason === 'search_extract_empty'
        ? '浏览器任务未完成：搜索/抽取未得到可用结果（页面可能已打开）。'
        : reason.startsWith('incomplete_')
          ? '浏览器任务未完成：步数用尽或目标动作未做完（打开≠成功）。'
          : '浏览器任务未完成：目标动作未达成（有截图仍可能失败）。'
  const lines = [
    head,
    url ? `当前页面：${url}` : '',
    input.hasScreenshot
      ? '说明：截图只证明页面已加载，不代表已点击链接或抽出标题。'
      : '',
    '建议：在 noVNC / Lobster(:13108) 观察是否点进详情；可显式加 `引擎:classic` 强制有头逐步；或先测短句 `打开 https://www.runoob.com/`。',
    `任务：${String(input.task || '').trim().slice(0, 240)}`,
  ]
  return lines.filter(Boolean).join('\n')
}

/** handoff → 拦截文案；incomplete/其它 → 未完成文案（禁止误套站点拦截） */
export function buildGuiFailureUserMessage(input: {
  failureTypeOrReason: string
  task: string
  finalUrl?: string
  headlessMcp?: boolean
  alreadyHandoff?: boolean
  hasScreenshot?: boolean
}): string {
  const code = String(input.failureTypeOrReason || '').trim().toLowerCase()
  if (code === 'network' || code === 'network_unreachable') {
    return buildGuiNetworkFinalMessage({ task: input.task, finalUrl: input.finalUrl })
  }
  if (isGuiHumanHandoffFailure(code)) {
    return buildGuiBlockedFinalMessage({
      failureType: code,
      task: input.task,
      finalUrl: input.finalUrl,
      headlessMcp: input.headlessMcp,
      alreadyHandoff: input.alreadyHandoff,
    })
  }
  return buildGuiIncompleteFinalMessage({
    reason: code || 'incomplete_task_output',
    task: input.task,
    finalUrl: input.finalUrl,
    hasScreenshot: input.hasScreenshot,
  })
}

/** 非搜索任务误标 search_* 时改写为 navigation_unverified */
export function normalizeGuiVerifyReasonForTask(task: string, reason: string): string {
  const r = String(reason || '').trim().toLowerCase()
  if (!r) return r
  const isSearch = /(搜索|search|查找|\bquery\b)/i.test(String(task || ''))
  if (!isSearch && (r === 'search_no_results' || r === 'search_extract_empty')) {
    return 'navigation_unverified'
  }
  return r
}

/** 从 graph state 检测 GUI 语义阻塞（验证码/登录墙），用于阻断 fix→multi 重跑 */
export function detectGuiSemanticBlockFromState(state: {
  evidence?: unknown[]
  results?: Record<string, unknown>
  meta?: Record<string, unknown>
}): { blocked: boolean; failureType?: string; finalUrl?: string } {
  const meta = state.meta && typeof state.meta === 'object' ? state.meta : {}
  const preset = String(meta.guiSemanticBlocked || '').trim().toLowerCase()
  if (preset && isGuiHumanHandoffFailure(preset)) {
    return { blocked: true, failureType: preset }
  }
  const evidence = Array.isArray(state.evidence) ? state.evidence : []
  for (const raw of evidence) {
    const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (String(e.kind || '') !== 'gui') continue
    const agentResult = e.agentResult as AgentResult | undefined
    const ft = resolveGuiFailureType({ agentResult })
    const failed = e.failed === true || agentResult?.ok === false
    const verifyReason = String(e.verifyReason || '').trim()
    if (failed && (isGuiHumanHandoffFailure(ft) || verifyReason === 'task_blocked')) {
      const structured =
        agentResult?.structured && typeof agentResult.structured === 'object'
          ? (agentResult.structured as Record<string, unknown>)
          : {}
      return {
        blocked: true,
        failureType: ft || 'need_human',
        finalUrl: String(structured.finalUrl || '').trim() || undefined,
      }
    }
  }
  const guiText = String(state.results?.gui || '').trim()
  const block = detectLobsterSemanticBlock({ task: '', text: guiText })
  if (block) {
    return { blocked: true, failureType: block.failureType }
  }
  return { blocked: false }
}

export function isDockerHeadlessMcpGui(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_GUI_MCP_FIRST ?? '0').trim() === '1'
}

export function guiFailureTypeLabel(failureType: string): string {
  const ft = String(failureType || '').trim().toLowerCase()
  if (ft === 'captcha') return '验证码'
  if (ft === 'need_login') return '需登录'
  if (ft === 'need_human') return '需人工'
  return ft ? ft : '阻塞'
}

export function emitGuiObservationEvents(input: {
  screenshotDataUrl?: string
  pageUrl?: string
  failureType?: string
  lobsterRunId?: string
  sendEvent?: (event: { event: string; data?: unknown; from?: string }) => void
}) {
  if (!input.sendEvent) return
  if (input.screenshotDataUrl) {
    input.sendEvent({
      event: 'gui_screenshot',
      data: {
        dataUrl: input.screenshotDataUrl,
        pageUrl: input.pageUrl,
        failureType: input.failureType,
        lobsterRunId: input.lobsterRunId,
      },
      from: 'gui',
    })
  }
}

export function guiAutoConfirmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_GUI_AUTO_CONFIRM ?? '').trim() === '1'
}

export function isGuiHumanHandoffFailure(failureType: string): boolean {
  const ft = String(failureType || '').trim().toLowerCase()
  return ft === 'captcha' || ft === 'need_login' || ft === 'need_human'
}

/** 阻塞/失败 outcome 的对外 error_code：禁止回落 empty_result 掩盖 handoff/incomplete */
export function resolveGuiBlockedErrorCode(raw?: string | null): string {
  const t = String(raw || '').trim().toLowerCase()
  if (t === 'user_cancelled_gui_handoff') return 'user_cancelled_gui_handoff'
  if (isGuiHumanHandoffFailure(t)) return t
  if (t === 'task_blocked') return 'task_blocked'
  if (isGuiIncompleteFailure(t)) return t === 'empty_result' ? 'incomplete_task_output' : t
  if (!t || t === 'empty_result') return 'task_blocked'
  return String(raw || 'task_blocked').trim() || 'task_blocked'
}

export function resolveGuiFailureType(input: {
  verify?: { failureType?: string; reason?: string } | null
  agentResult?: AgentResult | null
}): string {
  const structured =
    input.agentResult?.structured && typeof input.agentResult.structured === 'object'
      ? (input.agentResult.structured as Record<string, unknown>)
      : {}
  const verifyReason = String(input.verify?.reason || '').trim().toLowerCase()
  return String(
    input.verify?.failureType ||
      input.agentResult?.error_code ||
      structured.failureType ||
      (verifyReason === 'task_blocked' ? 'need_human' : '') ||
      (isGuiIncompleteFailure(verifyReason) ? verifyReason : '')
  )
    .trim()
    .toLowerCase()
}

export function buildGuiHumanConfirmMessage(input: {
  failureType: string
  task: string
  finalUrl?: string
}): { title: string; message: string } {
  const ft = String(input.failureType || 'need_human').trim().toLowerCase()
  const url = String(input.finalUrl || '').trim()
  const taskLine = `任务：${String(input.task || '').trim().slice(0, 240)}`
  if (ft === 'captcha') {
    return {
      title: '浏览器验证码需人工处理',
      message: [
        '当前站点触发了验证码或人机校验，自动化无法继续。',
        url ? `拦截页：${url}` : '',
        '协议说明：此处「确认继续」= 您已在 Lobster 工作台/noVNC **手动完成**验证码；总管界面**不能**代点验证码。',
        '确认后系统将改走 **有头 classic 引擎**（非无头 MCP 重跑），可在 http://<host>:13108 完成验证。',
        'Docker 无头 MCP 下百度几乎必出验证码——非协议故障。日常测试请用 runoob（G3）。',
        taskLine,
      ]
        .filter(Boolean)
        .join('\n')
    }
  }
  if (ft === 'need_login') {
    return {
      title: '浏览器登录需人工处理',
      message: [
        '当前页面需要登录或授权，自动化无法继续。',
        url ? `页面：${url}` : '',
        '请完成登录后点击「确认继续」重试；也可在任务中附带 `登录态:profile` 导入 cookie。',
        taskLine
      ]
        .filter(Boolean)
        .join('\n')
    }
  }
  return {
    title: '浏览器任务需人工介入',
    message: [
      '当前 GUI 步骤被站点拦截或需人工处理，自动化无法继续。',
      url ? `页面：${url}` : '',
      '请人工处理后点击「确认继续」重试本任务；取消则中止。',
      taskLine
    ]
      .filter(Boolean)
      .join('\n')
  }
}

/** 总管 GUI HITL：弹出 human_confirm_request 并阻塞至用户确认/取消 */
export async function requestGuiHumanConfirm(input: {
  runId?: string
  failureType: string
  task: string
  finalUrl?: string
  screenshotDataUrl?: string
  lobsterRunId?: string
  meta?: unknown
  sendThinking?: (t: string) => void
  sendEvent?: (event: { event: string; data?: unknown; from?: string }) => void
  timeoutMs?: number
}): Promise<boolean> {
  const riskPolicy = resolveRiskExecutionPolicy({
    actionKind: 'gui_write',
    meta: input.meta
  })
  if (guiAutoConfirmEnabled() && riskPolicy.allowAutoConfirm) return true
  const runId = String(input.runId || '').trim()
  if (!runId) return false
  const confirmId = crypto.randomUUID()
  const copy = buildGuiHumanConfirmMessage(input)
  const screenshotDataUrl = normalizeGuiScreenshotDataUrl(input.screenshotDataUrl)
  const pageUrl = String(input.finalUrl || '').trim() || undefined
  emitGuiObservationEvents({
    screenshotDataUrl,
    pageUrl,
    failureType: input.failureType,
    lobsterRunId: input.lobsterRunId,
    sendEvent: input.sendEvent,
  })
  if (riskPolicy.preferDryRun || riskPolicy.actionGate === 'dry_run_then_confirm') {
    input.sendThinking?.(`GUI Agent：${gateCopy('dry_run')}`)
    input.sendEvent?.({
      event: 'dry_run_result',
      data: {
        agent: 'gui',
        badge: gateCopy('dry_run'),
        message: copy.message.slice(0, 600),
        riskPolicy
      },
      from: 'manager'
    })
  }
  input.sendThinking?.(
    screenshotDataUrl
      ? `GUI Agent：${gateCopy('action')}，已附带浏览器截图，等待您确认…`
      : `GUI Agent：${gateCopy('action')}，等待您确认…`
  )
  input.sendEvent?.({
    event: 'human_confirm_request',
    data: {
      confirmId,
      title: copy.title,
      message: `${gateCopy('action')}\n${copy.message}`,
      agent: 'gui',
      failureType: input.failureType,
      pageUrl,
      screenshotDataUrl,
      lobsterRunId: input.lobsterRunId,
      riskTier: riskPolicy.tier
    },
    from: 'manager',
  })
  return waitGuiConfirm(runId, confirmId, input.timeoutMs ?? 300_000)
}
