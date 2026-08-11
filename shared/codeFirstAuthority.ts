/**
 * 多 Agent 流水线：下游图表/报告/汇总以 Code 步骤为权威数据源，冲突时 Code 覆盖。
 */

export type StructuredFactLike = { key?: string; value?: unknown; label?: string; source?: string }

export type ExtractPayloadFn = (raw: string) => {
  facts?: StructuredFactLike[]
  answer?: string
  data?: unknown
}

export type CodeFirstBundle = {
  hasCode: boolean
  codeAnswer: string
  mergedFacts: Array<{ key: string; value: unknown; label?: string; source: string }>
  factsMarkdown: string
  authorityBanner: string
  downstreamContext: string
}

export const CODE_AUTHORITY_RULE =
  '【数据权威 — Code】若上下文含 Code 计算/汇总结果：图表、表格与报告中的关键数字、比例、指标必须与 Code 的 answer 及 facts 一致；与 RAG/DB/爬虫 冲突时一律采信 Code，勿沿用上游未计算的原始数。'

export const CODE_AUTHORITY_SYNTH_RULE =
  '若存在 Code 步骤：图表/REPORT 块数字以 Code 为准；多源对照任务须分别呈现库内数据与联网参考，禁止把 DB 数值标成联网摘要。'

export const CODE_AUTHORITY_CRITIC_RULE =
  '若子步骤含 Code：图表/REPORT 块数字须与 Code 一致；多源任务（DB+爬虫/RAG）时正文可同时引用上游公开参考与 Code facts，仅当捏造未出现于任何上游/Code 的数字或图表 series 错误时 needsRetry=true。'

export const REPORT_SYNTH_ALIGNMENT_SYNTH_RULE =
  '若已有 report 子输出或 <!--REPORT--> 块：正文关键数字、是否缺失某字段/参考范围须与报告块一致，禁止正文与报告块对同一事实给出相反结论。'

export const REPORT_SYNTH_ALIGNMENT_CRITIC_RULE =
  '若拟回答同时含对话正文与 <!--REPORT-->（或 report 子步骤输出）：对同一对象/指标/参考范围/左右侧数据不得自相矛盾；矛盾时 needsRetry=true，retryIntent=multi 或 report。'

const UPSTREAM_AGENTS = ['rag', 'db', 'crawler', 'clean'] as const
export type UpstreamAgentId = (typeof UPSTREAM_AGENTS)[number]

export type DownstreamContextOpts = {
  maxCodeChars?: number
  maxRefChars?: number
  perAgentMaxChars?: Partial<Record<UpstreamAgentId, number>>
  /** 返回非空时优先作为该 Agent 上下文（如 crawler 表格 Markdown） */
  enrichAgentBody?: (agent: UpstreamAgentId, raw: string) => string
}

function normKey(k: string): string {
  return String(k ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

function flattenDataObject(data: unknown, prefix = ''): StructuredFactLike[] {
  if (data == null) return []
  if (typeof data !== 'object' || Array.isArray(data)) return []
  const out: StructuredFactLike[] = []
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenDataObject(v, key))
    } else if (v !== undefined && v !== null && String(v).trim() !== '') {
      out.push({ key, value: v })
    }
  }
  return out.slice(0, 40)
}

function factsFromAgent(
  agent: string,
  raw: string,
  extractPayload?: ExtractPayloadFn,
): StructuredFactLike[] {
  const txt = String(raw ?? '').trim()
  if (!txt) return []
  if (!extractPayload) return []
  const parsed = extractPayload(txt)
  const fromFacts = Array.isArray(parsed.facts) ? parsed.facts : []
  const fromData = flattenDataObject(parsed.data)
  return [...fromFacts, ...fromData].map((f) => {
    const label = String(f.label ?? '').trim()
    return {
      key: String(f.key ?? '').trim(),
      value: f.value,
      ...(label ? { label } : {}),
      source: agent
    }
  })
}

