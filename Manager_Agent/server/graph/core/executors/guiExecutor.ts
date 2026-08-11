import { normalizeLobsterCallResult } from '../../../utils/agents/lobsterClient'
import type { ManagerGraphState } from '../../state/state'
import { extractStartUrlFromTask, guiSourceHitsForEvent, isDesktopGuiTask, parseGuiTaskHints, sanitizeGuiStartUrl } from '../agent/guiTaskPayload'
import { extractStructuredPayload } from '../shared'
import type { AgentExecutorDeps, AgentExecutorOpts, AgentStepOutcome } from './types'
import { resolveSubAgentTurnScope, resolveTurnScopeFromMeta } from '../runtime/sessionBridge'
import {
  buildManagerTaskEnvelope,
  isManagerTaskEnvelopeV2Enabled,
  serializeManagerTaskEnvelope,
  type ManagerGuiTaskPayload
} from '#agent-shared/managerTaskEnvelope'
import { callLobsterGuiMcpTask, callLobsterDesktopMcpTask, callCodeAssistMcpTask } from '../../../utils/mcp/managerMcpHost'
import { enrichGuiLobsterMeta } from '#agent-shared/guiSiteRecipesLite'
import { executeMcpToolStep } from './mcpToolExecutor'
import { isManagerMcpToolNodeEnabled, resolveMcpDirectCallFromMeta } from '../../../utils/mcp/resolveMcpDirectCall'
import {
  buildGuiFailureUserMessage,
  detectGuiSemanticBlockFromState,
  extractGuiObservationFromRaw,
  isDockerHeadlessMcpGui,
  isGuiHumanHandoffFailure,
  isGuiIncompleteFailure,
  normalizeGuiVerifyReasonForTask,
  requestGuiHumanConfirm,
  resolveGuiBlockedErrorCode,
  resolveGuiFailureType,
} from '../../../utils/gui/guiHumanConfirm'
import { hasLobsterBrowseEvidence } from '#agent-shared/lobsterRunVerifyLite'

import {
  guiOperateKindFromMeta,
  resolveGuiOperateKindByLlm,
} from '../../../utils/gui/guiOperateKindLlm'
import { resolveGuiWorkflowForTaskKind, sanitizeGuiWorkflowId } from '../../../utils/gui/guiWorkflowAllowlist'
import {
  HANDS_NOT_READY_ERROR_CODE,
  HANDS_NOT_READY_MESSAGE,
  isDesktopEngineReady,
  probeLobsterReady,
  resolveGuiDesktopWsUrl,
  resolveLobsterHandsHttpBase,
} from '../../../utils/gui/guiHandsReady'

function parseMcpGuiRun(
  mcpOut: { ok: boolean; text: string; raw?: unknown },
  task: string,
  runId?: string
) {
  const parsedRaw =
    mcpOut.raw && typeof mcpOut.raw === 'object' ? (mcpOut.raw as Record<string, unknown>) : {}
  const verify =
    parsedRaw.verify && typeof parsedRaw.verify === 'object'
      ? (parsedRaw.verify as { failureType?: string; reason?: string })
      : null
  const resultRow =
    parsedRaw.result && typeof parsedRaw.result === 'object'
      ? (parsedRaw.result as Record<string, unknown>)
      : parsedRaw
  const answer =
    String(resultRow.answer || resultRow.summary || '').trim() || mcpOut.text.slice(0, 8000)
  // poll/status 已对齐 WS：优先用服务端 agentResult，避免 wrapGuiResult 空壳导致「有执行无 final」
  const normalized = normalizeLobsterCallResult(
    {
      ...resultRow,
      task,
      verify: parsedRaw.verify,
      ...(parsedRaw.agentResult && typeof parsedRaw.agentResult === 'object'
        ? { agentResult: parsedRaw.agentResult }
        : {}),
    },
    task,
    runId
  )
  const failureType = resolveGuiFailureType({ verify, agentResult: normalized.agentResult })
  const observation = extractGuiObservationFromRaw(parsedRaw)
  const finalUrl = observation.pageUrl || String(resultRow.finalUrl || resultRow.url || '').trim()
  const semanticOk = mcpOut.ok && normalized.agentResult.ok !== false
  return {
    parsedRaw,
    verify,
    resultRow,
    answer,
    normalized,
    failureType,
    finalUrl,
    semanticOk,
    screenshotDataUrl: observation.screenshotDataUrl,
    lobsterRunId: observation.lobsterRunId,
  }
}

function mcpGuiFailureSummary(mcpOut: { text?: string; raw?: unknown; ok?: boolean }): string {
  const raw = mcpOut.raw && typeof mcpOut.raw === 'object' ? (mcpOut.raw as Record<string, unknown>) : {}
  const err = String(raw.error || '').trim()
  const verify = raw.verify && typeof raw.verify === 'object' ? (raw.verify as { reason?: string }) : null
  const reason = String(verify?.reason || '').trim()
  const status = String(raw.status || '').trim()
  const parts = [err, reason ? `verify=${reason}` : '', status ? `status=${status}` : ''].filter(Boolean)
  if (parts.length) return parts.join('；').slice(0, 160)
  return String(mcpOut.text || 'lobster MCP run failed').slice(0, 120)
}

