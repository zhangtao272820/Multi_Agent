/**
 * Lobster GUI 轮询执行：HTTP start + status poll + in-run confirm 桥接（OpenClaw 类 · 对齐总管协议）
 */
import { agentWsUrlToHttpOrigin, resolveAgentUrl } from '../platform/agentEndpoints'
import {
  hasLobsterBrowseEvidence,
  isLobsterInfrastructureFailure,
  isLobsterRetryableFailure,
  verifyLobsterRunResult,
} from '#agent-shared/lobsterRunVerifyLite'
import {
  emitGuiObservationEvents,
  guiAutoConfirmEnabled,
  normalizeGuiScreenshotDataUrl,
} from '../gui/guiHumanConfirm'
import { waitGuiConfirm } from '../gui/guiConfirmBridge'
import { guiScreenshotFingerprint, LOBSTER_GUI_PROGRESS_LIMITS } from '#agent-shared/lobsterGuiProgressContract'

export type LobsterPollCallbacks = {
  sendThinking?: (t: string) => void
  sendEvent?: (event: { event: string; data?: unknown; from?: string }) => void
  managerRunId?: string
  signal?: AbortSignal
}

type LobsterRunStatus = {
  runId?: string
  status?: string
  error?: string
  state?: { phase?: string; pageUrl?: string }
  screenshotDataUrl?: string | null
  result?: unknown
  pendingConfirm?: {
    id: string
    title: string
    message: string
    ts?: number
  } | null
  awaitingConfirm?: boolean
}

function internalTokenHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = String(env.CLAWHIVE_INTERNAL_TOKEN || env.AGENT_INTERNAL_TOKEN || env.LOBSTER_ADMIN_TOKEN || '').trim()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) {
    headers.Authorization = `Bearer ${token}`
    headers['x-lobster-token'] = token
    headers['x-clawhive-internal-token'] = token
    headers['x-internal-token'] = token
  }
  return headers
}

export function resolveLobsterHttpBase(env: NodeJS.ProcessEnv = process.env): string {
  const guiWs = String(resolveAgentUrl(env.LOBSTER_AGENT_WS_URL, env) || '').trim()
  if (guiWs) return agentWsUrlToHttpOrigin(guiWs)
  return ''
}