/** 合并多源 facts：同名键 Code 最后写入，覆盖 RAG/DB/爬虫 */
export function mergeFactsWithCodePriority(
  results: Record<string, unknown>,
  extractPayload?: ExtractPayloadFn,
): Array<{ key: string; value: unknown; label?: string; source: string }> {
  const map = new Map<string, { key: string; value: unknown; label?: string; source: string }>()

  const ingest = (agent: string, facts: StructuredFactLike[]) => {
    for (const f of facts) {
      const key = String(f.key ?? '').trim()
      if (!key) continue
      const nk = normKey(key)
      const label = String(f.label ?? '').trim()
      map.set(nk, {
        key,
        value: f.value,
        ...(label ? { label } : {}),
        source: String(f.source || agent)
      })
    }
  }

  for (const agent of UPSTREAM_AGENTS) {
    ingest(agent, factsFromAgent(agent, String(results[agent] ?? ''), extractPayload))
  }

  const codeRaw = String(results.code ?? '').trim()
  if (codeRaw) {
    ingest('code', factsFromAgent('code', codeRaw, extractPayload))
  }

  return [...map.values()].slice(0, 48)
}

export function formatFactsMarkdown(
  facts: Array<{ key: string; value: unknown; source: string }>,
  title = '合并事实（Code 覆盖同名键）',
): string {
  if (!facts.length) return ''
  const lines = facts.slice(0, 24).map((f) => `- **${f.key}**：${String(f.value ?? '')}（${f.source}）`)
  return [`### ${title}`, '', ...lines].join('\n')
}

export function hasCodeInResults(results: Record<string, unknown> | null | undefined): boolean {
  return Boolean(String(results?.code ?? '').trim())
}

/** Critic Code 门禁：各子 Agent 原文摘要（含 admin/gui 工具输出，避免误报「凭空捏造」） */
export function collectAgentAnswerSummariesForAudit(
  results: Record<string, unknown>,
  extractPayload?: ExtractPayloadFn,
  maxPerAgent = 900
): string {
  const agents = ['db', 'rag', 'crawler', 'clean', 'code', 'admin', 'gui'] as const
  const parts: string[] = []
  for (const agent of agents) {
    const raw = String(results[agent] ?? '').trim()
    if (!raw) continue
    let body = raw.replace(/\s+/g, ' ').trim()
    if (extractPayload) {
      const parsed = extractPayload(raw)
      const ans = String(parsed.answer ?? '').trim()
      if (ans) body = ans.replace(/\s+/g, ' ').trim()
      else {
        const factLines = (Array.isArray(parsed.facts) ? parsed.facts : [])
          .slice(0, 12)
          .map((f) => `${String(f?.key ?? '').trim()}: ${String(f?.value ?? '')}`)
          .filter((l) => l.length > 2)
        if (factLines.length) body = factLines.join('; ')
      }
    }
    if (!body) continue
    parts.push(`[${agent}] ${body.length > maxPerAgent ? `${body.slice(0, maxPerAgent)}…` : body}`)
  }
  return parts.join('\n\n')
}