function mcpRawHasBrowseEvidence(mcpOut: { raw?: unknown; ok?: boolean }): boolean {
  const raw = mcpOut.raw && typeof mcpOut.raw === 'object' ? (mcpOut.raw as Record<string, unknown>) : {}
  if (hasLobsterBrowseEvidence(raw.result)) return true
  const pageUrl = String(raw.page_url || '').trim()
  if (pageUrl.startsWith('http')) return true
  const shot = String(raw.screenshot_data_url || '').trim()
  return Boolean(shot)
}

function buildMcpGuiStepOutcome(input: {
  task: string
  mcpOut: { ok: boolean; text: string; raw?: unknown }
  parsed: ReturnType<typeof parseMcpGuiRun>
  ok: boolean
  error?: string
  meta?: Record<string, unknown>
  outputOverride?: string
}): AgentStepOutcome & { task?: string; rawResult?: unknown } {
  const { task, mcpOut, parsed, ok, error, meta, outputOverride } = input
  const output = outputOverride || parsed.normalized.answer || parsed.answer || mcpOut.text
  const raw = mcpOut.raw && typeof mcpOut.raw === 'object' ? (mcpOut.raw as Record<string, unknown>) : {}
  const resultRow =
    raw.result && typeof raw.result === 'object' ? (raw.result as Record<string, unknown>) : raw
  const sourceHits = guiSourceHitsForEvent({
    ...resultRow,
    finalUrl: parsed.finalUrl || resultRow.finalUrl || raw.page_url,
  })
  const hasShot = Boolean(
    String(parsed.screenshotDataUrl || raw.screenshot_data_url || '').trim() || resultRow.hasScreenshot
  )
  const handoffFt = isGuiHumanHandoffFailure(parsed.failureType) || isGuiHumanHandoffFailure(String(error || ''))
  const rawErr = error || parsed.failureType || parsed.verify?.reason
  const resolvedError = !ok
    ? resolveGuiBlockedErrorCode(normalizeGuiVerifyReasonForTask(task, String(rawErr || '')))
    : undefined
  return {
    ok,
    agent: 'gui',
    output,
    query: task,
    parsed: extractStructuredPayload(output),
    evidence: {
      kind: 'gui',
      query: task,
      transport: 'mcp',
      engine: 'lobster-gui',
      itemCount: sourceHits.length,
      items: sourceHits,
      finalUrl: parsed.finalUrl || String(resultRow.finalUrl || raw.page_url || ''),
      hasScreenshot: hasShot,
      ...(ok ? {} : { failed: true, verifyReason: String(parsed.verify?.reason || '') }),
    },
    rawResult: mcpOut.raw,
    meta: {
      agentResult: parsed.normalized.agentResult,
      // handoff / !ok 不是缺槽澄清；仅透传真正的 slot needs_clarify
      needsClarify: handoffFt || Boolean(outputOverride)
        ? false
        : Boolean(parsed.normalized.agentResult.needs_clarify),
      ...meta,
    },
    ...(resolvedError ? { error: resolvedError } : {}),
  }
}

function buildGuiSemanticBlockMeta(failureType: string, handoffAttempted: boolean) {
  return {
    guiSemanticBlocked: failureType,
    guiHandoffAttempted: handoffAttempted,
  }
}

/** 验证码/登录墙人工确认后：无头 MCP 重跑易再触发风控，改走 WS + classic 有头引擎 */
function resolveGuiHandoffRetryEngine(failureType: string): string {
  return isGuiHumanHandoffFailure(failureType) ? 'classic' : 'mcp'
}

async function maybeHumanConfirmAndRetryMcpGui(input: {
  task: string
  startUrl?: string
  engineHint?: string
  storageProfile?: string
  browserProfile?: 'managed' | 'user'
  managerTask?: Record<string, unknown>
  managerTaskEnvelope?: string
  guiTimeoutMs: number
  runId?: string
  handoffAlreadyAttempted?: boolean
  sendThinking: (t: string) => void
  sendEvent: AgentExecutorOpts['sendEvent']
  mcpOut: { ok: boolean; text: string; raw?: unknown; retryable?: boolean }
  parsed: ReturnType<typeof parseMcpGuiRun>
}): Promise<{
  mcpOut: typeof input.mcpOut
  parsed: ReturnType<typeof parseMcpGuiRun>
  cancelled?: boolean
  handoffAttempted?: boolean
  skipRetry?: boolean
  /** 人工确认后改走 WS classic（有头/noVNC），禁止再次无头 MCP */
  retryViaWs?: boolean
  retryEngineHint?: string
}> {
  const needsHandoff =
    (!input.mcpOut.ok && input.mcpOut.retryable !== true) ||
    (input.mcpOut.ok && !input.parsed.semanticOk)
  if (!needsHandoff || !isGuiHumanHandoffFailure(input.parsed.failureType)) {
    return { mcpOut: input.mcpOut, parsed: input.parsed }
  }
  if (input.handoffAlreadyAttempted) {
    input.sendThinking('GUI Agent：本轮已人工确认过，验证码仍未通过，不再重复弹窗。')
    return { mcpOut: input.mcpOut, parsed: input.parsed, handoffAttempted: true, skipRetry: true }
  }
  const approved = await requestGuiHumanConfirm({
    runId: input.runId,
    failureType: input.parsed.failureType,
    task: input.task,
    finalUrl: input.parsed.finalUrl,
    screenshotDataUrl: input.parsed.screenshotDataUrl,
    lobsterRunId: input.parsed.lobsterRunId,
    sendThinking: input.sendThinking,
    sendEvent: input.sendEvent,
    timeoutMs: input.guiTimeoutMs,
  })
  if (!approved) {
    return { mcpOut: input.mcpOut, parsed: input.parsed, cancelled: true, handoffAttempted: true }
  }
  const retryEngineHint = resolveGuiHandoffRetryEngine(input.parsed.failureType)
  input.sendThinking(
    retryEngineHint === 'classic'
      ? 'GUI Agent：人工确认完成，改走有头 classic 引擎重试（可在 Lobster :13108/noVNC 完成验证码）…'
      : 'GUI Agent：人工确认完成，重新执行 MCP 任务…'
  )
  if (retryEngineHint === 'classic') {
    return {
      mcpOut: input.mcpOut,
      parsed: input.parsed,
      handoffAttempted: true,
      retryViaWs: true,
      retryEngineHint,
    }
  }
  const mcpOut = await callLobsterGuiMcpTask({
    task: input.task,
    startUrl: input.startUrl,
    engineHint: input.engineHint,
    storageProfile: input.storageProfile,
    browserProfile: input.browserProfile,
    timeoutMs: input.guiTimeoutMs,
    managerTask: input.managerTask,
    managerTaskEnvelope: input.managerTaskEnvelope,
    handoffContext: 'post_human_confirm',
    callbacks: {
      sendThinking: input.sendThinking,
      sendEvent: input.sendEvent,
      managerRunId: input.runId,
    },
  })
  return {
    mcpOut,
    parsed: parseMcpGuiRun(mcpOut, input.task, input.runId),
    handoffAttempted: true,
  }
}

