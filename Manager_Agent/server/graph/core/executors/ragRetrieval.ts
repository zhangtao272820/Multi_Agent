import type { AgentResult } from '../../../utils/agents/agentResult'
import { callRagRetrieve, callRagProbeAsRetrieve } from '../../../utils/agents/ragClient'
import type { RagRetrieveResponse } from '../../../utils/agents/ragClient'
import type { RagEvidenceMatchJudge, RagScopeHintJudge } from '../../../utils/rag/managerRagRelevance'
import { buildAnswerFromProbeSnippets, formatRagEvidenceAsManagerFacts, judgeFilterRagEvidence, judgeFilterRagProbeHint, shouldBypassRagEvidenceJudge } from '../../../utils/rag/managerRagRelevance'
import type { ManagerGraphState } from '../../state/state'
import { buildRagRetrievalMessage, isRetrieverPlanEnabled, resolveLeanRagQuery } from '../probe/retrieverPlan'
import type { RagProbeHint } from '../probe/retrieverPlan'
import type { RagRetrievePrefetchResult } from '../rag/ragPrefetch'
import { ragRetrieveCallOptions } from '../rag/ragRetrievePolicy'
import type { RagRetrieveAttemptMode } from '../rag/ragRetrievePolicy'
import { isHardExpertFailureRaw } from '../runtime/expertFailure'
import { extractStructuredPayload } from '../shared'
import { resolveRagPassthroughText } from '#agent-shared/deterministicPassthrough'
import { countRagEvidenceUnits, RAG_EMPTY_EVIDENCE_CLARIFY } from './sharedHelpers'
import type { AgentExecutorOpts, AgentStepOutcome } from './types'

export async function resolveRagRetrievalBundle(
  deps: { ragScopeHintJudge?: RagScopeHintJudge; ragEvidenceMatchJudge?: RagEvidenceMatchJudge },
  input: { userTask: string; baseQuery: string; probeRag?: RagProbeHint | null; turnScopeMode?: string | null; turnKind?: string | null }
) {
  const leanForFilter =
    resolveLeanRagQuery(String(input.baseQuery || input.userTask || '').trim(), String(input.userTask || '').trim()) ||
    String(input.userTask || '').trim()
  const routeProbeHits = Number(input.probeRag?.hits ?? 0) || 0
  const probeRag =
    routeProbeHits > 0
      ? input.probeRag
      : (await judgeFilterRagProbeHint(deps.ragEvidenceMatchJudge, leanForFilter, input.probeRag)) ?? input.probeRag
  let scopeHint = ''
  let retrievalKeywords: string[] | undefined
  let excludeHints: string[] | undefined
  if (isRetrieverPlanEnabled() && deps.ragScopeHintJudge && routeProbeHits <= 0) {
    try {
      const h = await deps.ragScopeHintJudge({
        userTask: input.userTask,
        stepQuery: input.baseQuery,
        probeSources: Array.isArray(probeRag?.sources) ? probeRag!.sources : [],
        probeSnippets: Array.isArray(probeRag?.snippets)
          ? probeRag!.snippets!.map((s) => String(s ?? ''))
          : []
      })
      scopeHint = h.catalogInstruction
      retrievalKeywords = h.retrievalKeywords
      excludeHints = h.excludeHints
    } catch {}
  }
  return buildRagRetrievalMessage(input.userTask, input.baseQuery, probeRag, scopeHint, {
    retrievalKeywords,
    excludeHints,
    turnScopeMode: input.turnScopeMode,
    turnKind: input.turnKind
  })
}

