import { unwrapAgentCall } from '../../../utils/agents/agentResult'
import type { AgentCallResult, AgentResult } from '../../../utils/agents/agentResult'
import { callRagProbe, ragProbeTimeoutMs } from '../../../utils/agents/ragClient'
import { buildRagRefocusMessage, isRagRelevanceJudgeEnabled, refineRagAnswerIfIrrelevant } from '../../../utils/rag/managerRagRelevance'
import type { ManagerGraphState } from '../../state/state'
import { resolveLeanRagQuery } from '../probe/retrieverPlan'
import { isManagerRagRetrieveFirstEnabled, shouldSkipRagRelevanceRefine, shouldTreatRagAsMiss } from '../rag/ragRetrievePolicy'
import { isSingleSourceRagTask, isTrueMultiTask, resolveSubAgentStepSessionId } from '../routing/subAgentPassthrough'
import { classifyAndDetectHard } from '../runtime/expertFailure'
import { buildRagHistoryFromState } from '../runtime/sessionBridge'
import { collectSubAgentScopeCandidates, pickSubAgentScopeSync } from '../../../utils/route/managerSubAgentScopeLlm'
import { extractStructuredPayload } from '../shared'
import { parseRagClarifyPayload } from '../text'
import { resolveRagRetrievalBundle, tryRagProbeSnippetFastPath, finishRagFastPath, tryRagRetrieveAlignedPath } from './ragRetrieval'
import { countRagEvidenceUnits, mergeRagClarifyQuestions, isChatRevisionMeta } from './sharedHelpers'
import type { AgentExecutorDeps, AgentExecutorOpts, AgentStepOutcome } from './types'
import { callRagMcpRetrieve } from '../../../utils/mcp/managerMcpHost'
import { groundFollowupQuery, shouldGroundFollowupQuery } from '#agent-shared/followupQueryGrounding'
import { sessionIntentAnchorFromMeta } from '../memory/multiTurnIntent'

function isRagHardFailureBlob(x: unknown): x is { hardFailure: true; error_code?: string; agentResult?: AgentResult } {
  return Boolean(x && typeof x === 'object' && (x as { hardFailure?: boolean }).hardFailure === true)
}

function ragHardFailOutcome(input: {
  query: string
  errorCode: string
  detail?: string
  agentResult?: AgentResult
}): AgentStepOutcome {
  const code = String(input.errorCode || 'network').trim() || 'network'
  const detail = String(input.detail || code).slice(0, 200)
  return {
    ok: false,
    agent: 'rag',
    output: `知识库（RAG）暂不可用（${code}），已截断后续检索以免空转。${detail ? `详情：${detail}` : ''}`,
    query: input.query,
    error: detail || code,
    meta: {
      agentResult: input.agentResult || { ok: false, error_code: code },
      hardFailure: true,
      error_code: code
    }
  }
}

export function isRagMcpFirstEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_RAG_MCP_FIRST ?? '0').trim() === '1'
}

