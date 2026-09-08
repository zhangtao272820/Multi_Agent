import WebSocket from 'ws'
import { withTimeout } from './agentTransport'
import { wrapAdminResult, coalesceAgentResult, type AgentCallResult } from './agentResult'
import { buildAgentTraceHeaders } from './agentTrace'
import { MANAGER_ORCHESTRATED_HEADER } from '../route/managerSubAgentHelpers'
import type { AgentResult } from './types'

/** 从总管图状态 meta 取出浏览器定位等上下文，透传个人助手 */
export function resolveAdminClientContext(
  meta: Record<string, unknown> | undefined | null,
  managerTask?: Record<string, unknown> | null
): Record<string, unknown> | undefined {
  const ctx =
    meta?.clientContext && typeof meta.clientContext === 'object' && !Array.isArray(meta.clientContext)
      ? ({ ...(meta.clientContext as Record<string, unknown>) } as Record<string, unknown>)
      : ({} as Record<string, unknown>)
  if (managerTask && typeof managerTask === 'object') {
    ctx.manager_orchestrated = true
    ctx.manager_task = managerTask
  } else if (meta?.interactionMode === 'professional' || meta?.workbenchMode === 'professional') {
    ctx.manager_orchestrated = true
  }
  if (!Object.keys(ctx).length) return undefined
  return ctx
}

function wsCancelOnAbort(ws: WebSocket) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel' }))
  } catch {
    /* ignore */
  }
}

type AdminWsCallParams = {
  aiAdminAgentWsUrl: string
  timeoutMs: number
  sessionId?: string
  traceId?: string
  userId?: string
  clientContext?: Record<string, unknown>
  sendThinking?: (text: string) => void
  sendDelta?: (delta: string) => void
  sendThoughtDelta?: (text: string) => void
  signal?: AbortSignal
  buildOpenPayload: () => Record<string, unknown>
}

async function callAiAdminWs(params: AdminWsCallParams): Promise<AgentCallResult> {
  const orchestrated = Boolean(params.clientContext?.manager_orchestrated || params.clientContext?.manager_task)
  const uid = String(params.userId || '').trim()
  const ws = new WebSocket(params.aiAdminAgentWsUrl, {
    headers: {
      ...buildAgentTraceHeaders(params.traceId, uid ? { userId: uid } : undefined),
      ...(orchestrated ? { [MANAGER_ORCHESTRATED_HEADER]: '1' } : {})
    }
  })
  return await withTimeout(
    new Promise<AgentCallResult>((resolve, reject) => {
      let finalText = ''
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }
      const onAbort = () => {
        wsCancelOnAbort(ws)
        cleanup()
        finish(() => reject(new Error('aiAdminAgent aborted')))
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
      ws.on('open', () => {
        ws.send(JSON.stringify(params.buildOpenPayload()))
      })
      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(String(raw || '{}')) as any
          const type = String(data?.type || '')
          if (type === 'thought' || type === 'thought_delta') {
            const t = String(data?.content || data?.text || '')
            if (t) {
              params.sendThoughtDelta?.(t)
              params.sendThinking?.(`个人助手 Agent：${t}`)
            }
            return
          }
          if (type === 'delta') {
            const d = String(data?.content || data?.data || '')
            if (d) {
              params.sendDelta?.(d)
              finalText += d
            }
            return
          }
          if (type === 'stream_start') {
            return
          }
          if (type === 'final') {
            finalText = String(data?.response || finalText || '')
            cleanup()
            const fallback = wrapAdminResult(finalText, params.traceId)
            const agentResult = coalesceAgentResult(data?.agentResult as AgentResult | undefined, fallback)
            const cards = Array.isArray(data?.cards)
              ? data.cards
              : Array.isArray((agentResult.structured as Record<string, unknown> | undefined)?.ui_cards)
                ? ((agentResult.structured as Record<string, unknown>).ui_cards as unknown[])
                : []
            if (cards.length) {
              agentResult.structured = {
                ...(agentResult.structured || {}),
                ui_cards: cards
              }
            }
            finish(() =>
              resolve({
                answer: String(agentResult.answer || finalText),
                agentResult
              })
            )
            return
          }
          if (type === 'error') {
            cleanup()
            finish(() => reject(new Error(String(data?.error || 'aiAdminAgent error'))))
            return
          }
        } catch (e) {
          void e
        }
      })
      ws.on('error', (err) => {
        cleanup()
        finish(() => reject(err))
      })
      ws.on('close', () => {
        if (settled) return
        cleanup()
        if (finalText) {
          const fallback = wrapAdminResult(finalText, params.traceId)
          finish(() =>
            resolve({
              answer: finalText,
              agentResult: fallback
            })
          )
        } else {
          finish(() => reject(new Error('aiAdminAgent closed without response')))
        }
      })
    }),
    params.timeoutMs,
    'aiAdminAgent',
    params.signal
  )
}

