/**
 * G5：证据新鲜度（非 GraphRAG；基于 ingest_at / source_version 元数据）。
 */

export type EvidenceFreshnessMeta = {
  ingest_at?: string
  source_version?: string
  source?: string
}

const DEFAULT_STALE_DAYS = 365

export function readEvidenceStaleDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MANAGER_EVIDENCE_STALE_DAYS ?? env.RAG_EVIDENCE_STALE_DAYS ?? DEFAULT_STALE_DAYS)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STALE_DAYS
  return Math.floor(n)
}

export function parseIngestTimestamp(raw: string | undefined | null): number | null {
  const s = String(raw || '').trim()
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

export function isEvidenceStale(meta: EvidenceFreshnessMeta, nowMs = Date.now(), staleDays?: number): boolean {
  const ts = parseIngestTimestamp(meta.ingest_at)
  if (ts == null) return false
  const days = staleDays ?? readEvidenceStaleDays()
  const ageMs = nowMs - ts
  return ageMs > days * 86_400_000
}

export function collectStaleEvidenceSources(
  items: EvidenceFreshnessMeta[],
  nowMs = Date.now(),
  staleDays?: number
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const it of items) {
    if (!isEvidenceStale(it, nowMs, staleDays)) continue
    const src = String(it.source || it.source_version || 'unknown').trim()
    if (!src || seen.has(src)) continue
    seen.add(src)
    out.push(src)
  }
  return out
}

export function buildStaleEvidenceHint(sources: string[]): string | null {
  if (!sources.length) return null
  const list = sources.slice(0, 5).join('、')
  return `部分引用文档可能已过期（${list}），回答时已标注需以最新制度为准。`
}
