import { pickRichestDbQuestion, resolveLeanDbUserQuestionAsync, dbAnchorCtx } from '../../../utils/db/managerDbQuestionLlm'
import { resolveSubAgentScopeByLlm } from '../../../utils/route/managerSubAgentScopeLlm'
import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'
import type { ManagerGraphState } from '../../state/state'
import {
  resolveDbStepQuestionSync,
  hasOrchestratedDbScope,
  dbQueryFocusFromMeta,
  sanitizeSubAgentBusinessQuestion
} from '../db/dbStepQuestion'
import { resolveManagerAgentSessionId } from '../runtime/sessionBridge'
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
  const execState = input.state
  const queryParts = String(input.effQuery ?? '').split(CTX_SEP)
  const stepCore = resolveDbStepQuestionSync(String(queryParts[0] || '').trim(), lastU, execState.meta)
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
  const finalDbMessage = sanitizeSubAgentBusinessQuestion(
    queryParts.length > 1
      ? `${dbQuestion}${CTX_SEP}${queryParts.slice(1).join(CTX_SEP)}`
      : dbQuestion
  )
  try {
    const dbSessionId = resolveManagerAgentSessionId(opts)
    // 透传：仅 NL 问句，等同独立端 /api/ask（不传 managerTask / 编排头）
    const dbRes = await deps.callDbAgent({
      dbAgentWsUrl: opts.dbAgentWsUrl,
      dbAgentHttpUrl: opts.dbAgentHttpUrl,
      dbId: opts.dbId,
      traceId: opts.runId,
      sessionId: dbSessionId,
      timeoutMs: input.timeoutMs,
      messages: [{ role: 'user', content: finalDbMessage }],
      sendThinking: input.sendThinking,
      ...(String(process.env.MANAGER_DB_HTTP_ONLY ?? '').trim() === '1' ? { httpOnly: true as const } : {}),
      signal: opts.signal
    })
    let output = String(dbRes?.answer ?? '')
    const ar = dbRes.agentResult
    const serverOk =
      ar?.ok === true &&
      ar?.error_code !== 'empty_result' &&
      ar?.error_code !== 'schema_miss' &&
      ar?.structured?.empty !== true &&
      dbRes?.empty !== true
    // 空结果以 DB empty / error_code 为准；服务端 ok 时不以文案启发式 isDbNoData 误杀短统计答。
    // 无 agentResult 但正文足够长且不像拒答时，也不用启发式误杀（协议对齐：保留专才 Artifact）。
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
    if (!stepOk) {
      return {
        ok: false,
        agent: 'db',
        output,
        query: finalDbMessage,
        parsed: extractStructuredPayload(output),
        error: errorCode || dbRes.reason || 'db_step_failed',
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
    }
    return {
      ok: true,
      agent: 'db',
      output,
      query: finalDbMessage,
      parsed: extractStructuredPayload(output),
      evidence: {
        kind: 'db',
        query: finalDbMessage,
        transport: dbRes.transport,
        run_id: dbRes.run_id,
        trace_id: dbRes.trace_id || opts.runId,
        sources: ar?.sources,
        empty: false,
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