export function isGuiMcpFirstEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_GUI_MCP_FIRST ?? '0').trim() === '1'
}

export function resolveGuiTimeoutMs(fallbackMs: number, task?: string): number {
  const base = Number(process.env.MANAGER_GUI_TIMEOUT_MS ?? 360_000)
  const configured = Number.isFinite(base) && base > 0 ? Math.floor(base) : 360_000
  const formMs = Number(process.env.MANAGER_GUI_TIMEOUT_FORM_MS ?? 360_000)
  const videoMs = Number(process.env.MANAGER_GUI_TIMEOUT_VIDEO_MS ?? 480_000)
  const t = String(task || '')
  const isForm = /(登录|填表|提交|OA|后台|表单)/i.test(t)
  const isVideo = /(播放|观看|视频|弹幕|B站|bilibili|哔哩)/i.test(t)
  let picked = configured
  if (isForm && Number.isFinite(formMs) && formMs > 0) picked = Math.max(picked, Math.floor(formMs))
  if (isVideo && Number.isFinite(videoMs) && videoMs > 0) picked = Math.max(picked, Math.floor(videoMs))
  return Math.max(picked, fallbackMs)
}

/** HITL 后 classic 有头重试：含验证码等待 + 多步决策，需更长超时 */
export function resolveGuiHandoffTimeoutMs(baseMs: number, task?: string): number {
  const handoffMs = Number(process.env.MANAGER_GUI_TIMEOUT_HANDOFF_MS ?? 480_000)
  const configured = Number.isFinite(handoffMs) && handoffMs > 0 ? Math.floor(handoffMs) : 480_000
  return Math.max(resolveGuiTimeoutMs(baseMs, task), configured)
}

export function isGuiEngineRetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_GUI_RETRY_ON_ENGINE_FAIL ?? '1').trim() !== '0'
}

/** 网页不再跨引擎级联（mcp/classic）；依赖 Lobster 内 Stagehand + gui-plus。
 * 返回 undefined = 不换引擎重试。desktop/mobile 不适用本函数。 */
export function nextGuiEngineHintForRetry(_current?: string): string | undefined {
  return undefined
}

