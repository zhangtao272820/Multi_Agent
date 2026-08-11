/**
 * 验证通用图表组装：多领域 mock LlmChartPlan → ECHARTS（不绑单场景、不调 LLM）。
 */
import {
  assembleVisualizeFromChartPlan,
  buildDeterministicReportFromCode,
  coerceChartNumericValue,
  enrichChartPlanWithPayload,
  embeddedChartHasMixedScales,
  hasEchartsOptionBlock,
  normalizeChartPlan,
  normalizeCodeOutputStructural,
  buildChartPlanFromFactsStructural,
  readChartPlanFromData,
  resolveCodeAuthorityPayload,
  isMachineIdentifierLabel,
  chartPlanHasUserFacingLabels,
  type LlmChartPlan
} from '#agent-shared/codeAuthorityPayload'
import { isRenderableChartOption, readChartTitle, readPanelCount, seriesPointCount, suggestChartContainerHeight } from '#agent-shared/chartOption'

function parseOptionFromMarkdown(out: string): unknown {
  const open = '<!--ECHARTS_OPTION-->'
  const close = '<!--/ECHARTS_OPTION-->'
  const start = out.indexOf(open)
  const end = out.indexOf(close, start + open.length)
  return JSON.parse(out.slice(start + open.length, end).trim())
}

function assertPlan(plan: LlmChartPlan, minPoints: number) {
  const out = assembleVisualizeFromChartPlan(plan)
  if (!hasEchartsOptionBlock(out)) throw new Error(`missing ECHARTS for ${plan.chartTitle}`)
  const option = parseOptionFromMarkdown(out)
  if (!isRenderableChartOption(option)) throw new Error(`not renderable: ${plan.chartTitle}`)
  if (readChartTitle(option) !== plan.chartTitle) throw new Error('title mismatch')
  if (seriesPointCount(option) < minPoints) throw new Error('series count too low')
}

// 领域 A：任意计数对比
assertPlan(
  {
    chartTitle: '指标对比',
    panels: [
      {
        panelTitle: '样本量',
        chartType: 'bar',
        visualRole: 'comparison',
        unitKind: 'count',
        comparableGroup: 'sample_size',
        series: [
          { label: '组 A', value: 10 },
          { label: '组 B', value: 20 },
          { label: '组 C', value: 15 }
        ]
      }
    ]
  },
  3
)

// 领域 B：构成占比 → pie
assertPlan(
  {
    chartTitle: '资源构成',
    panels: [
      {
        panelTitle: '结构占比',
        chartType: 'pie',
        visualRole: 'composition',
        unitKind: 'ratio',
        comparableGroup: 'resource_mix',
        series: [
          { label: '类别甲', value: 40, displayValue: '40%' },
          { label: '类别乙', value: 35, displayValue: '35%' },
          { label: '类别丙', value: 25, displayValue: '25%' }
        ]
      }
    ]
  },
  3
)

// 领域 C：时序趋势 → line
assertPlan(
  {
    chartTitle: '阶段变化',
    panels: [
      {
        panelTitle: '指标走势',
        chartType: 'line',
        visualRole: 'trend',
        unitKind: 'index',
        comparableGroup: 'kpi_index',
        series: [
          { label: 'T1', value: 72 },
          { label: 'T2', value: 81 },
          { label: 'T3', value: 78 }
        ]
      }
    ]
  },
  3
)

// 领域 D：多 panel（不同 comparable_group，非财务专属）
assertPlan(
  {
    chartTitle: '运营概览',
    panels: [
      {
        panelTitle: '规模指标',
        chartType: 'bar',
        visualRole: 'comparison',
        unitKind: 'count',
        comparableGroup: 'scale',
        series: [
          { label: '在岗人数', value: 120 },
          { label: '床位数', value: 200 }
        ]
      },
      {
        panelTitle: '达标率',
        chartType: 'gauge',
        visualRole: 'kpi',
        unitKind: 'percent',
        comparableGroup: 'compliance_rate',
        series: [{ label: '达标率', value: 86.5, displayValue: '86.5%' }]
      }
    ]
  },
  3
)

