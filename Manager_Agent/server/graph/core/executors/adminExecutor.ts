import { buildManagerAdminTaskPayload, adminScopedQueryFromMeta } from '../../../utils/admin/managerAdminTaskPayload'
import { resolveAdminClientContext, callAiAdminPendingDecide } from '../../../utils/agents/adminClient'
import { unwrapAgentCall, wrapAdminResult } from '../../../utils/agents/agentResult'
import type { AgentCallResult } from '../../../utils/agents/agentResult'
import type { AgentResult } from '../../../utils/agents/types'
import { waitGuiConfirm } from '../../../utils/gui/guiConfirmBridge'
import { stripAdminManagerGuards, isAdminResultProtocolGarbage, ADMIN_WRITE_UNCONFIRMED_USER_MSG } from '../../../utils/route/managerSubAgentHelpers'
import { resolveSubAgentScopeByLlm } from '../../../utils/route/managerSubAgentScopeLlm'
import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'
import type { ManagerGraphState } from '../../state/state'
import { isAdminReadOnlyOrchestrationStep } from '../db/writeGate'
import {
  buildAutoConfirmAuditMetric,
  resolveAdminAutoConfirmDecision
} from './autoConfirmAudit'
import { appendMetrics } from '../runtime/runtimePersistence'
import {
  gateCopy,
  inferActionKindFromAgent,
  resolveRiskExecutionPolicy
} from '../policy/riskExecutionPolicy'
import { mintHitlConfirmToken } from '#agent-shared/agentServiceAuth'
import {
  buildSpecialistBrief,
  shouldAttachSpecialistBrief,
  specialistBriefMaxToolRounds
} from '#agent-shared/specialistBrief'
import { resolveManagerAgentSessionId } from '../runtime/sessionBridge'
import {
  adminResponseSignalsPendingConfirm,
  buildAdminExecMessage,
  extractAdminPendingActions,
  extractAdminPendingOps,
  extractAdminSubtaskText
} from '../stepIsolation'
import { isGenericQueryFocus } from '../../../utils/route/managerSubAgentScopeLlm'
import type { AgentExecutorDeps, AgentExecutorOpts, AgentStepOutcome } from './types'
import { hasSuccessfulAdminWriteInRun } from '../output/criticEvidence'

function adminPendingOpLabels(
  adminText: string,
  agentResult?: AgentResult | null
): string[] {
  const rows = extractAdminPendingActions(agentResult)
  if (rows.length) {
    return rows.map((r) => r.title || r.tool || `action[${r.id}]`)
  }
  return extractAdminPendingOps(adminText)
}

function adminClarifyQuestions(adminText: string, agentResult?: AgentResult | null): string[] {
  const fromAr = Array.isArray(agentResult?.clarify_questions)
    ? agentResult!.clarify_questions!.map((q) => String(q || '').trim()).filter((q) => q.length >= 4)
    : []
  if (fromAr.length) return fromAr.slice(0, 4)
  const wrapped = wrapAdminResult(adminText)
  if (wrapped.needs_clarify && Array.isArray(wrapped.clarify_questions) && wrapped.clarify_questions.length) {
    return wrapped.clarify_questions.slice(0, 4)
  }
  if (agentResult?.needs_clarify === true || wrapped.needs_clarify) {
    const t = String(adminText || '').trim()
    if (t.length >= 4) return [t.slice(0, 240)]
  }
  return []
}

function adminStepOk(adminText: string, agentResult?: AgentResult | null, pendingConfirm?: boolean): boolean {
  if (pendingConfirm) return false
  if (agentResult?.needs_clarify === true) return false
  const wrapped = wrapAdminResult(adminText)
  if (wrapped.ok === false) return false
  return agentResult?.ok !== false
}

function buildManagerAdminWsMessage(
  scopedAction: string,
  opts: {
    autoConfirm?: boolean
    readOnlyOrchestration?: boolean
    upstreamContext?: string
    fallbackTask?: string
  }
): string {
  // lean 子句出站；槽位权威在 manager_task.action_text / source_user_task
  return buildAdminExecMessage(String(scopedAction || '').trim(), opts)
}