export function buildCodeFirstBundle(params: {
  results: Record<string, unknown>
  extractPayload?: ExtractPayloadFn
  maxCodeChars?: number
  maxRefChars?: number
  perAgentMaxChars?: Partial<Record<UpstreamAgentId, number>>
  enrichAgentBody?: (agent: UpstreamAgentId, raw: string) => string
}): CodeFirstBundle {
  const results = params.results && typeof params.results === 'object' ? params.results : {}
  const extractPayload = params.extractPayload
  const maxCode = params.maxCodeChars ?? 2800
  const maxRef = params.maxRefChars ?? 600

  const codeRaw = String(results.code ?? '').trim()
  const hasCode = codeRaw.length > 0
  let codeAnswer = codeRaw
  if (extractPayload && codeRaw) {
    const parsed = extractPayload(codeRaw)
    codeAnswer = String(parsed.answer ?? codeRaw).trim() || codeRaw
  }

  const mergedFacts = hasCode
    ? mergeFactsWithCodePriority({ code: codeRaw }, extractPayload)
    : mergeFactsWithCodePriority(results, extractPayload)
  const factsMarkdown = formatFactsMarkdown(mergedFacts)

  const authorityBanner = hasCode
    ? '【数据口径】图表、报告与对话汇总以 **Code 计算结果** 为准；与其它 Agent 冲突时采信 Code。'
    : ''

  const blocks: string[] = []
  if (hasCode) {
    blocks.push(
      '【权威数据源 — Code（visualize/report 唯一数字来源，禁止引用其它 Agent 数字）】',
      codeAnswer.length > maxCode ? `${codeAnswer.slice(0, maxCode)}…` : codeAnswer
    )
    if (factsMarkdown) blocks.push('', factsMarkdown)
    blocks.push(
      '',
      '【硬性约束】',
      '- 图表 ECharts series.data、表格金额、报告结论中的数字必须全部来自上方 Code 输出。',
      '- 禁止从 RAG/DB/爬虫 原文取数、禁止用占比/比率冒充金额、禁止自行推算或「修正」Code 结果。',
      '- 若 Code 未给出某字段，在输出中说明缺失，勿编造。'
    )
  } else {
    blocks.push(
      '【上游数据源（无 Code 步骤时参考；须与下方合并事实一致，禁止在报告中声称上下文明明已有的字段/参考范围「缺失」）】'
    )
    if (factsMarkdown) blocks.push('', factsMarkdown)
    for (const agent of UPSTREAM_AGENTS) {
      const raw = String(results[agent] ?? '').trim()
      if (!raw) continue
      const agentMax = params.perAgentMaxChars?.[agent] ?? maxRef
      let body = ''
      const enriched = params.enrichAgentBody?.(agent, raw)?.trim()
      if (enriched) {
        body = enriched
      } else if (extractPayload) {
        const parsed = extractPayload(raw)
        const ans = String(parsed.answer ?? '').trim()
        const factLines = (Array.isArray(parsed.facts) ? parsed.facts : [])
          .slice(0, 14)
          .map((f) => `${String(f.key ?? '').trim()}: ${String(f.value ?? '')}`)
          .filter((l) => !l.startsWith(':'))
          .join('; ')
        body = [ans, factLines ? `facts: ${factLines}` : ''].filter(Boolean).join('\n') || raw
      } else {
        body = raw
      }
      const slice = body.length > agentMax ? `${body.slice(0, agentMax)}…` : body
      blocks.push('', `${agent}:`, slice)
    }
  }

  return {
    hasCode,
    codeAnswer,
    mergedFacts,
    factsMarkdown,
    authorityBanner,
    downstreamContext: blocks.join('\n')
  }
}

/** visualize / report / clean 内置协作的上下文（Code 置顶） */
export function buildDownstreamAgentContext(
  results: Record<string, unknown>,
  extractPayload?: ExtractPayloadFn,
  opts?: DownstreamContextOpts,
): string {
  return buildCodeFirstBundle({ results, extractPayload, ...opts }).downstreamContext
}

/** 供 multi globalFacts：Code 合并事实优先展示 */
export function globalFactsForInternalPayload(
  results: Record<string, unknown>,
  extractPayload?: ExtractPayloadFn,
): Array<{ agent: string; facts: Array<{ key: string; value: unknown }>; summary: string }> {
  const bundle = buildCodeFirstBundle({ results, extractPayload, maxCodeChars: 1200, maxRefChars: 400 })
  const out: Array<{ agent: string; facts: Array<{ key: string; value: unknown }>; summary: string }> = []

  if (bundle.hasCode) {
    out.push({
      agent: 'code_authority',
      facts: bundle.mergedFacts.slice(0, 16).map((f) => ({ key: f.key, value: f.value })),
      summary: bundle.codeAnswer.slice(0, 220)
    })
    return out
  }

  for (const agent of ['code', 'rag', 'db', 'crawler', 'clean'] as const) {
    const txt = String(results[agent] ?? '').trim()
    if (!txt) continue
    const parsed = extractPayload ? extractPayload(txt) : { answer: txt, facts: [] }
    const facts = (Array.isArray(parsed.facts) ? parsed.facts : []).slice(0, 8).map((f) => ({
      key: String(f.key ?? ''),
      value: f.value
    }))
    out.push({
      agent,
      facts,
      summary: String(parsed.answer ?? txt).slice(0, 180)
    })
  }

  return out.slice(0, 8)
}
