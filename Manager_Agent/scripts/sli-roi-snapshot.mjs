/**
 * SLI ROI 快照（fixture 对照，不调 LLM）。
 * 用法：node scripts/sli-roi-snapshot.mjs
 */
import { compareSliRoi, formatSliRoiReport } from '../agent-repo-shared/sliRoiCompare.mjs'

const before = {
  routeAvgLlmCalls: 2.4,
  p95LatencyMs: 3200,
  routeSkipAlignRate: 0.1
}
const after = {
  routeAvgLlmCalls: 1.8,
  p95LatencyMs: 2900,
  routeSkipAlignRate: 0.35
}

const roi = compareSliRoi(before, after)
if (!roi.improved) {
  console.error('sli-roi-snapshot: expected improved fixture', roi)
  process.exit(1)
}
console.log(formatSliRoiReport(roi))
console.log('sli-roi-snapshot: OK')
