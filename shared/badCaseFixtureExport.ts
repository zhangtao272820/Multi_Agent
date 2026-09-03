/**
 * 在线坏例 → eval fixture（只进 eval，不进 System Prompt）。
 */

export type BadCaseRow = {
  runId?: string
  question: string
  score?: number
  reason?: string
  expectCap?: string[]
  expectClarify?: boolean
  source?: string
}

export type EvalFixtureCase = {
  id: string
  user: string
  expectCap?: string[]
  expectClarify?: boolean
  meta?: Record<string, unknown>
}

export function slugBadCaseId(runId: string, index: number): string {
  const base = String(runId || 'bad')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 48)
  return `BAD_${base || 'case'}_${index}`
}

/** Top N 低分 / 差评 → golden 结构（须人工审核后再入库） */
export function exportBadCasesToEvalFixture(
  rows: BadCaseRow[],
  opts?: { topN?: number; maxScore?: number }
): { description: string; cases: EvalFixtureCase[]; pendingReview: true } {
  const topN = Math.max(1, Math.min(50, Number(opts?.topN) || 10))
  const maxScore = Number.isFinite(opts?.maxScore) ? Number(opts?.maxScore) : 0.5

  const sorted = [...rows]
    .filter((r) => String(r.question || '').trim())
    .sort((a, b) => (Number(a.score ?? 1) - Number(b.score ?? 1)))
    .slice(0, topN)
    .filter((r) => Number(r.score ?? 0) <= maxScore)

  const cases: EvalFixtureCase[] = sorted.map((r, i) => ({
    id: slugBadCaseId(String(r.runId || r.source || 'online'), i + 1),
    user: String(r.question).trim(),
    ...(r.expectClarify ? { expectClarify: true } : {}),
    ...(Array.isArray(r.expectCap) && r.expectCap.length ? { expectCap: r.expectCap } : {}),
    meta: {
      source: r.source || 'online_eval',
      reason: r.reason || 'low_score',
      score: r.score,
      runId: r.runId,
      pendingReview: true
    }
  }))

  return {
    description: '在线坏例导出（pendingReview，须人工审核后 merge 进 eval golden）',
    cases,
    pendingReview: true
  }
}
