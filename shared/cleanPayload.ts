/**
 * Clean Agent 统一载荷：多源 db/rag/crawler → Code 可消费 JSON。
 * 语义对齐由 LLM 规划（managerCleanLlm）；此处仅类型、机械解析与确定性组装。
 */

import type { ExtractPayloadFn } from './codeFirstAuthority'
import type { ChartUnitKind } from './codeAuthorityPayload'

export type { ChartUnitKind }

export type CleanSourceAgent = 'db' | 'rag' | 'crawler'

export type CleanFact = {
  key: string
  label?: string
  value: string | number | boolean
  unit_kind?: ChartUnitKind
  entity_id?: string
  source: string
  confidence: number
}

export type CleanTable = {
  name: string
  columns: string[]
  rows: Array<Record<string, unknown>>
}

export type CleanAlignment = {
  left: string
  right: string
  relation: 'same_entity' | 'compare' | 'reference_range'
}

export type CleanPayload = {
  answer: string
  sources: Array<{ agent: CleanSourceAgent; ref?: string }>
  facts: CleanFact[]
  tables?: CleanTable[]
  alignments?: CleanAlignment[]
  quality: {
    conflicts: Array<{ keys: string[]; note: string }>
    missing_fields: string[]
    deduped_count: number
  }
  data: {
    mode: 'single_source' | 'multi_source_aligned' | 'multi_source_structural'
    raw_source_count: number
  }
}

export type SourceSnapshot = {
  agent: CleanSourceAgent
  raw: string
  answer: string
  facts: Array<{ key: string; value: unknown; sourcePath: string }>
}

/** LLM 对齐规划输入（由 managerCleanLlm 产出） */
export type AlignPlanInput = {
  entity_mappings?: Array<{
    entity_id: string
    labels: string[]
    source_refs: string[]
  }>
  field_mappings: Array<{
    canonical_key: string
    label?: string
    source_key: string
    source_agent: CleanSourceAgent
    unit_kind?: ChartUnitKind
    entity_id?: string
    value: string | number | boolean
    confidence?: number
  }>
  alignments?: CleanAlignment[]
  conflicts?: Array<{ keys: string[]; note: string }>
  missing_fields?: string[]
  confidence: number
}

const EMPTY_MARKERS = ['未命中', '无相关', '未找到', '未查到', '暂无', '抓取失败', '无有效', 'not found', 'No data']

function sourceHasContent(raw: string): boolean {
  const t = String(raw ?? '').trim()
  if (!t) return false
  const lower = t.toLowerCase()
  return !EMPTY_MARKERS.some((m) => t.includes(m) || lower.includes(m.toLowerCase()))
}

export function activeDataSources(results: Record<string, unknown>): CleanSourceAgent[] {
  const out: CleanSourceAgent[] = []
  if (sourceHasContent(String(results.db ?? ''))) out.push('db')
  if (sourceHasContent(String(results.rag ?? ''))) out.push('rag')
  if (sourceHasContent(String(results.crawler ?? ''))) out.push('crawler')
  return out
}