async function proxyLobsterMcp(
  mcpUrl: string,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: internalTokenHeaders(env),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Lobster MCP ${res.status}: ${t.slice(0, 200)}`)
  }
  return (await res.json()) as Record<string, unknown>
}

export async function resolveLobsterRunConfirm(input: {
  runId: string
  confirmId: string
  ok: boolean
  env?: NodeJS.ProcessEnv
}): Promise<boolean> {
  const env = input.env ?? process.env
  const httpBase = resolveLobsterHttpBase(env)
  const mcpUrl = httpBase ? `${httpBase}/api/mcp` : ''
  if (!mcpUrl) throw new Error('lobster-gui MCP 未配置')
  const res = await proxyLobsterMcp(
    mcpUrl,
    {
      jsonrpc: '2.0',
      id: 'resolve-confirm',
      method: 'tools/call',
      params: {
        name: 'resolve_run_confirm',
        arguments: { run_id: input.runId, confirm_id: input.confirmId, ok: input.ok },
      },
    },
    env,
  )
  if (res.error) return false
  const content = (res.result as any)?.content
  const text = Array.isArray(content)
    ? content.map((c: any) => String(c?.text ?? '')).filter(Boolean).join('\n')
    : ''
  try {
    const parsed = JSON.parse(text) as { handled?: boolean }
    return parsed.handled === true
  } catch {
    return false
  }
}

async function requestInRunConfirm(input: {
  lobsterRunId: string
  pending: NonNullable<LobsterRunStatus['pendingConfirm']>
  screenshotDataUrl?: string
  pageUrl?: string
  callbacks?: LobsterPollCallbacks
  env: NodeJS.ProcessEnv
}): Promise<boolean> {
  const { pending, lobsterRunId, callbacks, env } = input
  if (guiAutoConfirmEnabled(env)) {
    return resolveLobsterRunConfirm({
      runId: lobsterRunId,
      confirmId: pending.id,
      ok: true,
      env,
    })
  }
  const managerRunId = String(callbacks?.managerRunId || '').trim()
  if (!managerRunId || !callbacks?.sendEvent) return false
  const screenshotDataUrl = normalizeGuiScreenshotDataUrl(input.screenshotDataUrl)
  emitGuiObservationEvents({
    screenshotDataUrl,
    pageUrl: input.pageUrl,
    sendEvent: callbacks.sendEvent,
    lobsterRunId,
  })
  callbacks.sendThinking?.(`GUI Agent：等待人工确认 — ${pending.title}`)
  callbacks.sendEvent({
    event: 'human_confirm_request',
    data: {
      confirmId: pending.id,
      title: pending.title,
      message: pending.message,
      agent: 'gui',
      lobsterRunId,
      pageUrl: input.pageUrl,
      screenshotDataUrl,
      inRun: true,
    },
    from: 'gui',
  })
  const approved = await waitGuiConfirm(managerRunId, pending.id, 300_000)
  const handled = await resolveLobsterRunConfirm({
    runId: lobsterRunId,
    confirmId: pending.id,
    ok: approved,
    env,
  })
  return handled && approved
}

function buildPollResult(input: {
  task: string
  status: LobsterRunStatus
  runId: string
}) {
  const status = String(input.status.status || '').trim().toLowerCase()
  const pageUrl = String(input.status.state?.pageUrl || '').trim()
  const hasShot = Boolean(String(input.status.screenshotDataUrl || '').trim())
  let result = input.status.result
  // poll 侧二次 salvage：error 且 result 无 finalUrl 时用 state.pageUrl
  if (
    (status === 'error' || status === 'canceled') &&
    (!result || typeof result !== 'object' || !String((result as any).finalUrl || (result as any).url || '').trim()) &&
    (pageUrl || hasShot)
  ) {
    result = {
      ...(result && typeof result === 'object' ? (result as Record<string, unknown>) : {}),
      task: input.task,
      ...(pageUrl ? { finalUrl: pageUrl, url: pageUrl } : {}),
      ...(hasShot ? { hasScreenshot: true } : {}),
      ...(input.status.error ? { error: String(input.status.error).slice(0, 400) } : {}),
    }
  }
  const verify = verifyLobsterRunResult({
    task: input.task,
    status,
    result,
    error: input.status.error,
  })
  const agentResult = (input.status as any).agentResult
  const payload = {
    run_id: input.runId,
    status,
    result,
    error: input.status.error,
    verify,
    agentResult: agentResult || undefined,
    screenshot_data_url: input.status.screenshotDataUrl || undefined,
    page_url: pageUrl || undefined,
  }
  const text = JSON.stringify(payload)
  const infraFail = isLobsterInfrastructureFailure({
    status,
    error: input.status.error,
    result,
    text,
  })
  const connFail = /Connection closed|playwright_mcp_browser_unavailable/i.test(
    String(input.status.error || text || ''),
  )
  const browseOk = hasLobsterBrowseEvidence(result) || Boolean(pageUrl && !infraFail)
  // status=error 但 verify 通过（salvage 后导航类成功）也算 ok
  const ok =
    !infraFail &&
    !connFail &&
    verify.ok !== false &&
    (status === 'done' || (status === 'error' && browseOk && verify.ok)) &&
    Boolean(result)
  const retryable = isLobsterRetryableFailure({
    status,
    error: input.status.error,
    result,
    text,
    verify: verify && typeof verify === 'object' ? { reason: verify.reason } : undefined,
  })
  return { ok, text, raw: payload, retryable }
}

export async function startLobsterHttpRun(input: {
  task: string
  startUrl?: string
  engineHint?: string
  storageProfile?: string
  browserProfile?: 'managed' | 'user'
  sessionId?: string
  traceId?: string
  managerTask?: Record<string, unknown>
  managerTaskEnvelope?: string
  handoffContext?: 'initial' | 'post_human_confirm'
  env?: NodeJS.ProcessEnv
}): Promise<{ runId: string }> {
  const env = input.env ?? process.env
  const httpBase = resolveLobsterHttpBase(env)
  if (!httpBase) throw new Error('lobster-gui HTTP 未配置')
  const res = await fetch(`${httpBase}/api/lobster/start`, {
    method: 'POST',
    headers: internalTokenHeaders(env),
    body: JSON.stringify({
      task: input.task,
      ...(input.startUrl ? { startUrl: input.startUrl } : {}),
      ...(input.engineHint ? { engineHint: input.engineHint } : {}),
      ...(input.storageProfile ? { storageProfile: input.storageProfile } : {}),
      ...(input.browserProfile ? { browserProfile: input.browserProfile } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.traceId ? { trace_id: input.traceId } : {}),
      ...(input.managerTask ? { manager_task: input.managerTask } : {}),
      ...(input.managerTaskEnvelope ? { manager_task_envelope_v2: input.managerTaskEnvelope } : {}),
      ...(input.handoffContext ? { handoff_context: input.handoffContext } : {}),
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { runId?: string; message?: string; statusMessage?: string }
  if (!res.ok) throw new Error(String(data?.statusMessage || data?.message || res.statusText))
  const runId = String(data.runId || '').trim()
  if (!runId) throw new Error('lobster start 未返回 runId')
  return { runId }
}

export async function pollLobsterRunUntilDone(input: {
  runId: string
  task: string
  timeoutMs?: number
  callbacks?: LobsterPollCallbacks
  env?: NodeJS.ProcessEnv
}): Promise<{ ok: boolean; text: string; raw?: unknown; retryable?: boolean }> {
  const env = input.env ?? process.env
  const httpBase = resolveLobsterHttpBase(env)
  if (!httpBase) throw new Error('lobster-gui HTTP 未配置')
  const timeoutMs = Number(input.timeoutMs ?? 240_000)
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 240_000)
  const headers = internalTokenHeaders(env)
  let lastPhase = ''
  let lastScreenshotFp = ''
  const handledConfirms = new Set<string>()

  while (Date.now() < deadline) {
    if (input.callbacks?.signal?.aborted) throw new Error('lobster poll aborted')
    const res = await fetch(`${httpBase}/api/lobster/status?runId=${encodeURIComponent(input.runId)}`, {
      headers,
      signal: input.callbacks?.signal,
    })
    const status = (await res.json().catch(() => ({}))) as LobsterRunStatus
    if (!res.ok) throw new Error(String((status as any)?.statusMessage || (status as any)?.message || res.statusText))

    const phase = String(status.state?.phase || '').trim()
    const pageUrl = String(status.state?.pageUrl || '').trim()
    if (phase && phase !== lastPhase) {
      lastPhase = phase
      input.callbacks?.sendThinking?.(`GUI Agent [${phase}]${pageUrl ? ` · ${pageUrl.slice(0, 80)}` : ''}`)
    }
    // 根因修复：status 每 400ms 帶回同一张 lastScreenshot，原先无条件推送 → 总管 UI 数百张重复截图
    const shot = String(status.screenshotDataUrl || '').trim()
    if (shot) {
      const fp = guiScreenshotFingerprint(shot, pageUrl)
      if (fp !== lastScreenshotFp) {
        lastScreenshotFp = fp
        input.callbacks?.sendEvent?.({
          event: 'gui_screenshot',
          data: { dataUrl: status.screenshotDataUrl, pageUrl },
          from: 'gui',
        })
      }
    }

    const pending = status.pendingConfirm
    if (pending?.id && !handledConfirms.has(pending.id)) {
      handledConfirms.add(pending.id)
      const approved = await requestInRunConfirm({
        lobsterRunId: input.runId,
        pending,
        screenshotDataUrl: status.screenshotDataUrl || undefined,
        pageUrl,
        callbacks: input.callbacks,
        env,
      })
      if (!approved) {
        return buildPollResult({
          task: input.task,
          status: {
            ...status,
            status: 'error',
            error: 'user_denied_in_run_confirm',
            result: { answer: '已中止：高风险操作未获确认。', failureType: 'need_human' },
          },
          runId: input.runId,
        })
      }
      continue
    }

    const st = String(status.status || '').trim().toLowerCase()
    if (st === 'done' || st === 'error' || st === 'canceled') {
      return buildPollResult({ task: input.task, status, runId: input.runId })
    }
    await new Promise((r) => setTimeout(r, LOBSTER_GUI_PROGRESS_LIMITS.pollIntervalMs))
  }
  throw new Error(`lobster run timeout after ${timeoutMs}ms`)
}

export async function callLobsterGuiRunWithPoll(input: {
  task: string
  startUrl?: string
  engineHint?: string
  storageProfile?: string
  browserProfile?: 'managed' | 'user'
  sessionId?: string
  traceId?: string
  timeoutMs?: number
  managerTask?: Record<string, unknown>
  managerTaskEnvelope?: string
  handoffContext?: 'initial' | 'post_human_confirm'
  callbacks?: LobsterPollCallbacks
  env?: NodeJS.ProcessEnv
}): Promise<{ ok: boolean; text: string; raw?: unknown; retryable?: boolean }> {
  const { runId } = await startLobsterHttpRun(input)
  input.callbacks?.sendThinking?.(`GUI Agent：已提交 Lobster run ${runId.slice(0, 8)}…`)
  return pollLobsterRunUntilDone({
    runId,
    task: input.task,
    timeoutMs: input.timeoutMs,
    callbacks: input.callbacks,
    env: input.env,
  })
}
