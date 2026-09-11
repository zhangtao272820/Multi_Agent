import { useRuntimeConfig } from '#imports'
import { mergeLobsterRuntimeConfig } from '../utils/platform_config'
import { buildGuiAgentResult } from '../utils/agent_result'
import { ensureLobsterGuiFinalPayload } from '../services/lobsterGuiFinalPayload'
import { appendAgentTraceLog } from '../utils/trace_log'
import { getRunStatus, pauseRun, resumeRun, resolveConfirm, sendHumanAction, startRun, stepRun, stopRun } from '../services/lobsterRuntime'

function safeParseJson(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function sanitize(text: string) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9]{12,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
}

type ClientMessage =
  | {
      type: 'start'
      payload: {
        task: string
        startUrl?: string
        token?: string
        trace_id?: string
        manager_task_json?: string
        session_id?: string
        storage_profile?: string
        history?: Array<{ role: string; content: string }>
      }
    }
  | { type: 'cancel' }
  | { type: 'ping' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'step' }
  | { type: 'human_action'; payload: { action: any } }
  | { type: 'confirm_response'; payload: { id: string; ok: boolean } }

const activeRunId = new Map<string, string>()

export default defineWebSocketHandler({
  open(peer) {
    try {
      peer.send(JSON.stringify({ type: 'status', payload: 'open' }))
    } catch {}
  },
  async message(peer, message) {
    const rawText =
      message && typeof (message as any).text === 'function'
        ? (message as any).text()
        : typeof message === 'string'
          ? message
          : String(message)
    const data = safeParseJson(String(rawText)) as ClientMessage | null
    if (!data || typeof data !== 'object') {
      try {
        peer.send(JSON.stringify({ type: 'error', payload: { message: '消息格式必须为 JSON' } }))
      } catch {}
      return
    }

    const send = (type: string, payload: any) => {
      try {
        peer.send(JSON.stringify({ type, payload }))
      } catch {}
    }

    if (data.type === 'ping') {
      send('pong', Date.now())
      return
    }

    if (data.type === 'cancel') {
      const runId = activeRunId.get(peer.id)
      if (runId) {
        stopRun(runId)
        activeRunId.delete(peer.id)
      }
      send('status', 'canceled')
      return
    }

    if (data.type === 'pause' || data.type === 'resume' || data.type === 'step' || data.type === 'human_action' || data.type === 'confirm_response') {
      const runId = activeRunId.get(peer.id)
      if (!runId) {
        send('error', { message: '当前没有运行中的任务' })
        return
      }
      if (data.type === 'pause') {
        pauseRun(runId)
        send('status', 'paused')
        return
      }
      if (data.type === 'resume') {
        resumeRun(runId)
        send('status', 'running')
        return
      }
      if (data.type === 'step') {
        stepRun(runId)
        send('status', 'step')
        return
      }
      if (data.type === 'human_action') {
        const action = (data as any).payload?.action
        if (!action || typeof action !== 'object' || !String((action as any).type || '').trim()) {
          send('error', { message: 'human_action 缺少 action 或 action.type' })
          return
        }
        sendHumanAction(runId, action)
        send('status', 'human_action')
        return
      }
      if (data.type === 'confirm_response') {
        const id = String((data as any).payload?.id || '').trim()
        const ok = !!(data as any).payload?.ok
        if (!id) {
          send('error', { message: 'confirm_response 缺少 id' })
          return
        }
        const handled = resolveConfirm(runId, id, ok)
        if (!handled) send('error', { message: 'confirm_response 无效或已过期' })
        return
      }
      return
    }

    if (data.type !== 'start') return

    const cfg = useRuntimeConfig() as any
    const expectedToken = String(cfg?.lobster?.adminToken || '').trim()
    if (expectedToken) {
      const providedToken = String((data as any)?.payload?.token || '').trim()
      if (!providedToken || providedToken !== expectedToken) {
        send('error', { message: '未授权：缺少或错误的访问令牌' })
        return
      }
    }

    const task = String(data.payload?.task ?? '').trim()
    let startUrl = data.payload?.startUrl ? String(data.payload.startUrl).trim() : undefined
    const traceId = String((data.payload as any)?.trace_id ?? '').trim() || undefined
    const sessionId = String((data.payload as any)?.session_id ?? '').trim() || undefined
    let storageProfile = String((data.payload as any)?.storage_profile ?? '').trim() || undefined
    let engineHint = String((data.payload as any)?.engine_hint ?? (data.payload as any)?.engineHint ?? '').trim() || undefined
    const browserProfileRaw = String((data.payload as any)?.browser_profile ?? (data.payload as any)?.browserProfile ?? '').trim().toLowerCase()
    const handoffContext = String((data.payload as any)?.handoff_context ?? (data.payload as any)?.handoffContext ?? '').trim().toLowerCase()
    const managerTaskJson = String((data.payload as any)?.manager_task_json ?? '').trim() || undefined
    const managerTaskEnvelope = (data.payload as any)?.manager_task_envelope_v2 ?? undefined
    const { resolveLobsterManagerStartHints } = await import('../services/lobsterManagerEnvelope')
    const { taskSpecFromManagerHints } = await import('../services/lobsterManagerTaskSpec')
    const merged = resolveLobsterManagerStartHints({
      task,
      startUrl,
      storageProfile,
      engineHint,
      managerTaskJson,
      managerTaskEnvelope,
    })
    const runTask = merged.task || task
    startUrl = merged.startUrl || startUrl
    storageProfile = merged.storageProfile || storageProfile
    engineHint = merged.engineHint || engineHint
    if (handoffContext === 'post_human_confirm') engineHint = 'classic'
    const browserProfile =
      browserProfileRaw === 'user' || browserProfileRaw === 'managed'
        ? browserProfileRaw
        : merged.browserProfile
    const workflowId =
      merged.workflowId ||
      String((data.payload as any)?.workflow_id ?? (data.payload as any)?.workflowId ?? '').trim() ||
      undefined
    let workflowArgs = merged.workflowArgs
    const rawArgs = (data.payload as any)?.workflow_args ?? (data.payload as any)?.workflowArgs
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      workflowArgs = { ...(workflowArgs || {}), ...(rawArgs as Record<string, unknown>) }
    }
    if (!runTask) {
      send('error', { message: '缺少 task' })
      return
    }

    const prev = activeRunId.get(peer.id)
    if (prev) {
      stopRun(prev)
      activeRunId.delete(peer.id)
    }

    send('status', 'start')

    const mergedCfg = await mergeLobsterRuntimeConfig({
      openaiApiKey: cfg.openaiApiKey,
      openaiBaseUrl: cfg.openaiBaseUrl,
      lobster: cfg.lobster
    })

    const taskSpec = taskSpecFromManagerHints({
      task: runTask,
      startUrl,
      engineHint,
      intentHint: merged.intentHint,
      taskKind: merged.taskKind,
      needsLogin: merged.needsLogin,
      siteRecipeId: merged.siteRecipeId,
      successCriteria: merged.successCriteria,
      maxInteractionSteps: merged.maxInteractionSteps,
    })

    const runStartedAt = Date.now()
    const tenantId =
      String((msg as any)?.payload?.tenantId || (msg as any)?.payload?.tenant_id || '').trim() ||
      'default'
    const runId = startRun({
      task: runTask,
      startUrl,
      sessionId,
      tenantId,
      storageProfile,
      engineHint,
      workflowId,
      workflowArgs,
      browserProfile,
      taskSpec: taskSpec || undefined,
      externalTraceId: traceId,
      config: mergedCfg,
      emit: (evt) => {
        if (evt.type === 'log') {
          const p = evt.payload
          send('log', { ...p, message: sanitize(String(p.message || '')) })
          return
        }
        if (evt.type === 'thinking') {
          const p = evt.payload as any
          send('thinking', { stage: String(p.stage || ''), text: sanitize(String(p.text || '')), ts: Number(p.ts || Date.now()) })
          return
        }
        if (evt.type === 'state') {
          send('state', evt.payload)
          return
        }
        if (evt.type === 'screenshot') {
          send('screenshot', evt.payload)
          return
        }
        if (evt.type === 'live_view') {
          send('live_view', evt.payload)
          return
        }
        if (evt.type === 'step') {
          send('step', evt.payload)
          return
        }
        if (evt.type === 'candidates') {
          send('candidates', evt.payload)
          return
        }
        if (evt.type === 'confirm') {
          send('confirm', evt.payload)
          return
        }
        if (
          evt.type === 'understand' ||
          evt.type === 'engine_chain' ||
          evt.type === 'engine_active' ||
          evt.type === 'verify' ||
          evt.type === 'run_meta'
        ) {
          send(evt.type, evt.payload)
          return
        }
        if (evt.type === 'error') {
          const p = evt.payload as any
          send('error', { message: sanitize(String(p.message || 'unknown error')), ts: Number(p.ts || Date.now()) })
          send('status', 'error')
          activeRunId.delete(peer.id)
          return
        }
        if (evt.type === 'result') {
          const payload = evt.payload && typeof evt.payload === 'object' ? { ...(evt.payload as object) } : evt.payload
          const rawRow = payload as Record<string, unknown>
          const row = ensureLobsterGuiFinalPayload(rawRow, String(rawRow.task || task))
          const agentResult = buildGuiAgentResult({
            data: Array.isArray(row.data) ? (row.data as Record<string, unknown>[]) : [],
            finalUrl: String(row.finalUrl || ''),
            task: String(row.task || task),
            trace_id: traceId || String(row.traceId || ''),
            latency_ms: Date.now() - runStartedAt,
            answer: String(row.answer || ''),
            failureType: String(row.failureType || ''),
            stats: row.stats && typeof row.stats === 'object' ? (row.stats as Record<string, unknown>) : undefined
          })
          void appendAgentTraceLog({
            agent: 'gui',
            path: '/_ws',
            trace_id: traceId || String(row.traceId || ''),
            ok: agentResult.ok,
            latency_ms: agentResult.latency_ms,
            detail: String(row.stats && typeof row.stats === 'object' ? (row.stats as Record<string, unknown>).stepCount : '')
          })
          send('result', { ...row, agentResult })
          send('status', 'end')
          activeRunId.delete(peer.id)
          return
        }
      }
    })
    activeRunId.set(peer.id, runId)
    const st = getRunStatus(runId)
    if (st?.status === 'queued') send('status', 'queued')
  },
  close(peer) {
    const runId = activeRunId.get(peer.id)
    if (runId) {
      stopRun(runId)
      activeRunId.delete(peer.id)
    }
  }
})
