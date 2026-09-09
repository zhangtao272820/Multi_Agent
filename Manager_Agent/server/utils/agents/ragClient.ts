import crypto from 'node:crypto'
import { resolveRagPassthroughText } from '#agent-shared/deterministicPassthrough'
import { resolveLeanRagQuery } from '../../graph/core/probe/retrieverPlan'
import { ragProbeTimeoutMs } from '../../graph/core/probe/probeConfig'
import { withTimeout, LruCache } from './agentTransport'
import { fetchWithExpertPolicy } from '../../graph/core/runtime/expertFailure'
import { buildAgentTraceHeaders, isManagerStreamDeltaEnabled, withTraceBody } from './agentTrace'
import type { AgentCallResult, AgentResult, RagCitation, RagEvidence, RagHistoryMessage } from './types'

const ragCache = new LruCache<{ answer: string; evidence?: RagEvidence; agentResult?: AgentResult }>(120, 90_000)

/** 与 dbClient 对齐：不缓存空结果/未命中，避免短超时或冷启动后的假阴性长期命中 */
function isRagEmptyResult(answer: string, evidence?: RagEvidence, agentResult?: AgentResult): boolean {
  if (agentResult?.needs_clarify) return true
  const hits = Number(evidence?.hits ?? agentResult?.structured?.evidence_count ?? 0)
  const citeCount = Array.isArray(evidence?.citations) ? evidence!.citations!.length : 0
  const srcCount = Array.isArray(agentResult?.sources) ? agentResult!.sources!.length : 0
  if (hits > 0 || citeCount > 0 || srcCount > 0) return false
  const t = String(answer || '').trim()
  if (!t) return true
  if (t.includes('<RAG_NEEDS_CLARIFY>') || t.includes('【需要补充信息】')) return true
  if (/暂未找到|未检索到|知识库检索未找到|未找到相关|查不到|无法进行后续分析|未找到相关背景信息/i.test(t)) {
    return true
  }
  return false
}

function ragCacheKey(input: {
  url: string
  conversationId?: string
  leanQ: string
  chatMessage: string
  historyKey: string
  traceId?: string
}) {
  const msgKey = crypto.createHash('sha1').update(input.chatMessage).digest('hex').slice(0, 12)
  return `rag|${input.url}|${input.conversationId || ''}|${input.leanQ}|${msgKey}|${input.historyKey}|${input.traceId || ''}`
}

export { ragProbeTimeoutMs }

function parseEvidenceFromToolOutput(output: unknown): RagCitation[] {
  const raw = typeof output === 'string' ? output : String((output as { content?: string })?.content ?? '')
  if (!raw.trim()) return []

  const jsonMatch = raw.match(/\[evidence_json\]\s*([\s\S]*?)(?:\n\[|$)/)
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim()) as {
        evidence?: Array<{ source?: string; content?: string; quote?: string }>
      }
      const items = Array.isArray(parsed?.evidence) ? parsed.evidence : []
      return items
        .map((it) => ({
          source: String(it?.source ?? '').trim(),
          excerpt: String(it?.content ?? it?.quote ?? '').trim().slice(0, 480)
        }))
        .filter((c) => c.source || c.excerpt)
        .slice(0, 12)
    } catch {
      /* fall through */
    }
  }

  const citations: RagCitation[] = []
  const blocks = raw.split(/\n{2,}/g).map((b) => b.trim()).filter(Boolean)
  for (const b of blocks) {
    const m = b.match(/\[内容\]:\s*([\s\S]*?)(?:\n\[来源\]:\s*([\s\S]*))?$/)
    if (!m) continue
    const excerpt = String(m[1] ?? '').trim()
    const source = String(m[2] ?? '').trim()
    if (excerpt || source) citations.push({ source: source || 'unknown', excerpt })
  }
  return citations.slice(0, 12)
}

