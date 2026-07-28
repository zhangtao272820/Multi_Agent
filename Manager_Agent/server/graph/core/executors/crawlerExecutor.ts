import { markAgentPayloadUntrusted } from '#agent-shared/contentTrust'
import { wrapCrawlerResult } from '../../../utils/agents/agentResult'
import type { AgentResult } from '../../../utils/agents/agentResult'
import { crawlerSourceHitsForEvent, extractCrawlerItemsFromPayload, extractCrawlerItemsFromText } from '../../../utils/crawler/crawlerItemsParse'
import { resolveCrawlerExecutionPolicyByLlm } from '../../../utils/crawler/managerCrawlerExecutionPolicyLlm'
import { ensureCrawlerSerpEnhancement, isCrawlerRequireSerpEnabled } from '../../../utils/crawler/managerCrawlerSerpEnhance'
import {
  inferSerpOnlyStructural,
  resolveShouldUseSerpOnlyCrawler
} from '../../../utils/crawler/managerCrawlerSerpOnlyLlm'
import { inferManagerCrawlerHintsByLlm } from '../../../utils/crawler/managerCrawlerTaskLlm'
import type { ManagerCrawlerLlmHints } from '../../../utils/crawler/managerCrawlerTaskLlm'
import { filterLowRiskSeedUrls } from '../../../utils/crawler/crawlSeedRisk'
import {
  buildLeanCrawlerUserTaskSync,
  resolveLeanCrawlerUserTaskAsync
} from '../../../utils/crawler/managerCrawlerLeanTaskLlm'
import {
  buildCrawlerHistoryFromMessages,
  buildCrawlerResultForManager,
  buildManagerCrawlerInvoke,
  buildSerpFallbackCrawlerAnswer,
  buildSerpFallbackCrawlerRaw,
  buildSerpOnlyCrawlerOutcome,
  crawlerInvokeFromState,
  resolveCrawlerSerpBundleFromMeta
} from '../../../utils/crawler/managerCrawlerTaskPayload'
import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'
import { taskConstraintsFromMeta } from '../../llm/taskConstraintsLlm'
import type { ManagerGraphState } from '../../state/state'
import { extractStructuredPayload } from '../shared'
import { parseCrawlerClarifyPayload } from '../text'
import { ChatOpenAI } from '@langchain/openai'
import type { AgentExecutorDeps, AgentExecutorOpts, AgentStepOutcome } from './types'

/** 供 smoke / 观测：记录 crawler 步骤实际触达的昂贵阶段 */
export type CrawlerStepPhaseTrace = {
  serpEnhanceMs: number
  policyMs: number
  hintsMs: number
  leanMs: number
  extractorMs: number
  path:
    | 'structural_serp_only'
    | 'structural_crawl_seeds'
    | 'policy_serp_only'
    | 'llm_serp_only'
    | 'crawl'
    | 'blocked'
    | 'error'
  calledPolicyLlm: boolean
  calledHintsLlm: boolean
  calledLeanLlm: boolean
  calledExtractor: boolean
}

export async function resolveCrawlerLlmHints(
  leanQuery: string,
  llm: { openaiApiKey?: string; openaiModel?: string; openaiBaseUrl?: string }
): Promise<ManagerCrawlerLlmHints | null> {
  const q = String(leanQuery || '').trim()
  if (!q || !String(llm.openaiApiKey ?? '').trim()) return null
  try {
    const model = new ChatOpenAI({
      apiKey: llm.openaiApiKey,
      modelName: String(llm.openaiModel || 'gpt-4o-mini').trim(),
      configuration: { baseURL: llm.openaiBaseUrl },
      temperature: 0
    })
    return await inferManagerCrawlerHintsByLlm(q, model)
  } catch {
    return null
  }
}

export function isCrawlerResultEmpty(result: unknown, answer: string): boolean {
  const text = String(answer || '').trim()
  if (text && !/^\s*(\{\s*\}|\[\s*\])\s*$/.test(text)) {
    const fromText = extractCrawlerItemsFromText(text)
    if (fromText.length) return false
  }
  const hits = crawlerSourceHitsForEvent(result, 24)
  if (hits.length) return false
  const items = extractCrawlerItemsFromPayload(result)
  if (items.length) return false
  if (result && typeof result === 'object') {
    const ar = (result as { agentResult?: { structured?: { itemCount?: number }; sources?: unknown[] } }).agentResult
    const count = Number(ar?.structured?.itemCount ?? 0)
    if (count > 0) return false
    if (Array.isArray(ar?.sources) && ar!.sources!.length > 0) return false
  }
  return !text || /^\s*(\{\s*\}|\[\s*\])\s*$/.test(text)
}

