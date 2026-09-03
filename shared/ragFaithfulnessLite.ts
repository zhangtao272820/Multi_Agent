/**
 * RAG 引用忠实度（轻量）：evidence 句块与回答 token 重叠率（规则，非 RAGAS）。
 */

function tokenize(s: string): string[] {
  const t = String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const words = t.split(/\s+/).filter((x) => x.length >= 2)
  const cjk = t.match(/[\u4e00-\u9fff]{2,}/g) || []
  const grams: string[] = []
  for (const seg of cjk) {
    for (let i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2))
  }
  return [...new Set([...words, ...grams])]
}

function splitEvidenceChunks(evidence: string[]): string[] {
  const out: string[] = []
  for (const block of evidence) {
    for (const line of String(block ?? '').split(/[\n。！？!?]+/)) {
      const t = line.trim()
      if (t.length >= 6) out.push(t)
    }
  }
  return out
}

function chunkMatchesAnswer(chunk: string, answer: string): boolean {
  const norm = (s: string) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const c = norm(chunk)
  const a = norm(answer)
  if (c.length >= 4) {
    for (let i = 0; i <= Math.min(c.length - 4, 24); i += 2) {
      const probe = c.slice(i, i + 4)
      if (a.includes(probe)) return true
    }
  }
  const keys = tokenize(chunk)
  if (!keys.length) return false
  const answerTokens = new Set(tokenize(answer))
  const hit = keys.filter((k) => answerTokens.has(k)).length
  return hit / keys.length >= 0.35
}

export type RagFaithfulnessLiteResult = {
  score: number
  matched: number
  total: number
  /** 文档化阈值：>=0.35 视为 pass（可调，不进 Prompt） */
  pass: boolean
}

export const RAG_FAITHFULNESS_LITE_THRESHOLD = 0.35

/** evidence 句块中至少 40% 关键词出现在 answer 则计为 matched */
export function scoreRagFaithfulnessLite(answer: string, evidence: string[]): RagFaithfulnessLiteResult {
  const chunks = splitEvidenceChunks(evidence)
  if (!chunks.length) {
    return { score: 0, matched: 0, total: 0, pass: false }
  }
  let matched = 0
  for (const chunk of chunks) {
    if (chunkMatchesAnswer(chunk, answer)) matched += 1
  }
  const total = chunks.length
  const score = total ? Math.round((matched / total) * 1000) / 1000 : 0
  return {
    score,
    matched,
    total,
    pass: score >= RAG_FAITHFULNESS_LITE_THRESHOLD
  }
}
