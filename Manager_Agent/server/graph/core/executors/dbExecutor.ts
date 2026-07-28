import { ensureDbProbeHintsForPlan } from '../../../utils/db/managerDbHintsLlm'
import { judgeDbPrefetchAlignment } from '../../../utils/db/managerDbPrefetchAlignLlm'
import { prefetchHasDbHints, enrichManagerDbTaskFromPrefetch, stripMisalignedPrefetchFromManagerTask } from '../../../utils/db/managerDbPrefetchReuse'
import { pickRichestDbQuestion, resolveLeanDbUserQuestionAsync, dbAnchorCtx } from '../../../utils/db/managerDbQuestionLlm'
import { shouldOmitManagerDbSchemaHints } from '../../../utils/db/managerDbSchemaHintsPolicy'
import { buildManagerDbTaskPayloadFromState } from '../../../utils/db/managerDbTaskPayload'
import { resolveSubAgentScopeByLlm } from '../../../utils/route/managerSubAgentScopeLlm'
import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'
import type { ManagerGraphState } from '../../state/state'
import { prefetchDbTaskPlan } from '../db/dbPrefetch'
import { resolveDbStepQuestionSync, hasOrchestratedDbScope, dbQueryFocusFromMeta } from '../db/dbStepQuestion'
import { buildDbHistoryFromState, resolveManagerAgentSessionId, resolveSubAgentTurnScope } from '../runtime/sessionBridge'
import { extractStructuredPayload } from '../shared'
import { CTX_SEP } from './sharedHelpers'
import type { AgentExecutorDeps, AgentExecutorOpts, AgentStepOutcome } from './types'

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
  let execState = input.state
  const omitSchemaHints = shouldOmitManagerDbSchemaHints({
    question: input.effQuery,
    lastUser: lastU,
    meta: execState.meta,
    intent: execState.intent
  })
  const probeTableCount = Array.isArray(execState.probe?.db?.tables) ? execState.probe!.db!.tables!.length : 0
  if (
    !omitSchemaHints &&
    !execState.meta?.dbProbeHints &&
    !prefetchHasDbHints(execState.meta) &&
    execState.probe?.db?.matched &&
    input.llmInvoke &&
    probeTableCount >= 2
  ) {
    const dbProbeHints = await ensureDbProbeHintsForPlan({
      state: execState,
      question: input.effQuery,
      llmInvoke: input.llmInvoke,
      willUseDb: true
    })
    if (dbProbeHints.hintTables.length || dbProbeHints.riskNotes.length) {
      execState = {
        ...execState,
        meta: { ...(execState.meta || {}), dbProbeHints }
      }
    }
  }
  const queryParts = String(input.effQuery ?? '').split(CTX_SEP)
  const stepCore = resolveDbStepQuestionSync(
    String(queryParts[0] || '').trim(),
    lastU,
    execState.meta
  )
  const lockDbScope = hasOrchestratedDbScope(execState.meta)
  let dbQuestion: string
  if (lockDbScope) {
    const scopeRes = await resolveSubAgentScopeByLlm({
      agent: 'db',
      meta: execState.meta,
      stepQuery: stepCore,
      userTask: lastU,
      llmInvoke: input.llmInvoke,
      state: execState
    })
    dbQuestion =
      scopeRes.text ||
      dbQueryFocusFromMeta(execState.meta, stepCore) ||
      stepCore ||
      resolveDbStepQuestionSync(String(input.effQuery ?? '').trim(), lastU, execState.meta)
  } else {
    const refinedCore = await resolveLeanDbUserQuestionAsync({
      stepOrRouted: stepCore || String(queryParts[0] || '').trim(),
      lastUserMessage: lastU,
      llmInvoke: input.llmInvoke,
      llm: input.llm,
      state: execState,
      probe: execState.probe
    })
    dbQuestion = pickRichestDbQuestion(refinedCore, lastU, dbAnchorCtx(execState), { meta: execState.meta })
  }
  const dbUserMessage =
    queryParts.length > 1
      ? `${dbQuestion}${CTX_SEP}${queryParts.slice(1).join(CTX_SEP)}`
      : dbQuestion

  const prefetchQ = String(
    (execState.meta as { dbPlanPrefetch?: { question?: string } } | null)?.dbPlanPrefetch?.question || ''
  ).trim()
  const prefetchTables =
    ((execState.meta as { dbPlanPrefetch?: { unified_task_plan?: { hints?: { suggested_tables?: string[] } } } } | null)
      ?.dbPlanPrefetch?.unified_task_plan?.hints?.suggested_tables as string[] | undefined) ?? []
  const align = await judgeDbPrefetchAlignment({
    prefetchQuestion: prefetchQ,
    execQuestion: dbQuestion,
    userTask: lastU,
    suggestedTables: prefetchTables,
    llmInvoke: input.llmInvoke,
    state: execState
  })
  const finalDbMessage =
    align.dbQuestion && align.dbQuestion !== dbQuestion
      ? queryParts.length > 1
        ? `${align.dbQuestion}${CTX_SEP}${queryParts.slice(1).join(CTX_SEP)}`
        : align.dbQuestion
      : dbUserMessage
  if (!align.aligned && prefetchQ) {
    input.sendThinking(
      `数据库：预取问句与执行问句不一致，已跳过 schema 复用（${align.rationale || 'misaligned'}）`
    )
  }
  let allowPrefetchReuse = align.aligned
  if (!align.aligned && opts.dbAgentHttpUrl) {
    const execPlanQ = String(align.dbQuestion || finalDbMessage).split(CTX_SEP)[0]!.trim()
    const fresh = await prefetchDbTaskPlan({
      dbAgentHttpUrl: opts.dbAgentHttpUrl,
      question: execPlanQ,
      timeoutMs: Math.min(input.timeoutMs, 12_000),
      dbId: opts.dbId,
      traceId: opts.runId,
      managerTask: {
        source: 'manager',
        refined_question: execPlanQ,
        must_filters: [],
        schema_search_keywords: ''
      }
    })
    if (fresh.ok && fresh.unified_task_plan) {
      execState = {
        ...execState,
        meta: {
          ...(execState.meta || {}),
          dbPlanPrefetch: { ...fresh, question: execPlanQ }
        }
      }
      allowPrefetchReuse = true
      input.sendThinking(`数据库：已按执行问句重新预取 schema（${fresh.ms}ms）`)
    }
  }
  try {
    const dbSessionId = resolveManagerAgentSessionId(opts)
    const subScope = resolveSubAgentTurnScope(execState.meta)
    const turnScopeMode =
      subScope?.mode ??
      (String((execState.meta as { turnScopeMode?: string } | null)?.turnScopeMode || '').trim() || null)
    const turnKind =
      subScope?.turn_kind ??
      (String((execState.meta as { turnKind?: string } | null)?.turnKind || '').trim() || null)
    const dbRes = await deps.callDbAgent({
      dbAgentWsUrl: opts.dbAgentWsUrl,
      dbAgentHttpUrl: opts.dbAgentHttpUrl,
      dbId: opts.dbId,
      traceId: opts.runId,
      sessionId: dbSessionId,
      timeoutMs: input.timeoutMs,
      messages: buildDbHistoryFromState(input.state.messages, finalDbMessage, { turnScopeMode, turnKind }),
      managerTask: (() => {
        const base = buildManagerDbTaskPayloadFromState(finalDbMessage, execState)
        const enriched = enrichManagerDbTaskFromPrefetch(base, execState.meta, {
          omitSchemaHints: omitSchemaHints && !allowPrefetchReuse,
          allowReuse: allowPrefetchReuse
        })
        return allowPrefetchReuse ? enriched : stripMisalignedPrefetchFromManagerTask(enriched)
      })() ?? undefined,
      sendThinking: input.sendThinking,
      ...(String(process.env.MANAGER_DB_HTTP_ONLY ?? '').trim() === '1' ? { httpOnly: true as const } : {}),
      signal: opts.signal
    })
    let output = String(dbRes?.answer ?? '')
    const ar = dbRes.agentResult
    const isEmpty =
      Boolean(dbRes?.empty) ||
      Boolean(ar?.structured?.empty) ||
      ar?.error_code === 'empty_result' ||
      ar?.error_code === 'schema_miss' ||
      deps.isDbNoData(output)
    const arFailed = ar?.ok === false
    const stepOk = !isEmpty && !arFailed
    if (isEmpty) {
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
    const errorCode = String(ar?.error_code || (isEmpty ? 'empty_result' : '')).trim() || undefined
    return {
      ok: stepOk,
      agent: 'db',
      output,
      query: finalDbMessage,
      parsed: extractStructuredPayload(output),
      error: stepOk ? undefined : errorCode || dbRes.reason || 'db_step_failed',
      evidence: {
        kind: 'db',
        query: finalDbMessage,
        transport: dbRes.transport,
        run_id: dbRes.run_id,
        trace_id: dbRes.trace_id || opts.runId,
        sources: ar?.sources,
        empty: isEmpty,
        reason: dbRes.reason,
        error_code: errorCode,
        executed_sql: ar?.structured?.executed_sql,
        ...(explainPreflight.length ? { explain_preflight: explainPreflight } : {})
      },
      meta: ar ? { agentResult: ar } : {}
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