// 结构层：LLM 误混不可比 series → 按 unit_kind + comparable_group 拆分
const splitMixed = normalizeChartPlan({
  chartTitle: '混组（应拆分）',
  chartType: 'bar',
  unitKind: 'other',
  series: [
    { label: '人数', value: 50, unitKind: 'count', comparableGroup: 'headcount' },
    { label: '补贴额', value: 120000, unitKind: 'currency', comparableGroup: 'subsidy' },
    { label: '床位', value: 80, unitKind: 'count', comparableGroup: 'capacity' }
  ]
})
if (!splitMixed || splitMixed.panels.length < 2) throw new Error('comparable_group split failed')

const fromData = readChartPlanFromData({
  chart_plan: {
    chart_title: '来自 data.chart_plan',
    panels: [
      {
        panel_title: '对比',
        chart_type: 'line',
        visual_role: 'trend',
        unit_kind: 'count',
        series: [
          { label: 'X', value: 1 },
          { label: 'Y', value: 2 }
        ]
      }
    ]
  }
})
if (!fromData || fromData.panels.length !== 1) throw new Error('readChartPlanFromData failed')

// 多 panel 垂直堆叠布局
const stacked = assembleVisualizeFromChartPlan({
  chartTitle: '堆叠看板',
  panels: [
    {
      panelTitle: '对比',
      chartType: 'bar',
      visualRole: 'comparison',
      unitKind: 'count',
      series: [
        { label: 'A', value: 10 },
        { label: 'B', value: 20 }
      ]
    },
    {
      panelTitle: 'KPI',
      chartType: 'gauge',
      visualRole: 'kpi',
      unitKind: 'percent',
      series: [{ label: '完成率', value: 72, displayValue: '72%' }]
    }
  ]
})
const stackedOpt = parseOptionFromMarkdown(stacked) as { grid?: unknown[]; _layout?: { panelCount?: number } }
if (readPanelCount(stackedOpt) !== 2) throw new Error('stacked panel count mismatch')
if (!Array.isArray(stackedOpt.grid) || stackedOpt.grid.length !== readPanelCount(stackedOpt)) {
  throw new Error('stacked grid layout broken')
}

const ratioCoerced = coerceChartNumericValue('1:3')
if (!ratioCoerced || ratioCoerced.value !== 3 || ratioCoerced.unitKind !== 'ratio') {
  throw new Error('ratio coerce failed')
}

const elderPayload = resolveCodeAuthorityPayload({
  code: JSON.stringify({
    answer: '配比与补贴',
    facts: [
      { key: 'ratio_full', value: '1:3', label: '全失能老人' },
      { key: 'ratio_semi', value: '1:6', label: '半失能老人' },
      { key: 'ratio_self', value: '1:12', label: '自理老人' },
      { key: 'sub_full', value: 800, label: '完全失能老人' },
      { key: 'sub_mild', value: 300, label: '轻度失能老人' },
      { key: 'sub_80', value: 100, label: '80-89 周岁' },
      { key: 'sub_90', value: 200, label: '90-99 周岁' },
      { key: 'sub_100', value: 500, label: '100 周岁以上' }
    ]
  })
})!
const partialPlan: LlmChartPlan = {
  chartTitle: '养老标准',
  panels: [
    {
      panelTitle: '配比',
      chartType: 'horizontal_bar',
      unitKind: 'ratio',
      visualRole: 'comparison',
      comparableGroup: 'ratio',
      series: [{ label: '全失能老人', value: 3, displayValue: '1:3', sourceKey: 'ratio_full' }]
    }
  ]
}
const enriched = enrichChartPlanWithPayload(partialPlan, elderPayload, { chartOnly: false })
if (enriched.panels.length < 2) throw new Error('enrich should add subsidy panel')
const enrichedOut = assembleVisualizeFromChartPlan(enriched, '', elderPayload)
if (!hasEchartsOptionBlock(enrichedOut)) throw new Error('enriched assemble failed')
if ((enriched.tableRows?.length ?? 0) < 8) throw new Error('table should list all facts')