function buildPendingDecideClientContext(
  scopedAction: string,
  managerTask: ReturnType<typeof buildManagerAdminTaskPayload>,
  extra?: { confirm_token?: string; blast_radius?: string }
): Record<string, unknown> | undefined {
  return {
    manager_orchestrated: true,
    manager_task: {
      source: 'manager',
      action_text: scopedAction,
      ...(managerTask.source_user_task ? { source_user_task: managerTask.source_user_task } : {}),
      ...(managerTask.read_only ? { read_only: true } : {}),
      ...(extra?.confirm_token ? { confirm_token: extra.confirm_token } : {}),
      ...(extra?.blast_radius ? { blast_radius: extra.blast_radius } : {})
    },
    ...(extra?.confirm_token ? { confirm_token: extra.confirm_token } : {}),
    ...(extra?.blast_radius ? { blast_radius: extra.blast_radius } : {})
  }
}

function resolveAdminScopeQuery(input: {
  scopeQuery?: string
  effQuery: string
  meta: unknown
  lastUserTask?: string
}): string {
  const fromInput = String(input.scopeQuery || '').trim()
  if (fromInput.length >= 4 && !isGenericQueryFocus(fromInput)) return fromInput
  const fromUser = extractAdminSubtaskText(String(input.lastUserTask || '').trim())
  if (fromUser.length >= 4 && !isGenericQueryFocus(fromUser)) return fromUser
  const extracted = extractAdminSubtaskText(input.effQuery)
  if (extracted.length >= 4 && !isGenericQueryFocus(extracted)) return extracted
  const fromMeta = adminScopedQueryFromMeta(input.meta, fromInput || fromUser || input.effQuery)
  if (fromMeta.length >= 4 && !isGenericQueryFocus(fromMeta)) return fromMeta
  return fromInput || fromUser || extracted || String(input.effQuery || '').trim()
}