export function tryRagProbeSnippetFastPath(input: {
  leanRagQuery: string
  probeRag?: { hits?: number; sources?: string[]; snippets?: string[] } | null
}): { answer: string; evidence: Record<string, unknown> } | null {
  const hits = Number(input.probeRag?.hits ?? 0) || 0
  const snippets = (input.probeRag?.snippets ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (hits <= 0 || !snippets.length) return null
  return buildAnswerFromProbeSnippets({
    query: input.leanRagQuery,
    probeSources: input.probeRag?.sources,
    probeSnippets: snippets,
    useAllProbeSnippets: true
  })
}

export function finishRagFastPath(
  input: { leanRagQuery: string; sendThinking: (t: string) => void; sendDelta?: (d: string) => void },
  opts: AgentExecutorOpts,
  probeRag: { hits?: number; sources?: string[]; snippets?: string[] } | null | undefined,
  fast: {
    answer?: string
    evidence?: Record<string, unknown>
    agentResult?: import('../../utils/agents/types').AgentResult
    hardFailure?: boolean
    error_code?: string
  },
  label: string
): AgentStepOutcome {
  // R3：向量未就绪 / 超时 — 可解释失败，禁止扮成快路径成功
  if (fast.hardFailure) {
    const code = String(fast.error_code || fast.agentResult?.error_code || 'business').trim()
    const msg =
      code === 'vector_not_ready'
        ? '知识库向量服务未就绪，本步已跳过。请稍后重试或检查 RAG 向量库。'
        : code === 'timeout'
          ? '知识库检索超时，本步已停止等待。'
          : `知识库检索失败（${code}）。`
    input.sendThinking(`RAG Agent：${msg}`)
    return {
      ok: false,
      agent: 'rag',
      output: msg,
      query: input.leanRagQuery,
      error: code,
      evidence: {
        kind: 'rag',
        query: input.leanRagQuery,
        error_code: code,
        ...(fast.evidence || {})
      },
      meta: fast.agentResult ? { agentResult: fast.agentResult } : { agentResult: { ok: false, agent: 'rag', error_code: code } }
    }
  }
  const answerRaw = String(fast.answer || '')
  const evidenceArr = fast.evidence
    ? [{ kind: 'rag', ...(fast.evidence as Record<string, unknown>) }]
    : []
  const answer = resolveRagPassthroughText({ text: answerRaw, evidence: evidenceArr })
  input.sendThinking(label)
  if (answer !== answerRaw.trim()) {
    input.sendThinking('RAG Agent：已有检索证据，已去掉开头「未找到」误导表述')
  }
  input.sendDelta?.(answer)
  opts.sendEvent({ event: 'delta', data: answer, from: 'rag' })
  const evidenceUnits = countRagEvidenceUnits(fast.evidence || {}, probeRag)
  return {
    ok: true,
    agent: 'rag',
    output: answer,
    query: input.leanRagQuery,
    parsed: extractStructuredPayload(answer),
    evidence: fast.evidence,
    meta: fast.agentResult ? { agentResult: fast.agentResult } : undefined,
    clarifyQuestions: evidenceUnits === 0 ? [...RAG_EMPTY_EVIDENCE_CLARIFY] : undefined
  }
}

export async function tryRagRetrieveAlignedPath(input: {
  state: ManagerGraphState
  question: string
  leanRagQuery: string
  probeRag?: { hits?: number; sources?: string[]; snippets?: string[] } | null
  opts: AgentExecutorOpts
  timeoutMs: number
  mode?: RagRetrieveAttemptMode
  ragEvidenceMatchJudge?: RagEvidenceMatchJudge
}): Promise<{ answer: string; evidence: Record<string, unknown>; agentResult?: import('../../utils/agents/types').AgentResult } | null> {
  const probeHits = Number(input.probeRag?.hits ?? 0) || 0
  const bypassJudge = shouldBypassRagEvidenceJudge(probeHits)
  const prefetch = input.state.meta?.ragRetrievePrefetch as RagRetrievePrefetchResult | undefined
  if (input.mode !== 'relaxed' && prefetch?.ok && Array.isArray(prefetch.evidence) && prefetch.evidence.length > 0 && !prefetch.needsClarify) {
    const judged = await judgeFilterRagEvidence(
      input.ragEvidenceMatchJudge,
      input.leanRagQuery,
      prefetch.evidence,
      { probeHits, bypassJudge: true }
    )
    if (judged.relevant && judged.rows.length) {
      const formatted = formatRagEvidenceAsManagerFacts(input.leanRagQuery, judged.rows)
      if (formatted) return formatted
    }
  }

  const callOpts = ragRetrieveCallOptions(input.mode ?? 'default', probeHits)
  const retrieveTimeout = probeHits > 0 ? Math.min(input.timeoutMs, 12_000) : Math.min(input.timeoutMs, 20_000)

  const data: RagRetrieveResponse | null =
    probeHits > 0 && input.mode !== 'relaxed'
      ? await callRagProbeAsRetrieve({
          ragAgentHttpUrl: input.opts.ragAgentHttpUrl,
          timeoutMs: retrieveTimeout,
          query: input.leanRagQuery,
          rawQuery: input.question,
          userId: input.opts.userId,
          traceId: input.opts.runId,
          signal: input.opts.signal
        })
      : await callRagRetrieve({
          ragAgentHttpUrl: input.opts.ragAgentHttpUrl,
          timeoutMs: retrieveTimeout,
          query: input.leanRagQuery,
          rawQuery: input.question,
          userId: input.opts.userId,
          traceId: input.opts.runId,
          skipLlmRerank: callOpts.skipLlmRerank,
          skipEvidenceSelect: callOpts.skipEvidenceSelect,
          signal: input.opts.signal
        })
  const rawEvidence = Array.isArray(data?.evidence) ? data!.evidence! : []
  // R3 / fail-fast：硬失败向上抛带码结构，勿静默当空检索再叠 chat
  const failCode = String(data?.error_code || data?.agentResult?.error_code || '').trim()
  if (!data) {
    return {
      kind: 'rag',
      query: input.leanRagQuery,
      hits: 0,
      citations: [],
      hardFailure: true,
      error_code: 'network'
    } as any
  }
  if (
    data.ok === false &&
    (failCode === 'vector_not_ready' ||
      failCode === 'timeout' ||
      failCode === 'http_5xx' ||
      failCode === 'network' ||
      isHardExpertFailureRaw(failCode))
  ) {
    return {
      kind: 'rag',
      query: input.leanRagQuery,
      hits: 0,
      citations: [],
      agentResult: data.agentResult,
      hardFailure: true,
      error_code: failCode || 'network'
    } as any
  }
  const judged = await judgeFilterRagEvidence(input.ragEvidenceMatchJudge, input.leanRagQuery, rawEvidence, {
    probeHits,
    bypassJudge
  })
  if (!judged.rows.length || !judged.relevant || data?.needsClarify) return null
  const formatted = formatRagEvidenceAsManagerFacts(input.leanRagQuery, judged.rows)
  if (!formatted) return null
  return { ...formatted, agentResult: data?.agentResult }
}