function crawlerMetaAgentResult(raw: unknown, output: string, traceId?: string): AgentResult | undefined {
  const row = raw as { agentResult?: AgentResult; items?: unknown[] } | null
  const base: AgentResult | undefined =
    row?.agentResult && typeof row.agentResult === 'object'
      ? row.agentResult
      : wrapCrawlerResult(output, Array.isArray(row?.items) ? row.items : [], traceId)
  if (!base) return undefined
  return {
    ...base,
    structured: markAgentPayloadUntrusted(
      (base.structured && typeof base.structured === 'object' ? base.structured : {}) as Record<string, unknown>,
      'crawler'
    )
  }
}

function formatCrawlerPhaseTiming(trace: CrawlerStepPhaseTrace): string {
  const extractorLabel = trace.calledExtractor ? `${trace.extractorMs}ms` : 'skipped'
  return `hints=${trace.calledHintsLlm ? `${trace.hintsMs}ms` : 'skipped'} policy=${trace.calledPolicyLlm ? `${trace.policyMs}ms` : 'skipped'} lean=${trace.calledLeanLlm ? `${trace.leanMs}ms` : 'skipped'} extractor=${extractorLabel}`
}

function emptyPhaseTrace(): CrawlerStepPhaseTrace {
  return {
    serpEnhanceMs: 0,
    policyMs: 0,
    hintsMs: 0,
    leanMs: 0,
    extractorMs: 0,
    path: 'error',
    calledPolicyLlm: false,
    calledHintsLlm: false,
    calledLeanLlm: false,
    calledExtractor: false
  }
}

/** smoke 用：构造空 phaseTrace */
export function emptyPhaseTraceForTest(): CrawlerStepPhaseTrace {
  return emptyPhaseTrace()
}

export function isStructuralCrawlSeedsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_CRAWLER_STRUCTURAL_CRAWL_SEEDS ?? '1').trim() !== '0'
}

/** 路由已声明需正文深抓 + 已有 SERP 种子 → 跳过 policy/hints/lean */
export function inferStructuralCrawlSeeds(
  meta?: Record<string, unknown> | null,
  seedUrls?: string[]
): { crawl: true; rationale: string } | null {
  if (!isStructuralCrawlSeedsEnabled()) return null
  const seeds = (seedUrls || []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u))
  if (!seeds.length) return null
  const webMode = meta?.webExecutionMode as { mode?: string; serpSummaryEnough?: boolean } | undefined
  if (!webMode || webMode.serpSummaryEnough === true) return null
  if (webMode.mode === 'search_then_crawl' || webMode.mode === 'crawl_direct') {
    return { crawl: true, rationale: `web_mode_${webMode.mode}` }
  }
  return null
}

function pickCrawlSeedUrls(allSeeds: string[], preferred?: string[]): string[] {
  const prefer = (preferred || []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u))
  if (prefer.length) return prefer.slice(0, 6)
  const lowRisk = filterLowRiskSeedUrls(allSeeds, 6)
  return lowRisk.length ? lowRisk : allSeeds.filter((u) => /^https?:\/\//i.test(u)).slice(0, 6)
}

function serpOnlyOutcomeResult(
  serpOnly: { output: string; raw: Record<string, unknown> | null },
  task: string,
  path: CrawlerStepPhaseTrace['path'],
  trace: CrawlerStepPhaseTrace,
  sendThinking: (t: string) => void
): AgentStepOutcome & { task?: string; rawResult?: unknown; phaseTrace?: CrawlerStepPhaseTrace } {
  trace.path = path
  sendThinking(`联网快路径：仅需参考摘要，跳过全量浏览器抓取（${formatCrawlerPhaseTiming(trace)}）`)
  const sourceHits = serpOnly.raw ? crawlerSourceHitsForEvent(serpOnly.raw) : []
  return {
    ok: true,
    agent: 'crawler',
    output: serpOnly.output,
    query: task,
    task,
    parsed: extractStructuredPayload(serpOnly.output),
    evidence: {
      kind: 'crawler',
      query: task,
      itemCount: sourceHits.length,
      items: sourceHits,
      serpFallback: true,
      serpOnly: true
    },
    rawResult: serpOnly.raw,
    phaseTrace: { ...trace }
  }
}