const mixedEmbedded = {
  series: [
    { name: '护理员配比', type: 'bar', data: [0.33, 0.08] },
    { name: '补贴金额', type: 'bar', data: [800, 300] }
  ]
}
if (!embeddedChartHasMixedScales(mixedEmbedded)) throw new Error('mixed scale detect failed')

// 横向配比图（3 类目）高度
const ratioPlan: LlmChartPlan = {
  chartTitle: '三类老人护理员配比对比',
  panels: [
    {
      panelTitle: '护理员配比标准对比',
      chartType: 'horizontal_bar',
      unitKind: 'ratio',
      visualRole: 'comparison',
      comparableGroup: 'ratio',
      series: [
        { label: '全失能老人', value: 3, displayValue: '1:3' },
        { label: '半失能老人', value: 6, displayValue: '1:6' },
        { label: '自理老人', value: 12, displayValue: '1:12' }
      ]
    }
  ]
}
const ratioOut = assembleVisualizeFromChartPlan(ratioPlan)
const ratioOpt = parseOptionFromMarkdown(ratioOut)
const ratioH = suggestChartContainerHeight(ratioOpt)
if (ratioH < 300) throw new Error('horizontal_bar height too small for 3 categories')
if (ratioOut.includes('| 3% |') || ratioOut.includes('| 6% |') || ratioOut.includes('| 12% |')) {
  throw new Error('ratio table must not show percent labels')
}
if (!ratioOut.includes('1:3') || !ratioOut.includes('1:6') || !ratioOut.includes('1:12')) {
  throw new Error('ratio table must preserve a:b display')
}

const ratioReport = buildDeterministicReportFromCode(elderPayload)
if (ratioReport.includes('| 3% |') || !ratioReport.includes('1:3')) {
  throw new Error('deterministic report must preserve ratio display')
}

// 财务多 panel：重复 gauge 合并 + 宽跨度 bar 拆分
const financeNorm = normalizeChartPlan({
  chartTitle: '月度财务分析',
  panels: [
    {
      panelTitle: '月度结余情况',
      chartType: 'bar',
      unitKind: 'currency',
      series: [
        { label: '月收入', value: 6000 },
        { label: '月支出', value: 5000 },
        { label: '公积金', value: 510 },
        { label: '五险一金', value: 560 },
        { label: '月结余', value: 1000 }
      ]
    },
    {
      panelTitle: '储蓄率',
      chartType: 'gauge',
      unitKind: 'percent',
      series: [{ label: '储蓄率', value: 16.67, displayValue: '16.67%' }]
    },
    {
      panelTitle: '其他',
      chartType: 'gauge',
      unitKind: 'percent',
      series: [{ label: 'ratios.储蓄率', value: 0.1667, sourceKey: 'ratios.储蓄率' }]
    }
  ]
})
if (!financeNorm || financeNorm.panels.length < 2) throw new Error('finance normalize failed')
const hasPercentGauge = financeNorm.panels.some((p) => p.chartType === 'gauge' && p.unitKind === 'percent')
if (hasPercentGauge) throw new Error('percent should not use gauge')
const financeOut = assembleVisualizeFromChartPlan(
  {
    chartTitle: '月度财务分析',
    panels: financeNorm!.panels
  },
  '',
  {
    answer: '',
    facts: [
      { key: 'income', value: 6000, label: '月收入' },
      { key: 'monthly_finance.结余', value: 1000, label: 'monthly_finance.结余' },
      { key: 'ratios.储蓄率', value: 0.1667, label: 'ratios.储蓄率' },
      { key: 'rate', value: '16.67%', label: '储蓄率' }
    ],
    data: {},
    raw: ''
  },
  { chartOnly: true }
)
if (financeOut.includes('monthly_finance') || financeOut.includes('ratios.')) {
  throw new Error('table should humanize dotted labels')
}
const tableBlock = financeOut.match(/<!--TABLE_DATA-->([\s\S]*?)<!--\/TABLE_DATA-->/)?.[1] ?? ''
const rateMatches = tableBlock.match(/\| 储蓄率 \|/g)
if (!rateMatches || rateMatches.length !== 1) throw new Error('table should dedupe 储蓄率')
if (!tableBlock.includes('16.67%')) throw new Error('table should format percent decimals')

