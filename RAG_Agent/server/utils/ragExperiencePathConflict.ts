/**
 * RAG 经验 path 冲突仲裁（纯函数，无 PG / embedding 依赖）
 */

export function normalizeRagQuestionKeyLite(question: string): string {
  return String(question || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[？?！!。，,；;：:\s]/g, '')
    .slice(0, 120)
}

/** 从 hint「路径=xxx」提取 path；与 Manager path 冲突口径对齐 */
export function extractRagExperiencePathKey(hint: string, sources?: string[]): string {
  const h = String(hint || '')
  const m = h.match(/路径[=＝]\s*([^；;\s]+)/)
  if (m?.[1]) return m[1].trim().toLowerCase().slice(0, 64) || '—'
  if (sources?.length) {
    return (
      sources
        .map((s) => String(s || '').trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 2)
        .join('|') || '—'
    )
  }
  return '—'
}

/**
 * 同 question 下不同检索 path 只保留分最高的一条（RAG 侧轻量冲突仲裁）。
 */
export function resolveRagExperiencePathConflicts<
  T extends { score: number; question: string; hint: string; sources?: string[]; pathKey?: string }
>(rows: T[]): T[] {
  if (rows.length <= 1) return rows
  const byQ = new Map<string, T[]>()
  for (const row of rows) {
    const qn = normalizeRagQuestionKeyLite(row.question) || String(row.question || '').slice(0, 80)
    const list = byQ.get(qn) || []
    list.push(row)
    byQ.set(qn, list)
  }
  const out: T[] = []
  for (const list of byQ.values()) {
    if (list.length === 1) {
      out.push(list[0]!)
      continue
    }
    const byPath = new Map<string, T>()
    for (const row of list) {
      const pk = row.pathKey || extractRagExperiencePathKey(row.hint, row.sources)
      const prev = byPath.get(pk)
      if (!prev || row.score > prev.score) byPath.set(pk, row)
    }
    const paths = [...byPath.values()]
    if (paths.length === 1) {
      out.push(paths[0]!)
      continue
    }
    paths.sort((a, b) => b.score - a.score)
    out.push(paths[0]!)
  }
  return out.sort((a, b) => b.score - a.score)
}
