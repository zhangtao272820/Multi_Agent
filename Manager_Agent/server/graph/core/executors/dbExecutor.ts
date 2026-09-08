import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'
import type { ManagerGraphState } from '../../state/state'
import {
  resolveDbStepQuestionSync,
  hasOrchestratedDbScope,
  dbQueryFocusFromMeta,
  sanitizeSubAgentBusinessQuestion,
  isSingleSourceDbTask
} from '../db/dbStepQuestion'
import { resolveSubAgentStepSessionId } from '../routing/subAgentPassthrough'
import { extractStructuredPayload } from '../shared'
import { CTX_SEP } from './sharedHelpers'
import type { AgentExecutorDeps, AgentExecutorOpts, AgentStepOutcome } from './types'
import { callDbPendingDecide } from '../../../utils/agents/dbClient'
import { waitGuiConfirm } from '../../../utils/gui/guiConfirmBridge'
import { mintHitlConfirmToken } from '#agent-shared/agentServiceAuth'
import {
  gateCopy,
  inferActionKindFromAgent,
  resolveRiskExecutionPolicy
} from '../policy/riskExecutionPolicy'
import { resolveBlastRadius } from '#agent-shared/blastRadius'

function dbWriteAllowedFromMeta(meta: unknown): boolean {
  const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
  if (m.dbWriteAllowed === true || m.db_write_allowed === true) return true
  if (m.allowRiskyWrites === true && String(process.env.MANAGER_DB_WRITE_WITH_RISKY ?? '0').trim() === '1') {
    return true
  }
  return String(process.env.MANAGER_DB_WRITE_ALLOWED ?? '0').trim() === '1'
}

function dbSignalsPendingConfirm(ar?: { structured?: Record<string, unknown> } | null): boolean {
  const s = ar?.structured
  if (!s) return false
  if (s.needs_human_confirm === true) return true
  const pending = s.pending_actions
  return Array.isArray(pending) && pending.length > 0
}

function extractDbPendingIds(ar?: { structured?: Record<string, unknown> } | null): string[] {
  const s = ar?.structured
  if (!s) return []
  const out: string[] = []
  const pid = String(s.pending_id || '').trim()
  if (pid) out.push(pid)
  const rows = Array.isArray(s.pending_actions) ? s.pending_actions : []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = String((row as { id?: unknown }).id || '').trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out.slice(0, 4)
}

function previewSqlFromResult(ar?: { structured?: Record<string, unknown> } | null, output?: string): string {
  const sql = String(ar?.structured?.executed_sql || '').trim()
  if (sql) return sql.slice(0, 1200)
  return String(output || '').slice(0, 800)
}

function extractImpactEstimate(ar?: { structured?: Record<string, unknown> } | null): {
  estimated_rows?: number | null
  requires_ack?: boolean
  statement_count?: number
} | null {
  const s = ar?.structured
  if (!s) return null
  const raw =
    (s.impact_estimate as Record<string, unknown> | undefined) ||
    (s.meta && typeof s.meta === 'object'
      ? ((s.meta as Record<string, unknown>).impact_estimate as Record<string, unknown> | undefined)
      : undefined)
  const actions = Array.isArray(s.pending_actions) ? s.pending_actions : []
  const fromAction =
    actions.length && actions[0] && typeof actions[0] === 'object'
      ? ((actions[0] as Record<string, unknown>).impact_estimate as Record<string, unknown> | undefined)
      : undefined
  const imp = raw || fromAction
  if (!imp || typeof imp !== 'object') return null
  const rows = imp.estimated_rows
  return {
    estimated_rows: rows === null || rows === undefined ? null : Number(rows),
    requires_ack: Boolean(imp.requires_ack),
    statement_count: Number(imp.statement_count || 1) || 1
  }
}

