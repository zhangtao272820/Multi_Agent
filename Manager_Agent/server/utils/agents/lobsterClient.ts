import WebSocket from 'ws'
import { agentWsUrlToHttpOrigin, resolveAgentUrl } from '../platform/agentEndpoints'
import { withTimeout, waitForAgentHttpReady, isCrawlerTransportError } from './agentTransport'
import { wrapGuiResult } from './agentResult'
import { waitGuiConfirm } from '../gui/guiConfirmBridge'
import { buildGuiResultForManager } from '../../graph/core/agent/guiTaskPayload'
import { lobsterHttpPollEnabled } from './pollAgentJob'
import { isManagerDockerRuntime } from '../platform/managerEnvModes'
import { callLobsterGuiRunWithPoll } from '../mcp/lobsterGuiPoll'
import {
  guiScreenshotFingerprint,
  shouldForwardGuiThinking,
} from '#agent-shared/lobsterGuiProgressContract'
import { markAgentPayloadUntrusted } from '#agent-shared/contentTrust'

function resolveLobsterWsCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const primary = resolveAgentUrl(env.LOBSTER_AGENT_WS_URL, env)
  const out: string[] = []
  const push = (u: string) => {
    const t = String(u || '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  push(primary)
  const docker = isManagerDockerRuntime(env)
  if (docker) {
    push('ws://lobster_agent:13108/_ws')
  } else {
    push('ws://localhost:13108/_ws')
    push('ws://127.0.0.1:13108/_ws')
  }
  return out
}

function resolveLobsterToken(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.LOBSTER_ADMIN_TOKEN || env.CLAWHIVE_INTERNAL_TOKEN || env.AGENT_INTERNAL_TOKEN || '').trim()
}

function lobsterAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = resolveLobsterToken(env)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) {
    headers.Authorization = `Bearer ${token}`
    headers['x-lobster-token'] = token
    headers['x-clawhive-internal-token'] = token
  }
  return headers
}

function guiAutoConfirmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_GUI_AUTO_CONFIRM ?? '').trim() === '1'
}

function emitGuiProgress(
  params: {
    sendThinking?: (text: string) => void
    sendEvent?: (event: { event: string; data?: unknown; from?: string }) => void
  },
  stage: string,
  pageUrl?: string
) {
  const s = String(stage || '').trim()
  if (!s) return
  params.sendThinking?.(`GUI Agent [${s}]${pageUrl ? ` · ${pageUrl.slice(0, 80)}` : ''}`)
  params.sendEvent?.({
    event: 'step_status',
    data: { agent: 'gui', status: 'running', stage: s, pageUrl: pageUrl || undefined },
    from: 'gui'
  })
}

/** 降噪：step_end JSON / 重复感知句不进总管思考流（否则单任务 200+ 行） */
function shouldForwardGuiThinkingToManager(text: string): boolean {
  return shouldForwardGuiThinking(text)
}

function screenshotFingerprint(dataUrl: string, pageUrl?: string): string {
  return guiScreenshotFingerprint(dataUrl, pageUrl)
}

