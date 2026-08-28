import { callRagProbe, callRagRetrieve } from '../../../utils/agents/ragClient'
import { isManagerDockerRuntime } from '../../../utils/platform/managerEnvModes'
import { classifyAndDetectHard, isHardExpertFailureRaw } from '../runtime/expertFailure'
import { resolvePrefetchTargets, type PrefetchGateState } from '../probe/prefetchGate'
import { isSingleSourceRagTask } from '../routing/subAgentPassthrough'
import {
  resolveLeanRagQuery,
  resolveRagPrefetchLeanQuery
} from '../probe/retrieverPlan'

export type RagRetrievePrefetchResult = {
  ok: boolean
  ms: number
  query?: string
  evidence?: Array<{ source?: string; content?: string }>
  citations?: Array<{ source?: string; quote?: string }>
  hits?: number
  needsClarify?: boolean
  sub_queries?: string[]
  error?: string
  /** 硬失败：同 run 内勿再打 RAG */
  hardFailure?: boolean
  error_code?: string
}

/** Docker / 提速：跳过 RAG EvidenceSelect LLM（省 1 次调用；403 模型权限问题时亦避免拖慢） */
export function shouldSkipRagEvidenceSelect() {
  const raw = String(process.env.MANAGER_RAG_SKIP_EVIDENCE_SELECT ?? '').trim().toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'yes') return true
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return isManagerDockerRuntime(process.env)
}

/** route 后、planner 前是否预取 RAG /api/retrieve */
export function shouldPrefetchRagRetrieve(state: PrefetchGateState): boolean {
  if (String(process.env.MANAGER_PREFETCH_RAG_RETRIEVE ?? '1').trim() === '0') return false
  if (
    isSingleSourceRagTask({
      ...(state.meta && typeof state.meta === 'object' ? state.meta : {}),
      allowedAgents: state.allowedAgents,
      intent: state.intent,
    })
  ) {
    return false
  }
  return resolvePrefetchTargets(state).rag
}

export function isAgentPrefetchEnabled() {
  return String(process.env.MANAGER_PREFETCH_AGENTS ?? '1').trim() !== '0'
}

/** probe 未命中时是否跳过 /api/retrieve（默认否：与 RAG 端对齐，预取必须真实检索） */
export function shouldSkipRagPrefetchRetrieveOnMiss(): boolean {
  return String(process.env.MANAGER_RAG_PREFETCH_SKIP_RETRIEVE_ON_MISS ?? '0').trim() === '1'
}

/** 直接复用 route probe 片段，0 次额外 RAG 调用 */
export function prefetchRagFromProbeCache(
  probeRag?: { hits?: number; sources?: string[]; snippets?: string[] } | null,
  query?: string,
  ms = 0
): RagRetrievePrefetchResult | null {
  const snippets = (probeRag?.snippets ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!snippets.length) return null
  const sources = (probeRag?.sources ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)
  const evidence = snippets.map((content, i) => ({
    source: sources[i] || sources[0] || 'doc',
    content
  }))
  const q = String(query || '').trim()
  return {
    ok: true,
    ms: Math.max(0, ms),
    query: q,
    evidence,
    hits: evidence.length,
    needsClarify: false
  }
}