export async function executeAdminStep(
  deps: AgentExecutorDeps,
  opts: AgentExecutorOpts,
  input: {
    state: ManagerGraphState
    effQuery: string
    scopeQuery?: string
    timeoutMs: number
    sendThinking: (t: string) => void
    message?: string
    llmInvoke?: LlmInvokeFn | null
  }
): Promise<AgentStepOutcome> {
  try {
    // 图级重试双保险：本 run 已有成功写证据则不再 HTTP 调 Admin（resumeAdminConfirm 续跑除外）
    const resumeConfirm =
      Boolean((input.state as { resumeAdminConfirm?: boolean }).resumeAdminConfirm) ||
      Boolean((input.state.meta as { resumeAdminConfirm?: boolean } | undefined)?.resumeAdminConfirm)
    if (
      !resumeConfirm &&
      hasSuccessfulAdminWriteInRun({
        results: input.state.results as Record<string, unknown> | undefined,
        evidence: Array.isArray(input.state.evidence) ? (input.state.evidence as Array<Record<string, unknown>>) : []
      })
    ) {
      const prior = String((input.state.results as Record<string, unknown> | undefined)?.admin || '').trim()
      input.sendThinking('admin：本轮写操作已成功，跳过重复执行（side_effect_done）')
      return {
        ok: true,
        agent: 'admin',
        output: prior || '（复用上轮已成功的 admin 写结果）',
        query: input.effQuery,
        meta: { reusedPriorAdminWrite: true, reason: 'side_effect_done' }
      }
    }
    const lastU = deps.lastUserText(input.state.messages)
    const scopeSeed = resolveAdminScopeQuery({
      scopeQuery: input.scopeQuery,
      effQuery: input.effQuery,
      meta: input.state.meta,
      lastUserTask: lastU
    })
    const preScoped = String(input.scopeQuery || '').trim()
    let scopedAction = ''
    if (preScoped.length >= 4 && !isGenericQueryFocus(preScoped)) {
      scopedAction = stripAdminManagerGuards(preScoped) || preScoped
    } else if (scopeSeed.length >= 4 && !isGenericQueryFocus(scopeSeed)) {
      scopedAction = stripAdminManagerGuards(scopeSeed) || scopeSeed
    } else {
      const scopeRes = await resolveSubAgentScopeByLlm({
        agent: 'admin',
        meta: input.state.meta,
        stepQuery: scopeSeed,
        userTask: lastU,
        llmInvoke: input.llmInvoke,
        state: input.state
      })
      scopedAction =
        stripAdminManagerGuards(scopeRes.text) ||
        scopeRes.text ||
        adminScopedQueryFromMeta(input.state.meta, scopeSeed) ||
        scopeSeed ||
        input.effQuery
    }
    const managerTask = buildManagerAdminTaskPayload({
      actionText: scopedAction || stripAdminManagerGuards(input.effQuery) || input.effQuery,
      meta: input.state.meta,
      scopedText: scopedAction || stripAdminManagerGuards(input.effQuery) || undefined,
      sourceUserTask: String(lastU || '').trim() || undefined,
      specialistBrief: shouldAttachSpecialistBrief({
        managerOrchestrated: true,
        executionTopology: String(
          (input.state.meta as { executionTopology?: string } | undefined)?.executionTopology || ''
        ),
        stepCount: Array.isArray((input.state.meta as { planSteps?: unknown } | undefined)?.planSteps)
          ? ((input.state.meta as { planSteps: unknown[] }).planSteps || []).length
          : Array.isArray((input.state as { plan?: { steps?: unknown[] } }).plan?.steps)
            ? ((input.state as { plan: { steps: unknown[] } }).plan.steps || []).length
            : 1
      })
        ? buildSpecialistBrief({
            goal: String(scopedAction || input.effQuery || '').trim().slice(0, 400),
            acceptance: ['工具链完成或产出可核对结果', '写操作须 HITL，禁跳闸'],
            budget: { max_tool_rounds: specialistBriefMaxToolRounds() },
            constraints: {
              read_only: isAdminReadOnlyOrchestrationStep(scopedAction || input.effQuery),
              no_hitl_bypass: true
            }
          })
        : null
    })
    const autoDecision = resolveAdminAutoConfirmDecision(input.state, scopedAction || input.effQuery)
    const adminMessage =
      input.message ??
      buildManagerAdminWsMessage(scopedAction || stripAdminManagerGuards(input.effQuery) || input.effQuery, {
        fallbackTask: scopedAction || stripAdminManagerGuards(input.effQuery) || input.effQuery,
        autoConfirm: autoDecision.autoConfirm,
        readOnlyOrchestration: isAdminReadOnlyOrchestrationStep(scopedAction || input.effQuery)
      })
    if (autoDecision.autoConfirm) {
      const audit = buildAutoConfirmAuditMetric({
        runId: String(opts.runId || input.state?.meta?.runId || 'unknown'),
        trace_id: String(opts.runId || ''),
        step: scopedAction || input.effQuery,
        reason: autoDecision.reason,
        autoConfirm: true
      })
      await appendMetrics(audit).catch(() => undefined)
    }
    const res = await deps.callAiAdminAgent({
      aiAdminAgentWsUrl: opts.aiAdminAgentWsUrl,
      timeoutMs: input.timeoutMs,
      message: adminMessage,
      sessionId: resolveManagerAgentSessionId(opts),
      traceId: opts.runId,
      userId: String(opts.userId || '').trim() || undefined,
      tenantId: String(opts.tenantId || '').trim() || undefined,
      autoConfirmRisky: autoDecision.autoConfirm,
      autoConfirmReason: autoDecision.reason,
      clientContext: resolveAdminClientContext(
        input.state.meta as Record<string, unknown> | undefined,
        managerTask
      ),
      sendThinking: input.sendThinking,
      sendDelta: (d: string) => {
        opts.sendEvent({ event: 'delta', data: d, from: 'admin' })
      },
      sendThoughtDelta: (t: string) => {
        opts.sendEvent({ event: 'thought_delta', data: { text: t, done: false }, from: 'admin' })
      },
      signal: opts.signal
    })
    const { answer: adminTextRaw, agentResult: agentResultRaw } = unwrapAgentCall(res as string | AgentCallResult)
    let adminText = adminTextRaw
    let agentResult = agentResultRaw
    if (isAdminResultProtocolGarbage(adminText)) {
      adminText = '个人助手协议异常：未返回可执行结果。'
      agentResult = {
        ...(agentResult || {}),
        ok: false,
        agent: 'admin',
        answer: adminText,
        error_code: 'admin_protocol_garbage',
        structured: { ...(agentResult?.structured || {}), transport: 'ws', adminWriteTerminal: true }
      }
    }
    const uiCards = Array.isArray((agentResult as { structured?: { ui_cards?: unknown[] } } | undefined)?.structured?.ui_cards)
      ? ((agentResult as { structured?: { ui_cards?: unknown[] } }).structured!.ui_cards as unknown[])
      : []
    if (uiCards.length) {
      opts.sendEvent({
        event: 'admin_ui_cards',
        data: { cards: uiCards },
        from: 'admin'
      })
    }
    const autoConfirm = autoDecision.autoConfirm
    const pendingConfirm = adminResponseSignalsPendingConfirm(adminText, agentResult)
    const riskPolicy = resolveRiskExecutionPolicy({
      actionKind: inferActionKindFromAgent('admin', {
        readOnly: Boolean(managerTask.read_only) || isAdminReadOnlyOrchestrationStep(scopedAction || input.effQuery)
      }),
      meta: input.state.meta,
      securityRiskLevel: (() => {
        const fromState = (input.state as { security?: { riskLevel?: 'low' | 'medium' | 'high' } }).security
          ?.riskLevel
        if (fromState) return fromState
        const m = input.state.meta as { security?: { riskLevel?: 'low' | 'medium' | 'high' } } | undefined
        return m?.security?.riskLevel
      })(),
      worldModelRisk: Number((input.state.meta as { worldModelRisk?: number } | undefined)?.worldModelRisk ?? 0)
    })
    if (pendingConfirm && !autoConfirm) {
      if (!opts.runId) {
        return {
          ok: false,
          agent: 'admin',
          output: adminText,
          query: input.effQuery,
          error: 'admin_pending_confirm_no_run'
        }
      }
      const confirmId = crypto.randomUUID()
      const confirmToken = mintHitlConfirmToken(opts.runId, confirmId)
      const ops = adminPendingOpLabels(adminText, agentResult)
      const opLine = ops.length ? ops.join('、') : '个人事务写操作'
      if (riskPolicy.preferDryRun || riskPolicy.actionGate === 'dry_run_then_confirm') {
        input.sendThinking(`个人助手：${gateCopy('dry_run')} — ${opLine}`)
        opts.sendEvent({
          event: 'dry_run_result',
          data: {
            agent: 'admin',
            badge: gateCopy('dry_run'),
            message: `拟执行（未写入）：${opLine}`,
            preview: String(adminText || '').slice(0, 1200),
            riskPolicy,
            blast_radius: riskPolicy.blast_radius
          },
          from: 'manager'
        })
      }
      input.sendThinking(
        `个人助手：${gateCopy('action')}（${riskPolicy.blast_radius.toUpperCase()}），任务已暂停，等待您确认…`
      )
      opts.sendEvent({
        event: 'human_confirm_request',
        data: {
          confirmId,
          confirm_token: confirmToken,
          title: '个人事务写操作待确认',
          message: `${gateCopy('action')}\n待执行：${opLine}`,
          agent: 'admin',
          riskTier: riskPolicy.tier,
          blast_radius: riskPolicy.blast_radius
        },
        from: 'manager'
      })
      const approved = await waitGuiConfirm(opts.runId, confirmId)
      if (!approved) {
        return {
          ok: false,
          agent: 'admin',
          output: ADMIN_WRITE_UNCONFIRMED_USER_MSG,
          query: input.effQuery,
          error: 'user_cancelled_admin_write',
          meta: { adminWriteTerminal: true, agentResult: { ok: false, error_code: 'user_cancelled_admin_write' } }
        }
      }
      const pendingRows = extractAdminPendingActions(agentResult)
      const decideClientContext = buildPendingDecideClientContext(scopedAction, managerTask, {
        confirm_token: confirmToken,
        blast_radius: riskPolicy.blast_radius
      })
      if (pendingRows.length) {
        let decideText = adminText
        let decideResult: AgentResult | undefined = agentResult
        for (const row of pendingRows) {
          const decideRes = await callAiAdminPendingDecide({
            aiAdminAgentWsUrl: opts.aiAdminAgentWsUrl,
            timeoutMs: input.timeoutMs,
            actionId: row.id,
            decision: '确认',
            originalUserMessage: scopedAction,
            sessionId: resolveManagerAgentSessionId(opts),
            traceId: opts.runId,
            userId: String(opts.userId || '').trim() || undefined,
            tenantId: String(opts.tenantId || '').trim() || undefined,
            clientContext: decideClientContext,
            sendThinking: input.sendThinking,
            signal: opts.signal
          })
          const unwrapped = unwrapAgentCall(decideRes)
          decideText = unwrapped.answer
          decideResult = unwrapped.agentResult
          if (decideResult?.ok === false) break
        }
        const stepOk = adminStepOk(decideText, decideResult, false)
        if (!stepOk) {
          const qs = adminClarifyQuestions(decideText, decideResult)
          return {
            ok: false,
            agent: 'admin',
            output: decideText,
            query: input.effQuery,
            error: String(decideResult?.error_code || (qs.length ? 'needs_clarify' : 'admin_pending_decide_failed')),
            clarifyQuestions: qs.length ? qs : undefined,
            meta: decideResult ? { agentResult: decideResult } : undefined
          }
        }
        return {
          ok: true,
          agent: 'admin',
          output: decideText,
          query: input.effQuery,
          meta: { ...(decideResult ? { agentResult: decideResult } : {}), readOnly: managerTask.read_only === true },
          evidence: {
            kind: 'admin',
            query: input.effQuery,
            agentResult: decideResult,
            readOnly: managerTask.read_only === true,
            pendingDecide: true
          }
        }
      }
      const resumeState = {
        ...input.state,
        meta: {
          ...(input.state.meta && typeof input.state.meta === 'object' ? input.state.meta : {}),
          allowRiskyWrites: true
        }
      } as ManagerGraphState
      return executeAdminStep(deps, opts, { ...input, state: resumeState })
    }
    if (pendingConfirm && autoConfirm && !input.state.meta?.lowCostMode) {
      opts.sendEvent({
        event: 'thinking',
        data: 'admin 步骤已完成；输出中仍有待确认信号，已按本会话自动确认策略继续。',
        from: 'manager'
      })
    }
    const stepOk = adminStepOk(adminText, agentResult, pendingConfirm)
    if (!stepOk) {
      const qs = adminClarifyQuestions(adminText, agentResult)
      const errCode = String(agentResult?.error_code || (qs.length ? 'needs_clarify' : 'admin_pending_or_write_failed'))
      const terminal =
        errCode === 'admin_protocol_garbage' ||
        errCode === 'user_cancelled_admin_write' ||
        errCode === 'admin_write_failed'
      return {
        ok: false,
        agent: 'admin',
        output: adminText,
        query: input.effQuery,
        error: errCode,
        clarifyQuestions: qs.length ? qs : undefined,
        meta: {
          ...(agentResult ? { agentResult } : {}),
          ...(terminal ? { adminWriteTerminal: true } : {})
        }
      }
    }
    return {
      ok: true,
      agent: 'admin',
      output: adminText,
      query: input.effQuery,
      meta: { ...(agentResult ? { agentResult } : {}), readOnly: managerTask.read_only === true },
      evidence: { kind: 'admin', query: input.effQuery, agentResult, readOnly: managerTask.read_only === true }
    }
  } catch (e: unknown) {
    const err = String((e as Error)?.message || e || 'unknown error')
    return {
      ok: false,
      agent: 'admin',
      output: `个人助手步骤失败：${err}\n请检查 AI_admin_Agent 服务是否在线。`,
      query: input.effQuery,
      error: err
    }
  }
}
