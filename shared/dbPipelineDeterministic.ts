import type { ExtractPayloadFn } from './codeFirstAuthority'
import { formatFactsAsDeepSeekReply } from './deepSeekReplyFormat'
import { assembleVisualizeFromChartPlan } from './codeAuthorityPayload'
import { buildChartPlanFromTabularRows, parseTabularRowsFromData, parseMarkdownTableAsTabularRows, rowsFromRankedFacts } from './tabularChartSchema'

function dbRawFromResults(results: Record<string, unknown>): string {
  return String(results.db ?? '').trim()
}

function isDbEmptyText(raw: string): boolean {
  const t = String(raw ?? '').trim()
  if (!t) return true
  return /未查到|暂无|无相关|没有相关|No data|not found/i.test(t)
}

/** 仅 db 为取数源（无 rag/crawler 实质内容）时走确定性透传 */
export function isDbPrimaryPipeline(results: Record<string, unknown>): boolean {
  const db = dbRawFromResults(results)
  if (!db || isDbEmptyText(db)) return false
  const rag = String(results.rag ?? '').trim()
  const crawler = String(results.crawler ?? '').trim()
  if (rag && !/未命中|无相关|未找到/i.test(rag)) return false
  if (crawler && !/未从公开|抓取失败|无有效/i.test(crawler)) return false
  return true
}

function collectDbFacts(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn
): Array<{ key: string; value: unknown; source: string }> {
  const dbRaw = dbRawFromResults(results)
  const cleanRaw = String(results.clean ?? '').trim()
  const fromDb = extractPayload(dbRaw).facts || []
  const fromClean = cleanRaw ? extractPayload(cleanRaw).facts || [] : []
  const map = new Map<string, { key: string; value: unknown; source: string }>()
  for (const f of fromDb) {
    const key = String(f?.key ?? '').trim()
    if (!key) continue
    map.set(key.toLowerCase().replace(/\s+/g, ''), { key, value: f.value, source: 'db' })
  }
  for (const f of fromClean) {
    const key = String(f?.key ?? '').trim()
    if (!key) continue
    const nk = key.toLowerCase().replace(/\s+/g, '')
    if (!map.has(nk)) map.set(nk, { key, value: f.value, source: 'clean' })
  }
  return [...map.values()].slice(0, 32)
}

/** clean 仅依赖 db 时：字段标准化 JSON，避免 LLM 改写数字 */
export function tryDeterministicCleanFromDbResults(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn
): string | null {
  if (!isDbPrimaryPipeline(results)) return null
  const facts = collectDbFacts(results, extractPayload)
  if (facts.length < 2) return null
  const obj = {
    answer: '已自数据库记录标准化字段（数值与原文一致，未改写）。',
    facts: facts.map((f) => ({ key: f.key, value: f.value, source: f.source })),
    data: { cleaned_from: 'db', mode: 'deterministic' }
  }
  return JSON.stringify(obj, null, 0)
}

function mapFactsForCodeOutput(
  facts: Array<{ key: string; value: unknown; source: string }>
): Array<{ key: string; value: unknown; source: string }> {
  return facts.map((f) => ({ key: f.key, value: f.value, source: f.source }))
}

/** clean 已产出结构化 JSON 时直接透传，跳过 Code LLM */
function tryPassthroughCleanCode(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn
): string | null {
  const cleanRaw = String(results.clean ?? '').trim()
  if (!cleanRaw) return null
  const parsed = extractPayload(cleanRaw)
  const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
    .map((f) => ({
      key: String(f?.key ?? '').trim(),
      value: f?.value,
      source: 'clean' as const
    }))
    .filter((f) => f.key)
  if (!facts.length) return null
  const answer = String(parsed.answer ?? '').trim()
  if (!answer && facts.length < 1) return null
  const data =
    parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
      ? { ...(parsed.data as Record<string, unknown>), source: 'clean_deterministic' }
      : { source: 'clean_deterministic', fact_count: facts.length }
  const summary =
    answer ||
    (facts.length > 10
      ? `已整理 ${facts.length} 项数据库字段（见 facts，不逐条复述）。`
      : facts
          .slice(0, 14)
          .map((f) => `${f.key}：${String(f.value ?? '')}`)
          .join('；'))
  return JSON.stringify(
    {
      answer: summary.length > 480 ? `${summary.slice(0, 477)}…` : summary,
      facts: mapFactsForCodeOutput(facts),
      confidence: 0.94,
      data
    },
    null,
    0
  )
}

function buildDeterministicCodeJson(
  facts: Array<{ key: string; value: unknown; source: string }>
): string {
  const summary =
    facts.length > 10
      ? `已从数据库读取 ${facts.length} 项指标（数值见 facts，正文由 report 汇总，不逐条复述）。`
      : facts
          .slice(0, 14)
          .map((f) => `${f.key}：${String(f.value ?? '')}`)
          .join('；')
  return JSON.stringify(
    {
      answer: summary.length > 480 ? `${summary.slice(0, 477)}…` : summary,
      facts: mapFactsForCodeOutput(facts),
      confidence: 0.96,
      data: { source: 'db_deterministic', fact_count: facts.length }
    },
    null,
    0
  )
}

/** code 仅依赖 db（+可选 clean）时：facts 全量来自上游，禁止 LLM 编造 */
export function tryDeterministicCodeFromDbResults(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn
): string | null {
  if (!isDbPrimaryPipeline(results)) return null
  return tryDeterministicStructuralCode(results, extractPayload)
}

