/**
 * P1 升级回归：tabular 出图、ready 探针、平台超时等纯函数校验。
 */
import { probeServiceReady } from '../../../server/graph/core/runtime/serviceReady'
import { platformSyncTimeoutMs } from '../../../server/graph/core/probe/probeConfig'
import { buildChartPlanFromTabularRows, parseTabularRowsFromData, parseMatrixFromData, buildChartPlanFromMatrix } from '#agent-shared/tabularChartSchema'
import { isRenderableChartOption } from '#agent-shared/chartOption'
import { assembleVisualizeFromChartPlan, buildChartPlanFromFactsStructural } from '#agent-shared/codeAuthorityPayload'
import { assembleReportFromPlan, validateReportPlanEvidence, readReportBlock } from '#agent-shared/reportPlan'
import { tryDeterministicVisualizeFromDbTabular, tryDeterministicVisualizeFromVannaChart, buildChartPlanFromVannaChart } from '#agent-shared/dbPipelineDeterministic'
import { extractStructuredPayload } from '../../../server/graph/core/shared'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

// P1-3: tabular 确定性出图
const rows = parseTabularRowsFromData({
  tabular_rows: [
    { label: 'A', value: 120 },
    { label: 'B', value: 80 },
    { label: 'C', value: 60 }
  ]
})
assert(rows?.length === 3, 'parse tabular_rows')
const plan = buildChartPlanFromTabularRows(rows!, 'Top3')
assert(plan && plan.panels.length === 1, 'chart plan from tabular')
const viz = assembleVisualizeFromChartPlan(plan!)
assert(viz.includes('ECHARTS_OPTION'), 'assemble visualize markdown')

const vannaPlan = buildChartPlanFromVannaChart({
  type: 'pie',
  points: [
    { label: '东区', value: 12 },
    { label: '西区', value: 8 }
  ]
})
assert(vannaPlan && vannaPlan.panels[0]?.chartType === 'pie', 'vanna chart plan pie')
const vannaViz = tryDeterministicVisualizeFromVannaChart({
  db: '分区人数',
  db_vanna_chart: {
    type: 'bar',
    points: [
      { label: 'A', value: 3 },
      { label: 'B', value: 5 },
      { label: 'C', value: 2 }
    ]
  }
})
assert(vannaViz && vannaViz.includes('ECHARTS_OPTION'), 'vanna chart → echarts')
assert(
  tryDeterministicVisualizeFromDbTabular(
    {
      db: '分区人数',
      db_vanna_chart: {
        type: 'line',
        points: [
          { label: '2024-01', value: 1 },
          { label: '2024-02', value: 2 }
        ]
      }
    },
    extractStructuredPayload
  )?.includes('ECHARTS_OPTION'),
  'db tabular path prefers vanna chart'
)

const dbViz = tryDeterministicVisualizeFromDbTabular(
  {
    db: JSON.stringify({
      answer: '销售排名',
      facts: [
        { key: '华东', value: 100 },
        { key: '华南', value: 80 }
      ],
      data: {
        tabular_rows: [
          { label: '华东', value: 100 },
          { label: '华南', value: 80 }
        ]
      }
    })
  },
  extractStructuredPayload
)
assert(Boolean(dbViz && dbViz.includes('ECHARTS_OPTION')), 'db tabular deterministic visualize')

const optionMatch = dbViz?.match(/<!--ECHARTS_OPTION-->\s*([\s\S]*?)\s*<!--\/ECHARTS_OPTION-->/)
assert(Boolean(optionMatch), 'echarts block present')
if (optionMatch) {
  const option = JSON.parse(optionMatch[1]!)
  assert(isRenderableChartOption(option), 'renderable echarts option')
}

// P1-6: 平台探针默认 12s
assert(platformSyncTimeoutMs() >= 12_000, 'platform sync timeout >= 12s')

// P1-4: ready 探针对不可达地址应 fail（不依赖外部服务）
const bad = await probeServiceReady('http://127.0.0.1:1', 500)
assert(!bad.ready && !bad.healthOk, 'unreachable ready probe fails')

// P1-5: matrix → heatmap
const matrix = parseMatrixFromData({
  matrix: {
    rows: ['A', 'B'],
    columns: ['X', 'Y'],
    values: [
      [10, 20],
      [30, 40]
    ]
  }
})
assert(matrix?.cols.length === 2, 'parse matrix cols')
const matrixPlan = buildChartPlanFromMatrix(matrix!, '矩阵图')
assert(matrixPlan?.panels[0]?.chartType === 'heatmap', 'matrix chart plan')
const matrixViz = assembleVisualizeFromChartPlan(matrixPlan!)
assert(matrixViz.includes('ECHARTS_OPTION'), 'matrix visualize')

const matrixFactsPlan = buildChartPlanFromFactsStructural({
  answer: '热力',
  facts: [],
  data: {
    heatmap: {
      rows: ['R1', 'R2'],
      cols: ['C1', 'C2'],
      values: [
        [1, 2],
        [3, 4]
      ]
    }
  },
  raw: ''
})
assert(matrixFactsPlan?.panels[0]?.chartType === 'heatmap', 'facts structural prefers matrix')

// P1-1: ReportPlan evidence
const reportPayload = {
  answer: 'ok',
  facts: [
    { key: 'kpi_a', value: 10 },
    { key: 'kpi_b', value: 20 }
  ],
  data: {},
  raw: ''
}
const reportPlan = {
  title: 'KPI 报告',
  executive_summary: ['A 低于 B'],
  key_findings: [{ claim: 'B 更高', evidence_keys: ['kpi_b'], display_values: ['20'] }]
}
assert(validateReportPlanEvidence(reportPlan, reportPayload).ok, 'report evidence ok')
const reportOut = assembleReportFromPlan(reportPlan)
assert(readReportBlock(reportOut)?.includes('KPI'), 'report block')

console.log('smoke: p1 upgrades ok')