// 结余校正：balance 须等于 income − expense
const codeFixed = normalizeCodeOutputStructural(
  JSON.stringify({
    answer: '月度财务',
    facts: [
      { key: '月收入', value: 6000 },
      { key: '月支出', value: 5000 },
      { key: '月结余', value: 830 }
    ],
    data: { monthly_finance: { income_yuan: 6000, expense_yuan: 5000, balance_yuan: 830 } }
  })
)
const codeObj = JSON.parse(codeFixed) as { data?: { monthly_finance?: { balance_yuan?: number } } }
if (codeObj.data?.monthly_finance?.balance_yuan !== 1000) throw new Error('balance should reconcile to 1000')

// 数值包含关系：仅 smoke 保留结构能力时可手动构造 composition panel，不再自动从 bar 拆分
const contained = normalizeChartPlan({
  chartTitle: '扣款构成',
  panels: [
    {
      panelTitle: '五险一金构成',
      chartType: 'pie',
      visualRole: 'composition',
      unitKind: 'currency',
      comparableGroup: 'supplement_currency_parts',
      series: [
        { label: '公积金', value: 510, sourceKey: 'housing_fund' },
        { label: '差额', value: 50, displayValue: '50' }
      ]
    }
  ]
})
if (!contained || contained.panels.length !== 1 || contained.panels[0]!.chartType !== 'pie') {
  throw new Error('composition panel should stay intact')
}

const fromFacts = buildChartPlanFromFactsStructural({
  answer: '月度财务',
  facts: [
    { key: '月收入', value: 6000 },
    { key: '月支出', value: 5000 },
    { key: '月结余', value: 1000 },
    { key: '储蓄率', value: '16.67%' },
    { key: '公积金', value: 510 },
    { key: '五险一金', value: 560 }
  ],
  data: { monthly_finance: { income_yuan: 6000, expense_yuan: 5000, balance_yuan: 1000 } },
  raw: ''
})
if (!fromFacts || fromFacts.panels.length < 2) throw new Error('buildChartPlanFromFactsStructural failed')
if (fromFacts.panels.length > 3) throw new Error(`too many panels: ${fromFacts.panels.length}`)
const hasPercent = fromFacts.panels.some((p) => p.unitKind === 'percent')
if (!hasPercent) throw new Error('percent panel missing')
const factsOut = assembleVisualizeFromChartPlan(fromFacts)
if (!hasEchartsOptionBlock(factsOut)) throw new Error('facts-only visualize failed')
if (readPanelCount(parseOptionFromMarkdown(factsOut)) > 3) throw new Error('facts chart too fragmented')
if (embeddedChartHasMixedScales(parseOptionFromMarkdown(factsOut))) {
  throw new Error('canonical multi-panel chart must not trigger mixed-scale gate')
}

// 噪声 fact 不得入图；savings_rate 与金额分 panel
const noisyPayload = resolveCodeAuthorityPayload({
  code: JSON.stringify({
    answer: '月度财务',
    facts: [
      { key: '月收入', value: 6000 },
      { key: '月支出', value: 5000 },
      { key: 'net_savings', value: 1000, label: '月结余' },
      { key: 'savings_rate', value: 16.67, label: '储蓄率' },
      { key: 'com', value: '[查询](https com/blog/article/1784414)' },
      { key: '5', value: '年末盘点 html)' },
      { key: '(说明', value: '目标站点返回 403/拦截' }
    ],
    data: { monthly_finance: { income_yuan: 6000, expense_yuan: 5000, balance_yuan: 1000 } }
  })
})!
const noisyPlan = buildChartPlanFromFactsStructural(noisyPayload)
if (!noisyPlan) throw new Error('noisy plan failed')
const currencyPanel = noisyPlan.panels.find((p) => p.unitKind === 'currency')
const percentPanel = noisyPlan.panels.find((p) => p.unitKind === 'percent')
if (!currencyPanel) throw new Error('currency panel missing')
if (percentPanel) throw new Error('savings_rate without % must not create percent panel')
const savingsPt = noisyPlan.panels.flatMap((p) => p.series).find((s) => s.sourceKey === 'savings_rate')
if (savingsPt?.unitKind === 'percent') throw new Error('savings_rate must not be labeled percent without %')
const noisyOut = assembleVisualizeFromChartPlan(noisyPlan)
if (noisyOut.includes('403') || noisyOut.includes('html)')) throw new Error('noise leaked into visualize')

