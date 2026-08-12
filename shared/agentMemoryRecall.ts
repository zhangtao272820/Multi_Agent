/**
 * 统一记忆召回评分：lexical + vector + recency + success_score
 * 见 docs/Agent记忆与存储数据库化升级方案.md §7.1
 */

import { ampRecallDecayLambdaPerDay } from './agentMemoryPolicy'

export type RecallCandidate = {
  text: string
  ts?: string
  successScore?: number
  scenarioKey?: string
  embedding?: number[]
  /** 0..1 写入时规则分 */
  importance?: number
  memoryId?: number | string
}

export type RankedRecallItem = RecallCandidate & {
  score: number
  jaccard: number
  vectorSim: number
  recency: number
}

export function tokenBag(text: string): Set<string> {
  const s = String(text || '').toLowerCase()
  const parts = s.match(/[\p{L}\p{N}_]{2,}/gu) || []
  return new Set(parts.slice(0, 120))
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) {
    if (b.has(x)) inter += 1
  }
  const union = a.size + b.size - inter
  return union ? inter / union : 0
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom ? dot / denom : 0
}

export function timeDecayScore(ts: unknown, lambdaPerDay = 0.09): number {
  const t = Date.parse(String(ts || ''))
  if (!Number.isFinite(t)) return 1
  const days = Math.max(0, (Date.now() - t) / 86_400_000)
  return Math.exp(-days * lambdaPerDay)
}

/** 0.35×vector + 0.25×lexical + 0.15×recency + 0.1×success + 0.15×importance */
export function blendRecallScore(input: {
  vectorSim: number
  jaccard: number
  recency: number
  successScore?: number
  importance?: number
  vectorWeight?: number
}): number {
  const vw = input.vectorWeight ?? 0.35
  const jw = 0.25
  const rw = 0.15
  const sw = 0.1
  const iw = 0.15
  const success = Math.max(0, Math.min(1, Number(input.successScore ?? 0.72)))
  const importance = Math.max(0, Math.min(1, Number(input.importance ?? 0.5)))
  return vw * input.vectorSim + jw * input.jaccard + rw * input.recency + sw * success + iw * importance
}

/** 过滤已 soft-delete 的条目（forget 后召回必过） */
export function filterActiveMemoryPayloads<T extends { deleted_at?: unknown; payload?: { deleted_at?: unknown } }>(
  items: T[]
): T[] {
  return items.filter((it) => {
    const d = it.deleted_at ?? it.payload?.deleted_at
    return !d || String(d).trim() === ''
  })
}

export function rankRecallCandidates(
  query: string,
  candidates: RecallCandidate[],
  opts?: {
    limit?: number
    queryEmbedding?: number[]
    vectorWeight?: number
    /** Wave6：时间衰减 λ/天；默认读 AMP */
    decayLambdaPerDay?: number
  }
): RankedRecallItem[] {
  const limit = Math.max(1, Math.min(20, opts?.limit ?? 4))
  const qBag = tokenBag(query)
  const lambda =
    opts?.decayLambdaPerDay != null && Number.isFinite(opts.decayLambdaPerDay)
      ? Number(opts.decayLambdaPerDay)
      : ampRecallDecayLambdaPerDay()
  const ranked = candidates
    .map((c) => {
      const jaccard = jaccardSimilarity(qBag, tokenBag(c.text))
      const vectorSim =
        opts?.queryEmbedding && c.embedding?.length
          ? cosineSimilarity(opts.queryEmbedding, c.embedding)
          : 0
      const recency = timeDecayScore(c.ts, lambda)
      const score = blendRecallScore({
        vectorSim,
        jaccard,
        recency,
        successScore: c.successScore,
        importance: c.importance,
        vectorWeight: opts?.vectorWeight
      })
      return { ...c, score, jaccard, vectorSim, recency }
    })
    .sort((a, b) => b.score - a.score)
  return ranked.slice(0, limit)
}