function buildRagEvidence(query: string, citations: RagCitation[], agentResult?: AgentResult): RagEvidence | undefined {
  if (!citations.length && !agentResult?.sources?.length) return undefined
  const fromAgent = (agentResult?.sources || [])
    .filter((s) => s.type === 'doc')
    .map((s) => ({ source: s.ref }))
  const merged = citations.length
    ? citations
    : fromAgent.map((s) => ({ source: s.source, excerpt: undefined }))
  return {
    kind: 'rag',
    query,
    hits: merged.length || agentResult?.structured?.evidence_count as number | undefined,
    citations: merged,
    agentResult
  }
}

export type RagProbeResponse = {
  hasDocs?: boolean
  hits?: number
  sources?: string[]
  snippets?: string[]
}

/** 执行阶段补探测：probe 节点冷启动超时后，向量库已热时再探一次 */
export async function callRagProbe(params: {
  ragAgentHttpUrl: string
  timeoutMs: number
  query: string
  k?: number
  userId?: string
  tenantId?: string
  traceId?: string
  signal?: AbortSignal
}): Promise<RagProbeResponse | null> {
  const base = String(params.ragAgentHttpUrl || '').trim().replace(/\/+$/, '')
  const q = String(params.query || '').trim()
  if (!base || !q) return null
  const uid = String(params.userId || '').trim()
  const tid = String(params.tenantId || '').trim()
  const kRaw = Number(params.k ?? 8)
  const k = Number.isFinite(kRaw) && kRaw > 0 ? Math.max(1, Math.min(12, Math.floor(kRaw))) : 8
  try {
    const res = await withTimeout(
      fetch(`${base}/api/probe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAgentTraceHeaders(params.traceId, {
            ...(uid ? { userId: uid } : {}),
            ...(tid ? { tenantId: tid } : {})
          }),
          ...(uid ? { 'x-user-id': uid } : {}),
          ...(tid ? { 'x-tenant-id': tid } : {})
        },
        body: JSON.stringify(
          withTraceBody(
            {
              query: q,
              k
            },
            params.traceId
          )
        ),
        signal: params.signal
      }),
      params.timeoutMs,
      'ragProbe'
    )
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    return {
      hasDocs: Boolean(data.hasDocs),
      hits: Number(data.hits ?? 0) || 0,
      sources: Array.isArray(data.sources) ? (data.sources as unknown[]).map((s) => String(s)).filter(Boolean) : [],
      snippets: Array.isArray(data.snippets) ? (data.snippets as unknown[]).map((s) => String(s)).filter(Boolean) : []
    }
  } catch {
    return null
  }
}

export type RagRetrieveResponse = {
  ok?: boolean
  query?: string
  needsClarify?: boolean
  evidence?: Array<{ source?: string; content?: string }>
  citations?: Array<{ source?: string; quote?: string }>
  agentResult?: AgentResult
  ms?: number
  error_code?: string
}

function ragFailureRetrieveResponse(code: string, query: string, detail?: string): RagRetrieveResponse {
  return {
    ok: false,
    query,
    needsClarify: false,
    evidence: [],
    citations: [],
    error_code: code,
    agentResult: {
      ok: false,
      agent: 'rag',
      answer: query,
      error_code: code,
      structured: { evidence_count: 0, ...(detail ? { detail } : {}) }
    }
  }
}

/** 将 /api/probe 结果映射为 retrieve 形态（与 route probe 召回一致） */
export async function callRagProbeAsRetrieve(params: {
  ragAgentHttpUrl: string
  timeoutMs: number
  query: string
  rawQuery?: string
  userId?: string
  traceId?: string
  k?: number
  signal?: AbortSignal
}): Promise<RagRetrieveResponse | null> {
  const probe = await callRagProbe({
    ragAgentHttpUrl: params.ragAgentHttpUrl,
    timeoutMs: params.timeoutMs,
    query: params.query,
    k: params.k ?? 8,
    userId: params.userId,
    traceId: params.traceId,
    signal: params.signal
  })
  const snippets = (probe?.snippets ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!snippets.length) return null
  const sources = (probe?.sources ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)
  const evidence = snippets.map((content, i) => ({
    source: sources[i] || sources[0] || 'doc',
    content
  }))
  const q = String(params.query || '').trim()
  return {
    ok: true,
    query: q,
    needsClarify: false,
    evidence,
    hits: evidence.length,
    ms: undefined
  } as RagRetrieveResponse & { hits?: number }
}

/** 程序化检索：与 /api/probe 同内核，可 skipEvidenceSelect 对齐探测命中路径 */
export async function callRagRetrieve(params: {
  ragAgentHttpUrl: string
  timeoutMs: number
  query: string
  rawQuery?: string
  userId?: string
  traceId?: string
  skipLlmRerank?: boolean
  skipEvidenceSelect?: boolean
  signal?: AbortSignal
}): Promise<RagRetrieveResponse | null> {
  const base = String(params.ragAgentHttpUrl || '').trim().replace(/\/+$/, '')
  const q = resolveLeanRagQuery(String(params.query || ''), String(params.rawQuery || params.query || ''))
  if (!base || !q) return null
  const uid = String(params.userId || '').trim()
  try {
    const res = await withTimeout(
      fetch(`${base}/api/retrieve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAgentTraceHeaders(params.traceId),
          ...(uid ? { 'x-user-id': uid } : {})
        },
        body: JSON.stringify(
          withTraceBody(
            {
              query: q,
              message: q,
              rawQuery: String(params.rawQuery || q).trim() || q,
              skipLlmRerank: Boolean(params.skipLlmRerank),
              skipEvidenceSelect: Boolean(params.skipEvidenceSelect),
              ...(uid ? { userId: uid } : {})
            },
            params.traceId
          )
        ),
        signal: params.signal
      }),
      params.timeoutMs,
      'ragRetrieve'
    )
    // R3：HTTP 失败也返回带码结构，禁止一律 null 吞错
    if (!res.ok) {
      const code = res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'http_5xx' : 'business'
      const statusText = String(res.statusText || '').trim()
      const detail =
        res.status === 401
          ? `HTTP 401 ${statusText || 'login_required'}（检查 RAG CLAWHIVE_INTERNAL_TOKEN）`
          : `HTTP ${res.status}${statusText ? ` ${statusText}` : ''}`
      return ragFailureRetrieveResponse(code, q, detail)
    }
    const data = (await res.json()) as RagRetrieveResponse
    if (data?.ok === false && data?.agentResult) return data
    if (data?.agentResult?.ok === false) return data
    return data
  } catch (e: unknown) {
    const msg = String((e as Error)?.message || e || '').toLowerCase()
    const code =
      msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')
        ? 'timeout'
        : msg.includes('econnrefused') || msg.includes('fetch failed')
          ? 'vector_not_ready'
          : 'business'
    return ragFailureRetrieveResponse(code, q, String((e as Error)?.message || e || '').slice(0, 200))
  }
}