// 主指标与扣款分 panel；facts 结余优先
const splitPayload = resolveCodeAuthorityPayload({
  code: JSON.stringify({
    answer: '月度财务',
    facts: [
      { key: '月收入', value: 6000 },
      { key: '月支出', value: 5000 },
      { key: '月结余', value: 130 },
      { key: '公积金', value: 510 },
      { key: '五险一金', value: 560 },
      { key: '储蓄率', value: 0.0217, label: '储蓄率' }
    ],
    data: { monthly_finance: { income_yuan: 6000, expense_yuan: 5000, balance_yuan: 1000 } }
  })
})!
const splitPlan = buildChartPlanFromFactsStructural(splitPayload)
if (!splitPlan) throw new Error('split plan failed')
const flowPanel = splitPlan.panels.find((p) => p.comparableGroup === 'flow_main')
const deductPanel = splitPlan.panels.find((p) => p.comparableGroup === 'deductions_currency')
const pctPanel = splitPlan.panels.find((p) => p.unitKind === 'percent')
if (!flowPanel || flowPanel.series.length !== 3) throw new Error('flow_main should have 3 series')
if (flowPanel.series.find((s) => s.sourceKey === 'balance')?.value !== 130) {
  throw new Error('balance should use facts 130 not schema 1000')
}
if (!deductPanel || deductPanel.series.length < 2) throw new Error('deductions panel missing')
const splitOut = assembleVisualizeFromChartPlan(splitPlan)
const splitOpt = parseOptionFromMarkdown(splitOut) as { series?: Array<{ data?: unknown[] }> }
const splitSeries = splitOpt.series ?? []
const mainBar = splitSeries.find((s) => Array.isArray(s.data) && (s.data as unknown[]).length === 3)
if (!mainBar) throw new Error('main bar should have 3 categories only')
if (pctPanel) throw new Error('0.0217 without % must not create percent panel')
const savingsSplit = splitPlan.panels.flatMap((p) => p.series).find((s) => s.label.includes('储蓄率'))
if (savingsSplit?.unitKind === 'percent') throw new Error('储蓄率 without % must not be percent')

// 传感类小数指标：不得误标为百分数；元数据不入图
const footPayload = resolveCodeAuthorityPayload({
  code: JSON.stringify({
    answer: '足底压力测试',
    facts: [
      { key: '整体-压力平均值', value: 13.35 },
      { key: '整体-压力最大值', value: 45.3 },
      { key: '左-足弓指', value: 0.41 },
      { key: '左-脚宽', value: 8.78 },
      { key: '创建人', value: 1 },
      { key: '修改人', value: 1 }
    ],
    data: { source: 'db_deterministic' }
  })
})!
const footPlan = buildChartPlanFromFactsStructural(footPayload)
if (footPlan) {
  const pct = footPlan.panels.find((p) => p.unitKind === 'percent')
  if (pct?.series.some((s) => s.value >= 40 && s.value <= 42)) {
    throw new Error('arch index 0.41 must not become 41%')
  }
  const allSeries = footPlan.panels.flatMap((p) => p.series)
  if (allSeries.some((s) => /创建人|修改人/.test(s.label))) {
    throw new Error('metadata facts must not enter chart')
  }
}
const footOut = footPlan ? assembleVisualizeFromChartPlan(footPlan) : ''
if (footOut.includes('41%') || footOut.includes('100%')) {
  throw new Error('foot pressure chart must not mislabel units as percent')
}

