import { HumanMessage } from '@langchain/core/messages'
import { buildGraphHistoryMessages } from '../../../graph/core/runtime/conversationBudget'
import { buildSummarizeWithLlmFn } from '../../../utils/session/managerConversationLlmSummary'
import { createManagerGraph } from '../../../graph/state/createManagerGraph'
import { buildManagerGraphInvokeConfig, buildManagerTurnInvokeState } from '../../../graph/state/invokeConfig'
import {
  composeFinalFromGraphResult,
  composeFinalBundleFromGraphResult,
  buildHumanConfirmCheckpoint,
  pickRicherFinalText
} from '../../../graph/core/output/composeFinal'
import {
  deleteHumanConfirmCheckpoint,
  loadHumanConfirmCheckpoint,
  saveHumanConfirmCheckpoint
} from '../../../graph/core/runtime/checkpointStore'
import { isSynthRejectingMedia } from '../../../graph/core/shared'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { loadTaskStack, saveTaskStack } from '../../../graph/core/task/taskStack'
import { detectClarifyFollowUp, clarifyReplanMetaPatch } from '../../../graph/core/plan/clarifyReplan'
import {
  drainPendingAutonomousResults,
  isAutonomousWsNotifyEnabled
} from '../../../graph/core/task/autonomousNotify'
import {
  registerWsSessionPeer,
  unregisterWsSessionPeer
} from '../../../graph/core/runtime/wsSessionHub'
import {
  isManagerWsAuthEnabled,
  isWsPeerAuthed,
  markWsPeerAuthed,
  peerRequestMeta,
  tryAuthenticateWsPeer,
  validateManagerWsAuth
} from '../../../graph/core/runtime/wsAuth'
import { normalizeFeedbackScore } from '../../../graph/core/runtime/runtimePersistence'
import {
  maybeTuneLearningWeights,
  patchLearningSignalWithFeedback
} from '../../../graph/core/unifiedLearning'
import { resolveAgentEndpoints } from '../../../utils/platform/agentEndpoints'
import { resolveAgentEndpointsWithPlatform } from '../../../utils/platform/agentPlatformSync'
import { resolveManagerLlmConfig } from '../../../utils/platform/platformConfigRuntime'
import { resolveGuiConfirm, cancelGuiConfirmsForRun } from '../../../utils/gui/guiConfirmBridge'
import { resolvePlanConfirm, cancelPlanConfirmsForRun } from '../../../utils/shared/planConfirmBridge'
import { IncomingMessageSchema } from '../schemas'
import {
  allowRate,
  cleanupMaps,
  isRunAbortError,
  peerUnregister,
  runMeta,
  runs,
  sessionMeta,
  sessions,
  touchSession
} from '../runtimeState'
import {
  appendRunEvent,
  buildRagHistoryForRun,
  buildUserContent,
  clearExperience,
  emitAdminHumanConfirmRequest,
  emitImplicitLearning,
  emitRunObservability,
  ensureUserBinding,
  graphAgentEndpoints,
  ingestTaskStackFromUserMessage,
  isHumanConfirmClarification,
  shouldPauseForPostGraphAdminConfirm,
  pauseAdminConfirmMessage,
  policyDataDir,
  pruneAutoUserTasksOnEditResend,
  readSession,
  resolveUserMessageSessionIndex,
  sanitizeHistoryText,
  stripAttachmentSuffix,
  writeSession,
  type Session
} from '../wsSessionHelpers'

import { RunIdSchema } from '../schemas'
import { nowMs } from '../runtimeState'
import { withAgentTraceContext } from '../../../utils/agents/agentTrace'
import type { WsHandlerContext, WsSendFn } from './types'

export type WsSetupResult =
  | { ok: false; send: WsSendFn }
  | { ok: true; ctx: WsHandlerContext; type: string; payload: import('./types').ParsedWsMessage }

export async function setupWsMessage(peer: any, message: any): Promise<WsSetupResult> {
  cleanupMaps()
  const send: WsSendFn = (event, data, from, runId) => {
    try {
      peer.send(JSON.stringify({ event, data, from, runId }))
    } catch {}
    if (runId) void appendRunEvent(runId, { event, data, from, ts: new Date().toISOString() })
  }

  let payloadRaw: any = null
  try {
    const rawText =
      message && typeof (message as any).text === 'function' ? (message as any).text() : String(message)
    payloadRaw = JSON.parse(String(rawText))
  } catch {
    send('error', '消息格式必须为 JSON', 'manager')
    return { ok: false, send }
  }
   const parsed = IncomingMessageSchema.safeParse(payloadRaw)
  if (!parsed.success) {
    send('error', '消息字段不合法（type/sessionId/runId/text 等）', 'manager')
    return { ok: false, send }
  }
  const payload = parsed.data
  const type = payload.type
  const sessionId = payload.sessionId
   if (isManagerWsAuthEnabled() && !isWsPeerAuthed(peer)) {
    const wsToken =
      typeof payloadRaw?.wsToken === 'string'
        ? payloadRaw.wsToken.trim()
        : typeof payloadRaw?.token === 'string'
          ? payloadRaw.token.trim()
          : ''
    const verdict = validateManagerWsAuth({ ...peerRequestMeta(peer), messageToken: wsToken })
    if (!verdict.ok) {
      send('error', verdict.reason || 'WS 鉴权失败', 'manager')
      return { ok: false, send }
    }
    markWsPeerAuthed(peer)
  }
   const peerKey = String((peer as any)?.id || 'peer')
  if (!allowRate(`${peerKey}:all`, 30, 10_000)) {
    send('error', '请求过于频繁，请稍后再试', 'manager')
    return { ok: false, send }
  }
  touchSession(sessionId)
   peerUnregister.get(peer)?.()
  const unreg = registerWsSessionPeer(peerKey, sessionId, (payload) => {
    try {
      peer.send(JSON.stringify({ event: payload.event, data: payload.data, from: payload.from, runId: payload.runId }))
    } catch {}
  })
  peerUnregister.set(peer, unreg)
   const explicitUserId = 'userId' in payload && payload.userId ? payload.userId : undefined
  const boundUserId = await ensureUserBinding(sessionId, explicitUserId).catch(() => null)
  const tenantId = 'tenantId' in payload && payload.tenantId ? payload.tenantId : undefined
  if (tenantId) {
    void import('#agent-shared/userSessionMapStore')
      .then(({ bindSessionTenant }) => bindSessionTenant(sessionId, tenantId))
      .catch(() => undefined)
  }
  const platformTraceId = 'traceId' in payload && payload.traceId ? payload.traceId : undefined

  return {
    ok: true,
    ctx: {
      peer,
      peerKey,
      send,
      sessionId,
      boundUserId,
      tenantId,
      explicitUserId,
      platformTraceId,
      payloadRaw: payloadRaw as Record<string, unknown>
    },
    type,
    payload
  }
}
