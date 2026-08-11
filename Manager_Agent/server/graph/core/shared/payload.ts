import { z } from 'zod'
import { looksLikePromptInjectionLine } from '#agent-shared/textMarkers'
import { safeJsonParse } from './llmJson'

export { safeJsonParse }

export function sanitizeUntrustedText(text: string) {
  let s = String(text ?? '')
  s = s.replace(/\r/g, '')
  const lines = s.split('\n')
  const kept = lines.filter((l) => {
    const t = l.trim()
    if (!t) return false
    return !looksLikePromptInjectionLine(t)
  })
  s = kept.join('\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

export type StructuredFact = { key: string; value: any; label?: string; source?: string }

const StructuredPayloadSchema = z
  .object({
    answer: z.string().optional(),
    facts: z
      .array(
        z.object({
          key: z.string().min(1),
          value: z.any(),
          label: z.string().optional(),
          source: z.string().optional()
        })
      )
      .optional(),
    missingFields: z.array(z.string().min(1)).optional(),
    citations: z
      .array(
        z.object({
          source: z.string().min(1),
          title: z.string().optional(),
          url: z.string().optional(),
          page: z.number().optional(),
          chunkId: z.string().optional(),
          excerpt: z.string().optional()
        })
      )
      .optional(),
    data: z.any().optional(),
    confidence: z.number().min(0).max(1).optional()
  })
  .passthrough()

function splitFactKeyValue(line: string): { key: string; value: string } | null {
  let body = String(line ?? '').trim()
  if (!body) return null
  const sepCn = body.indexOf('：')
  const sepEn = body.indexOf(':')
  const sep = sepCn >= 0 && (sepEn < 0 || sepCn <= sepEn) ? sepCn : sepEn
  if (sep < 0) return null
  const key = body.slice(0, sep).trim()
  let value = body.slice(sep + 1).trim()
  if (!key || !value) return null
  if (key.toLowerCase() === 'http' || key.toLowerCase() === 'https') return null
  if (/\.(docx?|pdf|txt|md|xlsx?)\b/i.test(key) || key.length > 32) return null
  value = value.replace(/[、,，]\s*[^：:]+[：:].*$/, '').trim()
  if (!value) return null
  return { key, value }
}

/** 单行多事实：如 [事实1] xxx.docx - 月收入：6000、月支出：5000 */
function factsFromFactLine(line: string): StructuredFact[] {
  let body = String(line ?? '').trim()
  if (!body) return []
  if (body.startsWith('[事实')) {
    const close = body.indexOf(']')
    if (close >= 0) body = body.slice(close + 1).trim()
  }
  body = body.replace(/^[\s\S]{0,160}?[-—]\s+/, '').trim()
  const segments = body.includes('、') || body.includes('，') || body.includes(',')
    ? body.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)
    : [body]
  const out: StructuredFact[] = []
  const seen = new Set<string>()
  for (const seg of segments) {
    const kv = splitFactKeyValue(seg)
    if (!kv) continue
    const nk = kv.key.toLowerCase().replace(/\s+/g, '')
    if (seen.has(nk)) continue
    seen.add(nk)
    out.push({ key: kv.key, value: kv.value })
    if (out.length >= 24) break
  }
  return out
}

function factsFromText(text: string) {
  const out: StructuredFact[] = []
  const seen = new Set<string>()
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 60)
  for (const line of lines) {
    const rowFacts = factsFromFactLine(line)
    const batch = rowFacts.length ? rowFacts : splitFactKeyValue(line) ? [splitFactKeyValue(line)!] : []
    for (const f of batch) {
      const nk = String(f.key).toLowerCase().replace(/\s+/g, '')
      if (seen.has(nk)) continue
      seen.add(nk)
      out.push(f)
      if (out.length >= 24) break
    }
    if (out.length >= 24) break
  }
  return out
}

function missingFieldsFromText(text: string) {
  const t = String(text ?? '')
  const out: string[] = []
  const hit = t.match(/需要补充[\s\S]{0,260}/)
  const body = hit ? hit[0] : t
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 40)
  for (const line of lines) {
    const m = line.match(/^\d+[.)、]\s*(.{1,120})$/)
    if (m) {
      out.push(String(m[1] || '').trim())
      continue
    }
    const m2 = line.match(/^-+\s*(.{1,120})$/)
    if (m2) out.push(String(m2[1] || '').trim())
  }
  return Array.from(new Set(out.filter(Boolean))).slice(0, 6)
}

export function extractStructuredPayload(raw: string) {
  const txt = String(raw ?? '').trim()
  const parsed = StructuredPayloadSchema.safeParse(safeJsonParse(txt))
  if (parsed.success) {
    const v = parsed.data
    const answer = typeof v.answer === 'string' ? v.answer : txt
    const facts = Array.isArray(v.facts) ? v.facts : []
    const missingFields = Array.isArray(v.missingFields) ? v.missingFields : []
    const citations = Array.isArray(v.citations) ? v.citations : undefined
    const confidence = typeof v.confidence === 'number' ? v.confidence : undefined
    const data = 'data' in v ? (v as any).data : undefined
    return { answer, facts, missingFields, citations, confidence, data }
  }
  return { answer: txt, facts: factsFromText(txt), missingFields: missingFieldsFromText(txt) }
}