async function callLobsterAgentWs(params: {
  lobsterAgentWsUrl: string
  timeoutMs: number
  task: string
  startUrl?: string
  managerTask?: Record<string, unknown> | string | null
  managerTaskEnvelope?: string
  sessionId?: string
  storageProfile?: string
  engineHint?: string
  browserProfile?: 'managed' | 'user'
  handoffContext?: 'initial' | 'post_human_confirm'
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  sendThinking?: (text: string) => void
  sendEvent?: (event: { event: string; data?: unknown; from?: string }) => void
  signal?: AbortSignal
  traceId?: string
  runId?: string
}) {
  const ws = new WebSocket(params.lobsterAgentWsUrl)
  return await withTimeout(
    new Promise<any>((resolve, reject) => {
      let result: any = null
      let sawEnd = false
      let finished = false
      let lastScreenshotFp = ''
      let lastThinkingKey = ''

      const finish = (fn: () => void) => {
        if (finished) return
        finished = true
        fn()
      }

      const onAbort = () => {
        cleanup()
        finish(() => reject(new Error('lobsterAgent aborted')))
      }
      const cleanup = () => {
        try {
          ws.removeAllListeners()
          ws.close()
        } catch {}
        try {
          params.signal?.removeEventListener('abort', onAbort)
        } catch {}
      }
      if (params.signal) params.signal.addEventListener('abort', onAbort)

      const handleConfirm = async (data: any) => {
        const p = data?.payload || {}
        const confirmId = String(p.id || '').trim()
        const title = String(p.title || '需要确认').trim()
        const message = String(p.message || '').trim()
        params.sendThinking?.(`GUI Agent：等待人工确认 — ${title}`)
        let ok = false
        if (guiAutoConfirmEnabled(process.env)) {
          ok = true
        } else if (params.runId && confirmId) {
          params.sendEvent?.({
            event: 'human_confirm_request',
            data: { confirmId, title, message, agent: 'gui' },
            from: 'gui'
          })
          ok = await waitGuiConfirm(params.runId, confirmId)
        }
        try {
          ws.send(JSON.stringify({ type: 'confirm_response', payload: { id: confirmId, ok } }))
        } catch {}
      }

      ws.on('open', () => {
        params.sendThinking?.('GUI Agent：已连接 Lobster，提交任务…')
        const manager_task_json =
          typeof params.managerTask === 'string'
            ? params.managerTask.trim() || undefined
            : params.managerTask && typeof params.managerTask === 'object'
              ? JSON.stringify(params.managerTask)
              : undefined
        const history = Array.isArray(params.history)
          ? params.history
              .map((m) => ({
                role: String(m?.role ?? '').toLowerCase() === 'assistant' ? 'assistant' : 'user',
                content: String(m?.content ?? '').trim()
              }))
              .filter((m) => m.content)
              .slice(-6)
          : undefined
        const token = resolveLobsterToken(process.env)
        ws.send(
          JSON.stringify({
            type: 'start',
            payload: {
              task: params.task,
              ...(params.startUrl ? { startUrl: params.startUrl } : {}),
              ...(token ? { token } : {}),
              ...(params.traceId ? { trace_id: params.traceId } : {}),
              ...(manager_task_json ? { manager_task_json } : {}),
              ...(params.managerTaskEnvelope ? { manager_task_envelope_v2: params.managerTaskEnvelope } : {}),
              ...(params.sessionId ? { session_id: params.sessionId } : {}),
              ...(params.storageProfile ? { storage_profile: params.storageProfile } : {}),
              ...(params.engineHint ? { engine_hint: params.engineHint } : {}),
              ...(params.browserProfile ? { browser_profile: params.browserProfile } : {}),
              ...(params.handoffContext ? { handoff_context: params.handoffContext } : {}),
              ...(history?.length ? { history } : {})
            }
          })
        )
      })

      ws.on('message', (raw) => {
        let data: any
        try {
          data = JSON.parse(String(raw || '{}'))
        } catch {
          return
        }
        const type = String(data?.type || '')

        if (type === 'log') {
          const m = String(data?.payload?.message || '')
          if (!shouldForwardGuiThinkingToManager(m)) return
          const key = `log:${m.slice(0, 160)}`
          if (key === lastThinkingKey) return
          lastThinkingKey = key
          params.sendThinking?.(`GUI Agent：${m}`)
          return
        }
        if (type === 'thinking') {
          const p = data?.payload || {}
          const text = String(p.text || '').trim()
          const stage = String(p.stage || 'plan')
          if (!shouldForwardGuiThinkingToManager(text)) return
          const key = `th:${stage}:${text.slice(0, 120)}`
          if (key === lastThinkingKey) return
          lastThinkingKey = key
          params.sendThinking?.(`GUI Agent [${stage}]：${text}`)
          return
        }
        if (type === 'state') {
          const p = data?.payload || {}
          emitGuiProgress(params, String(p.phase || 'running'), String(p.pageUrl || ''))
          return
        }
        if (type === 'screenshot') {
          const p = data?.payload || {}
          const dataUrl = String(p.dataUrl || p.data_url || '')
          const pageUrl = String(p.pageUrl || p.page_url || '')
          const fp = screenshotFingerprint(dataUrl, pageUrl)
          if (!dataUrl || fp === lastScreenshotFp) return
          lastScreenshotFp = fp
          params.sendEvent?.({ event: 'gui_screenshot', data: data.payload, from: 'gui' })
          return
        }
        if (type === 'status') {
          const st = String(data.payload || '')
          if (st === 'queued') params.sendThinking?.('GUI Agent：任务排队中…')
          if (st === 'start') params.sendThinking?.('GUI Agent：浏览器任务已启动…')
          if (st === 'end') {
            sawEnd = true
            cleanup()
            finish(() => resolve(result))
          }
          return
        }
        if (type === 'confirm') {
          void handleConfirm(data)
          return
        }
        if (type === 'result') {
          result = data.payload
          return
        }
        if (type === 'error') {
          cleanup()
          finish(() => reject(new Error(String(data?.payload?.message || 'lobsterAgent error'))))
        }
      })

      ws.on('error', (err) => {
        cleanup()
        finish(() => reject(err))
      })
      ws.on('close', () => {
        if (sawEnd) finish(() => resolve(result))
        else if (!finished) finish(() => reject(new Error('lobsterAgent websocket closed unexpectedly')))
      })
    }),
    params.timeoutMs,
    'lobsterAgent',
    params.signal
  )
}