export async function executeGuiStep(
  deps: AgentExecutorDeps,
  opts: AgentExecutorOpts,
  input: {
    state: ManagerGraphState
    effQuery: string
    timeoutMs: number
    sendThinking: (t: string) => void
  }
): Promise<AgentStepOutcome & { task?: string; rawResult?: unknown }> {
  const rawTask = String(input.effQuery || deps.lastUserText(input.state.messages) || '').trim()
  const hints = parseGuiTaskHints(rawTask)
  let task = hints.task || rawTask
  const lastUser = String(deps.lastUserText(input.state.messages) || '').trim()
  const startUrlRaw =
    extractStartUrlFromTask(task) ||
    extractStartUrlFromTask(rawTask) ||
    extractStartUrlFromTask(lastUser)
  const startUrl = sanitizeGuiStartUrl(startUrlRaw) || startUrlRaw
  // 改写后的 queryFocus 常丢 URL；回填到 task，与 crawler→gui handoff 一致
  if (startUrl && !task.includes(startUrl)) {
    task = `${task}\n起始URL: ${startUrl}`
  }
  const guiTimeoutMs = resolveGuiTimeoutMs(input.timeoutMs, task)
  let engineHint = hints.engineHint

  const operateFromMeta = guiOperateKindFromMeta(input.state.meta)
  let operateKind = operateFromMeta
  if (!operateKind) {
    try {
      operateKind = await resolveGuiOperateKindByLlm({ userText: task, state: input.state })
    } catch {
      operateKind = null
    }
  }
  const taskKind = operateKind?.task_kind
  const needsLogin = operateKind?.needs_login === true
  if (operateKind) {
    input.sendThinking(
      `GUI 操作类型：${operateKind.task_kind}${needsLogin ? '（needs_login）' : ''} · conf=${operateKind.confidence.toFixed(2)}`,
    )
    if (operateKind.dropped_workflow_id) {
      input.sendThinking(
        `GUI：未知宏「${operateKind.dropped_workflow_id}」已丢弃，改走逐步 GUI`,
      )
    }
  }

  // 禁止经验召回写入 forced engineHint（软偏好仅留 lobster meta）
  // 用户显式「引擎:xxx」仍走 hints.engineHint

  // workflow：LLM 优先；显式 `工作流:` hint 仅作 overlay。未知/与 task_kind 不兼容的宏丢弃。
  const rawWorkflowId =
    String(operateKind?.workflow_id || '').trim() || String(hints.workflowId || '').trim() || undefined
  const wfSanitized = resolveGuiWorkflowForTaskKind(rawWorkflowId, taskKind)
  const workflowId = wfSanitized.ok ? wfSanitized.id : undefined
  if (!wfSanitized.ok && wfSanitized.dropped) {
    const viaAllowlist = !sanitizeGuiWorkflowId(wfSanitized.dropped).ok
    input.sendThinking(
      viaAllowlist
        ? `GUI：未知宏「${wfSanitized.dropped}」已丢弃，改走逐步 GUI`
        : `GUI：宏「${wfSanitized.dropped}」与 task_kind=${taskKind || '?'} 不兼容已丢弃，改走逐步 GUI`,
    )
  } else if (operateKind?.dropped_workflow_id && !workflowId) {
    input.sendThinking(
      `GUI：宏「${operateKind.dropped_workflow_id}」已丢弃，改走逐步 GUI`,
    )
  }

  // Docker / 网页：透传用户显式引擎 hint；Lobster_Agent 多引擎路由
  const storageProfile =
    hints.storageProfile ||
    (opts.userId && opts.sessionId ? `${opts.userId}_${opts.sessionId}` : opts.sessionId || opts.userId)
  const browserProfile = hints.browserProfile
  const isDesktopTask =
    isDesktopGuiTask(task, startUrl) || engineHint === 'desktop' || hints.engineHint === 'desktop'

  const turn_scope = resolveSubAgentTurnScope(input.state.meta) ?? resolveTurnScopeFromMeta(input.state.meta)
  const handoffAlreadyAttempted = Boolean(input.state.meta?.guiHandoffAttempted)
  const priorBlock = detectGuiSemanticBlockFromState(input.state)
  if (priorBlock.blocked && handoffAlreadyAttempted) {
    const blockedMsg = buildGuiFailureUserMessage({
      failureTypeOrReason: priorBlock.failureType || 'captcha',
      task,
      finalUrl: priorBlock.finalUrl,
      headlessMcp: isDockerHeadlessMcpGui(),
      alreadyHandoff: true,
    })
    input.sendThinking('GUI Agent：跳过重复执行（验证码/登录墙本轮已处理过）')
    return {
      ok: false,
      agent: 'gui',
      output: blockedMsg,
      query: task,
      error: resolveGuiBlockedErrorCode(priorBlock.failureType || 'task_blocked'),
      meta: buildGuiSemanticBlockMeta(priorBlock.failureType || 'captcha', true),
    }
  }
  const lobsterMeta = enrichGuiLobsterMeta(task, startUrl, hints.engineHint)
  // 仅用户显式引擎 hint 或 desktop 可 forced；禁止经验/recipe → engineHint
  const forcedEngineHint = isDesktopTask
    ? 'desktop'
    : hints.engineHint || undefined

  const workflowArgs: Record<string, unknown> = {
    ...(operateKind?.workflow_args || {}),
    ...(hints.workflowArgs || {}),
    ...(startUrl ? { startUrl } : {}),
  }
  if (workflowId) {
    input.sendThinking(
      `GUI Workflow Macro：${workflowId}${
        operateKind?.workflow_id ? '（LLM）' : '（显式 hint）'
      }`,
    )
  }

  const guiPayload: ManagerGuiTaskPayload = {
    source: 'manager',
    task,
    startUrl,
    storageProfile: storageProfile ? String(storageProfile) : undefined,
    engineHint: forcedEngineHint,
    ...(taskKind ? { task_kind: taskKind } : {}),
    ...(operateKind ? { needs_login: needsLogin } : {}),
    ...(taskKind ? { intent_hint: taskKind } : {}),
    ...(browserProfile ? { browser_profile: browserProfile } : {}),
    ...(workflowId ? { workflow_id: workflowId } : {}),
    ...(workflowId && Object.keys(workflowArgs).length ? { workflow_args: workflowArgs } : {}),
    ...(lobsterMeta ? { lobster: lobsterMeta } : {}),
    ...(turn_scope ? { turn_scope } : {}),
  }
  const envelope =
    isManagerTaskEnvelopeV2Enabled()
      ? buildManagerTaskEnvelope({
          target_agent: 'gui',
          trace_id: opts.runId,
          session_id: opts.sessionId || opts.runId,
          utterance: task,
          turn_scope,
          payload: { kind: 'gui', data: guiPayload }
        })
      : null

  const runOnce = async (
    hint?: string,
    timeoutOverrideMs?: number,
    handoffContext?: 'initial' | 'post_human_confirm',
  ) => {
    const payload = {
      ...guiPayload,
      engineHint: hint || guiPayload.engineHint,
    }
    const desktopWs =
      isDesktopTask || hint === 'desktop'
        ? resolveGuiDesktopWsUrl({ lobsterAgentWsUrl: opts.lobsterAgentWsUrl })
        : ''
    return deps.callLobsterAgent({
      lobsterAgentWsUrl: desktopWs || opts.lobsterAgentWsUrl,
      timeoutMs: timeoutOverrideMs ?? guiTimeoutMs,
      task,
      startUrl,
      sessionId: opts.sessionId,
      storageProfile: storageProfile ? String(storageProfile) : undefined,
      browserProfile,
      engineHint: hint || forcedEngineHint || (isDesktopTask ? 'desktop' : undefined),
      handoffContext,
      managerTask: payload,
      managerTaskEnvelope: envelope ? serializeManagerTaskEnvelope(envelope) : undefined,
      sendThinking: input.sendThinking,
      sendEvent: opts.sendEvent,
      signal: opts.signal,
      traceId: opts.runId,
      runId: opts.runId,
    })
  }

  try {
    if (isDesktopTask) {
      const handsBase = resolveLobsterHandsHttpBase(process.env, opts.lobsterAgentWsUrl)
      input.sendThinking(`GUI Agent：探测 Hands/desktop 就绪（${handsBase}）…`)
      const probe = await probeLobsterReady({ httpBase: handsBase, timeoutMs: 2500 })
      if (!isDesktopEngineReady(probe)) {
        const detail = probe.error || probe.engines?.desktop?.error || probe.desktop?.error || 'desktop_down'
        input.sendThinking(`GUI Agent：Hands 未就绪（${String(detail).slice(0, 120)}）→ 澄清，不假成功`)
        return {
          ok: false,
          agent: 'gui',
          output: HANDS_NOT_READY_MESSAGE,
          query: task,
          error: HANDS_NOT_READY_ERROR_CODE,
          clarifyQuestions: [
            '请在 Windows 宿主机启动 Hands 侧车（LOBSTER_HANDS_ONLY=1 + LOBSTER_DESKTOP_MCP_ENABLED=1），或设置 LOBSTER_HANDS_WS_URL。',
          ],
          meta: {
            agentResult: {
              ok: false,
              agent: 'gui',
              error_code: HANDS_NOT_READY_ERROR_CODE,
              answer: HANDS_NOT_READY_MESSAGE,
              needs_clarify: true,
              clarify_questions: [
                '请在 Windows 宿主机启动 Hands 侧车（LOBSTER_HANDS_ONLY=1 + LOBSTER_DESKTOP_MCP_ENABLED=1），或设置 LOBSTER_HANDS_WS_URL。',
              ],
              structured: { failureType: HANDS_NOT_READY_ERROR_CODE, probe },
            },
          },
        }
      }
      input.sendThinking(
        `GUI Agent：Hands/desktop 就绪${probe.handsOnly ? '（hands-only）' : ''} · tools=${probe.engines?.desktop?.toolCount ?? probe.desktop?.toolCount ?? '?'}`,
      )
    }

    const mcpDirect = resolveMcpDirectCallFromMeta(input.state.meta)
    if (mcpDirect && isManagerMcpToolNodeEnabled()) {
      input.sendThinking(`GUI/MCP：直调 ${mcpDirect.serverName}/${mcpDirect.toolName}…`)
      const mcpStep = await executeMcpToolStep({
        request: mcpDirect,
        query: task,
        sendThinking: input.sendThinking,
      })
      return {
        ok: mcpStep.ok,
        agent: 'gui',
        output: mcpStep.output,
        query: task,
        parsed: mcpStep.parsed,
        evidence: { kind: 'gui', query: task, transport: 'mcp_direct', ...(mcpStep.evidence ?? {}) },
        rawResult: mcpStep.rawResult,
      }
    }

    if (isDesktopTask && isGuiMcpFirstEnabled()) {
      try {
        input.sendThinking('GUI Agent：桌面任务 MCP（lobster-gui run_desktop_task）…')
        const mcpOut = await callLobsterDesktopMcpTask({
          task,
          timeoutMs: guiTimeoutMs,
          sessionId: opts.sessionId,
          traceId: opts.runId,
          managerTask: guiPayload,
          managerTaskEnvelope: envelope ? serializeManagerTaskEnvelope(envelope) : undefined,
          callbacks: {
            sendThinking: input.sendThinking,
            sendEvent: opts.sendEvent,
            managerRunId: opts.runId,
            signal: opts.signal,
          },
        })
        const parsed = parseMcpGuiRun(mcpOut, task, opts.runId)
        return buildMcpGuiStepOutcome({
          task,
          mcpOut,
          parsed,
          ok: parsed.semanticOk,
          error: parsed.semanticOk ? undefined : parsed.failureType || 'desktop_task_failed',
          meta: { transport: 'mcp', engine: 'desktop' },
        })
      } catch (desktopErr) {
        input.sendThinking(
          `GUI Agent：桌面 MCP 不可用，回退 WebSocket desktop（${String((desktopErr as Error)?.message || desktopErr).slice(0, 120)}）…`,
        )
        engineHint = 'desktop'
      }
    }

    if (isGuiMcpFirstEnabled() && !isDesktopTask) {
      try {
        input.sendThinking('GUI Agent：MCP 主路径（lobster-gui run_browser_task）…')
        let mcpOut = await callLobsterGuiMcpTask({
          task,
          startUrl,
          engineHint: engineHint || hints.engineHint,
          storageProfile: storageProfile ? String(storageProfile) : undefined,
          browserProfile,
          timeoutMs: guiTimeoutMs,
          sessionId: opts.sessionId,
          traceId: opts.runId,
          managerTask: guiPayload,
          managerTaskEnvelope: envelope ? serializeManagerTaskEnvelope(envelope) : undefined,
          handoffContext: 'initial',
          callbacks: {
            sendThinking: input.sendThinking,
            sendEvent: opts.sendEvent,
            managerRunId: opts.runId,
            signal: opts.signal,
          },
        })
        let parsed = parseMcpGuiRun(mcpOut, task, opts.runId)
        if (mcpOut.retryable === true && !mcpOut.ok) {
          // 已有页面/截图证据：落 outcome，禁止整段双跑
          if (mcpRawHasBrowseEvidence(mcpOut) || parsed.finalUrl || parsed.semanticOk) {
            input.sendThinking(
              `GUI Agent：MCP 标记可回退，但已有浏览证据，直接采纳（${mcpGuiFailureSummary(mcpOut)}）`
            )
            const browseOk = parsed.semanticOk === true
            return buildMcpGuiStepOutcome({
              task,
              mcpOut,
              parsed,
              ok: browseOk,
              error: browseOk
                ? undefined
                : normalizeGuiVerifyReasonForTask(
                    task,
                    parsed.failureType || parsed.verify?.reason || mcpGuiFailureSummary(mcpOut),
                  ),
              ...(!browseOk
                ? {
                    outputOverride: buildGuiFailureUserMessage({
                      failureTypeOrReason: normalizeGuiVerifyReasonForTask(
                        task,
                        parsed.failureType || String(parsed.verify?.reason || 'incomplete_task_output'),
                      ),
                      task,
                      finalUrl: parsed.finalUrl,
                      headlessMcp: isDockerHeadlessMcpGui(),
                      hasScreenshot: Boolean(parsed.screenshotDataUrl),
                    }),
                  }
                : {}),
            })
          }
          throw new Error(mcpGuiFailureSummary(mcpOut) || 'lobster MCP run failed')
        }
        const handoff = await maybeHumanConfirmAndRetryMcpGui({
          task,
          startUrl,
          engineHint: engineHint || hints.engineHint,
          storageProfile: storageProfile ? String(storageProfile) : undefined,
          browserProfile,
          managerTask: guiPayload,
          managerTaskEnvelope: envelope ? serializeManagerTaskEnvelope(envelope) : undefined,
          guiTimeoutMs,
          runId: opts.runId,
          handoffAlreadyAttempted,
          sendThinking: input.sendThinking,
          sendEvent: opts.sendEvent,
          mcpOut,
          parsed,
        })
        if (handoff.retryViaWs) {
          const wsHint = handoff.retryEngineHint || 'classic'
          const handoffTimeoutMs = resolveGuiHandoffTimeoutMs(guiTimeoutMs, task)
          input.sendThinking(
            `GUI Agent：有头 classic 重试（超时 ${Math.round(handoffTimeoutMs / 1000)}s）…`
          )
          let res = await runOnce(wsHint, handoffTimeoutMs, 'post_human_confirm')
          let normalized = normalizeLobsterCallResult(res, task, opts.runId)
          let wsFailureType = resolveGuiFailureType({ agentResult: normalized.agentResult })
          const wsBlocked = isGuiHumanHandoffFailure(wsFailureType) && normalized.agentResult.ok === false
          if (wsBlocked) {
            const wsObs = extractGuiObservationFromRaw(normalized.raw)
            const blockedMsg = buildGuiFailureUserMessage({
              failureTypeOrReason: wsFailureType,
              task,
              finalUrl: wsObs.pageUrl,
              headlessMcp: false,
              alreadyHandoff: true,
              hasScreenshot: Boolean(wsObs.screenshotDataUrl),
            })
            return {
              ok: false,
              agent: 'gui',
              output: blockedMsg || normalized.answer,
              query: task,
              parsed: extractStructuredPayload(blockedMsg || normalized.answer),
              evidence: {
                kind: 'gui',
                query: task,
                transport: 'websocket',
                engine: String(
                  (normalized.raw as Record<string, unknown>)?.engine ||
                    (normalized.raw as Record<string, unknown>)?.executionEngine ||
                    'classic'
                ),
                failed: true,
              },
              rawResult: normalized.raw,
              meta: {
                agentResult: normalized.agentResult,
                ...buildGuiSemanticBlockMeta(wsFailureType, true),
              },
              error: resolveGuiBlockedErrorCode(wsFailureType || 'task_blocked'),
            }
          }
          const sourceHits = guiSourceHitsForEvent(normalized.raw)
          return {
            ok: normalized.agentResult.ok !== false,
            agent: 'gui',
            output: normalized.answer,
            query: task,
            parsed: extractStructuredPayload(normalized.answer),
            evidence: {
              kind: 'gui',
              query: task,
              itemCount: sourceHits.length,
              items: sourceHits,
              transport: 'websocket',
              finalUrl: String((normalized.raw as Record<string, unknown>)?.finalUrl || ''),
              engine: String(
                (normalized.raw as Record<string, unknown>)?.engine ||
                  (normalized.raw as Record<string, unknown>)?.executionEngine ||
                  'classic'
              ),
            },
            rawResult: normalized.raw,
            meta: { agentResult: normalized.agentResult, guiHandoffRetriedClassic: true },
          }
        }
        mcpOut = handoff.mcpOut
        parsed = handoff.parsed
        const blockMeta = isGuiHumanHandoffFailure(parsed.failureType)
          ? buildGuiSemanticBlockMeta(parsed.failureType, Boolean(handoff.handoffAttempted))
          : undefined
        if (handoff.cancelled) {
          return buildMcpGuiStepOutcome({
            task,
            mcpOut,
            parsed,
            ok: false,
            error: 'user_cancelled_gui_handoff',
            meta: blockMeta,
          })
        }
        if (handoff.skipRetry) {
          const failCode = normalizeGuiVerifyReasonForTask(
            task,
            parsed.failureType || String(parsed.verify?.reason || 'task_blocked'),
          )
          const blockedMsg = buildGuiFailureUserMessage({
            failureTypeOrReason: failCode,
            task,
            finalUrl: parsed.finalUrl,
            headlessMcp: isDockerHeadlessMcpGui(),
            alreadyHandoff: true,
            hasScreenshot: Boolean(parsed.screenshotDataUrl),
          })
          return buildMcpGuiStepOutcome({
            task,
            mcpOut,
            parsed,
            ok: false,
            error: resolveGuiBlockedErrorCode(failCode),
            meta: blockMeta,
            outputOverride: blockedMsg,
          })
        }
        if (mcpOut.retryable === true && !mcpOut.ok) {
          if (mcpRawHasBrowseEvidence(mcpOut) || parsed.finalUrl || parsed.semanticOk) {
            input.sendThinking(
              `GUI Agent：MCP 标记可回退，但已有浏览证据，直接采纳（${mcpGuiFailureSummary(mcpOut)}）`
            )
            // 有截图/URL 不等于目标达成；仅 semanticOk 才算成功
            const browseOk = parsed.semanticOk === true
            return buildMcpGuiStepOutcome({
              task,
              mcpOut,
              parsed,
              ok: browseOk,
              error: browseOk
                ? undefined
                : normalizeGuiVerifyReasonForTask(
                    task,
                    parsed.failureType || parsed.verify?.reason || mcpGuiFailureSummary(mcpOut),
                  ),
              meta: blockMeta,
              ...(!browseOk
                ? {
                    outputOverride: buildGuiFailureUserMessage({
                      failureTypeOrReason: normalizeGuiVerifyReasonForTask(
                        task,
                        parsed.failureType || String(parsed.verify?.reason || 'incomplete_task_output'),
                      ),
                      task,
                      finalUrl: parsed.finalUrl,
                      headlessMcp: isDockerHeadlessMcpGui(),
                      hasScreenshot: Boolean(parsed.screenshotDataUrl),
                    }),
                  }
                : {}),
            })
          }
          throw new Error(mcpGuiFailureSummary(mcpOut) || 'lobster MCP run failed')
        }
        if (!parsed.semanticOk) {
          const failCode = normalizeGuiVerifyReasonForTask(
            task,
            parsed.failureType || String(parsed.verify?.reason || 'incomplete_task_output'),
          )
          const blockedMsg = buildGuiFailureUserMessage({
            failureTypeOrReason: failCode,
            task,
            finalUrl: parsed.finalUrl,
            headlessMcp: isDockerHeadlessMcpGui(),
            alreadyHandoff: Boolean(handoff.handoffAttempted),
            hasScreenshot: Boolean(parsed.screenshotDataUrl),
          })
          return buildMcpGuiStepOutcome({
            task,
            mcpOut,
            parsed,
            ok: false,
            error: resolveGuiBlockedErrorCode(failCode),
            meta: isGuiHumanHandoffFailure(failCode)
              ? blockMeta
              : isGuiIncompleteFailure(failCode)
                ? undefined
                : blockMeta,
            outputOverride: blockedMsg,
          })
        }
        return buildMcpGuiStepOutcome({ task, mcpOut, parsed, ok: true })
      } catch (mcpErr) {
        input.sendThinking(
          `GUI Agent：MCP 传输失败，回退 WebSocket（${String((mcpErr as Error)?.message || mcpErr).slice(0, 160)}）`
        )
        engineHint = engineHint || hints.engineHint || 'classic'
      }
    }

    let res = await runOnce(isDesktopTask ? 'desktop' : engineHint || hints.engineHint, undefined, 'initial')
    let normalized = normalizeLobsterCallResult(res, task, opts.runId)
    let wsFailureType = resolveGuiFailureType({ agentResult: normalized.agentResult })
    if (isGuiHumanHandoffFailure(wsFailureType) && !handoffAlreadyAttempted) {
      const wsObs = extractGuiObservationFromRaw(normalized.raw)
      const approved = await requestGuiHumanConfirm({
        runId: opts.runId,
        failureType: wsFailureType,
        task,
        finalUrl: wsObs.pageUrl || String((normalized.raw as Record<string, unknown>)?.finalUrl || ''),
        screenshotDataUrl: wsObs.screenshotDataUrl,
        lobsterRunId: wsObs.lobsterRunId,
        sendThinking: input.sendThinking,
        sendEvent: opts.sendEvent,
        timeoutMs: guiTimeoutMs,
      })
      if (!approved) {
        const blockedMsg = buildGuiFailureUserMessage({
          failureTypeOrReason: wsFailureType,
          task,
          finalUrl: wsObs.pageUrl,
          headlessMcp: isDockerHeadlessMcpGui(),
          hasScreenshot: Boolean(wsObs.screenshotDataUrl),
        })
        return {
          ok: false,
          agent: 'gui',
          output: blockedMsg || normalized.answer || '已取消浏览器人工介入。',
          query: task,
          parsed: extractStructuredPayload(blockedMsg || normalized.answer),
          error: 'user_cancelled_gui_handoff',
          meta: {
            agentResult: normalized.agentResult,
            ...buildGuiSemanticBlockMeta(wsFailureType, true),
          },
        }
      }
      input.sendThinking('GUI Agent：人工确认完成，重新执行 WebSocket 任务…')
      const handoffTimeoutMs = resolveGuiHandoffTimeoutMs(guiTimeoutMs, task)
      res = await runOnce(engineHint || hints.engineHint || 'classic', handoffTimeoutMs, 'post_human_confirm')
      normalized = normalizeLobsterCallResult(res, task, opts.runId)
      wsFailureType = resolveGuiFailureType({ agentResult: normalized.agentResult })
    }
    if (
      normalized.agentResult.ok === false &&
      !isGuiHumanHandoffFailure(wsFailureType) &&
      isGuiEngineRetryEnabled() &&
      nextGuiEngineHintForRetry(engineHint || hints.engineHint)
    ) {
      const retryHint = nextGuiEngineHintForRetry(engineHint || hints.engineHint)
      if (retryHint && retryHint !== (engineHint || hints.engineHint)) {
        input.sendThinking(`GUI Agent：换引擎重试（${retryHint}）…`)
        res = await runOnce(retryHint)
        normalized = normalizeLobsterCallResult(res, task, opts.runId)
        wsFailureType = resolveGuiFailureType({ agentResult: normalized.agentResult })
      }
    }
    const sourceHits = guiSourceHitsForEvent(normalized.raw)
    const wsObs = extractGuiObservationFromRaw(normalized.raw)
    const wsFailCode = normalizeGuiVerifyReasonForTask(
      task,
      wsFailureType || normalized.agentResult.error_code || 'incomplete_task_output',
    )
    if (normalized.agentResult.ok === false) {
      const failMsg = buildGuiFailureUserMessage({
        failureTypeOrReason: wsFailCode,
        task,
        finalUrl: wsObs.pageUrl || String((normalized.raw as Record<string, unknown>)?.finalUrl || ''),
        headlessMcp: isDockerHeadlessMcpGui(),
        alreadyHandoff: handoffAlreadyAttempted || Boolean(input.state.meta?.guiHandoffAttempted),
        hasScreenshot: Boolean(wsObs.screenshotDataUrl),
      })
      return {
        ok: false,
        agent: 'gui',
        output: failMsg || normalized.answer,
        query: task,
        parsed: extractStructuredPayload(failMsg || normalized.answer),
        evidence: {
          kind: 'gui',
          query: task,
          itemCount: sourceHits.length,
          items: sourceHits,
          finalUrl: String((normalized.raw as Record<string, unknown>)?.finalUrl || ''),
          engine: String((normalized.raw as Record<string, unknown>)?.engine || (normalized.raw as Record<string, unknown>)?.executionEngine || ''),
          failed: true,
          hasScreenshot: Boolean(wsObs.screenshotDataUrl),
        },
        rawResult: normalized.raw,
        meta: {
          agentResult: normalized.agentResult,
          ...(isGuiHumanHandoffFailure(wsFailCode)
            ? buildGuiSemanticBlockMeta(wsFailCode, true)
            : {}),
        },
        error: resolveGuiBlockedErrorCode(wsFailCode),
      }
    }
    return {
      ok: true,
      agent: 'gui',
      output: normalized.answer,
      query: task,
      parsed: extractStructuredPayload(normalized.answer),
      evidence: {
        kind: 'gui',
        query: task,
        itemCount: sourceHits.length,
        items: sourceHits,
        finalUrl: String((normalized.raw as Record<string, unknown>)?.finalUrl || ''),
        engine: String((normalized.raw as Record<string, unknown>)?.engine || (normalized.raw as Record<string, unknown>)?.executionEngine || ''),
        hasScreenshot: Boolean(wsObs.screenshotDataUrl),
      },
      rawResult: normalized.raw,
      meta: { agentResult: normalized.agentResult },
    }
  } catch (e: unknown) {
    const err = String((e as Error)?.message || e || 'unknown error')
    return {
      ok: false,
      agent: 'gui',
      output: `GUI 自动化失败：${err}`,
      query: task,
      error: err
    }
  }
}

