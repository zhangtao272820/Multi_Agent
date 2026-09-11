/**
 * Multimodal → 下游专家结构化交接（Wave M1）。
 * 确定性组装：从 agentResult.structured 归一化 entities/metrics/ocr，
 * 写入 softHandoff / Field Guide，并改写 dependsOn multimodal 的 queryFocus。
 * 禁止用户原话 regex 做路由；本模块只做契约层确定性拼装。
 */

export type MultimodalEntity = {
  name: string
  kind?: string
}

export type MultimodalMetric = {
  name: string
  value: string
  unit?: string
}

export type MultimodalStructuredHandoff = {
  entities: MultimodalEntity[]
  metrics: MultimodalMetric[]
  ocr_text_digest: string
  confidence?: number
  media_type?: string
}

const MAX_ENTITIES = 12
const MAX_METRICS = 16
const MAX_OCR = 240
const MAX_NAME = 64
const MAX_VALUE = 48

function clip(s: string, n: number): string {
  const t = String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function normalizeEntity(row: unknown): MultimodalEntity | null {
  if (typeof row === 'string') {
    const name = clip(row, MAX_NAME)
    return name ? { name } : null
  }
  const o = asRecord(row)
  if (!o) return null
  const name = clip(String(o.name ?? o.label ?? o.text ?? ''), MAX_NAME)
  if (!name) return null
  const kind = clip(String(o.kind ?? o.type ?? ''), 32)
  return kind ? { name, kind } : { name }
}

function normalizeMetric(row: unknown): MultimodalMetric | null {
  const o = asRecord(row)
  if (!o) return null
  const name = clip(String(o.name ?? o.label ?? o.key ?? ''), MAX_NAME)
  const value = clip(String(o.value ?? o.val ?? o.amount ?? ''), MAX_VALUE)
  if (!name || !value) return null
  const unit = clip(String(o.unit ?? ''), 16)
  return unit ? { name, value, unit } : { name, value }
}

/** 从 VL / agentResult.structured（可含 raw）归一化交接载荷 */
export function normalizeMultimodalStructured(raw: unknown): MultimodalStructuredHandoff | null {
  const root = asRecord(raw)
  if (!root) return null
  const nested = asRecord(root.raw) || asRecord(root.result)
  const bag = { ...(nested || {}), ...root }

  const entitiesRaw = bag.entities ?? bag.entity_list ?? bag.named_entities
  const metricsRaw = bag.metrics ?? bag.indicators ?? bag.kv_metrics
  const entities = (Array.isArray(entitiesRaw) ? entitiesRaw : [])
    .map(normalizeEntity)
    .filter((x): x is MultimodalEntity => Boolean(x))
    .slice(0, MAX_ENTITIES)
  const metrics = (Array.isArray(metricsRaw) ? metricsRaw : [])
    .map(normalizeMetric)
    .filter((x): x is MultimodalMetric => Boolean(x))
    .slice(0, MAX_METRICS)

  const ocr = clip(
    String(
      bag.ocr_text_digest ??
        bag.ocr_text ??
        bag.ocr_snippet ??
        bag.transcript ??
        ''
    ),
    MAX_OCR
  )
  const confidenceRaw = Number(bag.confidence)
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.min(1, Math.max(0, confidenceRaw))
    : undefined
  const media_type = clip(String(bag.media_type ?? ''), 24) || undefined

  if (!entities.length && !metrics.length && !ocr) return null
  return {
    entities,
    metrics,
    ocr_text_digest: ocr,
    ...(confidence != null ? { confidence } : {}),
    ...(media_type ? { media_type } : {})
  }
}

/** 短 digest：进 softHandoff / Field Guide（控字符） */
export function formatMultimodalStructuredDigest(
  structured: MultimodalStructuredHandoff | null | undefined,
  maxChars = 280
): string {
  if (!structured) return ''
  const parts: string[] = []
  if (structured.entities.length) {
    parts.push(
      `实体:${structured.entities
        .slice(0, 8)
        .map((e) => (e.kind ? `${e.name}(${e.kind})` : e.name))
        .join('、')}`
    )
  }
  if (structured.metrics.length) {
    parts.push(
      `指标:${structured.metrics
        .slice(0, 8)
        .map((m) => `${m.name}=${m.value}${m.unit ? m.unit : ''}`)
        .join('；')}`
    )
  }
  if (structured.ocr_text_digest) {
    parts.push(`OCR:${structured.ocr_text_digest.slice(0, 120)}`)
  }
  return clip(parts.join(' | '), maxChars)
}

/**
 * 将 multimodal 结构化事实注入下游 queryFocus（确定性拼接，不改 cap）。
 * 已含同一 digest 时不重复追加。
 */
export function enrichQueryWithMultimodalHandoff(
  baseQuery: string,
  structured: MultimodalStructuredHandoff | null | undefined,
  maxTotal = 480
): string {
  const base = String(baseQuery || '').trim()
  const digest = formatMultimodalStructuredDigest(structured, 220)
  if (!digest) return base
  if (base.includes(digest.slice(0, Math.min(40, digest.length)))) return base.slice(0, maxTotal)
  const block = `【识图交接】${digest}`
  if (!base) return block.slice(0, maxTotal)
  const joined = `${base}\n${block}`
  return joined.length <= maxTotal ? joined : `${joined.slice(0, Math.max(0, maxTotal - 1))}…`
}

export type PlanStepLike = {
  id?: string
  agent?: string
  query?: string
  queryFocus?: string
  dependsOn?: string[]
}

/**
 * multimodal 步成功后：改写仍 pending、且 dependsOn 该步的下游 query/queryFocus。
 * 返回新数组（浅拷贝改写项）；不触碰已完成步。
 */
export function applyMultimodalHandoffToPendingSteps<T extends PlanStepLike>(
  steps: T[],
  multimodalStepId: string,
  structured: MultimodalStructuredHandoff | null | undefined,
  completedIds?: Set<string> | string[]
): T[] {
  const mmId = String(multimodalStepId || '').trim()
  if (!mmId || !structured) return steps
  const done = completedIds instanceof Set
    ? completedIds
    : new Set((Array.isArray(completedIds) ? completedIds : []).map(String))
  return (Array.isArray(steps) ? steps : []).map((s) => {
    const id = String(s.id || '').trim()
    if (id && done.has(id)) return s
    const deps = Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : []
    if (!deps.includes(mmId)) return s
    const agent = String(s.agent || '').trim()
    if (agent === 'multimodal' || agent === 'music' || agent === 'video') return s
    const qKey = typeof s.query === 'string' ? 'query' : typeof s.queryFocus === 'string' ? 'queryFocus' : 'query'
    const prev = String((s as Record<string, unknown>)[qKey] || '').trim()
    const next = enrichQueryWithMultimodalHandoff(prev, structured)
    if (next === prev) return s
    return { ...s, [qKey]: next }
  })
}

/** Field Guide「已决」行：有界实体/指标事实 */
export function multimodalFactsForFieldGuide(
  structured: MultimodalStructuredHandoff | null | undefined,
  max = 5
): string[] {
  if (!structured) return []
  const out: string[] = []
  for (const e of structured.entities.slice(0, 4)) {
    out.push(e.kind ? `识图实体 ${e.name}（${e.kind}）` : `识图实体 ${e.name}`)
  }
  for (const m of structured.metrics.slice(0, 4)) {
    out.push(`识图指标 ${m.name}=${m.value}${m.unit || ''}`)
  }
  if (structured.ocr_text_digest && out.length < max) {
    out.push(`识图OCR ${structured.ocr_text_digest.slice(0, 80)}`)
  }
  return out.slice(0, max)
}