export async function callLobsterAgent(params: {
  lobsterAgentWsUrl: string
  timeoutMs: number
  task: string
  startUrl?: string
  managerTask?: Record<string, unknown> | string | null
  managerTaskEnvelope?: string
  sessionId?: string
  storageProfile?: string
  engineHint?: string
  browserProfile?: 'managed' | 'user'
  handoffContext?: 'initial' | 'post_human_confirm'
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  sendThinking?: (text: string) => void
  sendEvent?: (event: { event: string; data?: unknown; from?: string }) => void
  signal?: AbortSignal
  traceId?: string
  runId?: string
}) {
  params.sendThinking?.('GUI Agent：正在启动浏览器自动化…')
  const primaryWs = resolveAgentUrl(params.lobsterAgentWsUrl, process.env) || String(params.lobsterAgentWsUrl || '').trim()
  const wsUrls = resolveLobsterWsCandidates(process.env)
  if (primaryWs && !wsUrls.includes(primaryWs)) wsUrls.unshift(primaryWs)
  const httpBases = Array.from(new Set(wsUrls.map((ws) => agentWsUrlToHttpOrigin(ws)).filter(Boolean)))
  const docker = isManagerDockerRuntime(process.env)
  const bootWaitMs = docker ? 120_000 : 25_000

  for (const httpBase of httpBases) {
    const ready = await waitForAgentHttpReady(httpBase, bootWaitMs, params.signal, ['/api/health', '/health', '/api/ready'])
    if (ready) break
  }

  const maxAttempts = docker ? 4 : 3
  let lastErr: unknown = null

  // WS 优先：实时 log / state / screenshot / confirm
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const waitMs = Math.min(15_000, 1_500 * attempt * attempt)
      params.sendThinking?.(`GUI Agent：连接异常，${Math.round(waitMs / 1000)}s 后重试（${attempt + 1}/${maxAttempts}）…`)
      await new Promise((r) => setTimeout(r, waitMs))
      if (params.signal?.aborted) break
    }
    for (const wsUrl of wsUrls) {
      try {
        return await callLobsterAgentWs({ ...params, lobsterAgentWsUrl: wsUrl })
      } catch (e) {
        lastErr = e
        if (!isCrawlerTransportError(e)) throw e
      }
    }
  }

  if (lobsterHttpPollEnabled()) {
    params.sendThinking?.('GUI Agent：WebSocket 不可用，改用 HTTP 轮询…')
    try {
      const managerTask =
        typeof params.managerTask === 'object' && params.managerTask ? params.managerTask : undefined
      const polled = await callLobsterGuiRunWithPoll({
        task: params.task,
        startUrl: params.startUrl,
        engineHint: params.engineHint,
        storageProfile: params.storageProfile,
        browserProfile: params.browserProfile,
        sessionId: params.sessionId,
        traceId: params.traceId,
        timeoutMs: params.timeoutMs,
        managerTask,
        managerTaskEnvelope: params.managerTaskEnvelope,
        handoffContext: params.handoffContext,
        callbacks: {
          sendThinking: params.sendThinking,
          sendEvent: params.sendEvent,
          managerRunId: params.runId,
          signal: params.signal,
        },
      })
      const parsed = polled.raw && typeof polled.raw === 'object' ? (polled.raw as Record<string, unknown>) : {}
      const result = parsed.result ?? parsed
      return { ...(result as object), agentResult: (result as any)?.agentResult }
    } catch (e) {
      lastErr = e
      if (!isCrawlerTransportError(e)) throw e
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'lobsterAgent failed'))
}

export function normalizeLobsterCallResult(raw: unknown, task: string, traceId?: string) {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const agentResult =
    row.agentResult && typeof row.agentResult === 'object'
      ? (row.agentResult as import('./types').AgentResult)
      : wrapGuiResult('', row, traceId)
  const taskKind = String(
    row.task_kind ||
      (row.taskSpec && typeof row.taskSpec === 'object'
        ? (row.taskSpec as Record<string, unknown>).task_kind
        : '') ||
      '',
  ).trim()
  const answer =
    String(agentResult.answer || '').trim() ||
    buildGuiResultForManager(raw, task, taskKind ? { taskKind } : undefined)
  // form_fill/login：即使 Lobster 已给 answer，也套一层操作腔（避免资讯长文）
  const framed =
    taskKind === 'form_fill' || taskKind === 'login'
      ? buildGuiResultForManager(
          { ...row, agentResult: { ...agentResult, answer } },
          task,
          { taskKind },
        )
      : answer
  const structured = markAgentPayloadUntrusted(
    (agentResult.structured && typeof agentResult.structured === 'object'
      ? agentResult.structured
      : {}) as Record<string, unknown>,
    'gui'
  )
  return {
    raw,
    agentResult: { ...agentResult, answer: framed, structured },
    answer: framed
  }
}
