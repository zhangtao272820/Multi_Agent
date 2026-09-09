/**
 * 执行成熟 SLI（Phase F）：从 meta / 步结果确定性聚合，不调 LLM。
 */
export type MaturitySliSnapshot = {
  stepsTotal: number
  stepsAccepted: number
  stepsReplan: number
  stepsFailed: number
  acceptanceRate: number
  briefAttached: number
  specialistRoundsP95: number
  localReplanCount: number
  raceEnabled: boolean
}

function p95(nums: number[]): number {
  const a = nums.filter((n) => Number.isFinite(n) && n >= 0).sort((x, y) => x - y)
  if (!a.length) return 0
  const idx = Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)
  return a[Math.max(0, idx)]!
}

export function buildMaturitySliSnapshot(input: {
  stepStatuses?: Array<{ status?: string }>
  briefAttachedCount?: number
  specialistRoundsUsed?: number[]
  localReplanCount?: number
  raceEnabled?: boolean
}): MaturitySliSnapshot {
  const statuses = Array.isArray(input.stepStatuses) ? input.stepStatuses : []
  let accepted = 0
  let replan = 0
  let failed = 0
  for (const s of statuses) {
    const st = String(s?.status || '').toLowerCase()
    if (st === 'success' || st === 'ok' || st === 'skipped') accepted += 1
    else if (st === 'replan') replan += 1
    else if (st === 'failed' || st === 'error') failed += 1
  }
  const total = statuses.length
  const acceptanceRate = total > 0 ? accepted / total : 1
  return {
    stepsTotal: total,
    stepsAccepted: accepted,
    stepsReplan: replan,
    stepsFailed: failed,
    acceptanceRate: Math.round(acceptanceRate * 1000) / 1000,
    briefAttached: Math.max(0, Math.floor(Number(input.briefAttachedCount) || 0)),
    specialistRoundsP95: p95(input.specialistRoundsUsed || []),
    localReplanCount: Math.max(0, Math.floor(Number(input.localReplanCount) || 0)),
    raceEnabled: Boolean(input.raceEnabled)
  }
}
