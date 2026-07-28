import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { extractStructuredPayload } from '../../graph/core/shared'
import {
  ragJudgeFalseNegativeOverride,
  shouldSkipRagRelevanceRefine
} from '../../graph/core/rag/ragRetrievePolicy'
import type { RagEvidenceRow } from '../../graph/core/rag/ragEvidenceAlign'

const RAG_RELEVANCE_JSON_EXAMPLE = `{
  "relevant": true,
  "complete": true,
  "confidence": 0.85,
  "reason": "检索结果覆盖了问句所需信息",
  "userFacingGap": "",
  "refocusInstruction": "",
  "useAllProbeSnippets": false
}`

const RAG_EVIDENCE_MATCH_JSON_EXAMPLE = `{
  "relevant": true,
  "confidence": 0.85,
  "reason": "证据与检索问句主题一致",
  "snippetIndices": [0, 1],
  "evidenceIndices": [0, 1],
  "useAllProbeSnippets": true,
  "useAllEvidence": true
}`

export type RagRelevanceVerdict = {
  relevant: boolean
  complete: boolean
  confidence: number
  reason: string
  userFacingGap?: string
  refocusInstruction?: string
  useAllProbeSnippets?: boolean
}

export type RagEvidenceMatchVerdict = {
  relevant: boolean
  confidence: number
  reason: string
  snippetIndices?: number[]
  evidenceIndices?: number[]
  useAllProbeSnippets?: boolean
  useAllEvidence?: boolean
}

export function collectCitationSources(citations: unknown): string[] {
  const rows = Array.isArray(citations) ? citations : []
  return rows
    .map((c: any) => String(c?.source ?? c?.title ?? c?.name ?? '').trim())
    .filter(Boolean)
}

export type RagRelevanceJudge = (input: {
  userTask: string
  stepQuery: string
  answer: string
  citations: string[]
  probeSources?: string[]
  probeSnippets?: string[]
}) => Promise<RagRelevanceVerdict>

export type RagEvidenceMatchJudge = (input: {
  stepQuery: string
  evidence?: Array<{ content?: string; source?: string }>
  probeSnippets?: string[]
  probeSources?: string[]
  mode: 'retrieve_evidence' | 'probe_snippets'
}) => Promise<RagEvidenceMatchVerdict>

export type RagScopeHint = {
  catalogInstruction: string
  retrievalKeywords?: string[]
  excludeHints?: string[]
}

export type RagScopeHintJudge = (input: {
  userTask: string
  stepQuery: string
  probeSources?: string[]
  probeSnippets?: string[]
}) => Promise<RagScopeHint>

