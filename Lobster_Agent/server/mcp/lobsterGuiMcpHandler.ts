/**
 * lobster-gui MCP export：包装 Lobster 三引擎 + Playwright MCP 快照。
 */
import { mergeLobsterRuntimeConfig } from '../utils/platform_config'
import { isLobsterMcpExportEnabled } from '../utils/lobster_env'
import {
  getRun,
  getRunScreenshot,
  getRunStatus,
  resolveConfirm,
  startRun,
  stopRun,
} from '../services/lobsterRuntime'
import { probeLobsterMcpReady } from '../services/lobsterMcpAgent'
import { probeLobsterDesktopReady } from '../services/lobsterDesktopMcpAgent'
import { probeLobsterAndroidReady } from '../services/lobsterAndroidMcpAgent'
import { callMcpTool, closeMcpConnections, extractMcpToolText } from '../utils/mcpClient'
import {
  resolveLobsterMcpServers,
  isLobsterDesktopMcpEnabled,
  isLobsterAndroidMcpEnabled,
  lobsterMcpTransportMode,
} from '../utils/lobster_env'
import { browserProfileLabel, isUserBrowserProfile, resolveBrowserCdpUrl, resolveBrowserProfile } from '../services/browserProfiles'
import { persistCookiesStorage, resolveRunStoragePaths } from '../services/sessionStorageBridge'
import {
  mcpErr,
  mcpOk,
  mcpTextResult,
  parseMcpToolCallParams,
  type McpJsonRpcRequest,
} from '#agent-shared/mcpJsonRpc'
import { LOBSTER_GUI_MCP_TOOLS } from './lobsterGuiMcpSchema'
import { siteHintsForPrompt } from '../services/siteRecipes'
import { verifyLobsterRunResult } from '../services/lobsterRunVerify'
import { resolveLobsterManagerStartHints } from '../services/lobsterManagerEnvelope'
import { taskSpecFromManagerHints } from '../services/lobsterManagerTaskSpec'
import { buildGuiAgentResult } from '../utils/agent_result'
import { ensureLobsterGuiFinalPayload } from '../services/lobsterGuiFinalPayload'
import { assertMcpGuiRunHasAgentResult } from '#agent-shared/lobsterGuiProgressContract'

const TOOLS = LOBSTER_GUI_MCP_TOOLS

function attachGuiAgentResult(
  out: {
    run_id: string
    status: string
    result: unknown
    error?: string
    trace_id?: string
    verify?: unknown
    [k: string]: unknown
  },
  task: string,
) {
  const st = String(out.status || '').toLowerCase()
  const raw =
    out.result && typeof out.result === 'object' ? (out.result as Record<string, unknown>) : {}
  const ensured = ensureLobsterGuiFinalPayload({ ...raw, task: String(raw.task || task) }, task)
  const agentResult = buildGuiAgentResult({
    data: Array.isArray(ensured.data) ? (ensured.data as Record<string, unknown>[]) : [],
    finalUrl: String(ensured.finalUrl || ''),
    task: String(ensured.task || task),
    trace_id: String(out.trace_id || out.run_id || ''),
    latency_ms: Number((ensured.stats as any)?.latency_ms || 0) || undefined,
    answer: String(ensured.answer || ''),
    failureType: String(ensured.failureType || ''),
    status: st === 'done' ? 'done' : 'error',
    stats: ensured.stats && typeof ensured.stats === 'object' ? (ensured.stats as Record<string, unknown>) : undefined,
    error_code: st === 'done' ? undefined : String(out.error || ensured.failureType || 'run_error'),
  })
  const payload = {
    ...out,
    result: ensured,
    agentResult,
  }
  if (!assertMcpGuiRunHasAgentResult(payload)) {
    throw new Error('mcp_gui_missing_agentResult')
  }
  return payload
}