export async function executeCrawlerStep(
  deps: AgentExecutorDeps,
  opts: AgentExecutorOpts,
  input: {
    state: ManagerGraphState
    effQuery: string
    timeoutMs: number
    sendThinking: (t: string) => void
    allowRetry: boolean
    /** 已解析的 hints；仅深抓路径需要。未传则在确认深抓时内部解析 */
    llmHints?: ManagerCrawlerLlmHints | null
    llm?: { openaiApiKey?: string; openaiModel?: string; openaiBaseUrl?: string } | null
    llmInvoke?: LlmInvokeFn | null
    /** 可选：smoke 写入阶段触达标记 */
    phaseTraceOut?: CrawlerStepPhaseTrace
  }
): Promise<AgentStepOutcome & { task?: string; rawResult?: unknown; phaseTrace?: CrawlerStepPhaseTrace }> {
  const trace = input.phaseTraceOut ?? emptyPhaseTrace()
  const lastUser = deps.lastUserText(input.state.messages)
  const metaBase = (input.state.meta && typeof input.state.meta === 'object'
    ? input.state.meta
    : {}) as Record<string, unknown>

  const tEnhance0 = Date.now()
  const enhancedMeta = await ensureCrawlerSerpEnhancement({
    meta: metaBase,
    taskText: input.effQuery,
    lastUser,
    llm: input.llm,
    sendThinking: input.sendThinking
  })
  trace.serpEnhanceMs = Date.now() - tEnhance0

  const seedUrls = Array.isArray(enhancedMeta.seedUrls)
    ? (enhancedMeta.seedUrls as unknown[]).map((u) => String(u ?? '').trim()).filter(Boolean)
    : []
  const serpContext = String(enhancedMeta.serpContext ?? '').trim()
  const searchHits = Array.isArray(enhancedMeta.searchHits) ? enhancedMeta.searchHits : []

  if (
    isCrawlerRequireSerpEnabled() &&
    enhancedMeta.crawlerSerpBlocked === true &&
    !seedUrls.length &&
    !serpContext &&
    !searchHits.length
  ) {
    trace.path = 'blocked'
    return {
      ok: false,
      agent: 'crawler',
      output: '爬虫步骤须先完成联网搜索增强（SERP 种子/摘要）。请检查 MANAGER_WEB_SEARCH 配置，或改用 gui 执行浏览器交互任务。',
      error: 'crawler_serp_required',
      query: input.effQuery,
      phaseTrace: { ...trace }
    }
  }

  const allowed = Array.isArray(input.state.meta?.allowedAgents) ? input.state.meta!.allowedAgents! : []
  if (allowed.includes('gui') || String(input.state.intent ?? '') === 'gui') {
    trace.path = 'blocked'
    return {
      ok: false,
      agent: 'crawler',
      output: '该任务需浏览器交互（GUI），不应走爬虫/SERP 快路径。',
      error: 'gui_required',
      query: input.effQuery,
      task: input.effQuery,
      phaseTrace: { ...trace }
    }
  }

  const metaForInvoke = enhancedMeta

  // 1) 路由结构性快路径：webExecutionMode 已声明 SERP 足够 → 零 LLM
  const structural = inferSerpOnlyStructural(input.effQuery, metaForInvoke as Record<string, unknown>)
  if (structural?.serpOnly === true) {
    const inv = crawlerInvokeFromState(input.effQuery, lastUser, metaForInvoke, null, 'serp_only')
    const serpOnly = buildSerpOnlyCrawlerOutcome(metaForInvoke as Record<string, unknown>, inv.task)
    if (serpOnly) {
      input.sendThinking(
        `爬虫策略（结构）：${structural.rationale || 'web_mode_serp_only'} → 跳过浏览器深抓（${formatCrawlerPhaseTiming(trace)}）`
      )
      return serpOnlyOutcomeResult(serpOnly, inv.task, 'structural_serp_only', trace, input.sendThinking)
    }
  }

  // 1b) 路由结构性深抓：search_then_crawl/crawl_direct + 已有种子 → 直送 Extractor
  const structuralCrawl = inferStructuralCrawlSeeds(metaForInvoke as Record<string, unknown>, seedUrls)
  let preferredCrawlSeeds: string[] | undefined
  let effectiveStrategy: 'serp_only' | 'crawl_seeds' | 'open_discovery' | undefined
  let skipPrepLlms = false

  if (structuralCrawl) {
    preferredCrawlSeeds = pickCrawlSeedUrls(seedUrls)
    effectiveStrategy = 'crawl_seeds'
    skipPrepLlms = true
    input.sendThinking(
      `爬虫策略（结构）：${structuralCrawl.rationale} → SERP 种子精抓 ${preferredCrawlSeeds.length} 个（${formatCrawlerPhaseTiming(trace)}）`
    )
  } else {
    // 2) 执行策略 LLM（仅当结构未能锁定路径）
    const tPolicy0 = Date.now()
    trace.calledPolicyLlm = true
    const execPolicy = await resolveCrawlerExecutionPolicyByLlm({
      taskText: input.effQuery,
      serpContext,
      seedUrls,
      searchHitCount: searchHits.length,
      llmInvoke: input.llmInvoke ?? null,
      state: { ...input.state, meta: enhancedMeta }
    })
    trace.policyMs = Date.now() - tPolicy0

    effectiveStrategy = execPolicy?.strategy
    const webMode = metaForInvoke.webExecutionMode as { mode?: string } | undefined
    const routeWantsCrawl = webMode?.mode === 'search_then_crawl' || webMode?.mode === 'crawl_direct'
    if (effectiveStrategy === 'crawl_seeds' && execPolicy && !execPolicy.filteredSeedUrls.length) {
      if (routeWantsCrawl && seedUrls.length) {
        preferredCrawlSeeds = pickCrawlSeedUrls(seedUrls)
      } else {
        effectiveStrategy = 'serp_only'
      }
    } else if (effectiveStrategy === 'crawl_seeds' && execPolicy?.filteredSeedUrls.length) {
      preferredCrawlSeeds = pickCrawlSeedUrls(seedUrls, execPolicy.filteredSeedUrls)
    }

    if (effectiveStrategy === 'serp_only') {
      input.sendThinking(
        `爬虫策略（LLM）：${execPolicy?.rationale.slice(0, 72) || 'SERP 摘要足够'} → 跳过浏览器深抓（policy=${trace.policyMs}ms）`
      )
      const inv = crawlerInvokeFromState(input.effQuery, lastUser, metaForInvoke, null, 'serp_only')
      const serpOnly = buildSerpOnlyCrawlerOutcome(metaForInvoke as Record<string, unknown>, inv.task)
      if (serpOnly) {
        return serpOnlyOutcomeResult(serpOnly, inv.task, 'policy_serp_only', trace, input.sendThinking)
      }
    } else if (effectiveStrategy === 'crawl_seeds') {
      const n = preferredCrawlSeeds?.length || seedUrls.length
      input.sendThinking(
        `爬虫策略（LLM）：混合抓取 SERP 种子（${n} 个优先深抓，高风险走摘要旁路）（policy=${trace.policyMs}ms）`
      )
    } else if (effectiveStrategy === 'open_discovery') {
      input.sendThinking(
        `爬虫策略（LLM）：${execPolicy?.rationale.slice(0, 72) || '开放式发现'}（policy=${trace.policyMs}ms）`
      )
    }

    // 3) 策略未给 serp_only：再走一层（可能 LLM）；此时仍用同步 task，避免无谓 lean
    if (effectiveStrategy !== 'serp_only') {
      const syncInv = crawlerInvokeFromState(
        input.effQuery,
        lastUser,
        metaForInvoke,
        null,
        effectiveStrategy
      )
      const useSerpOnly = await resolveShouldUseSerpOnlyCrawler({
        taskText: syncInv.task,
        meta: metaForInvoke as Record<string, unknown>,
        llmInvoke: input.llmInvoke,
        llm: input.llm,
        state: input.state
      })
      if (useSerpOnly) {
        const serpOnly = buildSerpOnlyCrawlerOutcome(metaForInvoke as Record<string, unknown>, syncInv.task)
        if (serpOnly) {
          return serpOnlyOutcomeResult(serpOnly, syncInv.task, 'llm_serp_only', trace, input.sendThinking)
        }
      }
    }
  }

  // 4) 深抓路径：有种子时跳过 hints/lean；直送 Extractor
  const tDeep0 = Date.now()
  const hasSeedsForCrawl =
    (preferredCrawlSeeds && preferredCrawlSeeds.length > 0) ||
    seedUrls.length > 0 ||
    effectiveStrategy === 'crawl_seeds'

  let leanTask: string
  let llmHints: ManagerCrawlerLlmHints | null = null

  if (skipPrepLlms || (hasSeedsForCrawl && effectiveStrategy === 'crawl_seeds')) {
    leanTask = buildLeanCrawlerUserTaskSync(input.effQuery, lastUser)
    llmHints = { site: null, limit: null, openWebDiscovery: false }
  } else {
    const hintsPromise = (async (): Promise<ManagerCrawlerLlmHints | null> => {
      if (input.llmHints !== undefined) return input.llmHints ?? null
      if (!input.llm) return null
      const tHints0 = Date.now()
      trace.calledHintsLlm = true
      const hints = await resolveCrawlerLlmHints(input.effQuery, {
        openaiApiKey: input.llm.openaiApiKey,
        openaiModel: input.llm.openaiModel,
        openaiBaseUrl: input.llm.openaiBaseUrl
      })
      trace.hintsMs = Date.now() - tHints0
      return hints
    })()
    const leanPromise = (async () => {
      const tLean0 = Date.now()
      trace.calledLeanLlm = true
      const lean = await resolveLeanCrawlerUserTaskAsync({
        stepOrRouted: input.effQuery,
        lastUserMessage: lastUser,
        llm: input.llm
      })
      trace.leanMs = Date.now() - tLean0
      return lean
    })()
    ;[llmHints, leanTask] = await Promise.all([hintsPromise, leanPromise])
  }

  const bundle = resolveCrawlerSerpBundleFromMeta(metaForInvoke)
  const crawlSeedUrls = pickCrawlSeedUrls(bundle.seedUrls.length ? bundle.seedUrls : seedUrls, preferredCrawlSeeds)
  const needsWeb = metaForInvoke.needsWebSearch === true
  const mergedHints =
    llmHints ??
    (effectiveStrategy === 'open_discovery'
      ? { site: null, limit: null, openWebDiscovery: true }
      : needsWeb || crawlSeedUrls.length
        ? { site: null, limit: null, openWebDiscovery: false }
        : null)
  const inv = buildManagerCrawlerInvoke({
    stepOrRoutedQuery: input.effQuery,
    lastUserMessage: lastUser,
    leanTask,
    seedUrls: crawlSeedUrls.length ? crawlSeedUrls : bundle.seedUrls,
    serpContext: bundle.serpContext || undefined,
    serpHits: bundle.serpHits.length ? bundle.serpHits : undefined,
    searchContext: bundle.searchContext,
    crawlStrategy: effectiveStrategy ?? (crawlSeedUrls.length ? 'crawl_seeds' : undefined),
    llmHints: mergedHints,
    constraints: taskConstraintsFromMeta(metaForInvoke)
  })
  const task = inv.task
  const managerTask = inv.managerTask
  const maxItems = inv.maxItems

  if (structuralCrawl) {
    trace.path = 'structural_crawl_seeds'
  }

  input.sendThinking(
    `网页爬虫：深抓准备完成（种子 ${crawlSeedUrls.length || bundle.seedUrls.length}，${formatCrawlerPhaseTiming(trace)}，prepare=${Date.now() - tDeep0}ms）`
  )

  try {
    const tExt0 = Date.now()
    trace.calledExtractor = true
    const res = await deps.callCrawlerAgent({
      crawlerAgentWsUrl: opts.crawlerAgentWsUrl,
      timeoutMs: input.timeoutMs,
      task,
      managerTask,
      sessionId: opts.sessionId,
      history: buildCrawlerHistoryFromMessages(input.state.messages),
      options: { maxItems: maxItems ?? 10 },
      sendThinking: input.sendThinking,
      signal: opts.signal,
      traceId: opts.runId
    })
    trace.extractorMs = Date.now() - tExt0
    if (trace.path !== 'structural_crawl_seeds') trace.path = 'crawl'
    input.sendThinking(`网页爬虫：Extractor 返回（extractor=${trace.extractorMs}ms）`)

    const domRes = typeof res === 'object' && res ? deps.filterCrawlerResultDomestic(res) : res
    const crawlerClarify = parseCrawlerClarifyPayload(domRes)
    let output = buildCrawlerResultForManager(domRes, task)
    let rawForEvidence = domRes
    if (isCrawlerResultEmpty(domRes, output)) {
      const serpAnswer = buildSerpFallbackCrawlerAnswer(metaForInvoke, task)
      if (serpAnswer) {
        output = serpAnswer
        rawForEvidence = buildSerpFallbackCrawlerRaw(metaForInvoke) ?? domRes
        input.sendThinking('网页爬虫：部分 URL 被站点拒绝(403)，已回退使用联网检索摘要')
      }
    }
    const routeSuggestion = String(
      (rawForEvidence as { agentResult?: { structured?: { route_suggestion?: string } } })?.agentResult?.structured
        ?.route_suggestion ??
        (domRes as { agentResult?: { structured?: { route_suggestion?: string } } })?.agentResult?.structured
          ?.route_suggestion ??
        ''
    ).trim()
    if (routeSuggestion === 'gui') {
      input.sendThinking('网页抓取：检测到登录/SPA 场景，建议后续改用 gui（Lobster）交互操作')
    }
    const sourceHits = crawlerSourceHitsForEvent(rawForEvidence)
    return {
      ok: true,
      agent: 'crawler',
      output,
      query: task,
      task,
      parsed: extractStructuredPayload(output),
      evidence: {
        kind: 'crawler',
        query: task,
        itemCount: sourceHits.length,
        items: sourceHits,
        serpFallback: output.includes('联网检索摘要'),
        ...(routeSuggestion ? { routeSuggestion } : {})
      },
      clarifyQuestions: crawlerClarify.needsClarify ? crawlerClarify.questions : undefined,
      rawResult: rawForEvidence,
      meta: { agentResult: crawlerMetaAgentResult(rawForEvidence, output, opts.runId) },
      phaseTrace: { ...trace }
    }
  } catch (e: unknown) {
    const err = String((e as Error)?.message || e || 'unknown error')
    const serpAnswer = buildSerpFallbackCrawlerAnswer(metaForInvoke, task)
    const serpFallbackEligible =
      serpAnswer &&
      (searchHits.length > 0 ||
        ['403', 'forbidden', 'blocked', '拦截', '验证码', 'aborted', 'timeout', 'empty', '无有效'].some((m) =>
          err.toLowerCase().includes(m.toLowerCase())
        ))
    if (serpFallbackEligible) {
      input.sendThinking('网页爬虫：抓取失败，已回退使用 Manager 联网检索摘要')
      const rawForEvidence =
        buildSerpFallbackCrawlerRaw(metaForInvoke) ??
        buildSerpFallbackCrawlerRaw(input.state.meta as Record<string, unknown>)
      const sourceHits = rawForEvidence ? crawlerSourceHitsForEvent(rawForEvidence) : []
      return {
        ok: true,
        agent: 'crawler',
        output: serpAnswer,
        query: task,
        task,
        parsed: extractStructuredPayload(serpAnswer),
        evidence: { kind: 'crawler', query: task, itemCount: sourceHits.length, items: sourceHits, serpFallback: true },
        rawResult: rawForEvidence,
        phaseTrace: { ...trace }
      }
    }
    const hasUrl = /https?:\/\/\S+/i.test(task)
    if (input.allowRetry && hasUrl) {
      try {
        const url = (task.match(/https?:\/\/\S+/i) || [])[0] || ''
        const retryTask = url ? `仅抓取该 URL 并提取与任务相关的关键信息：${url}` : task
        const res2 = await deps.callCrawlerAgent({
          crawlerAgentWsUrl: opts.crawlerAgentWsUrl,
          timeoutMs: Math.min(opts.timeoutMs, 45_000),
          task: retryTask,
          managerTask,
          sendThinking: input.sendThinking,
          signal: opts.signal,
          traceId: opts.runId
        })
        const crawlerClarify2 = parseCrawlerClarifyPayload(res2)
        const output = buildCrawlerResultForManager(res2, retryTask)
        return {
          ok: true,
          agent: 'crawler',
          output,
          query: task,
          task,
          parsed: extractStructuredPayload(output),
          evidence: { kind: 'crawler', query: retryTask },
          clarifyQuestions: crawlerClarify2.needsClarify ? crawlerClarify2.questions : undefined,
          rawResult: res2,
          phaseTrace: { ...trace }
        }
      } catch (e2: unknown) {
        const err2 = String((e2 as Error)?.message || e2 || 'unknown error')
        trace.path = 'error'
        return {
          ok: false,
          agent: 'crawler',
          output: `网页抓取失败：${err}\n重试失败：${err2}\n\n下一步：请提供更具体的 URL（可直接粘贴）或关键词，并说明需要提取的字段/范围。`,
          query: task,
          task,
          error: err2,
          phaseTrace: { ...trace }
        }
      }
    }
    trace.path = 'error'
    const output = hasUrl
      ? `网页抓取失败：${err}\n建议检查 URL 是否可访问或稍后再试。`
      : `网页抓取失败：${err}\n无法从公开网页获取到有效信息。`
    return { ok: false, agent: 'crawler', output, query: task, task, error: err, phaseTrace: { ...trace } }
  }
}
