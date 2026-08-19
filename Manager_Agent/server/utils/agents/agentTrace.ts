/** E2：跨 Agent 透传 runId / trace_id；P3：tenantId / userId；T0-4：协议版本头；E5.2：服务身份 */

import { buildW3cTraceparent, isManagerOtelTraceparentEnabled } from '../../graph/core/runtime/otelExport'
import {
  isManagerTaskEnvelopeV2Enabled,
  MANAGER_PROTOCOL_VERSION_HEADER,
  MANAGER_TASK_ENVELOPE_VERSION,
} from '#agent-shared/managerTaskEnvelope'
import { buildAgentServiceAuthHeaders } from '#agent-shared/agentServiceAuth'

export function isManagerAgentTraceEnabled() {
  const v = String(process.env.MANAGER_AGENT_TRACE ?? '1').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

export type AgentTraceContext = {
  traceId?: string
  tenantId?: string
  userId?: string
}

let _activeTraceCtx: Pick<AgentTraceContext, 'tenantId' | 'userId'> | null = null

/** 单次 Manager run 内子 Agent 调用共享 tenant / user 上下文 */
export function withAgentTraceContext<T>(
  ctx: Pick<AgentTraceContext, 'tenantId' | 'userId'>,
  fn: () => T | Promise<T>
): T | Promise<T> {
  const prev = _activeTraceCtx
  _activeTraceCtx = {
    tenantId: ctx.tenantId || prev?.tenantId,
    userId: ctx.userId || prev?.userId
  }
  try {
    return fn()
  } finally {
    _activeTraceCtx = prev
  }
}

export function resolveTraceId(traceId?: string) {
  const id = String(traceId || '').trim()
  return isManagerAgentTraceEnabled() && id ? id : ''
}

export function buildAgentTraceHeaders(traceId?: string, ctx?: Pick<AgentTraceContext, 'tenantId' | 'userId'>) {
  const id = resolveTraceId(traceId)
  const merged = { ..._activeTraceCtx, ...ctx }
  const out: Record<string, string> = { ...buildInternalAuthHeaders() }
  if (id) {
    out['x-trace-id'] = id
    out['x-run-id'] = id
    if (isManagerOtelTraceparentEnabled()) {
      out.traceparent = buildW3cTraceparent(id)
    }
  }
  const tenantId = String(merged?.tenantId || '').trim()
  if (tenantId) out['x-tenant-id'] = tenantId
  const userId = String(merged?.userId || '').trim()
  if (userId) out['x-user-id'] = userId
  if (isManagerTaskEnvelopeV2Enabled()) {
    out[MANAGER_PROTOCOL_VERSION_HEADER] = MANAGER_TASK_ENVELOPE_VERSION
  }
  return out
}

/** P3 / E5.2：Manager 调用子 Agent 时携带服务身份令牌 */
export function buildInternalAuthHeaders(): Record<string, string> {
  return buildAgentServiceAuthHeaders()
}

export function withTraceBody<T extends Record<string, unknown>>(body: T, traceId?: string): T {
  const id = resolveTraceId(traceId)
  if (!id) return body
  return { ...body, trace_id: id }
}

export function isManagerStreamDeltaEnabled() {
  const v = String(process.env.MANAGER_STREAM_DELTA ?? '1').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}
