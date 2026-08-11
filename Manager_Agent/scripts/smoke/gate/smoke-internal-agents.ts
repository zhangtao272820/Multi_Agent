/**
 * P1-7：内置 clean / visualize / report 纯函数 + mock payload（不调 LLM、不拉 graph）。
 */
import { assembleCleanPayloadStructural, parseCleanPayload, serializeCleanPayload, type SourceSnapshot } from '#agent-shared/cleanPayload'
import { assembleVisualizeFromChartPlan, buildChartPlanFromFactsStructural } from '#agent-shared/codeAuthorityPayload'
import { isRenderableChartOption } from '#agent-shared/chartOption'
import {
  assembleReportFromPlan,
  validateReportPlanEvidence,
  readReportBlock,
  type ReportPlan
} from '#agent-shared/reportPlan'
import { buildChartPlanFromMatrix, parseMatrixFromData } from '#agent-shared/tabularChartSchema'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

// --- clean ---
const snapshots: SourceSnapshot[] = [
  {
    agent: 'db',
    raw: '{}',
    answer: 'db',
    facts: [{ key: 'east_sales', value: 120, sourcePath: 'db.east' }]
  },
  {
    agent: 'rag',
    raw: '{}',
    answer: 'rag',
    facts: [{ key: 'east_sales', value: 120, sourcePath: 'rag.east' }, { key: 'south_sales', value: 80, sourcePath: 'rag.south' }]
  }
]
const cleanPayload = assembleCleanPayloadStructural(snapshots)
assert(cleanPayload && cleanPayload.facts.length >= 2, 'structural clean payload')
const cleanJson = serializeCleanPayload(cleanPayload!)
const reparsed = parseCleanPayload(cleanJson)
assert(reparsed?.facts.length === cleanPayload!.facts.length, 'clean roundtrip')

// --- visualize（结构层，mock Code payload）---
const matrix = parseMatrixFromData({
  matrix: {
    rows: ['R1', 'R2'],
    cols: ['C1', 'C2', 'C3'],
    values: [
      [1, 2, 3],
      [4, 5, 6]
    ]
  }
})
assert(matrix?.rows.length === 2, 'matrix parse')
const heatPlan = buildChartPlanFromMatrix(matrix!, '区域热力')
assert(heatPlan?.panels[0]?.chartType === 'heatmap', 'matrix → heatmap plan')
const heatViz = assembleVisualizeFromChartPlan(heatPlan!)
const heatMatch = heatViz.match(/<!--ECHARTS_OPTION-->\s*([\s\S]*?)\s*<!--\/ECHARTS_OPTION-->/)
assert(Boolean(heatMatch), 'heatmap echarts block')
if (heatMatch) assert(isRenderableChartOption(JSON.parse(heatMatch[1]!)), 'heatmap renderable')

const factsPlan = buildChartPlanFromFactsStructural({
  answer: '销售对比',
  facts: [
    { key: 'east', value: 100, label: '华东' },
    { key: 'west', value: 80, label: '华西' },
    { key: 'north', value: 60, label: '华北' }
  ],
  data: {},
  raw: ''
})
assert(factsPlan && factsPlan.panels.length >= 1, 'facts structural plan')
const factsViz = assembleVisualizeFromChartPlan(factsPlan!)
assert(factsViz.includes('ECHARTS_OPTION'), 'facts visualize')
assert(!factsViz.includes('| east |') && factsViz.includes('华东'), 'user-facing labels not raw keys')

// --- report（ReportPlan 组装 + evidence 校验）---
const codePayload = {
  answer: '华东领先',
  facts: [
    { key: 'east', value: 100, label: '华东' },
    { key: 'west', value: 80, label: '华西' }
  ],
  data: {},
  raw: ''
}
const reportPlan: ReportPlan = {
  title: '销售分析',
  executive_summary: ['华东销量最高'],
  key_findings: [
    { claim: '华东销量 100 领先', evidence_keys: ['east'], display_values: ['100'] }
  ],
  risks: [{ text: '样本有限', because: '仅 2 个区域' }],
  recommendations: [{ action: '补充更多区域数据', priority: 'high' }]
}
const badPlan: ReportPlan = {
  ...reportPlan,
  key_findings: [{ claim: '虚构', evidence_keys: ['missing_key'] }]
}
assert(!validateReportPlanEvidence(badPlan, codePayload).ok, 'orphan evidence rejected')
assert(validateReportPlanEvidence(reportPlan, codePayload).ok, 'valid evidence')
const reportMd = assembleReportFromPlan(reportPlan)
assert(readReportBlock(reportMd)?.includes('华东'), 'report block readable')
assert(reportMd.includes('[依据: east]'), 'evidence citation')

console.log('smoke: internal agents (clean/visualize/report) ok')