export async function executeDbStep(
  deps: AgentExecutorDeps,
  opts: AgentExecutorOpts,
  input: {
    state: ManagerGraphState
    effQuery: string
    timeoutMs: number
    sendThinking: (t: string) => void
    llmInvoke?: LlmInvokeFn | null
    llm?: { openaiApiKey?: string; openaiModel?: string; openaiBaseUrl?: string } | null
  }
): Promise<AgentStepOutcome> {
  const lastU = deps.lastUserText(input.state.messages)
  const execState = input.state
  const queryParts = String(input.effQuery ?? '').split(CTX_SEP)
  const stepCore = resolveDbStepQuestionSync(String(queryParts[0] || '').trim(), lastU, execState.meta)
  const singleSource = isSingleSourceDbTask(execState.meta)
  const lockDbScope = hasOrchestratedDbScope(execState.meta)
  let dbQuestion: string
  if (singleSource && lastU.length >= 4) {
    dbQuestion = lastU
  } else if (lockDbScope) {
    dbQuestion =
      dbQueryFocusFromMeta(execState.meta, stepCore) ||
      stepCore ||
      resolveDbStepQuestionSync(String(input.effQuery ?? '').trim(), lastU, execState.meta)
  } else {
    dbQuestion = stepCore || lastU
  }
  const finalDbMessage = singleSource
    ? dbQuestion
    : sanitizeSubAgentBusinessQuestion(
        queryParts.length > 1
          ? `${dbQuestion}${CTX_SEP}${queryParts.slice(1).join(CTX_SEP)}`
          : dbQuestion
      )
  if (lastU && finalDbMessage && lastU !== finalDbMessage) {
    input.sendThinking(
      `DB 出站问句与用户末轮不同（len ${lastU.length}→${finalDbMessage.length}）；multi 子句切分属预期`
    )
  }
  const writeAllowed = dbWriteAllowedFromMeta(execState.meta)
  try {
    const dbSessionId = resolveSubAgentStepSessionId({
      runId: opts.runId,
      agent: 'db',
      stepId: String((execState.meta as { currentStepId?: string } | null)?.currentStepId || '').trim() || undefined
    })
    const managerTask = writeAllowed
      ? {
          source: 'manager',
          write_allowed: true,
          refined_question: finalDbMessage
        }
      : undefined
    if (writeAllowed) {
      input.sendThinking('数据库 Agent：写库预览模式（须 HITL 确认后执行）')
    }
    let dbRes = await deps.callDbAgent({
      dbAgentWsUrl: opts.dbAgentWsUrl,
      dbAgentHttpUrl: opts.dbAgentHttpUrl,
      dbId: opts.dbId,
      traceId: opts.runId,
      sessionId: dbSessionId,
      timeoutMs: input.timeoutMs,
      messages: [{ role: 'user', content: finalDbMessage }],
      sendThinking: input.sendThinking,
      sendDelta: (d: string) => {
        opts.sendEvent({ event: 'delta', data: d, from: 'db' })
      },
      ...(String(process.env.MANAGER_DB_HTTP_ONLY ?? '').trim() === '1' ? { httpOnly: true as const } : {}),
      signal: opts.signal,
      ...(managerTask ? { managerTask } : {})
    })
    let output = String(dbRes?.answer ?? '')
    let ar = dbRes.agentResult

    if (writeAllowed && dbSignalsPendingConfirm(ar)) {
      const riskPolicy = resolveRiskExecutionPolicy({
        actionKind: inferActionKindFromAgent('db', { writeAllowed: true }),
        meta: input.state.meta
      })
      const blast =
        riskPolicy.blast_radius ||
        resolveBlastRadius({ agent: 'db', writeAllowed: true, actionKind: 'db_write' })
      const pendingIds = extractDbPendingIds(ar)
      const sqlPreview = previewSqlFromResult(ar, output)
      const impact = extractImpactEstimate(ar)
      if (!opts.runId) {
        return {
          ok: false,
          agent: 'db',
          output: output || '写库待确认但缺少 runId',
          query: finalDbMessage,
          error: 'db_pending_confirm_no_run',
          meta: ar ? { agentResult: ar } : {}
        }
      }
      const confirmId = crypto.randomUUID()
      const confirmToken = mintHitlConfirmToken(opts.runId, confirmId)
      const impactLine =
        impact?.estimated_rows != null
          ? `\n预估影响约 ${impact.estimated_rows} 行${impact.requires_ack ? '（高影响，确认即视为 impact_ack）' : ''}`
          : impact?.requires_ack
            ? '\n无法预估影响行数（确认即视为 impact_ack）'
            : ''
      input.sendThinking(`数据库：${gateCopy('dry_run')} — 写 SQL 预览（未执行）`)
      opts.sendEvent({
        event: 'dry_run_result',
        data: {
          agent: 'db',
          badge: gateCopy('dry_run'),
          message: '拟执行写库 SQL（未写入）',
          preview: sqlPreview,
          pending_ids: pendingIds,
          impact_estimate: impact,
          riskPolicy,
          blast_radius: blast
        },
        from: 'manager'
      })
      input.sendThinking(
        `数据库：${gateCopy('action')}（${String(blast).toUpperCase()}），等待您确认…`
      )
      opts.sendEvent({
        event: 'human_confirm_request',
        data: {
          confirmId,
          confirm_token: confirmToken,
          title: '数据库写操作待确认',
          message: `${gateCopy('action')}${impactLine}\n\`\`\`sql\n${sqlPreview}\n\`\`\``,
          agent: 'db',
          riskTier: riskPolicy.tier,
          blast_radius: blast,
          pending_ids: pendingIds,
          impact_estimate: impact,
          riskPolicyDecision: riskPolicy
        },
        from: 'manager'
      })
      const approved = await waitGuiConfirm(opts.runId, confirmId)
      if (!approved) {
        for (const pid of pendingIds) {
          try {
            await callDbPendingDecide({
              dbAgentHttpUrl: String(opts.dbAgentHttpUrl || ''),
              pendingId: pid,
              decision: '取消',
              dbId: opts.dbId,
              sessionId: dbSessionId,
              traceId: opts.runId,
              timeoutMs: Math.min(input.timeoutMs, 30_000),
              signal: opts.signal
            })
          } catch {
            /* cancel best-effort */
          }
        }
        return {
          ok: false,
          agent: 'db',
          output: '已取消写库操作，未改动数据库。',
          query: finalDbMessage,
          error: 'user_cancelled_db_write',
          meta: { dbWriteTerminal: true, agentResult: { ok: false, error_code: 'user_cancelled_db_write' } }
        }
      }
      if (!pendingIds.length) {
        return {
          ok: false,
          agent: 'db',
          output: '写库待确认但缺少 pending_id。',
          query: finalDbMessage,
          error: 'db_pending_missing'
        }
      }
      let decideText = output
      let decideAr = ar
      for (const pid of pendingIds) {
        const decideRes = await callDbPendingDecide({
          dbAgentHttpUrl: String(opts.dbAgentHttpUrl || ''),
          pendingId: pid,
          decision: '确认',
          confirmToken,
          blastRadius: blast,
          // HITL 确认卡已展示影响预估：用户点确认 = impact_ack
          impactAck: true,
          dbId: opts.dbId,
          sessionId: dbSessionId,
          traceId: opts.runId,
          timeoutMs: input.timeoutMs,
          signal: opts.signal,
          sendThinking: input.sendThinking
        })
        decideText = String(decideRes.answer || '')
        decideAr = decideRes.agentResult
        if (decideAr?.ok === false) break
      }
      output = decideText
      ar = decideAr
      dbRes = { ...dbRes, answer: decideText, agentResult: decideAr, empty: false }
    }

    const softEmpty =
      ar?.ok === true &&
      (ar?.error_code === 'empty_result' || ar?.structured?.empty === true || dbRes?.empty === true)
    const serverOk =
      softEmpty ||
      (ar?.ok === true &&
        ar?.error_code !== 'empty_result' &&
        ar?.error_code !== 'schema_miss' &&
        ar?.structured?.empty !== true &&
        dbRes?.empty !== true)
    const heuristicEmpty = ar?.ok !== true && deps.isDbNoData(output)
    const richNonEmptyAnswer =
      !ar &&
      output.trim().length >= 40 &&
      !heuristicEmpty
    const isEmpty = serverOk || richNonEmptyAnswer
      ? false
      : Boolean(dbRes?.empty) ||
        Boolean(ar?.structured?.empty) ||
        ar?.error_code === 'empty_result' ||
        ar?.error_code === 'schema_miss' ||
        heuristicEmpty
    const arFailed = ar?.ok === false && !softEmpty
    const stepOk = softEmpty ? true : !isEmpty && !arFailed
    if (isEmpty && !softEmpty) {
      output = output ? `${output}\n(注：未在数据库中查到匹配的明细数据)` : '数据库未查到相关记录。'
    }
    const explainPreflight = Array.isArray(ar?.structured?.explain_preflight)
      ? (ar!.structured!.explain_preflight as string[]).map((x) => String(x ?? '').trim()).filter(Boolean)
      : []
    if (explainPreflight.length) {
      input.sendThinking(`数据库 Agent：SQL 预检提示 — ${explainPreflight[0]}`)
      opts.sendEvent({
        event: 'db_explain',
        data: { insights: explainPreflight, agent: 'db' },
        from: 'db'
      })
    }
    const errorCode = softEmpty
      ? undefined
      : String(ar?.error_code || (isEmpty ? 'empty_result' : '')).trim() || undefined
    const fieldDetails = Array.isArray(ar?.structured?.field_details)
      ? ar!.structured!.field_details
      : Array.isArray(ar?.structured?.fieldDetails)
        ? ar!.structured!.fieldDetails
        : undefined
    const dbEvidenceBase = {
      kind: 'db' as const,
      query: finalDbMessage,
      transport: dbRes.transport,
      run_id: dbRes.run_id,
      trace_id: dbRes.trace_id || opts.runId,
      sources: ar?.sources,
      executed_sql: ar?.structured?.executed_sql,
      ...(explainPreflight.length ? { explain_preflight: explainPreflight } : {}),
      ...(ar?.structured?.chart != null ? { chart: ar.structured.chart } : {}),
      ...(ar?.structured?.deliverables && typeof ar.structured.deliverables === 'object'
        ? { deliverables: ar.structured.deliverables }
        : {}),
      ...(Array.isArray(ar?.structured?.rows) && ar.structured.rows.length
        ? { rows: ar.structured.rows }
        : {}),
      ...(Array.isArray(fieldDetails) && fieldDetails.length ? { field_details: fieldDetails } : {}),
      ...(ar ? { agentResult: ar } : {})
    }
    if (!stepOk) {
      return {
        ok: false,
        agent: 'db',
        output,
        query: finalDbMessage,
        parsed: extractStructuredPayload(output),
        error: errorCode || dbRes.reason || 'db_step_failed',
        evidence: {
          ...dbEvidenceBase,
          empty: isEmpty,
          reason: dbRes.reason,
          error_code: errorCode
        },
        meta: ar ? { agentResult: ar } : {}
      }
    }
    return {
      ok: true,
      agent: 'db',
      output,
      query: finalDbMessage,
      parsed: extractStructuredPayload(output),
      evidence: {
        ...dbEvidenceBase,
        empty: softEmpty ? true : false,
        reason: softEmpty ? 'empty_result' : dbRes.reason,
        error_code: errorCode
      },
      meta: ar ? { agentResult: ar, ...(writeAllowed ? { dbWrite: true } : {}) } : {}
    }
  } catch (e: unknown) {
    const err = String((e as Error)?.message || e || 'unknown error')
    const qs = deps.buildClarifyQuestions?.(String(input.state.routedQuery || ''), 'db', input.state.probe) ?? []
    const output = qs.length
      ? `数据库步骤失败：${err}\n\n为继续完成任务，需要补充：\n${qs.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : `数据库步骤失败：${err}\n\n为继续完成任务，请补充时间范围、对象唯一标识（姓名/编号）、以及输出口径（明细/汇总）。`
    return { ok: false, agent: 'db', output, query: finalDbMessage, error: err }
  }
}