/**
 * 单源 DB（+可选 clean）时：Code 仅字段归并，跳过 Code Agent。
 * 多源（db+rag/crawler）必须走 Code Agent compute/对照，禁止把 clean 机械堆砌当计算结果。
 */
export function tryDeterministicStructuralCode(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn
): string | null {
  if (isMultiSourceDataPipeline(results)) return null

  const db = dbRawFromResults(results)
  if (!db || isDbEmptyText(db)) return null

  const cleanPassthrough = tryPassthroughCleanCode(results, extractPayload)
  if (cleanPassthrough) return cleanPassthrough

  const facts = collectDbFacts(results, extractPayload)
  if (facts.length < 1) return null
  return buildDeterministicCodeJson(facts)
}

/** report：单源 DB 或 Code 含结构化 facts 时，确定性生成报告（跳过 report LLM） */
export function tryDeterministicReportFromDbResults(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn,
): string | null {
  if (!isDbPrimaryPipeline(results)) return null
  if (String(results.code ?? '').trim()) return null
  const facts = collectDbFacts(results, extractPayload)
  if (facts.length < 2) return null
  const dbRaw = dbRawFromResults(results)
  const parsed = extractPayload(dbRaw)
  const answer = String(parsed.answer ?? '').trim()
  return formatFactsAsDeepSeekReply({
    facts,
    answer: isReadableSummary(answer) ? answer : undefined,
    sourceHint: '取数'
  })
}

function sourceHasContent(raw: string): boolean {
  const t = String(raw ?? '').trim()
  if (!t) return false
  return !/未命中|无相关|未找到|未查到|暂无|抓取失败|无有效/i.test(t)
}

export function activeDataSources(results: Record<string, unknown>): Array<'db' | 'rag' | 'crawler'> {
  const out: Array<'db' | 'rag' | 'crawler'> = []
  if (sourceHasContent(String(results.db ?? ''))) out.push('db')
  if (sourceHasContent(String(results.rag ?? ''))) out.push('rag')
  if (sourceHasContent(String(results.crawler ?? ''))) out.push('crawler')
  return out
}

export function isMultiSourceDataPipeline(results: Record<string, unknown>): boolean {
  return activeDataSources(results).length > 1
}

/** 单取数源时确定性 clean（字段整理透传，跳过 Clean LLM） */
export function tryDeterministicCleanFromSingleSource(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn
): string | null {
  const fromDb = tryDeterministicCleanFromDbResults(results, extractPayload)
  if (fromDb) return fromDb

  const sources = activeDataSources(results)
  if (sources.length !== 1) return null
  const src = sources[0]!
  const raw = String(results[src] ?? '').trim()
  const parsed = extractPayload(raw)
  const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
    .map((f) => ({
      key: String(f?.key ?? '').trim(),
      value: f?.value,
      source: src
    }))
    .filter((f) => f.key)
  if (!facts.length) return null
  return JSON.stringify(
    {
      answer: `已对单一取数源（${src}）做结构化整理（确定性透传，未改写数值）。`,
      sources: [{ agent: src }],
      facts: facts.map((f) => ({ key: f.key, value: f.value, source: f.source })),
      quality: { conflicts: [], missing_fields: [], deduped_count: 0 },
      data: { cleaned_from: src, mode: 'single_source', raw_source_count: 1 }
    },
    null,
    0
  )
}

/** visualize：单源 DB 且含 tabular_rows / 可排名 facts 时确定性出图 */
export function tryDeterministicVisualizeFromDbTabular(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn
): string | null {
  if (!isDbPrimaryPipeline(results)) return null
  const dbRaw = dbRawFromResults(results)
  const parsed = extractPayload(dbRaw)
  const rows =
    parseTabularRowsFromData(parsed.data) ??
    rowsFromRankedFacts(
      (Array.isArray(parsed.facts) ? parsed.facts : []).map((f) => ({
        key: String(f?.key ?? ''),
        value: f?.value
      }))
    ) ??
    parseMarkdownTableAsTabularRows(dbRaw) ??
    parseMarkdownTableAsTabularRows(String(parsed.answer ?? ''))
  if (!rows?.length) return null
  const title = String((parsed.data as { chart_title?: string })?.chart_title ?? parsed.answer ?? '数据库图表')
    .trim()
    .slice(0, 48)
  const plan = buildChartPlanFromTabularRows(rows, title || '数据库图表')
  if (!plan) return null
  return assembleVisualizeFromChartPlan(plan, '【确定性】基于数据库 tabular 数据生成图表')
}

function isReadableSummary(s: string): boolean {
  const t = String(s ?? '').trim()
  return t.length >= 12 && !t.startsWith('{') && !/^[\d\s:：\-./]+$/.test(t.slice(0, 40))
}

/** report：Code 已含结构化 facts 但非财务三元组时，确定性生成报告 */
export function tryDeterministicReportFromCodeFacts(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn
): string | null {
  const codeRaw = String(results.code ?? '').trim()
  if (!codeRaw) return null
  const parsed = extractPayload(codeRaw)
  const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
    .map((f) => ({ key: String(f?.key ?? '').trim(), value: f?.value, source: 'code' as const }))
    .filter((f) => f.key)
  if (facts.length < 2) return null
  const answer = String(parsed.answer ?? '').trim()
  return formatFactsAsDeepSeekReply({
    facts,
    answer: isReadableSummary(answer) ? answer : undefined,
    sourceHint: 'Code'
  })
}