async function waitForRunDone(runId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = getRunStatus(runId)
    if (!st) throw new Error('run not found')
    if (st.status === 'done' || st.status === 'error' || st.status === 'canceled') {
      const rec = getRun(runId)
      return {
        run_id: runId,
        status: st.status,
        result: rec?.result ?? null,
        error: st.error,
        trace_id: st.traceId,
      }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  stopRun(runId)
  throw new Error(`run timeout after ${timeoutMs}ms`)
}

async function runBrowserTaskTool(args: Record<string, unknown>, cfg: any) {
  const rawTask = String(args.task ?? '').trim()
  if (!rawTask) throw new Error('task 不能为空')
  const hints = resolveLobsterManagerStartHints({
    task: rawTask,
    startUrl: String(args.start_url ?? args.startUrl ?? '').trim() || undefined,
    storageProfile: String(args.storage_profile ?? args.storageProfile ?? '').trim() || undefined,
    engineHint: String(args.engine_hint ?? args.engineHint ?? '').trim() || undefined,
    managerTaskEnvelope: args.manager_task_envelope_v2 as string | Record<string, unknown> | null | undefined,
    managerTaskJson: typeof args.manager_task === 'object' ? JSON.stringify(args.manager_task) : String(args.manager_task ?? ''),
  })
  const task = hints.task || rawTask
  const startUrl = hints.startUrl
  const handoffContext = String(args.handoff_context ?? args.handoffContext ?? 'initial').trim().toLowerCase()
  const browserProfileArg = String(args.browser_profile ?? args.browserProfile ?? '').trim().toLowerCase()
  let engineHint =
    hints.engineHint ||
    undefined
  // 勿用 recipePreferredEngine 写入 engineHint（会 forced 锁链）；recipe 走 router 软选型
  if (handoffContext === 'post_human_confirm') {
    engineHint = 'classic'
  }

  const workflowIdFromArgs = String(args.workflow_id ?? args.workflowId ?? '').trim() || undefined
  const workflowId = hints.workflowId || workflowIdFromArgs
  let workflowArgs = hints.workflowArgs
  const rawWfArgs = args.workflow_args ?? args.workflowArgs
  if (rawWfArgs && typeof rawWfArgs === 'object' && !Array.isArray(rawWfArgs)) {
    workflowArgs = { ...(workflowArgs || {}), ...(rawWfArgs as Record<string, unknown>) }
  }

  const mergedCfg = await mergeLobsterRuntimeConfig({
    openaiApiKey: cfg.openaiApiKey,
    openaiBaseUrl: cfg.openaiBaseUrl,
    lobster: cfg.lobster,
  })
  const taskSpec = taskSpecFromManagerHints({
    task,
    startUrl,
    engineHint,
    intentHint: hints.intentHint,
    taskKind: hints.taskKind,
    needsLogin: hints.needsLogin,
    siteRecipeId: hints.siteRecipeId,
    successCriteria: hints.successCriteria,
    maxInteractionSteps: hints.maxInteractionSteps,
  })
  const runId = startRun({
    task,
    startUrl,
    storageProfile: hints.storageProfile,
    engineHint,
    workflowId,
    workflowArgs,
    taskSpec: taskSpec || undefined,
    config: mergedCfg,
    browserProfile:
      browserProfileArg === 'user' || browserProfileArg === 'managed'
        ? browserProfileArg
        : hints.browserProfile,
  })
  const timeoutMs = Number(args.timeout_ms ?? 240_000)
  const out = await waitForRunDone(runId, Number.isFinite(timeoutMs) ? timeoutMs : 240_000)
  const rawResult =
    out.result && typeof out.result === 'object' ? (out.result as Record<string, unknown>) : {}
  const ensuredResult = ensureLobsterGuiFinalPayload({ ...rawResult, task }, task)
  const verify = verifyLobsterRunResult({
    task: rawTask,
    status: String(out.status || ''),
    result: ensuredResult,
    error: out.error,
  })
  const screenshot = getRunScreenshot(runId)
  const pageUrl = String(ensuredResult.finalUrl || ensuredResult.url || '').trim() || undefined
  return attachGuiAgentResult(
    {
      ...out,
      result: ensuredResult,
      verify,
      screenshot_data_url: screenshot || undefined,
      page_url: pageUrl,
    },
    task,
  )
}

async function runDesktopTaskTool(args: Record<string, unknown>, cfg: any) {
  const rawTask = String(args.task ?? '').trim()
  if (!rawTask) throw new Error('task 不能为空')
  if (!isLobsterDesktopMcpEnabled()) {
    throw new Error('desktop MCP 未启用（LOBSTER_DESKTOP_MCP_ENABLED=0 或非 Win 宿主机）')
  }
  const hints = resolveLobsterManagerStartHints({
    task: rawTask,
    engineHint: 'desktop',
    managerTaskEnvelope: args.manager_task_envelope_v2 as string | Record<string, unknown> | null | undefined,
    managerTaskJson: typeof args.manager_task === 'object' ? JSON.stringify(args.manager_task) : String(args.manager_task ?? ''),
  })
  const task = hints.task || rawTask
  const targetApp = String(args.target_app ?? args.targetApp ?? '').trim() || undefined
  const mergedCfg = await mergeLobsterRuntimeConfig({
    openaiApiKey: cfg.openaiApiKey,
    openaiBaseUrl: cfg.openaiBaseUrl,
    lobster: cfg.lobster,
  })
  const runId = startRun({
    task,
    engineHint: 'desktop',
    config: mergedCfg,
    taskSpec: targetApp
      ? {
          canonical_task: task,
          engine_hint: 'desktop',
          task_kind: 'desktop_app',
          browser_profile: 'managed',
          needs_login: false,
          explicitly_avoid_login: false,
          target_app: targetApp,
          confidence: 1,
          rationale: 'run_desktop_task MCP',
          source: 'manager',
        }
      : undefined,
  })
  const timeoutMs = Number(args.timeout_ms ?? 300_000)
  const out = await waitForRunDone(runId, Number.isFinite(timeoutMs) ? timeoutMs : 300_000)
  const verify = verifyLobsterRunResult({
    task: rawTask,
    status: String(out.status || ''),
    result: out.result,
    error: out.error,
  })
  return attachGuiAgentResult({ ...out, verify, engine: 'desktop' }, task)
}

async function runAndroidTaskTool(args: Record<string, unknown>, cfg: any) {
  const rawTask = String(args.task ?? '').trim()
  if (!rawTask) throw new Error('task 不能为空')
  if (!isLobsterAndroidMcpEnabled()) {
    throw new Error('Android MCP 未启用（LOBSTER_ANDROID_MCP_ENABLED=0）')
  }
  const hints = resolveLobsterManagerStartHints({
    task: rawTask,
    engineHint: 'mobile',
    managerTaskEnvelope: args.manager_task_envelope_v2 as string | Record<string, unknown> | null | undefined,
    managerTaskJson: typeof args.manager_task === 'object' ? JSON.stringify(args.manager_task) : String(args.manager_task ?? ''),
  })
  const task = hints.task || rawTask
  const targetApp = String(args.target_app ?? args.targetApp ?? '').trim() || undefined
  const mergedCfg = await mergeLobsterRuntimeConfig({
    openaiApiKey: cfg.openaiApiKey,
    openaiBaseUrl: cfg.openaiBaseUrl,
    lobster: cfg.lobster,
  })
  const runId = startRun({
    task,
    engineHint: 'mobile',
    config: mergedCfg,
    taskSpec: targetApp
      ? {
          canonical_task: task,
          engine_hint: 'mobile',
          task_kind: 'mobile_app',
          browser_profile: 'managed',
          needs_login: false,
          explicitly_avoid_login: false,
          target_app: targetApp,
          confidence: 1,
          rationale: 'run_android_task MCP',
          source: 'manager',
        }
      : undefined,
  })
  const timeoutMs = Number(args.timeout_ms ?? 300_000)
  const out = await waitForRunDone(runId, Number.isFinite(timeoutMs) ? timeoutMs : 300_000)
  const verify = verifyLobsterRunResult({
    task: rawTask,
    status: String(out.status || ''),
    result: out.result,
    error: out.error,
  })
  return attachGuiAgentResult({ ...out, verify, engine: 'mobile' }, task)
}

async function browserSnapshotTool(args: Record<string, unknown>) {
  const runId = String(args.run_id ?? args.runId ?? '').trim()
  if (runId) {
    const shot = getRunScreenshot(runId)
    const st = getRunStatus(runId)
    return { run_id: runId, status: st?.status, screenshot_data_url: shot ? shot.slice(0, 8000) : null }
  }
  const url = String(args.url ?? '').trim()
  if (!url) throw new Error('url 或 run_id 必填其一')
  const servers = resolveLobsterMcpServers()
  if (!servers) throw new Error('Playwright MCP 未配置')
  const serverName = Object.keys(servers)[0]!
  try {
    await callMcpTool(servers, serverName, 'browser_navigate', { url })
    const snap = await callMcpTool(servers, serverName, 'browser_snapshot', {})
    return { url, snapshot: extractMcpToolText(snap) }
  } finally {
    await closeMcpConnections().catch(() => undefined)
  }
}

async function resolveRunConfirmTool(args: Record<string, unknown>) {
  const runId = String(args.run_id ?? args.runId ?? '').trim()
  const confirmId = String(args.confirm_id ?? args.confirmId ?? '').trim()
  const ok = args.ok !== false
  if (!runId || !confirmId) throw new Error('run_id 与 confirm_id 必填')
  const handled = resolveConfirm(runId, confirmId, ok)
  return { run_id: runId, confirm_id: confirmId, ok, handled }
}

async function importSessionTool(args: Record<string, unknown>) {
  const profile = String(args.storage_profile ?? '').trim()
  const cookies = Array.isArray(args.cookies) ? args.cookies : []
  if (!profile) throw new Error('storage_profile 必填')
  if (!cookies.length) throw new Error('cookies 不能为空')
  const paths = await resolveRunStoragePaths({
    startUrl: String(args.start_url ?? '').trim() || undefined,
    storageProfile: profile,
  })
  if (!paths.savePath) throw new Error('无法解析 storage 路径')
  await persistCookiesStorage(paths.savePath, cookies as Array<Record<string, unknown>>)
  return { storage_profile: profile, save_path: paths.savePath, cookie_count: cookies.length }
}

export async function handleLobsterGuiMcpRequest(body: McpJsonRpcRequest, cfg: any) {
  if (!isLobsterMcpExportEnabled()) {
    return mcpErr(body.id, -32000, 'MCP export disabled (LOBSTER_MCP_EXPORT=0)')
  }

  const method = String(body.method ?? '').trim()
  const params = (body.params ?? {}) as Record<string, unknown>

  if (method === 'initialize') {
    return mcpOk(body.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'lobster-gui', version: '1.0.0' },
      capabilities: { tools: {} },
    })
  }
  if (method === 'ping') return mcpOk(body.id, {})
  if (method === 'tools/list') return mcpOk(body.id, { tools: TOOLS })

  if (method === 'tools/call') {
    const { name, args } = parseMcpToolCallParams(params)
    try {
      if (name === 'run_browser_task') {
        return mcpOk(body.id, mcpTextResult(await runBrowserTaskTool(args, cfg)))
      }
      if (name === 'run_desktop_task') {
        return mcpOk(body.id, mcpTextResult(await runDesktopTaskTool(args, cfg)))
      }
      if (name === 'run_android_task') {
        return mcpOk(body.id, mcpTextResult(await runAndroidTaskTool(args, cfg)))
      }
      if (name === 'browser_snapshot') {
        return mcpOk(body.id, mcpTextResult(await browserSnapshotTool(args)))
      }
      if (name === 'import_session') {
        return mcpOk(body.id, mcpTextResult(await importSessionTool(args)))
      }
      if (name === 'resolve_run_confirm') {
        return mcpOk(body.id, mcpTextResult(await resolveRunConfirmTool(args)))
      }
      if (name === 'health') {
        const playwright = await probeLobsterMcpReady()
        const desktop = await probeLobsterDesktopReady()
        const android = await probeLobsterAndroidReady()
        const profile = resolveBrowserProfile()
        return mcpOk(
          body.id,
          mcpTextResult({
            service: 'lobster-gui',
            export: true,
            browser_profile: profile,
            browser_profile_label: browserProfileLabel(profile, resolveBrowserCdpUrl() || undefined),
            user_browser_active: isUserBrowserProfile(),
            mcp_transport: lobsterMcpTransportMode(),
            playwright_mcp: playwright,
            desktop_mcp: desktop,
            android_mcp: android,
          }),
        )
      }
      return mcpErr(body.id, -32601, `unknown tool: ${name}`)
    } catch (e: unknown) {
      return mcpErr(body.id, -32000, String((e as Error)?.message ?? e ?? 'tool failed'))
    }
  }

  return mcpErr(body.id, -32601, `unknown method: ${method}`)
}

export { TOOLS as LOBSTER_GUI_MCP_TOOLS }
