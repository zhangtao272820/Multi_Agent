import type { WsHandlerContext, ParsedWsMessage } from './types'
import { runs, runMeta, sessionMeta, cancelGuiConfirmsForRun, cancelPlanConfirmsForRun, emitImplicitLearning, isRunAbortError, nowMs } from './wsBarrel'
import { recordWsStreamCancelLatency } from '#agent-shared/wsStreamSlo'

export async function handleCancel(ctx: WsHandlerContext, payload: ParsedWsMessage) {
  const { peer, peerKey, send, sessionId, boundUserId, tenantId, explicitUserId, platformTraceId, payloadRaw } = ctx

let rid = String(payload.runId || '').trim()
    if (!rid || !runs.has(rid)) {
      const active = sessionMeta.get(sessionId)?.activeRunId
      if (active) rid = String(active).trim()
    }
    const ctrl = rid ? runs.get(rid) : null
    if (ctrl) {
      const cancelAt = nowMs()
      recordWsStreamCancelLatency({ cancelRequestedAtMs: cancelAt, nowMs: cancelAt })
      ctrl.abort()
      cancelGuiConfirmsForRun(rid)
      cancelPlanConfirmsForRun(rid)
      void emitImplicitLearning(rid, sessionId, 'user_cancel')
      runs.delete(rid)
      runMeta.delete(rid)
      const sMeta = sessionMeta.get(sessionId)
      if (sMeta?.activeRunId === rid) sessionMeta.set(sessionId, { ...sMeta, activeRunId: undefined })
      send('status', { status: 'canceled', runId: rid }, 'manager', rid)
    } else {
      // 任务已结束或 runId 已清理：用 status 告知前端，避免误报为 error
      send('status', { status: 'cancel_noop', runId: rid || null, detail: '任务已结束或不存在，无需取消' }, 'manager', rid || undefined)
    }
    return
}