/** route probe 已命中时跳过 evidence/probe LLM 裁判，避免假阴性与额外 T0 延迟 */
export function shouldBypassRagEvidenceJudge(probeHits = 0): boolean {
  if (Number(probeHits) > 0) return true
  // 零命中默认不跳过 relevance judge；显式 MANAGER_RAG_BYPASS_JUDGE_ON_PROBE=1 才 bypass
  const v = String(process.env.MANAGER_RAG_BYPASS_JUDGE_ON_PROBE ?? '0').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

export function isRagRelevanceJudgeEnabled() {
  const v = String(process.env.MANAGER_RAG_RELEVANCE_JUDGE ?? '1').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

type JudgeDeps = {
  getModel: (modelName: string, temperature?: number) => { invoke: (messages: any[]) => Promise<any> }
  traceRun: <T>(name: string, fn: () => Promise<T>, extra?: Record<string, any>) => Promise<T>
  safeJsonParse: (text: string) => unknown | null
  modelName: string
}

function parseRelevanceVerdict(obj: Record<string, unknown> | null): RagRelevanceVerdict | null {
  if (!obj || typeof obj.relevant !== 'boolean') return null
  const complete = typeof obj.complete === 'boolean' ? Boolean(obj.complete) : Boolean(obj.relevant)
  return {
    relevant: Boolean(obj.relevant),
    complete,
    confidence: Math.max(0, Math.min(1, Number(obj.confidence ?? 0.5) || 0.5)),
    reason: String(obj.reason ?? '').slice(0, 500),
    userFacingGap: String(obj.userFacingGap ?? obj.user_facing_gap ?? '').slice(0, 800),
    refocusInstruction: String(obj.refocusInstruction ?? obj.refocus_instruction ?? '').slice(0, 900),
    useAllProbeSnippets: Boolean(obj.useAllProbeSnippets ?? obj.use_all_probe_snippets ?? false)
  }
}

function parseEvidenceMatchVerdict(
  obj: Record<string, unknown> | null,
  itemCount: number,
  mode: 'retrieve_evidence' | 'probe_snippets'
): RagEvidenceMatchVerdict | null {
  if (!obj || typeof obj.relevant !== 'boolean') return null
  const useAllProbe = Boolean(obj.useAllProbeSnippets ?? obj.use_all_probe_snippets ?? false)
  const useAllEvidence = Boolean(obj.useAllEvidence ?? obj.use_all_evidence ?? false)
  const indicesRaw =
    mode === 'retrieve_evidence'
      ? obj.evidenceIndices ?? obj.evidence_indices ?? obj.snippetIndices ?? obj.snippet_indices
      : obj.snippetIndices ?? obj.snippet_indices
  let snippetIndices: number[] | undefined
  let evidenceIndices: number[] | undefined
  const parseIdx = (raw: unknown) =>
    Array.isArray(raw)
      ? raw
          .map((x) => Number(x))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < itemCount)
          .slice(0, 12)
      : undefined
  if (mode === 'retrieve_evidence') {
    if (!useAllEvidence) evidenceIndices = parseIdx(indicesRaw)
  } else if (!useAllProbe) {
    snippetIndices = parseIdx(indicesRaw)
  }
  return {
    relevant: Boolean(obj.relevant),
    confidence: Math.max(0, Math.min(1, Number(obj.confidence ?? 0.5) || 0.5)),
    reason: String(obj.reason ?? '').slice(0, 500),
    snippetIndices,
    evidenceIndices,
    useAllProbeSnippets: useAllProbe,
    useAllEvidence
  }
}

/** 检索前：模型归纳本轮应覆盖的信息范围与检索侧车（通用，非关键词表） */
export function createRagScopeHintJudge(deps: JudgeDeps): RagScopeHintJudge {
  const empty: RagScopeHint = { catalogInstruction: '' }
  return async (input) => {
    if (!isRagRelevanceJudgeEnabled()) return empty
    const snippets = (input.probeSnippets || []).slice(0, 8)
    const probeSources = (input.probeSources || []).slice(0, 8)
    try {
      const resp = await deps.traceRun(
        'manager_rag_scope_hint',
        () =>
          deps.getModel(deps.modelName, 0).invoke([
            new SystemMessage(
              [
                '你是 RAG 检索规划助手。根据用户任务与检索问句，规划应从知识库提取的信息范围。',
                '不要编造文档内容；可结合探测片段推测可能存在的条目类型。',
                'retrievalKeywords：与问句主题相关的检索扩展词/同义词/实体名（2～8 个，勿列具体数字）。',
                'excludeHints：应排除的明显无关文档类型或主题描述（0～6 条，通用表述如「行业规范章节」「与问句无关的补贴标准表」）。',
                '只输出 JSON：{"catalogInstruction":"…","retrievalKeywords":["…"],"excludeHints":["…"]}'
              ].join('\n')
            ),
            new HumanMessage(
              [
                `【用户任务】${String(input.userTask || '').slice(0, 600)}`,
                `【检索问句】${String(input.stepQuery || '').slice(0, 800)}`,
                probeSources.length ? `【探测来源】${probeSources.join('；')}` : '',
                snippets.length ? `【探测片段】\n${snippets.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : ''
              ]
                .filter(Boolean)
                .join('\n\n')
            )
          ]),
        { stage: 'rag_scope_hint' }
      )
      const obj = deps.safeJsonParse(String((resp as any)?.content ?? '')) as Record<string, unknown> | null
      const catalogInstruction = String(obj?.catalogInstruction ?? obj?.catalog_instruction ?? '').trim().slice(0, 600)
      const kwRaw = obj?.retrievalKeywords ?? obj?.retrieval_keywords
      const retrievalKeywords = Array.isArray(kwRaw)
        ? kwRaw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 12)
        : []
      const exRaw = obj?.excludeHints ?? obj?.exclude_hints
      const excludeHints = Array.isArray(exRaw)
        ? exRaw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 8)
        : []
      if (!catalogInstruction && !retrievalKeywords.length && !excludeHints.length) return empty
      return {
        catalogInstruction,
        retrievalKeywords: retrievalKeywords.length ? retrievalKeywords : undefined,
        excludeHints: excludeHints.length ? excludeHints : undefined
      }
    } catch {
      return empty
    }
  }
}

export function createRagRelevanceJudge(deps: JudgeDeps): RagRelevanceJudge {
  const permissive: RagRelevanceVerdict = {
    relevant: true,
    complete: true,
    confidence: 0.5,
    reason: 'judge_disabled_or_failed'
  }

  return async (input) => {
    if (!isRagRelevanceJudgeEnabled()) return permissive
    const citations = (input.citations || []).slice(0, 12)
    const snippets = (input.probeSnippets || []).slice(0, 10)
    const probeSources = (input.probeSources || []).slice(0, 8)
    const prompt = [
      new SystemMessage(
        [
          '你是 RAG 检索质量裁判。评估「检索问句」是否被当前回答有效覆盖，以及信息是否**尽量完整**。',
          '【范围】只对照「检索问句」，不要因用户总任务还缺图表/爬虫/日程等后续步骤而判 relevant=false 或 complete=false。',
          'relevant：回答或探测片段是否包含与问句主题直接相关的事实。',
          'complete：同一主题下，问句所需的主要数字/字段是否已在回答中出现；若回答已列出 ≥3 条可核对事实（含收入/支出等），即使表述为自然语言也判 complete=true。',
          '勿因「还可更详细」「命中多文档」或探测里含无关片段而判 complete=false；仅当明显漏掉问句关心的核心字段时才 complete=false。',
          '若回答偏题但探测片段含可用事实 → relevant=true，可设 useAllProbeSnippets=true，由下游合并探测块。',
          'relevant=false：问句主题与回答、探测均无可用事实。',
          '若回答混入了与问句明显无关的文档事实（如问个人收支却列出养老机构补贴标准），判 relevant=false 或 complete=false，并在 refocusInstruction 要求排除无关来源。',
          'complete=false 且值得再检索：在 refocusInstruction 写补全检索指令（中文，说明还应提取哪些类型的信息，不要列具体数字除非来自探测）。',
          '只输出 JSON：',
          RAG_RELEVANCE_JSON_EXAMPLE
        ].join('\n')
      ),
      new HumanMessage(
        [
          `【用户总任务（仅供参考）】${String(input.userTask || '').slice(0, 600)}`,
          `【检索问句（裁判范围）】${String(input.stepQuery || '').slice(0, 800)}`,
          `【引用来源】${citations.length ? citations.join('；') : '（无）'}`,
          probeSources.length ? `【探测来源】${probeSources.join('；')}` : '',
          snippets.length ? `【探测片段】\n${snippets.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
          `【RAG 回答】\n${String(input.answer || '').slice(0, 4000)}`
        ]
          .filter(Boolean)
          .join('\n\n')
      )
    ]
    try {
      const resp = await deps.traceRun(
        'manager_rag_relevance_judge',
        () => deps.getModel(deps.modelName, 0).invoke(prompt),
        { stage: 'rag_relevance' }
      )
      const parsed = parseRelevanceVerdict(deps.safeJsonParse(String((resp as any)?.content ?? '')) as Record<string, unknown> | null)
      if (parsed) return parsed
    } catch {}
    return permissive
  }
}

/** 模型判断 retrieve 证据 / probe 片段是否与检索问句一致、是否应采纳全部探测片段 */
export function createRagEvidenceMatchJudge(deps: JudgeDeps): RagEvidenceMatchJudge {
  const permissiveRetrieve: RagEvidenceMatchVerdict = {
    relevant: true,
    confidence: 0.5,
    reason: 'judge_disabled_or_failed'
  }
  const denyProbe: RagEvidenceMatchVerdict = {
    relevant: false,
    confidence: 0.3,
    reason: 'judge_disabled_or_failed'
  }

  return async (input) => {
    if (!isRagRelevanceJudgeEnabled()) {
      return input.mode === 'retrieve_evidence' ? permissiveRetrieve : denyProbe
    }

    const stepQuery = String(input.stepQuery || '').slice(0, 800)
    const isRetrieve = input.mode === 'retrieve_evidence'
    const evidence = (input.evidence || []).slice(0, 10)
    const snippets = (input.probeSnippets || []).slice(0, 12)
    const probeSources = (input.probeSources || []).slice(0, 8)

    const systemLines = isRetrieve
      ? [
          '你是 RAG 检索证据质检员。判断 retrieve 证据块是否服务于检索问句（主题一致且可用于作答）。',
          'relevant=false：全部或主要证据与问句明显无关（主题、实体、字段不匹配）。',
          'relevant=true：至少一条证据能直接支撑问句；若部分相关，用 evidenceIndices 标注相关下标；若全部相关则 useAllEvidence=true。',
          '只输出 JSON：',
          RAG_EVIDENCE_MATCH_JSON_EXAMPLE.replace('"snippetIndices": [0, 1]', '"snippetIndices": []').replace(
            '"useAllProbeSnippets": true',
            '"useAllProbeSnippets": false'
          )
        ]
      : [
          '你是 RAG 向量探测质检员。判断探测片段是否含可回应检索问句的事实。',
          'relevant=true 时：若多条片段均与问句相关，设 useAllProbeSnippets=true；否则用 snippetIndices 标注相关下标。',
          '只输出 JSON：',
          RAG_EVIDENCE_MATCH_JSON_EXAMPLE
        ]

    const humanLines = [`【检索问句】${stepQuery}`]
    if (isRetrieve) {
      humanLines.push(
        evidence.length
          ? `【retrieve 证据】\n${evidence
              .map((e, i) => `${i + 1}. [${String(e?.source ?? 'unknown')}] ${String(e?.content ?? '').slice(0, 500)}`)
              .join('\n')}`
          : '【retrieve 证据】（无）'
      )
    } else {
      if (probeSources.length) humanLines.push(`【探测来源】${probeSources.join('；')}`)
      humanLines.push(
        snippets.length
          ? `【探测片段】\n${snippets.map((s, i) => `${i}. ${s}`).join('\n')}`
          : '【探测片段】（无）'
      )
    }

    try {
      const resp = await deps.traceRun(
        isRetrieve ? 'manager_rag_retrieve_evidence_judge' : 'manager_rag_probe_snippet_judge',
        () =>
          deps.getModel(deps.modelName, 0).invoke([
            new SystemMessage(systemLines.join('\n')),
            new HumanMessage(humanLines.join('\n\n'))
          ]),
        { stage: isRetrieve ? 'rag_retrieve_evidence' : 'rag_probe_snippets' }
      )
      const parsed = parseEvidenceMatchVerdict(
        deps.safeJsonParse(String((resp as any)?.content ?? '')) as Record<string, unknown> | null,
        isRetrieve ? evidence.length : snippets.length,
        input.mode
      )
      if (parsed) return parsed
    } catch {}

    return isRetrieve ? permissiveRetrieve : denyProbe
  }
}

export function applyEvidenceMatchToRows(
  rows: RagEvidenceRow[],
  verdict: RagEvidenceMatchVerdict
): RagEvidenceRow[] {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return []
  if (verdict.relevant === false) return []
  if (verdict.useAllEvidence) return list
  const idx = verdict.evidenceIndices
  if (Array.isArray(idx) && idx.length) {
    return idx.filter((i) => i >= 0 && i < list.length).map((i) => list[i]!)
  }
  return list
}

/** 模型判断 retrieve 证据是否与问句相关，并筛掉无关块 */
export async function judgeFilterRagEvidence(
  judge: RagEvidenceMatchJudge | undefined,
  stepQuery: string,
  rows: RagEvidenceRow[],
  opts?: { probeHits?: number; bypassJudge?: boolean }
): Promise<{ rows: RagEvidenceRow[]; relevant: boolean; reason?: string }> {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return { rows: [], relevant: false }
  if (opts?.bypassJudge || shouldBypassRagEvidenceJudge(opts?.probeHits ?? 0)) {
    return { rows: list, relevant: true }
  }
  if (!judge || !isRagRelevanceJudgeEnabled()) return { rows: list, relevant: true }
  try {
    const v = await judge({ stepQuery, evidence: list, mode: 'retrieve_evidence' })
    if (v.relevant === false) return { rows: [], relevant: false, reason: v.reason }
    const filtered = applyEvidenceMatchToRows(list, v)
    return { rows: filtered.length ? filtered : list, relevant: true, reason: v.reason }
  } catch {
    return { rows: list, relevant: true }
  }
}

export type RagProbeHint = { hasDocs?: boolean; hits?: number; sources?: string[]; snippets?: string[] }

/** 模型判断向量探测片段是否与问句相关；不相关则清空探测提示避免误导检索 */
export async function judgeFilterRagProbeHint(
  judge: RagEvidenceMatchJudge | undefined,
  stepQuery: string,
  probe?: RagProbeHint | null
): Promise<RagProbeHint | null | undefined> {
  if (!probe) return probe
  const snippets = (probe.snippets ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!snippets.length) return probe
  if (shouldBypassRagEvidenceJudge(Number(probe.hits ?? 0))) return probe
  if (!judge || !isRagRelevanceJudgeEnabled()) return probe
  try {
    const v = await judge({
      stepQuery,
      probeSnippets: snippets,
      probeSources: probe.sources,
      mode: 'probe_snippets'
    })
    if (v.relevant !== false) {
      if (v.useAllProbeSnippets || !v.snippetIndices?.length) return probe
      const picked = v.snippetIndices.filter((i) => i >= 0 && i < snippets.length).map((i) => snippets[i]!)
      const sources = (probe.sources ?? []).slice(0, picked.length)
      return { ...probe, hits: picked.length, snippets: picked, sources }
    }
    return { ...probe, hits: 0, snippets: [], sources: [] }
  } catch {
    return probe
  }
}

export function formatRagEvidenceAsManagerFacts(
  query: string,
  rows: Array<{ source?: string; content?: string; quote?: string }>,
  title = '【RAG 检索事实】'
): { answer: string; evidence: Record<string, unknown> } | null {
  const items = (rows || [])
    .map((r) => ({
      source: String(r?.source ?? '').trim() || 'unknown',
      content: String(r?.content ?? r?.quote ?? '').trim(),
    }))
    .filter((r) => r.content.length >= 4)
  if (!items.length) return null

  const facts = items.map((row, i) => `[事实${i + 1}] ${row.content}\n[来源] ${row.source}`)
  const citations = items.map((row) => ({
    source: row.source,
    excerpt: row.content.slice(0, 400),
  }))
  return {
    answer: [title, ...facts].join('\n\n'),
    evidence: {
      kind: 'rag',
      query,
      hits: items.length,
      citations,
      fromRetrieve: true,
    },
  }
}

export function buildAnswerFromProbeSnippets(input: {
  query: string
  probeSources?: string[]
  probeSnippets?: string[]
  snippetIndices?: number[]
  useAllProbeSnippets?: boolean
}): { answer: string; evidence: Record<string, unknown> } | null {
  const snippets = (input.probeSnippets ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)
  const sources = (input.probeSources ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!snippets.length) return null

  const useAll = Boolean(input.useAllProbeSnippets)
  const picked = useAll
    ? snippets
    : Array.isArray(input.snippetIndices) && input.snippetIndices.length
      ? input.snippetIndices.filter((i) => i >= 0 && i < snippets.length).map((i) => snippets[i])
      : snippets
  const limited = picked.slice(0, 12)
  if (!limited.length) return null

  const facts = limited.map((content, i) => {
    const source = sources[i] || sources[0] || 'probe'
    return `[事实${i + 1}] ${content}\n[来源] ${source}`
  })
  const citations = limited.map((content, i) => ({
    source: sources[i] || sources[0] || `probe#${i + 1}`,
    excerpt: content.slice(0, 400)
  }))
  return {
    answer: ['【RAG 探测事实块】（来自向量探测，供下游使用）', ...facts].join('\n\n'),
    evidence: {
      kind: 'rag',
      query: input.query,
      hits: limited.length,
      citations,
      fromProbe: true
    }
  }
}

export function buildRetrieveEvidenceJudgeCallback(judge?: RagEvidenceMatchJudge) {
  if (!judge) return undefined
  return async (query: string, evidence: Array<{ content?: string; source?: string }>) => {
    const v = await judge({ stepQuery: query, evidence, mode: 'retrieve_evidence' })
    return v.relevant
  }
}

/** 已从回答/事实块解析出足够字段时，避免二次全量检索 */
function answerFactCoverageSufficient(answer: string): boolean {
  const parsed = extractStructuredPayload(String(answer || ''))
  const facts = (Array.isArray(parsed.facts) ? parsed.facts : []).filter((f) =>
    String(f?.key ?? '').trim()
  )
  return facts.length >= 3
}

export function buildRagRefocusMessage(
  userTask: string,
  stepQuery: string,
  refocusInstruction?: string,
  mode: 'irrelevant' | 'incomplete' = 'irrelevant'
) {
  const core = String(stepQuery || userTask || '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .trim()
  const lead =
    mode === 'incomplete'
      ? '【补全检索】上一轮未覆盖问句所需的全部相关字段，请在同一主题文档中尽量列全可核对事实。'
      : '【收窄检索】请仅依据与任务直接相关的已索引文档作答；若文档不足请说明缺口，不要编造。'
  return [
    lead,
    refocusInstruction ? `【模型指令】${refocusInstruction}` : '',
    `【用户任务】${String(userTask || '').trim()}`,
    `【核心问句】${core}`,
    '\n【输出要求】',
    '- 列出与问句相关的全部可核对事实，每条标注来源；',
    '- 无依据的字段明确写缺失，禁止用 0 或猜测填补。'
  ]
    .filter(Boolean)
    .join('\n')
}

function buildGapAnswer(verdict: RagRelevanceVerdict, userTask: string) {
  const gap = String(verdict.userFacingGap || '').trim()
  if (gap) {
    return [
      '知识库检索未找到足以完成当前任务的相关内容。',
      '',
      gap,
      '',
      '建议：请上传与任务直接相关的文档或补充更明确的文档名称/章节后再试。'
    ].join('\n')
  }
  return [
    '知识库检索结果与当前任务主题不一致，无法用于分析。',
    '',
    `裁判说明：${verdict.reason || '检索主题不匹配'}`,
    '',
    `用户任务摘要：${String(userTask || '').slice(0, 200)}`,
    '',
    '建议：请上传与任务直接相关的文档或补充检索范围后再试。'
  ].join('\n')
}

async function tryProbeFallbackByModel(
  evidenceMatchJudge: RagEvidenceMatchJudge | undefined,
  relevanceVerdict: RagRelevanceVerdict | undefined,
  input: { query: string; probeSources?: string[]; probeSnippets?: string[] }
) {
  const snippets = (input.probeSnippets ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!snippets.length || !evidenceMatchJudge) return null
  const verdict = await evidenceMatchJudge({
    stepQuery: input.query,
    probeSnippets: snippets,
    probeSources: input.probeSources,
    mode: 'probe_snippets'
  })
  if (!verdict.relevant) return null
  const useAll = Boolean(verdict.useAllProbeSnippets || relevanceVerdict?.useAllProbeSnippets)
  return buildAnswerFromProbeSnippets({
    query: input.query,
    probeSources: input.probeSources,
    probeSnippets: snippets,
    snippetIndices: useAll ? undefined : verdict.snippetIndices,
    useAllProbeSnippets: useAll
  })
}

export async function refineRagAnswerIfIrrelevant(params: {
  query: string
  userTask: string
  answer: unknown
  evidence: any
  judge: RagRelevanceJudge
  evidenceMatchJudge?: RagEvidenceMatchJudge
  probeSources?: string[]
  probeSnippets?: string[]
  callRag: (message: string, mode?: 'irrelevant' | 'incomplete') => Promise<unknown>
  onEvidence?: (e: any) => void
}): Promise<{ answer: string; evidence: any; verdict?: RagRelevanceVerdict }> {
  let answer = String(params.answer ?? '')
  let evidence = params.evidence

  if (shouldSkipRagRelevanceRefine(evidence as Record<string, unknown>, answer)) {
    return { answer, evidence, verdict: { relevant: true, complete: true, confidence: 0.85, reason: 'evidence_skip_judge' } }
  }

  const cites = collectCitationSources(evidence?.citations)

  const judgeInput = {
    userTask: params.userTask,
    stepQuery: params.query,
    answer,
    citations: cites,
    probeSources: params.probeSources,
    probeSnippets: params.probeSnippets
  }

  let verdict = await params.judge(judgeInput)

  const finishIfOk = () => ({ answer, evidence, verdict })

  if (ragJudgeFalseNegativeOverride(verdict, evidence as Record<string, unknown>, answer)) {
    return {
      answer,
      evidence,
      verdict: { relevant: true, complete: true, confidence: 0.78, reason: 'evidence_override_judge_false_negative' }
    }
  }

  if (verdict.relevant && verdict.complete) return finishIfOk()

  if (verdict.relevant && !verdict.complete) {
    if (answerFactCoverageSufficient(answer)) {
      return finishIfOk()
    }
    const probeFill = await tryProbeFallbackByModel(params.evidenceMatchJudge, verdict, {
      query: params.query,
      probeSources: params.probeSources,
      probeSnippets: params.probeSnippets
    })
    if (probeFill) {
      return {
        answer: probeFill.answer,
        evidence: probeFill.evidence,
        verdict: { ...verdict, complete: true, reason: 'probe_merge_after_incomplete' }
      }
    }
    try {
      const refocus = buildRagRefocusMessage(
        params.userTask,
        params.query,
        verdict.refocusInstruction || verdict.reason,
        'incomplete'
      )
      const retry = await params.callRag(refocus, 'incomplete')
      answer = String(retry ?? '')
      verdict = await params.judge({ ...judgeInput, answer })
      if (verdict.relevant && verdict.complete) return finishIfOk()
      if (verdict.relevant && answerFactCoverageSufficient(answer)) return finishIfOk()
    } catch {}
    if (verdict.relevant) return finishIfOk()
  }

  const earlyProbe = await tryProbeFallbackByModel(params.evidenceMatchJudge, verdict, {
    query: params.query,
    probeSources: params.probeSources,
    probeSnippets: params.probeSnippets
  })
  if (earlyProbe) {
    return {
      answer: earlyProbe.answer,
      evidence: earlyProbe.evidence,
      verdict: { relevant: true, complete: true, confidence: 0.72, reason: 'probe_snippet_model_fallback' }
    }
  }

  const ans = answer.trim()
  if (ans.length >= 40 && !ans.includes('未找到相关背景信息')) {
    const retryVerdict = await params.judge({
      ...judgeInput,
      userTask: params.query,
      stepQuery: params.query
    })
    if (retryVerdict.relevant && retryVerdict.complete) return { answer, evidence, verdict: retryVerdict }

    const probeVerdict = params.evidenceMatchJudge
      ? await params.evidenceMatchJudge({
          stepQuery: params.query,
          probeSnippets: params.probeSnippets,
          probeSources: params.probeSources,
          mode: 'probe_snippets'
        })
      : null
    if (probeVerdict?.relevant && retryVerdict.confidence < 0.8) {
      const merged = await tryProbeFallbackByModel(params.evidenceMatchJudge, retryVerdict, {
        query: params.query,
        probeSources: params.probeSources,
        probeSnippets: params.probeSnippets
      })
      if (merged) {
        return {
          answer: merged.answer,
          evidence: merged.evidence,
          verdict: { relevant: true, complete: true, confidence: 0.75, reason: 'step_scope_probe_merge' }
        }
      }
      return { answer, evidence, verdict: { ...retryVerdict, relevant: true, complete: retryVerdict.complete } }
    }
  }

  try {
    const refocus = buildRagRefocusMessage(
      params.userTask,
      params.query,
      verdict.refocusInstruction || verdict.reason,
      'irrelevant'
    )
    const retry = await params.callRag(refocus, 'irrelevant')
    answer = String(retry ?? '')
    verdict = await params.judge({ ...judgeInput, answer })
    if (verdict.relevant && verdict.complete) return finishIfOk()
  } catch {}

  const lateProbe = await tryProbeFallbackByModel(params.evidenceMatchJudge, verdict, {
    query: params.query,
    probeSources: params.probeSources,
    probeSnippets: params.probeSnippets
  })
  if (lateProbe) {
    return {
      answer: lateProbe.answer,
      evidence: lateProbe.evidence,
      verdict: { relevant: true, complete: true, confidence: 0.72, reason: 'probe_snippet_model_fallback_after_retry' }
    }
  }

  return {
    answer: buildGapAnswer(verdict, params.userTask),
    evidence: { kind: 'rag' as const, query: params.query, hits: 0, citations: [], irrelevant: true, judgeReason: verdict.reason },
    verdict
  }
}