function normKey(k: string): string {
  return String(k ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

function parseUnitKind(v: unknown): ChartUnitKind | undefined {
  const s = String(v ?? '').trim()
  const allowed = ['currency', 'percent', 'count', 'ratio', 'index', 'duration', 'other'] as const
  return (allowed as readonly string[]).includes(s) ? (s as ChartUnitKind) : undefined
}

function factsFromCrawlerMarkdown(raw: string): Array<{ key: string; value: unknown; sourcePath: string }> {
  const facts: Array<{ key: string; value: unknown; sourcePath: string }> = []
  const lines = String(raw ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    const m = line.match(/^-\s*(\d+)\.\s*(.+?)\s*\|\s*([^|]+)\|\s*(https?:\/\/\S+)/)
    if (!m) continue
    const title = m[2]!.trim()
    const url = m[4]!.trim()
    let excerpt = ''
    const next = lines[i + 1]?.trim()
    if (next?.startsWith('- ') && !/^\d+\./.test(next.slice(2))) excerpt = next.slice(2).trim()
    const idx = facts.length + 1
    const key = `web_ref_${idx}`
    facts.push({
      key,
      value: excerpt ? `${title} — ${excerpt}` : title,
      sourcePath: `crawler.${key}`
    })
    if (url) facts.push({ key: `${key}_url`, value: url, sourcePath: `crawler.${key}_url` })
    if (facts.length >= 16) break
  }
  return facts
}

/** 机械解析各取数源为候选 facts（无 LLM） */
export function parseSourceSnapshots(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn
): SourceSnapshot[] {
  const out: SourceSnapshot[] = []
  for (const agent of ['db', 'rag', 'crawler'] as const) {
    const raw = String(results[agent] ?? '').trim()
    if (!sourceHasContent(raw)) continue
    const parsed = extractPayload(raw)
    let answer = String(parsed.answer ?? '').trim()
    let facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
      .map((f) => {
        const key = String(f?.key ?? '').trim()
        if (!key) return null
        return { key, value: f?.value, sourcePath: `${agent}.${key}` }
      })
      .filter(Boolean) as Array<{ key: string; value: unknown; sourcePath: string }>
    if (agent === 'crawler' && !facts.length) {
      facts = factsFromCrawlerMarkdown(raw)
      if (!answer && facts.length) {
        answer = facts
          .filter((f) => !String(f.key).endsWith('_url'))
          .slice(0, 3)
          .map((f) => String(f.value ?? ''))
          .join('；')
      }
    }
    out.push({ agent, raw, answer, facts })
  }
  return out
}

export function parseCleanPayload(raw: string): CleanPayload | null {
  const txt = String(raw ?? '').trim()
  if (!txt.startsWith('{')) return null
  try {
    const obj = JSON.parse(txt) as Record<string, unknown>
    if (!obj || typeof obj !== 'object') return null
    const data = obj.data as Record<string, unknown> | undefined
    const mode = String(data?.mode ?? '')
    if (!mode.includes('source')) return null
    const facts = Array.isArray(obj.facts) ? obj.facts : []
    if (!facts.length && !String(obj.answer ?? '').trim()) return null
    const sourcesRaw = Array.isArray(obj.sources) ? obj.sources : []
    const sources =
      sourcesRaw.length > 0
        ? sourcesRaw
            .map((s) => {
              const row = s as { agent?: string; ref?: string }
              const agent = String(row?.agent ?? '').trim() as CleanSourceAgent
              return agent ? { agent, ref: row.ref ? String(row.ref).trim() : undefined } : null
            })
            .filter((s): s is { agent: CleanSourceAgent; ref?: string } => Boolean(s))
        : inferCleanSourcesFromFacts(facts)
    const qualityRaw = (obj.quality as Record<string, unknown> | undefined) ?? {}
    return {
      answer: String(obj.answer ?? ''),
      sources,
      facts: facts as CleanFact[],
      tables: Array.isArray(obj.tables) ? (obj.tables as CleanPayload['tables']) : undefined,
      alignments: Array.isArray(obj.alignments) ? (obj.alignments as CleanPayload['alignments']) : undefined,
      quality: {
        conflicts: Array.isArray(qualityRaw.conflicts)
          ? (qualityRaw.conflicts as CleanPayload['quality']['conflicts'])
          : [],
        missing_fields: Array.isArray(qualityRaw.missing_fields)
          ? qualityRaw.missing_fields.map(String)
          : [],
        deduped_count: Number(qualityRaw.deduped_count ?? 0) || 0
      },
      data: {
        mode: (mode.includes('aligned')
          ? 'multi_source_aligned'
          : mode.includes('structural')
            ? 'multi_source_structural'
            : 'single_source') as CleanPayload['data']['mode'],
        raw_source_count: Number(data?.raw_source_count ?? sources.length) || sources.length || 1
      }
    }
  } catch {
    return null
  }
}

function inferCleanSourcesFromFacts(facts: unknown[]): Array<{ agent: CleanSourceAgent; ref?: string }> {
  const agents = new Set<CleanSourceAgent>()
  for (const f of facts) {
    if (!f || typeof f !== 'object') continue
    const src = String((f as { source?: string }).source ?? '').trim()
    const agent = (src.split('.')[0] || src) as CleanSourceAgent
    if (agent === 'db' || agent === 'rag' || agent === 'crawler' || agent === 'clean') agents.add(agent)
  }
  return [...agents].map((agent) => ({ agent }))
}

export function serializeCleanPayload(payload: CleanPayload): string {
  return JSON.stringify(payload)
}

export type CleanPreviewSummary = {
  summary: string
  factCount: number
  sources: string[]
  conflicts: number
  mode?: string
}

/** P3-2：协作条 preview（确定性，不调 LLM） */
export function buildCleanPreviewSummary(raw: string): CleanPreviewSummary | null {
  const payload = parseCleanPayload(raw)
  if (!payload) return null
  const facts = Array.isArray(payload.facts) ? payload.facts : []
  const sources = Array.isArray(payload.sources)
    ? payload.sources.map((s) => s.agent).filter(Boolean)
    : []
  const topFacts = facts.slice(0, 3).map((f) => {
    const label = String(f.label ?? f.key ?? '').trim()
    const val = String(f.value ?? '').trim()
    return label ? `${label}:${val}` : val
  })
  const summary =
    payload.answer?.trim() ||
    (topFacts.length ? topFacts.join(' · ') : `已整理 ${facts.length} 项事实`)
  return {
    summary: summary.length > 96 ? `${summary.slice(0, 93)}…` : summary,
    factCount: facts.length,
    sources: [...new Set(sources)],
    conflicts: payload.quality?.conflicts?.length ?? 0,
    mode: payload.data?.mode
  }
}

export function resolveCleanPayloadFromResults(results?: Record<string, unknown> | null): CleanPayload | null {
  if (!results || typeof results !== 'object') return null
  const raw = String(results.clean ?? '').trim()
  if (!raw) return null
  return parseCleanPayload(raw)
}

function valueFingerprint(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return `n:${v}`
  if (typeof v === 'boolean') return `b:${v}`
  return `s:${String(v ?? '').trim()}`
}

/** 确定性组装：将 LLM 对齐规划合并为 CleanPayload */
export function assembleCleanPayload(
  snapshots: SourceSnapshot[],
  plan: AlignPlanInput,
  opts?: { question?: string }
): CleanPayload | null {
  if (!snapshots.length || !Array.isArray(plan.field_mappings) || !plan.field_mappings.length) return null
  if (Number(plan.confidence ?? 0) < 0.45) return null

  const facts: CleanFact[] = []
  const seen = new Set<string>()
  for (const m of plan.field_mappings) {
    const key = String(m.canonical_key ?? '').trim()
    if (!key) continue
    const nk = normKey(key)
    if (seen.has(nk)) continue
    seen.add(nk)
    const conf = Number(m.confidence ?? 0.85)
    facts.push({
      key,
      label: m.label ? String(m.label).trim() : undefined,
      value: m.value as string | number | boolean,
      unit_kind: parseUnitKind(m.unit_kind),
      entity_id: m.entity_id ? String(m.entity_id).trim() : undefined,
      source: `${m.source_agent}.${String(m.source_key ?? key).trim()}`,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.85
    })
  }
  if (!facts.length) return null

  const sources = snapshots.map((s) => ({ agent: s.agent }))
  const deduped = snapshots.reduce((n, s) => n + s.facts.length, 0) - facts.length
  const conflicts = Array.isArray(plan.conflicts)
    ? plan.conflicts.map((c) => ({
        keys: (Array.isArray(c.keys) ? c.keys : []).map(String),
        note: String(c.note ?? '')
      }))
    : []
  const missing = Array.isArray(plan.missing_fields) ? plan.missing_fields.map(String) : []
  const alignments = Array.isArray(plan.alignments) ? plan.alignments : undefined
  const multi = snapshots.length >= 2

  const answer =
    snapshots.length === 1
      ? snapshots[0]!.answer ||
        `已对单一取数源（${snapshots[0]!.agent}）做结构化整理（${facts.length} 项事实）。`
      : `已对齐 ${snapshots.length} 个取数源，整理 ${facts.length} 项事实${conflicts.length ? `（${conflicts.length} 处待 Code 裁决冲突）` : ''}。`

  return {
    answer: answer.length > 480 ? `${answer.slice(0, 477)}…` : answer,
    sources,
    facts: facts.slice(0, 48),
    alignments,
    quality: {
      conflicts,
      missing_fields: missing.slice(0, 12),
      deduped_count: Math.max(0, deduped)
    },
    data: {
      mode: multi ? 'multi_source_aligned' : 'single_source',
      raw_source_count: snapshots.length
    }
  }
}

/** 多源机械合并（LLM 不可用时的结构层 fallback） */
export function assembleCleanPayloadStructural(snapshots: SourceSnapshot[]): CleanPayload | null {
  if (snapshots.length < 2) return null

  const byKey = new Map<string, { fact: CleanFact; agents: Set<string> }>()
  const conflicts: Array<{ keys: string[]; note: string }> = []

  for (const snap of snapshots) {
    for (const f of snap.facts) {
      const key = String(f.key).trim()
      if (!key) continue
      const nk = normKey(key)
      const fp = valueFingerprint(f.value)
      const existing = byKey.get(nk)
      if (!existing) {
        byKey.set(nk, {
          fact: {
            key,
            value: f.value as string | number | boolean,
            source: f.sourcePath,
            confidence: 0.75
          },
          agents: new Set([snap.agent])
        })
        continue
      }
      existing.agents.add(snap.agent)
      if (valueFingerprint(existing.fact.value) !== fp) {
        conflicts.push({
          keys: [existing.fact.key, key],
          note: `多源值不一致：${[...existing.agents].join('+')} vs ${snap.agent}`
        })
      }
    }
  }

  const facts = [...byKey.values()].map((x) => x.fact)
  if (!facts.length) return null

  return {
    answer: `已机械合并 ${snapshots.length} 个取数源（${facts.length} 项事实${conflicts.length ? `，${conflicts.length} 处冲突待 Code 处理` : ''}）。`,
    sources: snapshots.map((s) => ({ agent: s.agent })),
    facts: facts.slice(0, 48),
    quality: {
      conflicts,
      missing_fields: [],
      deduped_count: snapshots.reduce((n, s) => n + s.facts.length, 0) - facts.length
    },
    data: {
      mode: 'multi_source_structural',
      raw_source_count: snapshots.length
    }
  }
}

function agentFromFactSource(source: string): string {
  const s = String(source ?? '').trim()
  if (!s) return '_'
  const dot = s.indexOf('.')
  return dot > 0 ? s.slice(0, dot) : s
}

/** 多源 facts 按取数 Agent 分组后的最大键 Jaccard（0=完全异构堆砌） */
export function maxCrossAgentFactKeyOverlap(
  facts: Array<{ key?: string; source?: string }>
): number {
  const byAgent = new Map<string, Set<string>>()
  for (const f of facts) {
    const key = normKey(String(f?.key ?? ''))
    if (!key) continue
    const agent = agentFromFactSource(String(f?.source ?? ''))
    if (!byAgent.has(agent)) byAgent.set(agent, new Set())
    byAgent.get(agent)!.add(key)
  }
  const sets = [...byAgent.values()]
  if (sets.length < 2) return 1
  let maxJ = 0
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!
      const b = sets[j]!
      let inter = 0
      for (const k of a) if (b.has(k)) inter++
      const union = a.size + b.size - inter
      const jacc = union > 0 ? inter / union : 0
      if (jacc > maxJ) maxJ = jacc
    }
  }
  return maxJ
}