export async function listRagDocs(params: { ragAgentHttpUrl: string; timeoutMs: number }) {
  const url = `${params.ragAgentHttpUrl.replace(/\/+$/, '')}/api/list`
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  })
  if (!res.ok) throw new Error(`rag list failed: ${res.status}`)
  return await res.json()
}

/** 总管与文档助手 UI 统一：仅 /api/chat（SSE 含 tool_output / agentResult）；透传问句，无编排侧车 */
export async function callRagAgent(params: {
  ragAgentHttpUrl: string
  timeoutMs: number
  message: string
  retrievalQuery?: string
  history?: RagHistoryMessage[]
  conversationId?: string
  userId?: string
  traceId?: string
  sendThinking?: (text: string) => void
  sendDelta?: (delta: string) => void
  sendThoughtDelta?: (text: string) => void
  signal?: AbortSignal
  onEvidence?: (evidence: RagEvidence) => void
  onAgentResult?: (agentResult: AgentResult) => void
  /** 重试/改写问句时跳过缓存，避免命中同 trace 下的首次假阴性 */
  skipCache?: boolean
  /** probe 已命中时缓冲 token，避免「暂未找到」假阴性闪现在 UI */
  deferStreamDelta?: boolean
  /**
   * 编排态 multi/hub 可选侧车（单源勿传）。
   * 含 coverage_critical 时 RAG 弱证据有界再检。
   */
  managerRagTaskJson?: string
}): Promise<AgentCallResult> {
  const uid = String(params.userId || '').trim()
  const leanQ = String(params.retrievalQuery || params.message || '').trim()
  const chatMessage = String(params.message || params.retrievalQuery || '').trim()
  const streamDelta =
    isManagerStreamDeltaEnabled() && typeof params.sendDelta === 'function' ? params.sendDelta : undefined
  const sidecar = String(params.managerRagTaskJson || '').trim()

  const url = `${params.ragAgentHttpUrl.replace(/\/+$/, '')}/api/chat`
  const chatHistory = Array.isArray(params.history) ? params.history : []
  const historyKey = JSON.stringify(chatHistory.slice(-12))
  const cacheKey = ragCacheKey({
    url,
    conversationId: params.conversationId,
    leanQ,
    chatMessage,
    historyKey,
    traceId: params.traceId
  })
  const cached = params.skipCache ? undefined : ragCache.get(cacheKey)
  if (cached) {
    if (cached.evidence) params.onEvidence?.(cached.evidence)
    if (cached.agentResult) params.onAgentResult?.(cached.agentResult)
    return { answer: cached.answer, agentResult: cached.agentResult }
  }

  params.sendThinking?.('RAG Agent：正在检索文档…')
  let res: Response
  try {
    res = await fetchWithExpertPolicy(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAgentTraceHeaders(params.traceId),
          ...(uid ? { 'x-user-id': uid } : {}),
          ...(sidecar ? { 'x-manager-orchestrated': '1' } : {})
        },
        body: JSON.stringify(
          withTraceBody(
            {
              message: chatMessage,
              history: chatHistory,
              conversationId: params.conversationId || undefined,
              ...(uid ? { userId: uid } : {}),
              ...(sidecar ? { manager_rag_task_json: sidecar } : {})
            },
            params.traceId
          )
        ),
        signal: params.signal
      },
      {
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        label: 'ragAgent'
      }
    )
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e || 'ragAgent http error'))
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`ragAgent http ${res.status}: ${text || res.statusText}`)
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('text/event-stream')) {
    const decoder = new TextDecoder()
    const reader = res.body?.getReader()
    if (!reader) throw new Error('ragAgent sse stream body is empty')
    let buf = ''
    let answer = ''
    let donePayloadText = ''
    let done = false
    let agentResult: AgentResult | undefined
    let citations: RagCitation[] = []
    const tokenBuffer: string[] = []
    const deferStream = params.deferStreamDelta === true && Boolean(streamDelta)

    while (!done) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      buf += decoder.decode(value, { stream: true })
      const blocks = buf.split('\n\n')
      buf = blocks.pop() || ''
      for (const block of blocks) {
        const lines = block
          .split('\n')
          .map((x) => x.trim())
          .filter((x) => x.startsWith('data:'))
        for (const line of lines) {
          const raw = line.slice(5).trim()
          if (!raw) continue
          try {
            const evt = JSON.parse(raw) as Record<string, unknown>
            const type = String(evt?.type || '')
            if (type === 'token') {
              const t = String(evt?.content || '')
              if (t) {
                answer += t
                if (deferStream) tokenBuffer.push(t)
                else streamDelta?.(t)
              }
            } else if (type === 'reasoning') {
              const r = String(evt?.content || '').trim()
              if (r) {
                params.sendThoughtDelta?.(r)
                params.sendThinking?.(`RAG 思考：${r.slice(0, 240)}`)
              }
            } else if (type === 'tool_output') {
              const name = String(evt?.name || '').toLowerCase()
              if (name.includes('document_query')) {
                const parsed = parseEvidenceFromToolOutput(evt?.output)
                if (parsed.length) citations = parsed
              }
            } else if (type === 'agentResult') {
              const ar = evt?.agentResult as AgentResult | undefined
              if (ar && typeof ar === 'object') {
                agentResult = ar
                params.onAgentResult?.(ar)
              }
            } else if (type === 'status') {
              const s = String(evt?.content || '')
              if (s) params.sendThinking?.(`RAG Agent：${s}`)
            } else if (type === 'error') {
              throw new Error(String(evt?.content || 'ragAgent stream error'))
            } else if (type === 'done') {
              const payloadText = String(evt?.answer || evt?.content || evt?.text || '').trim()
              if (payloadText) donePayloadText = payloadText
              done = true
            }
          } catch (e: unknown) {
            const msg = String((e as Error)?.message || e)
            if (msg.startsWith('Unexpected token')) continue
            throw e
          }
        }
      }
    }
    const rawFinal = String(answer || donePayloadText || '').trim()
    if (!rawFinal) throw new Error('ragAgent returned empty streamed answer')
    const evidence = buildRagEvidence(leanQ, citations, agentResult)
    if (evidence) params.onEvidence?.(evidence)
    const evidenceForNorm = evidence
      ? [{ kind: 'rag', hits: evidence.hits, citations: evidence.citations, sources: evidence.sources }]
      : []
    const finalAnswer = resolveRagPassthroughText({ text: rawFinal, evidence: evidenceForNorm })
    if (deferStream && streamDelta && !isRagEmptyResult(finalAnswer, evidence, agentResult)) {
      streamDelta(finalAnswer)
    } else if (!deferStream && streamDelta && finalAnswer !== rawFinal && !isRagEmptyResult(finalAnswer, evidence, agentResult)) {
      streamDelta(finalAnswer)
    }
    if (!params.skipCache && !isRagEmptyResult(finalAnswer, evidence, agentResult)) {
      ragCache.set(cacheKey, { answer: finalAnswer, evidence, agentResult })
    }
    return { answer: finalAnswer, agentResult }
  }

  if (!contentType.includes('application/json')) {
    const text = await res.text().catch(() => '')
    const head = String(text || '').slice(0, 200).replace(/\s+/g, ' ')
    throw new Error(`ragAgent invalid response (expected json/sse): ${head || contentType || 'unknown'}`)
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const rawAnswer = typeof data?.answer === 'string' ? data.answer : JSON.stringify(data ?? {})
  const hits = typeof data?.hits === 'number' ? data.hits : undefined
  const citations: RagCitation[] = []
  if (Array.isArray(data?.citations)) {
    for (const c of data.citations) {
      const row = c as Record<string, unknown>
      const source = String(row?.source ?? row?.doc ?? row?.file ?? row?.id ?? '').trim()
      if (!source) continue
      citations.push({
        source,
        title: typeof row?.title === 'string' ? row.title : undefined,
        url: typeof row?.url === 'string' ? row.url : undefined,
        excerpt:
          typeof row?.excerpt === 'string' ? row.excerpt : typeof row?.text === 'string' ? row.text : undefined
      })
    }
  }
  const agentResult =
    data?.agentResult && typeof data.agentResult === 'object' ? (data.agentResult as AgentResult) : undefined
  const evidence = buildRagEvidence(leanQ, citations, agentResult) ?? (hits != null || citations.length
    ? ({ kind: 'rag', query: leanQ, hits, citations } as RagEvidence)
    : undefined)
  if (evidence) params.onEvidence?.(evidence)
  if (agentResult) params.onAgentResult?.(agentResult)
  const evidenceForNorm = evidence
    ? [{ kind: 'rag', hits: evidence.hits, citations: evidence.citations, sources: evidence.sources }]
    : []
  const answer = resolveRagPassthroughText({ text: rawAnswer, evidence: evidenceForNorm })
  if (!params.skipCache && !isRagEmptyResult(answer, evidence, agentResult)) {
    ragCache.set(cacheKey, { answer, evidence, agentResult })
  }
  return { answer, agentResult }
}