export async function executeRagStep(
  deps: AgentExecutorDeps,
  opts: AgentExecutorOpts,
  input: {
    state: ManagerGraphState
    question: string
    baseQuery: string
    effQuery: string
    timeoutMs: number
    sendThinking: (t: string) => void
    sendDelta?: (d: string) => void
    allowRetry: boolean
    onStrategyHint?: (meta: unknown) => void
  }
): Promise<AgentStepOutcome> {
  let ragEvidence: Record<string, unknown> | null = null
  let ragAgentResult: import('../../utils/agents/types').AgentResult | undefined
  const revisionSkipCache = isChatRevisionMeta(input.state.meta)
  let probeRag = input.state.probe?.rag
  const leanForProbe = resolveLeanRagQuery(String(input.baseQuery || input.question || ''), String(input.question || ''))

  const metaHard = (input.state.meta as { expertHardDown?: Record<string, string> } | null)?.expertHardDown
  const prefetchHard = (input.state.meta as { ragRetrievePrefetch?: { hardFailure?: boolean; error_code?: string; error?: string } } | null)
    ?.ragRetrievePrefetch
  if (metaHard?.rag || prefetchHard?.hardFailure) {
    const code = String(metaHard?.rag || prefetchHard?.error_code || 'network').trim() || 'network'
    input.sendThinking(`RAG Agent：本轮已硬失败（${code}），跳过重复调用`)
    return ragHardFailOutcome({
      query: input.effQuery || input.baseQuery,
      errorCode: code,
      detail: prefetchHard?.error || code
    })
  }

  if (Number(probeRag?.hits ?? 0) <= 0 && leanForProbe) {
    try {
      const freshProbe = await callRagProbe({
        ragAgentHttpUrl: opts.ragAgentHttpUrl,
        timeoutMs: Math.min(input.timeoutMs, ragProbeTimeoutMs()),
        query: leanForProbe,
        userId: opts.userId,
        traceId: opts.runId,
        signal: opts.signal
      })
      if (freshProbe && (freshProbe.hits ?? 0) > 0) {
        probeRag = {
          hasDocs: Boolean(freshProbe.hasDocs ?? probeRag?.hasDocs),
          hits: freshProbe.hits ?? 0,
          sources: freshProbe.sources ?? [],
          snippets: freshProbe.snippets ?? []
        }
      }
    } catch (probeErr: unknown) {
      const detected = classifyAndDetectHard({ error: probeErr })
      if (detected.hard) {
        return ragHardFailOutcome({
          query: input.effQuery || leanForProbe,
          errorCode: detected.code,
          detail: detected.message
        })
      }
    }
  }

  const lastUser = String(input.question || '').trim()
  const singleRag = isSingleSourceRagTask(input.state.meta)
  const turnScopeMode =
    String((input.state.meta as { turnScopeMode?: string } | null)?.turnScopeMode || '').trim() || null
  const turnKind = String((input.state.meta as { turnKind?: string } | null)?.turnKind || '').trim() || null
  const sessionAnchorTask = sessionIntentAnchorFromMeta(input.state.meta)?.coalescedTask || ''

  let leanRagQuery: string
  let ragMessage: string
  if (singleRag && lastUser.length >= 4) {
    // 协议：单源 ≡ 独立端 /api/chat，禁止 lean/queryFocus 改写
    // 例外：output_followup / 短 continuation 必须锚定上轮任务，禁止「再详细一点」裸检索
    if (shouldGroundFollowupQuery({ turnKind, lastUser, anchorTask: sessionAnchorTask })) {
      leanRagQuery = groundFollowupQuery({
        lastUser,
        turnKind,
        anchorTask: sessionAnchorTask,
        candidate: String(input.baseQuery || '').trim() || lastUser
      })
      ragMessage = leanRagQuery
    } else {
      leanRagQuery = lastUser
      ragMessage = lastUser
    }
  } else if (isTrueMultiTask(input.state.meta)) {
    const scoped =
      pickSubAgentScopeSync(collectSubAgentScopeCandidates('rag', input.state.meta, input.baseQuery)) ||
      resolveLeanRagQuery(String(input.baseQuery || ''), lastUser)
    leanRagQuery =
      shouldGroundFollowupQuery({ turnKind, lastUser, anchorTask: sessionAnchorTask })
        ? groundFollowupQuery({
            lastUser,
            turnKind,
            anchorTask: sessionAnchorTask,
            candidate: scoped || lastUser
          })
        : scoped || lastUser
    ragMessage = leanRagQuery
  } else {
    const bundle = await resolveRagRetrievalBundle(deps, {
      userTask: input.question,
      baseQuery: input.baseQuery,
      probeRag,
      turnScopeMode,
      turnKind
    })
    leanRagQuery = bundle.leanQuery || input.baseQuery
    if (shouldGroundFollowupQuery({ turnKind, lastUser, anchorTask: sessionAnchorTask })) {
      leanRagQuery = groundFollowupQuery({
        lastUser,
        turnKind,
        anchorTask: sessionAnchorTask,
        candidate: leanRagQuery
      })
    }
    ragMessage = leanRagQuery
    if (bundle.meta?.mode === 'heuristic_v1') {
      input.onStrategyHint?.(bundle.meta)
    }
  }
  const ragUi = { leanRagQuery, sendThinking: input.sendThinking, sendDelta: input.sendDelta }

  const probeHitCount = Number(probeRag?.hits ?? 0) || 0
  // 仅显式 MANAGER_RAG_RETRIEVE_FIRST=1 时用事实块当终答；默认与独立端同走 /api/chat
  if (isManagerRagRetrieveFirstEnabled()) {
    const aligned = await tryRagRetrieveAlignedPath({
      state: input.state,
      question: input.question,
      leanRagQuery,
      probeRag,
      opts,
      timeoutMs: input.timeoutMs,
      mode: 'default',
      ragEvidenceMatchJudge: deps.ragEvidenceMatchJudge
    })
    if (isRagHardFailureBlob(aligned)) {
      return ragHardFailOutcome({
        query: leanRagQuery,
        errorCode: String(aligned.error_code || 'network'),
        detail: String(aligned.error_code || 'retrieve hard failure'),
        agentResult: aligned.agentResult
      })
    }
    if (!aligned) {
      const relaxed = await tryRagRetrieveAlignedPath({
        state: input.state,
        question: input.question,
        leanRagQuery,
        probeRag,
        opts,
        timeoutMs: input.timeoutMs,
        mode: 'relaxed',
        ragEvidenceMatchJudge: deps.ragEvidenceMatchJudge
      })
      if (isRagHardFailureBlob(relaxed)) {
        return ragHardFailOutcome({
          query: leanRagQuery,
          errorCode: String(relaxed.error_code || 'network'),
          agentResult: relaxed.agentResult
        })
      }
      if (relaxed) {
        return finishRagFastPath(
          ragUi,
          opts,
          probeRag,
          relaxed,
          'RAG Agent：retrieve-first 宽松模式命中…'
        )
      }
    }
    if (aligned) {
      return finishRagFastPath(
        ragUi,
        opts,
        probeRag,
        aligned,
        'RAG Agent：检索命中，快路径整理事实块…'
      )
    }
    if (probeHitCount > 0) {
      const probeFast = tryRagProbeSnippetFastPath({ leanRagQuery, probeRag })
      if (probeFast) {
        return finishRagFastPath(
          ragUi,
          opts,
          probeRag,
          probeFast,
          `RAG Agent：probe 命中 ${probeHitCount} 条，快路径输出…`
        )
      }
    }
  }

  if (isRagMcpFirstEnabled()) {
    try {
      input.sendThinking('RAG Agent：MCP 主路径（rag retrieve）…')
      const mcpOut = await callRagMcpRetrieve({ query: leanRagQuery || ragMessage })
      if (mcpOut.ok && mcpOut.text.trim()) {
        return {
          ok: true,
          agent: 'rag',
          output: mcpOut.text.trim(),
          query: input.question,
          parsed: extractStructuredPayload(mcpOut.text),
          evidence: {
            kind: 'rag',
            query: leanRagQuery,
            transport: 'mcp',
            source_count: (mcpOut.raw as Record<string, unknown>)?.source_count,
          },
        }
      }
    } catch (mcpErr) {
      const detected = classifyAndDetectHard({ error: mcpErr })
      if (detected.hard) {
        return ragHardFailOutcome({
          query: leanRagQuery,
          errorCode: detected.code,
          detail: detected.message
        })
      }
      input.sendThinking(
        `RAG Agent：MCP 失败，回退 HTTP（${String((mcpErr as Error)?.message || mcpErr).slice(0, 120)}）`
      )
    }
  }

  // 编排默认 current_only：空 history；步进 conversationId 隔离，禁止复用 Manager session
  const ragHistory =
    singleRag || turnScopeMode === 'current_only' || !turnScopeMode
      ? []
      : buildRagHistoryFromState(
          input.state.messages as Array<{ role?: string; content?: string }>,
          input.question,
          turnScopeMode,
          turnKind
        ) || []
  const ragConversationId = resolveSubAgentStepSessionId({
    runId: opts.runId,
    agent: 'rag',
    stepId: String((input.state.meta as { currentStepId?: string } | null)?.currentStepId || '').trim() || undefined
  })
  const callRag = (message: string, timeoutMs: number, extra?: { skipCache?: boolean }) =>
    deps.callRagAgent({
      ragAgentHttpUrl: opts.ragAgentHttpUrl,
      timeoutMs,
      message,
      retrievalQuery: leanRagQuery,
      history: ragHistory,
      conversationId: ragConversationId,
      userId: opts.userId,
      traceId: opts.runId,
      skipCache: extra?.skipCache ?? revisionSkipCache,
      deferStreamDelta: probeHitCount > 0,
      sendThinking: input.sendThinking,
      sendDelta: (d: string) => {
        input.sendDelta?.(d)
        opts.sendEvent({ event: 'delta', data: d, from: 'rag' })
      },
      signal: opts.signal,
      onEvidence: (e: unknown) => {
        ragEvidence = (e as Record<string, unknown>) || null
      },
      onAgentResult: (ar) => {
        ragAgentResult = ar
      }
    })

  try {
    const chatMessage = singleRag && lastUser.length >= 4 ? lastUser : leanRagQuery || ragMessage
    if (lastUser && chatMessage && lastUser !== chatMessage) {
      input.sendThinking(
        `RAG 出站问句与用户末轮不同（len ${lastUser.length}→${chatMessage.length}）；multi 子句切分属预期`
      )
    }
    const chatTimeout = probeHitCount > 0 ? Math.min(input.timeoutMs, 28_000) : input.timeoutMs
    const ragCall = await callRag(chatMessage, chatTimeout)
    let ragOut = unwrapAgentCall(ragCall as string | AgentCallResult).answer.trim()
    if (unwrapAgentCall(ragCall as string | AgentCallResult).agentResult) {
      ragAgentResult = unwrapAgentCall(ragCall as string | AgentCallResult).agentResult
    }
    if (ragAgentResult?.ok === false) {
      const code = String(ragAgentResult.error_code || '').trim()
      const detected = classifyAndDetectHard({ agentResult: ragAgentResult, error: ragOut })
      if (detected.hard || code === 'vector_not_ready') {
        return ragHardFailOutcome({
          query: leanRagQuery,
          errorCode: code || detected.code,
          detail: ragOut,
          agentResult: ragAgentResult
        })
      }
    }
    if (isRagRelevanceJudgeEnabled() && deps.ragRelevanceJudge && !shouldSkipRagRelevanceRefine(ragEvidence as Record<string, unknown>, ragOut)) {
      const refined = await refineRagAnswerIfIrrelevant({
        query: leanRagQuery,
        userTask: input.question,
        answer: ragOut,
        evidence: ragEvidence,
        judge: deps.ragRelevanceJudge,
        evidenceMatchJudge: deps.ragEvidenceMatchJudge,
        probeSources: probeRag?.sources,
        probeSnippets: probeRag?.snippets,
        callRag: (msg) => callRag(msg, Math.min(opts.timeoutMs, 45_000), { skipCache: true }),
        onEvidence: (e: unknown) => {
          ragEvidence = (e as Record<string, unknown>) || null
        }
      })
      ragOut = String(refined.answer ?? '').trim()
      if (refined.evidence) ragEvidence = refined.evidence as Record<string, unknown>
    }
    const ragClarify = parseRagClarifyPayload(ragOut)
    let evidenceUnits = countRagEvidenceUnits(ragEvidence, probeRag)
    if (!ragEvidence && evidenceUnits === 0 && deps.ragEvidenceFromProbe && Number(probeRag?.hits ?? 0) > 0) {
      const fromProbe = deps.ragEvidenceFromProbe(leanRagQuery, probeRag) as Record<string, unknown> | null
      if (fromProbe) {
        ragEvidence = fromProbe
        evidenceUnits = countRagEvidenceUnits(ragEvidence, probeRag)
      }
    }
    const ragSaysNotFound = shouldTreatRagAsMiss(ragOut, evidenceUnits)
    if (ragSaysNotFound) {
      input.sendThinking('RAG Agent：对话检索未命中，改用 retrieve 兜底…')
      const retrieveFallback = await tryRagRetrieveAlignedPath({
        state: input.state,
        question: input.question,
        leanRagQuery,
        probeRag,
        opts,
        timeoutMs: Math.min(input.timeoutMs, 25_000),
        mode: 'relaxed',
        ragEvidenceMatchJudge: deps.ragEvidenceMatchJudge
      })
      if (isRagHardFailureBlob(retrieveFallback)) {
        return ragHardFailOutcome({
          query: leanRagQuery,
          errorCode: String(retrieveFallback.error_code || 'network'),
          agentResult: retrieveFallback.agentResult
        })
      }
      if (retrieveFallback) {
        return finishRagFastPath(ragUi, opts, probeRag, retrieveFallback, 'RAG Agent：retrieve 兜底命中…')
      }
      if (probeHitCount > 0) {
        const probeFast = tryRagProbeSnippetFastPath({ leanRagQuery, probeRag })
        if (probeFast) {
          return finishRagFastPath(
            ragUi,
            opts,
            probeRag,
            probeFast,
            `RAG Agent：probe 兜底 ${probeHitCount} 条…`
          )
        }
      }
    }
    const agentNeedsClarify = Boolean(ragAgentResult?.needs_clarify)
    const clarifyQuestions = mergeRagClarifyQuestions(ragOut, ragClarify, evidenceUnits, agentNeedsClarify)
    return {
      ok: true,
      agent: 'rag',
      output: ragOut,
      query: leanRagQuery,
      parsed: extractStructuredPayload(ragOut),
      evidence: ragEvidence ? { ...ragEvidence } : undefined,
      clarifyQuestions,
      meta: ragAgentResult ? { agentResult: ragAgentResult } : undefined
    }
  } catch (e: unknown) {
    const err = String((e as Error)?.message || e || 'unknown error')
    const detected = classifyAndDetectHard({ error: e })
    if (detected.hard) {
      return ragHardFailOutcome({
        query: input.effQuery,
        errorCode: detected.code,
        detail: err
      })
    }
    const hits = Number(probeRag?.hits ?? 0) || 0
    if (input.allowRetry && hits > 0) {
      try {
        const retryQuery = buildRagRefocusMessage(
          input.question,
          input.baseQuery,
          '请排除与问句无关的行业规范/通用补贴文档，仅保留个人收支相关来源。',
          'irrelevant'
        )
        const res2 = await callRag(retryQuery, Math.min(opts.timeoutMs, 45_000), { skipCache: true })
        const retryUnwrapped = unwrapAgentCall(res2 as string | AgentCallResult)
        const retryAnswer = retryUnwrapped.answer.trim()
        if (!ragEvidence) ragEvidence = (await deps.probeRagEvidence(retryQuery)) as Record<string, unknown> | null
        const ragClarify = parseRagClarifyPayload(retryAnswer)
        const evidenceUnits = countRagEvidenceUnits(ragEvidence, probeRag)
        const clarifyQuestions = mergeRagClarifyQuestions(retryAnswer, ragClarify, evidenceUnits)
        return {
          ok: true,
          agent: 'rag',
          output: retryAnswer,
          query: input.effQuery,
          parsed: extractStructuredPayload(retryAnswer),
          evidence: ragEvidence ? { ...ragEvidence } : undefined,
          clarifyQuestions,
          meta: retryUnwrapped.agentResult ? { agentResult: retryUnwrapped.agentResult } : undefined
        }
      } catch (e2: unknown) {
        const err2 = String((e2 as Error)?.message || e2 || 'unknown error')
        const d2 = classifyAndDetectHard({ error: e2 })
        if (d2.hard) {
          return ragHardFailOutcome({ query: input.effQuery, errorCode: d2.code, detail: err2 })
        }
        return {
          ok: false,
          agent: 'rag',
          output: `RAG 步骤失败：${err}\nRAG 重试失败：${err2}\n\n下一步：确认文档索引服务是否可用，或缩小问题范围（给出要查的文档名/章节/关键词）。`,
          query: input.effQuery,
          error: err2
        }
      }
    }
    const output =
      hits > 0
        ? `RAG 步骤失败：${err}\n\n探测显示命中文档（hits=${hits}），但拉取失败。下一步：确认 RAG 服务是否可用，或缩小查询范围（给出关键词/文档名）。`
        : `RAG 步骤失败：${err}\n\n下一步：提供更明确的文档线索（文档名/章节/关键词），或先上传/索引相关文件。`
    return { ok: false, agent: 'rag', output, query: input.effQuery, error: err }
  }
}