export type StructuralCleanSufficiencyOpts = {
  /** 计划含 Code 对照/计算步：异构多源键无交叠仍可由 Code 消费，跳过对齐 LLM */
  codeDownstream?: boolean
}

function distinctFactSourceAgents(factList: Array<{ key?: string; source?: string }>): number {
  const agents = new Set<string>()
  for (const f of factList) {
    agents.add(agentFromFactSource(String(f?.source ?? '')))
  }
  agents.delete('_')
  return agents.size
}

/**
 * 结构层合并是否足够供下游消费。
 * 冲突过多、或异构多源（键几乎无交）时不算洗净——应交 LLM 对齐/过滤，避免把 30 项堆砌当清洗结果。
 * 若下游有 Code 对照步，异构 rag+db 等可结构透传（由 Code 做对照，省 ~20s 对齐 LLM）。
 */
export function isStructuralCleanSufficient(
  payload: CleanPayload,
  opts?: StructuralCleanSufficiencyOpts
): boolean {
  const factList = Array.isArray(payload.facts) ? payload.facts : []
  const facts = factList.length
  const conflicts = Array.isArray(payload.quality?.conflicts) ? payload.quality!.conflicts.length : 0
  const minFacts = Math.max(1, Number(process.env.MANAGER_CLEAN_STRUCTURAL_MIN_FACTS ?? 1))
  const maxConflicts = Math.max(0, Number(process.env.MANAGER_CLEAN_STRUCTURAL_MAX_CONFLICTS ?? 6))
  if (facts < minFacts || conflicts > maxConflicts) return false

  const sourceCount = Array.isArray(payload.sources) ? payload.sources.length : 0
  const multi =
    sourceCount >= 2 || String((payload.data as { mode?: string } | undefined)?.mode || '') === 'multi_source_structural'
  if (multi) {
    if (opts?.codeDownstream && distinctFactSourceAgents(factList) >= 2) {
      return true
    }
    const minOverlap = Number(process.env.MANAGER_CLEAN_STRUCTURAL_MIN_KEY_OVERLAP ?? 0.12)
    const threshold = Number.isFinite(minOverlap) ? Math.min(1, Math.max(0, minOverlap)) : 0.12
    if (maxCrossAgentFactKeyOverlap(factList) < threshold) return false
  }
  return true
}

/** 结构层数据充足性（非业务语义 regex） */
export function assessDataSufficiencyStructural(input: {
  factsCount: number
  wantsVisualize?: boolean
  wantsReport?: boolean
}): { sufficient: boolean; gapMessage: string } {
  const n = Math.max(0, Number(input.factsCount ?? 0))
  if (n === 0) {
    return {
      sufficient: false,
      gapMessage: '当前尚无可结构化抽取的事实，请补充取数结果或明确查询条件。'
    }
  }
  if (input.wantsVisualize && n < 2) {
    return {
      sufficient: false,
      gapMessage: '可视化至少需要 2 个可量化数据点；请补充更多指标或按时间/类别展开的数据。'
    }
  }
  if (input.wantsReport && n < 1) {
    return {
      sufficient: false,
      gapMessage: '报告生成需要至少 1 条结构化事实依据。'
    }
  }
  return { sufficient: true, gapMessage: '' }
}