export async function prefetchRagRetrieve(params: {
  ragAgentHttpUrl: string
  question: string
  lastUserMessage?: string
  timeoutMs: number
  userId?: string
  traceId?: string
  coalescedTask?: string
  turnScopeMode?: string | null
  turnKind?: string | null
  planRagFocus?: string
  /** route probe 缓存（orchestrate 前）；仅当与当前问句一致时复用 */
  probeRag?: { hits?: number; sources?: string[]; snippets?: string[] } | null
}): Promise<RagRetrievePrefetchResult> {
  const t0 = Date.now()
  const base = String(params.ragAgentHttpUrl || '').trim().replace(/\/+$/, '')
  if (!base) {
    return { ok: false, ms: 0, error: 'rag url missing' }
  }
  const lastUser = String(params.lastUserMessage ?? '').trim()
  const userTask = String(params.coalescedTask || lastUser || params.question || '').trim()
  const q =
    resolveRagPrefetchLeanQuery({
      lastUser,
      planRagFocus: params.planRagFocus,
      routedQuery: params.question,
      coalescedTask: params.coalescedTask
    }) ||
    resolveLeanRagQuery(String(params.question || '').trim(), lastUser) ||
    lastUser
  if (!q) return { ok: false, ms: Date.now() - t0, error: 'empty query（预取问句为空，请检查 routedQuery/用户输入）' }

  const probeTimeout = Math.min(params.timeoutMs, 20_000)
  const retrieveTimeout = Math.max(probeTimeout, Math.min(params.timeoutMs, 45_000))

  try {
    /** orchestrate 后始终 fresh probe（与 RAG /api/probe 同内核）；透传不带 sidecar */
    let freshProbe: Awaited<ReturnType<typeof callRagProbe>> = null
    try {
      freshProbe = await callRagProbe({
        ragAgentHttpUrl: base,
        timeoutMs: probeTimeout,
        query: q,
        k: 8,
        userId: params.userId,
        traceId: params.traceId
      })
    } catch (probeErr: unknown) {
      const detected = classifyAndDetectHard({ error: probeErr })
      if (detected.hard) {
        return {
          ok: false,
          ms: Date.now() - t0,
          query: q,
          error: detected.message,
          hardFailure: true,
          error_code: detected.code
        }
      }
      // 软失败：继续走 route probe / retrieve
    }
    const fromProbe = prefetchRagFromProbeCache(
      freshProbe
        ? {
            hits: freshProbe.hits,
            sources: freshProbe.sources,
            snippets: freshProbe.snippets
          }
        : null,
      q,
      Date.now() - t0
    )
    if (fromProbe) return fromProbe

    /** route probe 在 orchestrate 前已有命中，fresh probe 因复合问句误判时复用 */
    const routeProbe = prefetchRagFromProbeCache(params.probeRag, q, Date.now() - t0)
    if (routeProbe && Number(params.probeRag?.hits ?? 0) > 0) return routeProbe

    // probe 抛错或返回空且环境要求跳过 retrieve，或默认：硬失败不再叠 retrieve
    if (shouldSkipRagPrefetchRetrieveOnMiss()) {
      return {
        ok: false,
        ms: Date.now() - t0,
        query: q,
        evidence: [],
        hits: 0,
        needsClarify: false
      }
    }

    /** 与 executeRagStep / RAG /api/retrieve 同参 */
    const data = await callRagRetrieve({
      ragAgentHttpUrl: base,
      timeoutMs: retrieveTimeout,
      query: q,
      rawQuery: userTask || q,
      userId: params.userId,
      traceId: params.traceId,
      skipLlmRerank: shouldSkipRagEvidenceSelect(),
      skipEvidenceSelect: shouldSkipRagEvidenceSelect()
    })
    if (!data) {
      // retrieve 空且无响应体：多为服务不可达
      return {
        ok: false,
        ms: Date.now() - t0,
        query: q,
        error: 'rag retrieve empty',
        hardFailure: true,
        error_code: 'network'
      }
    }
    const failCode = String(data.error_code || data.agentResult?.error_code || '').trim()
    if (data.ok === false && (isHardExpertFailureRaw(failCode) || failCode === 'vector_not_ready')) {
      return {
        ok: false,
        ms: Date.now() - t0,
        query: q,
        error: failCode || 'rag hard failure',
        hardFailure: true,
        error_code: failCode || 'network',
        hits: 0
      }
    }
    const evidence = Array.isArray(data.evidence)
      ? (data.evidence as Array<{ source?: string; content?: string }>)
      : []
    const citations = Array.isArray(data.citations)
      ? (data.citations as Array<{ source?: string; quote?: string }>)
      : []
    const hits = evidence.length || citations.length || 0
    return {
      ok: hits > 0,
      ms: Date.now() - t0,
      query: String(data.query || q),
      evidence,
      citations,
      hits,
      needsClarify: Boolean(data.needsClarify)
    }
  } catch (e: unknown) {
    const detected = classifyAndDetectHard({ error: e })
    return {
      ok: false,
      ms: Date.now() - t0,
      query: q,
      error: String((e as Error)?.message || e || 'prefetch failed'),
      hardFailure: detected.hard,
      error_code: detected.hard ? detected.code : undefined
    }
  }
}

/** 注入 Planner：RAG 预取摘要 */
export function formatRagPrefetchForPlanner(prefetch?: RagRetrievePrefetchResult | null): string {
  if (!prefetch) return ''
  const lines: string[] = [
    prefetch.ok
      ? '【RAG 预取（route 后并行，供规划参考）】'
      : '【RAG 预取（未命中，规划时勿假定已有文档事实）】'
  ]
  if (prefetch.query) lines.push(`- 检索问句：${prefetch.query}`)
  if (prefetch.hits != null) lines.push(`- 命中片段：${prefetch.hits} 条`)
  const snippets = (prefetch.evidence || [])
    .slice(0, 5)
    .map((e, i) => {
      const src = String(e.source || 'doc').trim()
      const body = String(e.content || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      return `${i + 1}. ${src}：${body}`
    })
  if (snippets.length) lines.push(`- 摘要：\n${snippets.join('\n')}`)
  return lines.join('\n')
}

/** 执行 rag 步骤时合并 probe + 预取片段（仅 planner 参考；执行步勿用 prefetch 以免污染检索） */
export function mergeRagProbeWithPrefetch(
  probe?: { hits?: number; sources?: string[]; snippets?: string[] } | null,
  prefetch?: RagRetrievePrefetchResult | null,
  opts?: { includePrefetch?: boolean }
) {
  if (!opts?.includePrefetch || !prefetch?.ok) return probe ?? null
  const fromPrefetch = (prefetch.evidence || [])
    .map((e) => {
      const src = String(e.source || '').trim()
      const body = String(e.content || '').trim()
      return src && body ? `${src}：${body.slice(0, 280)}` : body
    })
    .filter(Boolean)
  const snippets = [...fromPrefetch, ...(Array.isArray(probe?.snippets) ? probe!.snippets! : [])].slice(0, 8)
  const sources = [
    ...new Set([
      ...(Array.isArray(probe?.sources) ? probe!.sources! : []),
      ...(prefetch.evidence || []).map((e) => String(e.source || '').trim()).filter(Boolean)
    ])
  ]
  return {
    hits: Math.max(Number(probe?.hits ?? 0), prefetch.hits ?? 0, snippets.length),
    sources,
    snippets
  }
}