// P1-2/P1-3: 扩展 chart_type 组装
const extendedTypes: LlmChartPlan[] = [
  {
    chartTitle: '堆叠柱',
    panels: [
      {
        panelTitle: '堆叠',
        chartType: 'stacked_bar',
        visualRole: 'comparison',
        unitKind: 'count',
        stack: true,
        series: [
          { label: 'Q1-A', value: 10 },
          { label: 'Q1-B', value: 15 },
          { label: 'Q2-A', value: 12 },
          { label: 'Q2-B', value: 18 }
        ]
      }
    ]
  },
  {
    chartTitle: '散点',
    panels: [
      {
        panelTitle: 'XY',
        chartType: 'scatter',
        visualRole: 'distribution',
        unitKind: 'index',
        timeKey: 'X',
        series: [
          { label: 'P1', value: 3 },
          { label: 'P2', value: 7 },
          { label: 'P3', value: 5 }
        ]
      }
    ]
  },
  {
    chartTitle: '热力',
    panels: [
      {
        panelTitle: '矩阵',
        chartType: 'heatmap',
        visualRole: 'distribution',
        unitKind: 'count',
        series: [
          { label: 'A·X', value: 1 },
          { label: 'A·Y', value: 2 },
          { label: 'B·X', value: 3 },
          { label: 'B·Y', value: 4 }
        ]
      }
    ]
  },
  {
    chartTitle: '雷达',
    panels: [
      {
        panelTitle: '多维',
        chartType: 'radar',
        visualRole: 'comparison',
        unitKind: 'index',
        series: [
          { label: '速度', value: 80 },
          { label: '力量', value: 70 },
          { label: '耐力', value: 65 }
        ]
      }
    ]
  },
  {
    chartTitle: '组合',
    panels: [
      {
        panelTitle: '柱线',
        chartType: 'combo',
        visualRole: 'trend',
        unitKind: 'count',
        dualAxis: true,
        timeKey: 'month',
        series: [
          { label: 'M1', value: 100 },
          { label: 'M2', value: 120 },
          { label: 'M3', value: 110 }
        ]
      }
    ]
  }
]
for (const plan of extendedTypes) {
  assertPlan(plan, 2)
}

// 用户可见标签：英文 snake_case key 不得原样上屏；有 label 时须保留
if (!isMachineIdentifierLabel('monthly_income')) throw new Error('monthly_income should be machine id')
if (isMachineIdentifierLabel('月收入')) throw new Error('月收入 should be user-facing')
if (isMachineIdentifierLabel('月结余', 'net_savings')) throw new Error('labeled fact should be user-facing')

const rawKeyPayload = resolveCodeAuthorityPayload({
  code: JSON.stringify({
    answer: '月收入 6000',
    facts: [{ key: 'monthly_income', value: 6000 }]
  })
})!
const rawKeyPlan = buildChartPlanFromFactsStructural(rawKeyPayload)
if (!rawKeyPlan?.panels.length) throw new Error('raw-key structural plan missing')
if (chartPlanHasUserFacingLabels(rawKeyPlan)) {
  throw new Error('raw monthly_income plan must fail user-facing label gate')
}
const rawKeyOut = assembleVisualizeFromChartPlan(rawKeyPlan)
if (rawKeyOut) throw new Error('assemble must refuse machine-identifier labels')
if (rawKeyOut.includes('monthly_income')) throw new Error('monthly_income must not appear in visualize')

const labeledPayload = resolveCodeAuthorityPayload({
  code: JSON.stringify({
    answer: '月收入 6000',
    facts: [{ key: 'monthly_income', value: 6000, label: '月收入' }]
  })
})!
if (labeledPayload.facts[0]?.label !== '月收入') throw new Error('resolve must keep fact.label')
const labeledPlan = buildChartPlanFromFactsStructural(labeledPayload)
if (!labeledPlan || !chartPlanHasUserFacingLabels(labeledPlan)) {
  throw new Error('labeled monthly_income should pass user-facing gate')
}
const labeledOut = assembleVisualizeFromChartPlan(labeledPlan)
if (!hasEchartsOptionBlock(labeledOut)) throw new Error('labeled fact visualize failed')
if (labeledOut.includes('monthly_income')) throw new Error('machine key must not appear when label exists')
if (!labeledOut.includes('月收入')) throw new Error('user-facing label 月收入 missing')

console.log('smoke: generic multi-domain chart plan assemble ok')