export async function callAiAdminAgent(params: {
  aiAdminAgentWsUrl: string
  timeoutMs: number
  message: string
  sessionId?: string
  traceId?: string
  /** 登录用户 id：按用户解析邮箱绑定凭据 */
  userId?: string
  /** 为 true 时个人助手将直接执行高风险工具（待办/日程/提醒等），不再进入待确认队列 */
  autoConfirmRisky?: boolean
  /** N5：auto_confirm 原因码，写入 client_context 便于审计 */
  autoConfirmReason?: string
  /** 浏览器定位等上下文，透传给个人助手 */
  clientContext?: Record<string, unknown>
  sendThinking?: (text: string) => void
  sendDelta?: (delta: string) => void
  sendThoughtDelta?: (text: string) => void
  signal?: AbortSignal
}): Promise<AgentCallResult> {
  params.sendThinking?.('个人助手 Agent：正在处理请求…')
  const uid = String(params.userId || '').trim()
  return callAiAdminWs({
    aiAdminAgentWsUrl: params.aiAdminAgentWsUrl,
    timeoutMs: params.timeoutMs,
    sessionId: params.sessionId,
    traceId: params.traceId,
    userId: uid || undefined,
    clientContext: params.clientContext,
    sendThinking: params.sendThinking,
    sendDelta: params.sendDelta,
    sendThoughtDelta: params.sendThoughtDelta,
    signal: params.signal,
    buildOpenPayload: () => ({
      message: params.message,
      session_id: params.sessionId || 'manager-default',
      auto_confirm_risky: Boolean(params.autoConfirmRisky),
      ...(params.traceId ? { trace_id: params.traceId } : {}),
      ...(uid ? { user_id: uid } : {}),
      client_context: {
        ...(params.clientContext && typeof params.clientContext === 'object' ? params.clientContext : {}),
        ...(params.traceId ? { manager_orchestrated: true } : {}),
        ...(uid ? { user_id: uid } : {}),
        ...(params.autoConfirmRisky
          ? {
              auto_confirm_audit: {
                auto_confirm_risky: true,
                reason: String(params.autoConfirmReason || 'unknown'),
                trace_id: params.traceId || undefined
              }
            }
          : {})
      }
    })
  })
}

/** Admin 原生 pending_decide：HITL 批准后按 action_id 执行确认/取消，避免整步重试 */
export async function callAiAdminPendingDecide(params: {
  aiAdminAgentWsUrl: string
  timeoutMs: number
  actionId: number
  decision: '确认' | '取消'
  originalUserMessage: string
  sessionId?: string
  traceId?: string
  userId?: string
  clientContext?: Record<string, unknown>
  sendThinking?: (text: string) => void
  signal?: AbortSignal
}): Promise<AgentCallResult> {
  params.sendThinking?.(`个人助手 Agent：正在${params.decision}待办操作…`)
  const uid = String(params.userId || '').trim()
  return callAiAdminWs({
    aiAdminAgentWsUrl: params.aiAdminAgentWsUrl,
    timeoutMs: params.timeoutMs,
    sessionId: params.sessionId,
    traceId: params.traceId,
    userId: uid || undefined,
    clientContext: params.clientContext,
    sendThinking: params.sendThinking,
    signal: params.signal,
    buildOpenPayload: () => ({
      mode: 'pending_decide',
      action_id: params.actionId,
      decision: params.decision,
      original_user_message: params.originalUserMessage,
      session_id: params.sessionId || 'manager-default',
      ...(params.traceId ? { trace_id: params.traceId } : {}),
      ...(uid ? { user_id: uid } : {}),
      client_context: {
        ...(params.clientContext && typeof params.clientContext === 'object' ? params.clientContext : {}),
        manager_orchestrated: true,
        ...(uid ? { user_id: uid } : {})
      }
    })
  })
}
