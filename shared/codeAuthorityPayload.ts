/**
 * 通用 Code 权威载荷：任意计算任务（非财务专用）。
 * 下游 visualize/report 只读 Code JSON 的 answer / facts / data，禁止回落上游裸数。
 * 图表分组/选数/标签由启发模型规划（见 managerCodeAuthorityLlm），此处仅做结构化组装。
 */

import type { ExtractPayloadFn } from './codeFirstAuthority'
import { buildCodeFirstBundle } from './codeFirstAuthority'
import { formatFactsAsDeepSeekReply } from './deepSeekReplyFormat'
import { isAsciiOnlyShortKey, isStructuralMetadataFactKey } from './structuralFactFilter'
import {
  normalizeCodeFinanceOutputStructural,
  reconcileMonthlyFinanceTriplet,
  tripletFromExactFinanceFacts,
  tripletFromMonthlyFinanceData
} from './financeChartSchema'
import {
  buildChartPlanFromMatrix,
  buildChartPlanFromTabularRows,
  parseMatrixFromData,
  parseTabularRowsFromData,
  rowsFromRankedFacts
} from './tabularChartSchema'
import { assessCodeFinanceConsistencyStructural } from './financeAmount'
import {
  assessDownstreamOrphanNumbers,
  collectUpstreamEvidenceNumbers,
  shouldSkipStructuralOrphanAudit
} from './codeDownstreamAudit'
import { assessReportOutputStructural } from './reportPlan'
import { isRenderableChartOption, normalizeChartOptionStructural } from './chartOption'

export type CodeFact = { key: string; value: unknown; label?: string; source?: string }

export type CodeAuthorityPayload = {
  answer: string
  facts: CodeFact[]
  data: Record<string, unknown>
  raw: string
}

export type CodeDownstreamConsistencyResult = {
  pass: boolean
  reason?: string
  retryIntent?: 'code' | 'visualize' | 'report'
  synthOnly?: boolean
}

/** 量纲种类（由启发模型标注，组装层只做结构校验） */
export type ChartUnitKind = 'currency' | 'percent' | 'count' | 'ratio' | 'index' | 'duration' | 'other'

/** 数据关系 / 可视化意图（由启发模型决定图表形态，非领域硬编码） */
export type ChartVisualRole = 'comparison' | 'composition' | 'trend' | 'kpi' | 'distribution'

export type ChartPanelType =
  | 'bar'
  | 'line'
  | 'pie'
  | 'gauge'
  | 'horizontal_bar'
  | 'stacked_bar'
  | 'scatter'
  | 'heatmap'
  | 'radar'
  | 'combo'

export type LlmChartSeriesPoint = {
  label: string
  value: number
  displayValue?: string
  sourceKey?: string
  /** 点级量纲；与 panel 默认不同时触发结构层拆 panel */
  unitKind?: ChartUnitKind
  /** 可比组 id：仅同组指标可共轴（LLM 标注，如 scale_a / headcount / subsidy） */
  comparableGroup?: string
}

/** 单个图表面板：同一可比组 + 同一量纲 */
export type LlmChartPanel = {
  panelTitle: string
  chartType: ChartPanelType
  unitKind: ChartUnitKind
  visualRole?: ChartVisualRole
  comparableGroup?: string
  yAxisName?: string
  /** 时序维度字段 hint（LLM 标注，组装层用于 trend line） */
  timeKey?: string
  /** 系列分组 hint（同 panel 多 series 时） */
  groupBy?: string
  /** stacked_bar 是否堆叠 */
  stack?: boolean
  /** combo：bar+line 双轴（须同 comparable_group + unit_kind） */
  dualAxis?: boolean
  series: LlmChartSeriesPoint[]
}

/** 启发模型输出的可视化规划（可多 panel） */
export type LlmChartPlan = {
  chartTitle: string
  chartNote?: string
  panels: LlmChartPanel[]
  tableRows?: Array<{ label: string; value: string }>
}

/** @deprecated 旧版单图结构，由 normalizeChartPlan 转换 */
export type LegacyLlmChartPlan = {
  chartTitle: string
  chartType?: ChartPanelType
  yAxisName?: string
  chartNote?: string
  unitKind?: ChartUnitKind
  series: LlmChartSeriesPoint[]
  tableRows?: Array<{ label: string; value: string }>
}

const CHART_DATA_KEYS = [
  'echarts',
  'echarts_option',
  'echartsOption',
  'chart',
  'chart_option',
  'chartOption',
  'visualization',
  'chart_series',
  'chartSeries'
] as const

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const s = String(value).trim()
  if (!s) return null
  let cleaned = ''
  for (const ch of s) {
    if (ch === ',' || ch === '，' || ch === ' ') continue
    cleaned += ch
  }
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/** 机械性噪声标记（URL/HTML/爬虫片段），非领域关键词 */
const STRUCTURAL_NOISE_MARKERS = [
  'http://',
  'https://',
  '](',
  '.html',
  '.htm',
  '403',
  '\n',
  '<!--',
  '[查询',
  '拦截'
] as const

function stringHasStructuralNoise(s: string): boolean {
  const lower = String(s ?? '').toLowerCase()
  for (const m of STRUCTURAL_NOISE_MARKERS) {
    if (lower.includes(m.toLowerCase())) return true
  }
  return false
}

/** 结构层：fact 是否具备可绘制数值（过滤爬虫/HTML/纯数字键/库表元数据等，非业务语义） */
export function isStructurallyChartableFact(f: CodeFact): boolean {
  const key = String(f?.key ?? '').trim()
  if (!key || isAsciiOnlyShortKey(key) || isStructuralMetadataFactKey(key)) return false
  if (coerceFiniteNumber(key) != null && String(coerceFiniteNumber(key)) === key) return false
  if (stringHasStructuralNoise(key)) return false

  const raw = String(f?.value ?? '').trim()
  if (!raw || raw.length > 48 || stringHasStructuralNoise(raw)) return false
  const coerced = coerceChartNumericValue(f.value, raw)
  if (!coerced) return false
  // 0/1 布尔/主键标识不入图
  const v = coerced.value
  if ((v === 0 || v === 1) && Math.abs(v - Math.round(v)) < 1e-9) return false
  return true
}

/** 结构层：从 facts 中筛出可入图的条目 */
export function filterChartableFacts(facts: CodeFact[]): CodeFact[] {
  return facts.filter(isStructurallyChartableFact)
}

/** 带点号的路径式 key（如 a.b），非小数 */
function looksLikeDottedPath(s: string): boolean {
  if (!s.includes('.')) return false
  const segs = s.split('.')
  if (segs.length < 2) return false
  const first = segs[0]!.trim()
  if (!first) return false
  const n = coerceFiniteNumber(first)
  if (n != null && String(n) === first) return false
  return first.length <= 64
}

function pathLeafSegment(s: string): string {
  const t = String(s ?? '').trim()
  if (!t || !looksLikeDottedPath(t)) return t
  return t.split('.').pop()!.trim() || t
}

/** 结构层：把 fact / series 原始值转为可绘制数字（含 a:b 配比，非领域 regex） */
export function coerceChartNumericValue(
  raw: unknown,
  displayHint?: string
): { value: number; displayValue?: string; unitKind?: ChartUnitKind } | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw }

  const candidates = [String(displayHint ?? '').trim(), String(raw ?? '').trim()].filter(Boolean)
  for (const s of candidates) {
    const ratioParts = s.split(/[:：]/)
    if (ratioParts.length === 2) {
      const left = coerceFiniteNumber(ratioParts[0])
      const right = coerceFiniteNumber(ratioParts[1])
      if (left != null && right != null && right > 0) {
        return { value: right, displayValue: s.includes(':') || s.includes('：') ? s : `${left}:${right}`, unitKind: 'ratio' }
      }
    }
    const isPercent = s.includes('%') || s.includes('％')
    const n = coerceFiniteNumber(isPercent ? s.split('%')[0]!.split('％')[0]! : s)
    if (n != null) {
      return {
        value: n,
        displayValue: s,
        unitKind: isPercent ? 'percent' : undefined
      }
    }
  }
  return null
}

function extractTaggedBlockBody(raw: string, tag: string): string | null {
  const open = `<!--${tag}-->`
  const close = `<!--/${tag}-->`
  const text = String(raw || '')
  const start = text.indexOf(open)
  if (start < 0) return null
  const bodyStart = start + open.length
  const end = text.indexOf(close, bodyStart)
  if (end < 0) return null
  return text.slice(bodyStart, end).trim()
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const txt = String(raw ?? '').trim()
  if (!txt.startsWith('{')) return null
  try {
    const obj = JSON.parse(txt) as unknown
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function flattenDataFacts(data: unknown, prefix = ''): CodeFact[] {
  if (data == null) return []
  if (typeof data !== 'object' || Array.isArray(data)) return []
  const out: CodeFact[] = []
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (CHART_DATA_KEYS.includes(k as (typeof CHART_DATA_KEYS)[number])) continue
    if (k === 'chart_plan' || k === 'chartPlan') continue
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenDataFacts(v, key))
    } else if (v !== undefined && v !== null && String(v).trim() !== '') {
      out.push({ key, value: v, source: 'code.data' })
    }
  }
  return out.slice(0, 48)
}

/** 从 results.code 解析权威载荷（仅 JSON 字段读取） */
export function resolveCodeAuthorityPayload(
  results: Record<string, unknown>,
  extractPayload?: ExtractPayloadFn
): CodeAuthorityPayload | null {
  const raw = String(results?.code ?? '').trim()
  if (!raw) return null

  let answer = raw
  let facts: CodeFact[] = []
  let data: Record<string, unknown> = {}

  if (extractPayload) {
    const parsed = extractPayload(raw)
    answer = String(parsed.answer ?? raw).trim() || raw
    facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
      .map((f) => {
        const key = String(f?.key ?? '').trim()
        const label = String(f?.label ?? '').trim()
        return {
          key,
          value: f?.value,
          ...(label ? { label } : {}),
          source: 'code'
        }
      })
      .filter((f) => f.key)
    if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
      data = { ...(parsed.data as Record<string, unknown>) }
    }
  } else {
    const obj = parseJsonObject(raw)
    if (obj) {
      answer = String(obj.answer ?? raw).trim() || raw
      facts = (Array.isArray(obj.facts) ? obj.facts : [])
        .map((f) => {
          const key = String((f as { key?: string })?.key ?? '').trim()
          const label = String((f as { label?: string })?.label ?? '').trim()
          return {
            key,
            value: (f as { value?: unknown })?.value,
            ...(label ? { label } : {}),
            source: 'code'
          }
        })
        .filter((f) => f.key)
      if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
        data = { ...(obj.data as Record<string, unknown>) }
      }
    }
  }

  const dataFacts = filterChartableFacts(flattenDataFacts(data))
  const seen = new Set(facts.map((f) => f.key.toLowerCase()))
  for (const df of dataFacts) {
    const nk = df.key.toLowerCase()
    if (!seen.has(nk)) {
      seen.add(nk)
      facts.push(df)
    }
  }

  if (!answer && !facts.length && !Object.keys(data).length) return null
  return { answer, facts, data, raw }
}

/** Code 输出是否足以确定性生成 report */
export function codePayloadSupportsDeterministicReport(payload: CodeAuthorityPayload): boolean {
  return payload.facts.length >= 2 || payload.answer.length >= 12
}

export function readEmbeddedChartOption(data: Record<string, unknown>): unknown | null {
  for (const key of CHART_DATA_KEYS) {
    const block = data[key]
    if (!block) continue
    if (typeof block === 'object' && block !== null) return block
    if (typeof block === 'string' && block.trim().startsWith('{')) {
      try {
        return JSON.parse(block)
      } catch {
        continue
      }
    }
  }
  return null
}

function parseUnitKind(raw: unknown): ChartUnitKind {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'currency' || s === 'percent' || s === 'count' || s === 'ratio' || s === 'index' || s === 'duration') {
    return s
  }
  return 'other'
}

function parseVisualRole(raw: unknown): ChartVisualRole | undefined {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'comparison' || s === 'composition' || s === 'trend' || s === 'kpi' || s === 'distribution') return s
  return undefined
}

function parseChartPanelType(raw: unknown): ChartPanelType {
  const s = String(raw ?? 'bar').trim().toLowerCase()
  const allowed: ChartPanelType[] = [
    'line',
    'pie',
    'gauge',
    'horizontal_bar',
    'stacked_bar',
    'scatter',
    'heatmap',
    'radar',
    'combo'
  ]
  if ((allowed as readonly string[]).includes(s)) return s as ChartPanelType
  return 'bar'
}

function parseSeriesPoints(raw: unknown): LlmChartSeriesPoint[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((s) => {
      const row = s as Record<string, unknown>
      const label = String(row.label ?? '').trim()
      if (!label) return null
      const displayRaw =
        row.display_value != null
          ? String(row.display_value)
          : row.displayValue != null
            ? String(row.displayValue)
            : undefined
      const coerced = coerceChartNumericValue(row.value ?? row.val, displayRaw)
      if (!coerced) return null
      const unitRaw = row.unit_kind ?? row.unitKind
      const groupRaw = row.comparable_group ?? row.comparableGroup
      return {
        label,
        value: coerced.value,
        displayValue: coerced.displayValue ?? displayRaw,
        sourceKey:
          row.source_key != null
            ? String(row.source_key)
            : row.sourceKey != null
              ? String(row.sourceKey)
              : undefined,
        unitKind: unitRaw != null ? parseUnitKind(unitRaw) : coerced.unitKind,
        comparableGroup: groupRaw != null ? String(groupRaw).trim() || undefined : undefined
      }
    })
    .filter(Boolean) as LlmChartSeriesPoint[]
}

function parseChartPanel(raw: unknown): LlmChartPanel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  const series = parseSeriesPoints(p.series)
  if (!series.length) return null
  return {
    panelTitle: String(p.panel_title ?? p.panelTitle ?? p.chart_title ?? '图表').trim() || '图表',
    chartType: parseChartPanelType(p.chart_type ?? p.chartType),
    unitKind: parseUnitKind(p.unit_kind ?? p.unitKind),
    visualRole: parseVisualRole(p.visual_role ?? p.visualRole),
    comparableGroup:
      p.comparable_group != null
        ? String(p.comparable_group).trim() || undefined
        : p.comparableGroup != null
          ? String(p.comparableGroup).trim() || undefined
          : undefined,
    yAxisName: p.y_axis_name != null ? String(p.y_axis_name) : p.yAxisName != null ? String(p.yAxisName) : undefined,
    timeKey:
      p.time_key != null
        ? String(p.time_key).trim() || undefined
        : p.timeKey != null
          ? String(p.timeKey).trim() || undefined
          : undefined,
    groupBy:
      p.group_by != null
        ? String(p.group_by).trim() || undefined
        : p.groupBy != null
          ? String(p.groupBy).trim() || undefined
          : undefined,
    stack: p.stack === true || String(p.stack ?? '').toLowerCase() === 'true',
    dualAxis: p.dual_axis === true || p.dualAxis === true || String(p.dual_axis ?? p.dualAxis ?? '').toLowerCase() === 'true',
    series
  }
}

function pointComparableKey(point: LlmChartSeriesPoint, panel: LlmChartPanel): string {
  const uk = point.unitKind ?? panel.unitKind
  const cg = point.comparableGroup ?? panel.comparableGroup ?? supplementaryComparableGroup(uk)
  return `${uk}::${cg}`
}

/** 仅当 series 上存在多个显式可比组时才拆分（禁止用 sourceKey 逐条拆 panel） */
function splitPanelByComparableGroups(panel: LlmChartPanel): LlmChartPanel[] {
  if (panel.series.length < 2) return [panel]
  if (panel.comparableGroup) return [panel]
  const explicitKeys = new Set<string>()
  for (const pt of panel.series) {
    const cg = pt.comparableGroup ?? panel.comparableGroup
    if (!cg) continue
    explicitKeys.add(`${pt.unitKind ?? panel.unitKind}::${cg}`)
  }
  if (explicitKeys.size <= 1) return [panel]
  const buckets = new Map<string, LlmChartSeriesPoint[]>()
  for (const pt of panel.series) {
    const key = pointComparableKey(pt, panel)
    const arr = buckets.get(key) ?? []
    arr.push(pt)
    buckets.set(key, arr)
  }
  if (buckets.size <= 1) return [panel]
  return Array.from(buckets.entries()).map(([, series]) => ({
    ...panel,
    panelTitle: series.length === 1 ? series[0]!.label : panel.panelTitle,
    unitKind: series[0]?.unitKind ?? panel.unitKind,
    comparableGroup: series[0]?.comparableGroup ?? panel.comparableGroup,
    series
  }))
}

/** 结构层：visual_role + 点数 → 合法 chartType（仅类型映射，不改数字） */
function resolveChartType(panel: LlmChartPanel): ChartPanelType {
  const n = panel.series.length
  const role = panel.visualRole
  if (n === 1) {
    if (panel.unitKind === 'percent' || panel.unitKind === 'ratio') return 'horizontal_bar'
    if (role === 'kpi' || panel.unitKind === 'index') return 'gauge'
    return panel.chartType === 'gauge' ? 'gauge' : panel.chartType
  }
  if (role === 'composition') return 'pie'
  if (role === 'trend') return 'line'
  if (role === 'distribution') return 'bar'
  if (role === 'kpi') return 'gauge'
  if (panel.unitKind === 'ratio') return 'horizontal_bar'
  if (panel.unitKind === 'percent') {
    if (panel.chartType === 'horizontal_bar') return 'horizontal_bar'
    return n > 4 ? 'horizontal_bar' : panel.chartType === 'line' ? 'line' : 'bar'
  }
  if (panel.chartType === 'pie' || panel.chartType === 'line' || panel.chartType === 'horizontal_bar') {
    return panel.chartType
  }
  if (panel.chartType === 'stacked_bar' || panel.chartType === 'scatter' || panel.chartType === 'heatmap' || panel.chartType === 'radar' || panel.chartType === 'combo') {
    return panel.chartType
  }
  return role === 'comparison' || !role ? 'bar' : panel.chartType
}

/** 结构层：修正明显不合理的 panel（依赖 LLM 提供的 unitKind，不用正则猜语义） */
export function normalizeChartPlan(input: LegacyLlmChartPlan | LlmChartPlan | null | undefined): LlmChartPlan | null {
  if (!input) return null
  const chartTitle = String((input as LlmChartPlan).chartTitle ?? '').trim() || '计算结果概览'
  const chartNote = (input as LlmChartPlan).chartNote
  const tableRows = (input as LlmChartPlan).tableRows

  let panels: LlmChartPanel[] = []
  if (Array.isArray((input as LlmChartPlan).panels) && (input as LlmChartPlan).panels.length) {
    panels = (input as LlmChartPlan).panels
      .map(normalizePanelSeries)
      .flatMap(splitPanelByComparableGroups)
      .filter((p) => p.series.length > 0)
  } else {
    const legacy = input as LegacyLlmChartPlan
    if (Array.isArray(legacy.series) && legacy.series.length) {
      panels = splitPanelByComparableGroups(
        normalizePanelSeries({
          panelTitle: chartTitle,
          chartType: parseChartPanelType(legacy.chartType),
          unitKind: parseUnitKind(legacy.unitKind),
          yAxisName: legacy.yAxisName,
          series: legacy.series
        })
      )
    }
  }
  if (!panels.length) return null

  panels = dedupeGaugePanels(panels)
  panels = consolidateGaugePanels(panels)

  const fixed: LlmChartPanel[] = []
  for (const panel of panels) {
    let chartType = resolveChartType(panel)
    let series = panel.series
    if (chartType === 'gauge' && series.length > 1) {
      series = series.slice(0, 1)
    }
    if (chartType === 'radar' && series.length < 3) {
      continue
    }
    if (chartType === 'combo' && series.length < 3) {
      continue
    }
    if (chartType === 'pie' && series.length < 2) {
      continue
    }
    if ((chartType === 'bar' || chartType === 'line' || chartType === 'horizontal_bar' || chartType === 'stacked_bar' || chartType === 'scatter') && series.length < 2) {
      if (panel.unitKind === 'ratio' && series.length === 1) {
        chartType = 'horizontal_bar'
      } else if (panel.unitKind === 'percent' && series.length === 1) {
        chartType = 'horizontal_bar'
      } else if (panel.visualRole === 'kpi' && panel.unitKind !== 'percent' && panel.unitKind !== 'ratio' && series.length === 1) {
        chartType = 'gauge'
      } else if (series.length === 1) {
        chartType = 'horizontal_bar'
      } else {
        continue
      }
    }
    fixed.push({ ...panel, chartType, series })
  }
  if (!fixed.length) return null
  const consolidated = consolidatePanelsByUnitKind(consolidateSparseHorizontalPanels(fixed))
  if (!consolidated.length) return null
  return { chartTitle, chartNote, panels: consolidated, tableRows }
}

/** 从 Code data.chart_plan 读取启发模型预规划 */
export function readChartPlanFromData(data: Record<string, unknown>): LlmChartPlan | null {
  const raw = data.chart_plan ?? data.chartPlan
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  const panelsRaw = Array.isArray(p.panels) ? p.panels : []
  const panels = panelsRaw.map(parseChartPanel).filter(Boolean) as LlmChartPanel[]
  const tableRowsRaw = Array.isArray(p.table_rows) ? p.table_rows : Array.isArray(p.tableRows) ? p.tableRows : []
  const tableRows = tableRowsRaw
    .map((r) => {
      const row = r as Record<string, unknown>
      const label = String(row.label ?? '').trim()
      if (!label) return null
      return { label: humanizeSeriesLabel(label, label), value: formatDisplayText(String(row.value ?? '')) || String(row.value ?? '') }
    })
    .filter(Boolean) as Array<{ label: string; value: string }>

  if (panels.length) {
    return normalizeChartPlan({
      chartTitle: String(p.chart_title ?? p.chartTitle ?? '计算结果概览').trim() || '计算结果概览',
      chartNote: p.chart_note != null ? String(p.chart_note) : p.chartNote != null ? String(p.chartNote) : undefined,
      panels,
      tableRows: tableRows.length ? tableRows : undefined
    })
  }

  const series = parseSeriesPoints(p.series)
  if (series.length < 2) return null
  return normalizeChartPlan({
    chartTitle: String(p.chart_title ?? p.chartTitle ?? '计算结果概览').trim() || '计算结果概览',
    chartType: parseChartPanelType(p.chart_type ?? p.chartType),
    yAxisName: p.y_axis_name != null ? String(p.y_axis_name) : p.yAxisName != null ? String(p.yAxisName) : undefined,
    chartNote: p.chart_note != null ? String(p.chart_note) : undefined,
    unitKind: parseUnitKind(p.unit_kind ?? p.unitKind),
    series,
    tableRows: tableRows.length ? tableRows : undefined
  })
}

export function hasEchartsOptionBlock(text: string): boolean {
  return extractTaggedBlockBody(String(text ?? ''), 'ECHARTS_OPTION') != null
}

/** 从 visualize 输出读取 ECharts option JSON（结构层，无领域逻辑） */
export function readEchartsOptionJsonFromVisualizeText(text: string): unknown | null {
  const body = extractTaggedBlockBody(String(text ?? ''), 'ECHARTS_OPTION')
  if (!body) return null
  try {
    return JSON.parse(body) as unknown
  } catch {
    return null
  }
}

function extractBalancedJsonValue(raw: string): string {
  const s = String(raw || '').trim()
  for (const open of ['{', '['] as const) {
    const close = open === '{' ? '}' : ']'
    const start = s.indexOf(open)
    if (start < 0) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i]
      if (inStr) {
        if (esc) {
          esc = false
          continue
        }
        if (ch === '\\') {
          esc = true
          continue
        }
        if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') {
        inStr = true
        continue
      }
      if (ch === open) depth += 1
      if (ch === close) {
        depth -= 1
        if (depth === 0) return s.slice(start, i + 1).trim()
      }
    }
  }
  return ''
}

function coerceLooseChartPanel(raw: unknown): LlmChartPanel | null {
  const fromSeries = parseChartPanel(raw)
  if (fromSeries) return fromSeries
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  const categories = Array.isArray(p.categories)
    ? p.categories.map((c) => String(c ?? '').trim()).filter(Boolean)
    : []
  const data = Array.isArray(p.data) ? p.data : []
  const n = Math.min(categories.length, data.length)
  if (n < 2) return null
  const unitKind = parseUnitKind(p.unit ?? p.unit_kind ?? p.unitKind)
  const series: LlmChartSeriesPoint[] = []
  for (let i = 0; i < n; i += 1) {
    const coerced = coerceChartNumericValue(data[i])
    if (!coerced) continue
    series.push({
      label: categories[i]!,
      value: coerced.value,
      displayValue: coerced.displayValue,
      unitKind: coerced.unitKind ?? unitKind
    })
  }
  if (series.length < 2) return null
  return {
    panelTitle: String(p.title ?? p.panelTitle ?? p.panel_title ?? '图表').trim() || '图表',
    chartType: parseChartPanelType(p.type ?? p.chartType ?? p.chart_type ?? 'bar'),
    unitKind,
    series
  }
}

function coerceLooseChartPlan(parsed: unknown): LlmChartPlan | null {
  if (!parsed) return null
  let root: Record<string, unknown> | null = null
  if (Array.isArray(parsed) && parsed.length) {
    const first = parsed[0]
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const row = first as Record<string, unknown>
      root = {
        chartTitle: row.title ?? row.chartTitle ?? row.chart_title,
        panels: Array.isArray(row.panels) ? row.panels : [row]
      }
    }
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    root = parsed as Record<string, unknown>
  }
  if (!root) return null
  const panelsRaw = Array.isArray(root.panels) ? root.panels : []
  const panels = panelsRaw.map(coerceLooseChartPanel).filter(Boolean) as LlmChartPanel[]
  if (!panels.length) return null
  return normalizeChartPlan({
    chartTitle: String(root.chartTitle ?? root.title ?? root.chart_title ?? '数据图表').trim() || '数据图表',
    panels
  })
}

/** 从 visualize / final 文本解析可渲染 ECharts（支持 panels 简写与未闭合标签） */
export function resolveRenderableEchartsOptionFromText(text: string): Record<string, unknown> | null {
  const t = String(text ?? '')
  let body = extractTaggedBlockBody(t, 'ECHARTS_OPTION')
  if (!body) {
    const open = '<!--ECHARTS_OPTION-->'
    const idx = t.indexOf(open)
    if (idx >= 0) {
      const after = t.slice(idx + open.length).trim()
      body = extractBalancedJsonValue(after) || after.split('<!--')[0]?.trim() || ''
    }
  }
  if (!body) return null
  let parsed: unknown = null
  try {
    parsed = JSON.parse(body)
  } catch {
    const frag = extractBalancedJsonValue(body)
    if (!frag) return null
    try {
      parsed = JSON.parse(frag)
    } catch {
      return null
    }
  }
  const plan = coerceLooseChartPlan(parsed)
  if (plan) {
    const built = buildEchartsOptionFromPlan(plan) as Record<string, unknown>
    const normalized = normalizeChartOptionStructural(built)
    if (normalized && isRenderableChartOption(normalized)) return normalized
  }
  const normalized = normalizeChartOptionStructural(parsed)
  if (normalized && isRenderableChartOption(normalized)) return normalized
  return null
}

function factsMarkdownTable(facts: Array<{ label?: string; key?: string; value: unknown }>, title = '指标', valueTitle = '数值'): string {
  if (!facts.length) return ''
  const rows = normalizeTableRows(
    facts.slice(0, 32).map((f) => {
      const cf: CodeFact = { key: String(f.key ?? ''), value: f.value, label: f.label, source: 'table' }
      return {
        label: humanizeSeriesLabel(String(f.label ?? f.key ?? ''), f.key),
        value: formatFactTableValue(cf)
      }
    })
  )
  const mdRows = rows.map((r) => `| ${r.label} | ${r.value} |`)
  return [`| ${title} | ${valueTitle} |`, '|---|---:|', ...mdRows].join('\n')
}

function yAxisSuffix(unitKind: ChartUnitKind): string {
  if (unitKind === 'currency') return '元'
  if (unitKind === 'percent') return '%'
  if (unitKind === 'index') return '指数'
  if (unitKind === 'duration') return '时长'
  return ''
}

function formatTooltipValue(unitKind: ChartUnitKind, value: number, displayValue?: string): string {
  if (displayValue) return formatDisplayText(displayValue, unitKind)
  if (unitKind === 'percent') return formatChartNumber(value, unitKind)
  if (unitKind === 'currency') return `${formatChartNumber(value, 'count')} 元`
  return formatChartNumber(value, unitKind)
}

/** 展示文案：去路径前缀、收敛小数位（结构层，非领域 regex） */
function formatDisplayText(raw: string, unitKind?: ChartUnitKind): string {
  let s = String(raw ?? '').trim()
  if (!s) return s
  if (looksLikeDottedPath(s)) s = pathLeafSegment(s)
  const num = coerceFiniteNumber(s.replace(/%/g, ''))
  if (num != null && /^[\d.]+$/.test(s.replace(/%/g, '').trim())) {
    return unitKind === 'percent' || s.includes('%') ? formatChartNumber(num, 'percent') : formatChartNumber(num, unitKind ?? 'count')
  }
  return s
}

function formatChartNumber(value: number, unitKind: ChartUnitKind | 'count'): string {
  if (!Number.isFinite(value)) return String(value)
  if (unitKind === 'percent') {
    const v = value > 0 && value <= 1 ? value * 100 : value
    return `${Number(v.toFixed(2))}%`
  }
  if (Math.abs(value - Math.round(value)) < 1e-6) return String(Math.round(value))
  return Number(value.toFixed(2)).toString()
}

function humanizeSeriesLabel(label: string, sourceKey?: string): string {
  const fromLabel = pathLeafSegment(label)
  const fromKey = pathLeafSegment(sourceKey ?? '')
  return fromLabel || fromKey || String(label ?? sourceKey ?? '').trim()
}

/**
 * 结构判定：展示文案是否像代码字段名（snake_case / camelCase / 点路径标识符）。
 * 仅做形态校验，不做中英翻译。
 */
export function isMachineIdentifierLabel(label: string, sourceKey?: string): boolean {
  const raw = String(label ?? '').trim()
  if (!raw) return true
  const leaf = pathLeafSegment(raw)
  if (!leaf) return true
  // 含非 ASCII（中文等）→ 用户可见
  if (/[^\x00-\x7F]/.test(leaf)) return false
  // 含空白或人类可读分隔符
  if (/[\s\-–—·／/()（）]/.test(leaf)) return false
  // snake_case
  if (/^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/.test(leaf)) return true
  // camelCase
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(leaf)) return true
  // 整段点路径均为 ASCII 标识符
  if (raw.includes('.') && /^[A-Za-z][A-Za-z0-9_.]*$/.test(raw)) {
    return raw.split('.').every((seg) => /^[A-Za-z][A-Za-z0-9_]*$/.test(seg))
  }
  // 展示名与 sourceKey 叶节点相同且为纯标识符 → 未做人文化
  const skLeaf = pathLeafSegment(sourceKey ?? '')
  if (
    skLeaf &&
    leaf.toLowerCase() === skLeaf.toLowerCase() &&
    /^[A-Za-z][A-Za-z0-9_]*$/.test(leaf) &&
    leaf.length >= 3
  ) {
    return true
  }
  return false
}

/** 图表 plan 的 series / tableRows 是否均可面向用户展示 */
export function chartPlanHasUserFacingLabels(plan: LlmChartPlan | null | undefined): boolean {
  if (!plan?.panels?.length) return false
  for (const panel of plan.panels) {
    for (const s of panel.series ?? []) {
      if (isMachineIdentifierLabel(s.label, s.sourceKey)) return false
    }
  }
  for (const row of plan.tableRows ?? []) {
    if (isMachineIdentifierLabel(row.label)) return false
  }
  return true
}

export function inferUnitKindFromCoerce(
  f: CodeFact,
  coerced: ReturnType<typeof coerceChartNumericValue>,
  _batchMax = 0
): ChartUnitKind {
  if (coerced?.unitKind) return coerced.unitKind
  const raw = String(f.value ?? '')
  if (raw.includes('%') || raw.includes('％')) return 'percent'
  if (raw.includes(':') || raw.includes('：')) return 'ratio'
  // 禁止用数量级/小数猜百分数；仅显式 % / : 才标 percent/ratio
  return 'other'
}

function formatFactTableValue(f: CodeFact): string {
  const raw = String(f.value ?? '')
  const coerced = coerceChartNumericValue(f.value, raw)
  if (!coerced) return raw
  const uk = inferUnitKindFromCoerce(f, coerced)
  if (uk === 'ratio') return coerced.displayValue ?? raw
  if (uk === 'percent') return formatChartNumber(coerced.value, 'percent')
  if (uk === 'currency') return `${formatChartNumber(coerced.value, 'count')} 元`
  return coerced.displayValue ?? formatChartNumber(coerced.value, uk)
}

function tableRowKey(label: string, sourceKey?: string): string {
  let leaf = humanizeSeriesLabel(label, sourceKey).toLowerCase()
  if (leaf.startsWith('月') && leaf.length > 1) leaf = leaf.slice(1)
  return leaf
}

/** 表格行：人性化标签 + 格式化数值 + 按语义去重（结构层） */
function normalizeTableRows(rows: Array<{ label: string; value: string }>): Array<{ label: string; value: string }> {
  const map = new Map<string, { label: string; value: string }>()
  for (const row of rows) {
    const label = humanizeSeriesLabel(row.label, row.label)
    if (!label) continue
    const key = tableRowKey(label)
    const value = formatDisplayText(row.value) || row.value
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { label, value })
      continue
    }
    if (prev.value.length < value.length || value.includes('%')) {
      map.set(key, { label, value })
    }
  }
  return [...map.values()]
}

function inferComparableGroup(sourceKey?: string, unitKind?: ChartUnitKind): string | undefined {
  const key = String(sourceKey ?? '').trim()
  if (!key) return unitKind
  if (key.includes('.')) {
    const prefix = key.split('.')[0]!.trim()
    if (prefix) return prefix
  }
  return key
}

/** 补全 facts 默认可比组：同量纲并入同一 panel，由结构层再拆分包含关系 */
function supplementaryComparableGroup(unitKind: ChartUnitKind): string {
  return `supplement_${unitKind}`
}

/** 收支柱图 schema 字段与 series 对齐（结构层，仅 monthly_finance 已存在时） */
function classifyTripletSeriesRole(label: string, sourceKey?: string): 'income' | 'expense' | 'balance' | null {
  const leaf = humanizeSeriesLabel(label, sourceKey).toLowerCase()
  const sk = String(sourceKey ?? '').trim().toLowerCase()
  const leafNorm = leaf.startsWith('月') ? leaf.slice(1) : leaf
  if (leafNorm === '收入' || sk.includes('income')) return 'income'
  if (leafNorm === '支出' || sk.includes('expense')) return 'expense'
  if (leafNorm === '结余' || sk.includes('balance')) return 'balance'
  return null
}

export function syncChartPlanWithAuthorityTriplet(
  plan: LlmChartPlan,
  payload: CodeAuthorityPayload
): LlmChartPlan {
  const triplet = resolveChartAuthorityTriplet(payload)
  if (!triplet) return plan
  const panels = plan.panels.map((panel) => ({
    ...panel,
    series: panel.series.map((s) => {
      const role = classifyTripletSeriesRole(s.label, s.sourceKey)
      if (role === 'income') {
        return { ...s, value: triplet.income, displayValue: formatChartNumber(triplet.income, 'currency') }
      }
      if (role === 'expense') {
        return { ...s, value: triplet.expense, displayValue: formatChartNumber(triplet.expense, 'currency') }
      }
      if (role === 'balance') {
        return { ...s, value: triplet.balance, displayValue: formatChartNumber(triplet.balance, 'currency') }
      }
      return s
    })
  }))
  return { ...plan, panels }
}

// 数值包含关系拆分仅用于显式 composition panel，不在 normalize 主路径自动触发（避免收入/支出等同级指标被误判）

/** 多个单点 horizontal_bar 同量纲 → 合并为一个多类目横向图，避免重复「其他指标」panel */
function dedupeSeriesByLabel(series: LlmChartSeriesPoint[]): LlmChartSeriesPoint[] {
  const map = new Map<string, LlmChartSeriesPoint>()
  for (const pt of series) {
    const key = tableRowKey(pt.label, pt.sourceKey)
    if (!map.has(key)) map.set(key, pt)
  }
  return [...map.values()]
}

function panelComparableKey(panel: LlmChartPanel): string {
  const cg = panel.comparableGroup ?? supplementaryComparableGroup(panel.unitKind)
  return `${panel.unitKind}::${cg}`
}

/** 同 unit_kind + comparable_group 的 comparison bar 才合并（禁止把主指标与扣款/比率混 panel） */
function consolidatePanelsByUnitKind(panels: LlmChartPanel[]): LlmChartPanel[] {
  const keep: LlmChartPanel[] = []
  const barByKey = new Map<string, LlmChartPanel[]>()
  const hbarByKey = new Map<string, LlmChartPanel[]>()

  for (const panel of panels) {
    if (panel.visualRole === 'composition' || panel.chartType === 'pie' || panel.chartType === 'gauge') {
      keep.push(panel)
      continue
    }
    const bucketKey = panelComparableKey(panel)
    if (panel.chartType === 'horizontal_bar') {
      const arr = hbarByKey.get(bucketKey) ?? []
      arr.push(panel)
      hbarByKey.set(bucketKey, arr)
      continue
    }
    if (panel.chartType === 'bar' || panel.chartType === 'line' || panel.chartType === 'stacked_bar') {
      const arr = barByKey.get(bucketKey) ?? []
      arr.push(panel)
      barByKey.set(bucketKey, arr)
      continue
    }
    keep.push(panel)
  }

  const mergeGroup = (
    group: LlmChartPanel[],
    uk: ChartUnitKind,
    chartType: ChartPanelType,
    comparableGroup: string
  ): LlmChartPanel => {
    const series = dedupeSeriesByLabel(group.flatMap((g) => g.series))
    return {
      panelTitle: group[0]?.panelTitle ?? panelTitleForUnitKind(uk),
      chartType,
      unitKind: uk,
      visualRole: 'comparison',
      comparableGroup,
      series
    }
  }

  const merged: LlmChartPanel[] = [...keep]
  for (const [key, group] of barByKey) {
    const uk = group[0]!.unitKind
    const cg = group[0]!.comparableGroup ?? supplementaryComparableGroup(uk)
    merged.push(group.length > 1 ? mergeGroup(group, uk, 'bar', cg) : group[0]!)
  }
  for (const [key, group] of hbarByKey) {
    const uk = group[0]!.unitKind
    const cg = group[0]!.comparableGroup ?? supplementaryComparableGroup(uk)
    merged.push(group.length > 1 ? mergeGroup(group, uk, 'horizontal_bar', cg) : group[0]!)
  }
  return merged
}

function consolidateSparseHorizontalPanels(panels: LlmChartPanel[]): LlmChartPanel[] {
  const rest: LlmChartPanel[] = []
  const singlesByKey = new Map<string, LlmChartPanel[]>()
  for (const panel of panels) {
    if (panel.chartType === 'horizontal_bar' && panel.series.length === 1) {
      const key = panelComparableKey(panel)
      const arr = singlesByKey.get(key) ?? []
      arr.push(panel)
      singlesByKey.set(key, arr)
    } else {
      rest.push(panel)
    }
  }
  const merged: LlmChartPanel[] = []
  for (const [key, group] of singlesByKey) {
    if (group.length >= 2) {
      const uk = group[0]!.unitKind
      const cg = group[0]!.comparableGroup ?? supplementaryComparableGroup(uk)
      merged.push({
        panelTitle: panelTitleForUnitKind(uk),
        chartType: 'horizontal_bar',
        unitKind: uk,
        visualRole: 'comparison',
        comparableGroup: cg,
        series: group.flatMap((g) => g.series)
      })
    } else {
      merged.push(...group)
    }
  }
  return [...rest, ...merged]
}

/** 图表专用三元组：facts 显式结余优先于 schema；不强制改写为 income−expense */
export function resolveChartAuthorityTriplet(payload: CodeAuthorityPayload): FinanceTriplet | null {
  const schema = tripletFromMonthlyFinanceData(payload.data)
  const factsTriplet = tripletFromExactFinanceFacts(filterChartableFacts(payload.facts))
  if (!schema && !factsTriplet) return null
  const income = schema?.income ?? factsTriplet!.income
  const expense = schema?.expense ?? factsTriplet!.expense
  let balance: number
  if (factsTriplet && Number.isFinite(factsTriplet.balance)) {
    balance = factsTriplet.balance
  } else if (schema && Number.isFinite(schema.balance)) {
    balance = schema.balance
  } else {
    balance = income - expense
  }
  return { income, expense, balance, source: 'chart_merged', incomeLabel: 'Code chart authority' }
}

/** 无 chart_plan 时：仅从 Code facts/data 确定性生成规划（同类合并，panel 数最少） */
export function buildChartPlanFromFactsStructural(payload: CodeAuthorityPayload): LlmChartPlan | null {
  const matrix = parseMatrixFromData(payload.data)
  if (matrix) {
    const title = String(payload.data?.chart_title ?? payload.data?.chartTitle ?? payload.answer ?? '热力图')
      .trim()
      .slice(0, 48)
    return buildChartPlanFromMatrix(matrix, title || '热力图')
  }

  const tabularRows = parseTabularRowsFromData(payload.data)
  if (tabularRows?.length) {
    const title = String(payload.data?.chart_title ?? payload.data?.chartTitle ?? payload.answer ?? '数据图表')
      .trim()
      .slice(0, 48)
    return buildChartPlanFromTabularRows(tabularRows, title || '数据图表')
  }

  const chartableFacts = filterChartableFacts(payload.facts)
  if (!chartableFacts.length) return null
  const triplet = resolveChartAuthorityTriplet(payload)

  let batchMax = 0
  for (const f of chartableFacts) {
    const c = coerceChartNumericValue(f.value, String(f.value ?? ''))
    if (c && c.value > batchMax) batchMax = c.value
  }
  if (triplet) {
    batchMax = Math.max(batchMax, triplet.income, triplet.expense, triplet.balance)
  }

  const currencySeries: LlmChartSeriesPoint[] = []
  const deductionSeries: LlmChartSeriesPoint[] = []
  const percentSeries: LlmChartSeriesPoint[] = []
  const ratioSeries: LlmChartSeriesPoint[] = []
  const countSeries: LlmChartSeriesPoint[] = []
  const otherSeries: LlmChartSeriesPoint[] = []

  const pushUnique = (arr: LlmChartSeriesPoint[], pt: LlmChartSeriesPoint) => {
    const key = tableRowKey(pt.label, pt.sourceKey)
    if (arr.some((x) => tableRowKey(x.label, x.sourceKey) === key)) return
    arr.push(pt)
  }

  if (triplet) {
    pushUnique(currencySeries, {
      label: '月收入',
      value: triplet.income,
      displayValue: formatChartNumber(triplet.income, 'currency'),
      sourceKey: 'income',
      unitKind: 'currency',
      comparableGroup: 'flow_main'
    })
    pushUnique(currencySeries, {
      label: '月支出',
      value: triplet.expense,
      displayValue: formatChartNumber(triplet.expense, 'currency'),
      sourceKey: 'expense',
      unitKind: 'currency',
      comparableGroup: 'flow_main'
    })
    pushUnique(currencySeries, {
      label: '月结余',
      value: triplet.balance,
      displayValue: formatChartNumber(triplet.balance, 'currency'),
      sourceKey: 'balance',
      unitKind: 'currency',
      comparableGroup: 'flow_main'
    })
  }

  for (const f of chartableFacts) {
    const coerced = coerceChartNumericValue(f.value, String(f.value ?? ''))
    if (!coerced) continue
    let uk = coerced.unitKind ?? inferUnitKindFromCoerce(f, coerced, batchMax)
    if (uk === 'other' && triplet && coerced.value > 1) uk = 'currency'
    if (triplet && uk === 'currency' && classifyTripletSeriesRole(factLabel(f) || f.key, f.key)) continue
    const pt: LlmChartSeriesPoint = {
      label: humanizeSeriesLabel(factLabel(f) || f.key, f.key),
      value: coerced.value,
      displayValue: coerced.displayValue ?? String(f.value ?? ''),
      sourceKey: f.key,
      unitKind: uk,
      comparableGroup:
        uk === 'currency' && triplet
          ? 'deductions_currency'
          : uk === 'currency'
            ? 'metrics_currency'
            : uk === 'percent'
              ? 'metrics_percent'
              : uk === 'ratio'
                ? 'metrics_ratio'
                : supplementaryComparableGroup(uk)
    }
    if (uk === 'currency' && triplet) pushUnique(deductionSeries, pt)
    else if (uk === 'currency') pushUnique(currencySeries, pt)
    else if (uk === 'percent') pushUnique(percentSeries, scaleFractionToPercentPoint(pt))
    else if (uk === 'ratio') pushUnique(ratioSeries, pt)
    else if (uk === 'count') pushUnique(countSeries, pt)
    else pushUnique(otherSeries, pt)
  }

  const panels: LlmChartPanel[] = []
  if (currencySeries.length) {
    panels.push({
      panelTitle: triplet ? '主指标对比' : panelTitleForUnitKind('currency'),
      chartType: 'bar',
      unitKind: 'currency',
      visualRole: 'comparison',
      comparableGroup: triplet ? 'flow_main' : 'metrics_currency',
      series: currencySeries
    })
  }
  if (deductionSeries.length) {
    panels.push({
      panelTitle: '扣款/附加项',
      chartType: 'bar',
      unitKind: 'currency',
      visualRole: 'comparison',
      comparableGroup: 'deductions_currency',
      series: deductionSeries
    })
  }
  if (percentSeries.length) {
    panels.push({
      panelTitle: panelTitleForUnitKind('percent'),
      chartType: 'horizontal_bar',
      unitKind: 'percent',
      visualRole: 'comparison',
      comparableGroup: 'metrics_percent',
      series: percentSeries
    })
  }
  if (ratioSeries.length) {
    panels.push({
      panelTitle: panelTitleForUnitKind('ratio'),
      chartType: 'horizontal_bar',
      unitKind: 'ratio',
      visualRole: 'comparison',
      comparableGroup: 'metrics_ratio',
      series: ratioSeries
    })
  }
  if (countSeries.length) {
    panels.push({
      panelTitle: panelTitleForUnitKind('count'),
      chartType: 'bar',
      unitKind: 'count',
      visualRole: 'comparison',
      comparableGroup: supplementaryComparableGroup('count'),
      series: countSeries
    })
  }
  if (otherSeries.length) {
    panels.push({
      panelTitle: panelTitleForUnitKind('other'),
      chartType: 'bar',
      unitKind: 'other',
      visualRole: 'comparison',
      comparableGroup: supplementaryComparableGroup('other'),
      series: otherSeries
    })
  }

  if (!panels.length) return null
  return normalizeChartPlan({
    chartTitle: String(payload.data?.chart_title ?? payload.data?.chartTitle ?? '计算结果概览').trim() || '计算结果概览',
    panels
  })
}

/** 结构层：仅当已是 percent 量纲且原文无 % 时，将 (0,1) 小数转为百分轴刻度 */
function scaleFractionToPercentPoint(pt: LlmChartSeriesPoint): LlmChartSeriesPoint {
  if (pt.unitKind !== 'percent') return pt
  let value = pt.value
  let displayValue = pt.displayValue ?? String(value)
  const rawHasPercent = displayValue.includes('%') || displayValue.includes('％')
  if (value > 0 && value < 1 && !rawHasPercent) {
    value = value * 100
    displayValue = formatChartNumber(value, 'percent')
  }
  return { ...pt, value, displayValue, unitKind: 'percent' as const }
}

/** 百分数：0~1 小数转为 0~100；ratio 保留 a:b 原文，禁止误标为 % */
function normalizePercentPoint(
  unitKind: ChartUnitKind,
  pt: LlmChartSeriesPoint
): { value: number; displayValue: string; label: string } {
  let value = pt.value
  let displayValue = pt.displayValue ? formatDisplayText(pt.displayValue, unitKind) : ''
  const label = humanizeSeriesLabel(pt.label, pt.sourceKey)
  if (unitKind === 'ratio') {
    if (!displayValue) displayValue = String(value)
    return { value, displayValue, label }
  }
  const isPercentLike = unitKind === 'percent' || displayValue.includes('%')
  if (isPercentLike) {
    // 仅 percent 量纲且原文无 % 时，将 (0,1) 小数转为 0~100 轴
    if (unitKind === 'percent' && value > 0 && value < 1 && !displayValue.includes('%')) {
      value = value * 100
    } else if (value > 0 && value <= 1 && !displayValue.includes('%') && displayValue.includes('％')) {
      value = value * 100
    }
    if (!displayValue || /^[\d.]+$/.test(displayValue.replace(/%/g, ''))) {
      displayValue = formatChartNumber(value, 'percent')
    }
  } else if (!displayValue) {
    displayValue = formatChartNumber(value, unitKind)
  }
  return { value, displayValue, label }
}

function normalizeSeriesPoint(pt: LlmChartSeriesPoint, panel: LlmChartPanel): LlmChartSeriesPoint {
  const unitKind = pt.unitKind ?? panel.unitKind
  const normalized = normalizePercentPoint(unitKind, pt)
  return {
    ...pt,
    label: normalized.label,
    value: normalized.value,
    displayValue: normalized.displayValue,
    unitKind,
    comparableGroup: pt.comparableGroup ?? panel.comparableGroup ?? supplementaryComparableGroup(unitKind)
  }
}

function normalizePanelSeries(panel: LlmChartPanel): LlmChartPanel {
  return { ...panel, series: panel.series.map((s) => normalizeSeriesPoint(s, panel)) }
}

function panelMetricKey(panel: LlmChartPanel): string {
  const pt = panel.series[0]
  if (!pt) return panel.panelTitle
  const norm = normalizePercentPoint(panel.unitKind, pt)
  const val = Math.round(norm.value * 100) / 100
  return `${norm.label.toLowerCase()}::${val}`
}

/** 结构层：同 panel 内数值跨度过大时拆成两个 bar（非领域规则，仅看数量级） */
function splitWideSpreadBarPanel(panel: LlmChartPanel): LlmChartPanel[] {
  if (panel.chartType !== 'bar' || panel.series.length < 4) return [panel]
  const vals = panel.series.map((s) => Math.abs(s.value)).filter((v) => v > 0)
  if (vals.length < 4) return [panel]
  const max = Math.max(...vals)
  const min = Math.min(...vals)
  if (max / min < 8) return [panel]
  const threshold = max * 0.35
  const major = panel.series.filter((s) => Math.abs(s.value) >= threshold)
  const minor = panel.series.filter((s) => Math.abs(s.value) < threshold)
  if (major.length < 2 || minor.length < 1) return [panel]
  return [
    { ...panel, panelTitle: `${panel.panelTitle}（主指标）`, series: major },
    { ...panel, panelTitle: `${panel.panelTitle}（次级指标）`, series: minor }
  ]
}

function dedupeGaugePanels(panels: LlmChartPanel[]): LlmChartPanel[] {
  const seen = new Set<string>()
  const out: LlmChartPanel[] = []
  for (const panel of panels) {
    if (panel.chartType !== 'gauge') {
      out.push(panel)
      continue
    }
    const key = panelMetricKey(panel)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(panel)
  }
  return out
}

/** 多个 gauge 改为横向对比，避免堆叠重叠 */
function consolidateGaugePanels(panels: LlmChartPanel[]): LlmChartPanel[] {
  const gauges = panels.filter((p) => p.chartType === 'gauge')
  const rest = panels.filter((p) => p.chartType !== 'gauge')
  if (gauges.length <= 1) return panels
  const uk = gauges[0]!.unitKind
  return [
    ...rest,
    {
      panelTitle: '关键指标对比',
      chartType: 'horizontal_bar',
      unitKind: uk,
      visualRole: 'comparison',
      comparableGroup: 'kpi_group',
      series: gauges.flatMap((g) => g.series.map((s) => normalizeSeriesPoint(s, g)))
    }
  ]
}

function buildGaugeSeriesItem(
  panel: LlmChartPanel,
  pt: LlmChartSeriesPoint,
  center: [string, string],
  radius: string
): Record<string, unknown> {
  const norm = normalizePercentPoint(panel.unitKind, pt)
  const max = gaugeMaxValue(panel, norm.value)
  return {
    type: 'gauge',
    min: 0,
    max,
    center,
    radius,
    startAngle: 90,
    endAngle: -270,
    splitNumber: 4,
    pointer: { show: false },
    progress: {
      show: true,
      overlap: false,
      roundCap: true,
      clip: false,
      width: 12,
      itemStyle: { color: '#60a5fa' }
    },
    axisLine: { lineStyle: { width: 12, color: [[1, 'rgba(148,163,184,0.18)']] } },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { show: false },
    detail: {
      valueAnimation: true,
      formatter: norm.displayValue,
      fontSize: 20,
      fontWeight: 700,
      color: '#f8fafc',
      offsetCenter: [0, 0]
    },
    title: { show: false },
    data: [{ value: norm.value, name: '' }]
  }
}

function buildBarPanelOption(panel: LlmChartPanel, layout: { top: number; height: number }, showTitle: boolean): Record<string, unknown> {
  const categories = panel.series.map((s) => humanizeSeriesLabel(s.label, s.sourceKey))
  const data = panel.series.map((s) => {
    const item: { value: number; label?: { show: boolean; position: string; formatter: string } } = { value: s.value }
    const fmt = s.displayValue ?? formatTooltipValue(panel.unitKind, s.value)
    item.label = { show: true, position: 'top', formatter: fmt }
    return item
  })
  const rotate = categories.some((c) => c.length > 5)
  const yName = panel.yAxisName || yAxisSuffix(panel.unitKind)
  return {
    ...(showTitle ? { title: { text: panel.panelTitle, top: layout.top - 28, left: 'center' } } : {}),
    grid: { left: 48, right: 24, top: layout.top, height: layout.height, containLabel: true },
    xAxis: {
      type: 'category',
      data: categories,
      gridIndex: 0,
      axisLabel: { interval: 0, rotate: rotate ? 20 : 0 }
    },
    yAxis: { type: 'value', name: yName, gridIndex: 0 },
    series: [{ type: 'bar', data, barMaxWidth: 56 }]
  }
}

function buildHorizontalBarPanelOption(panel: LlmChartPanel, layout: { top: number; height: number }, showTitle: boolean): Record<string, unknown> {
  const categories = panel.series.map((s) => s.label)
  const data = panel.series.map((s) => s.value)
  const isPercent = panel.unitKind === 'percent'
  const yName = panel.yAxisName || yAxisSuffix(panel.unitKind)
  return {
    ...(showTitle ? { title: { text: panel.panelTitle, top: layout.top - 28, left: 'center' } } : {}),
    grid: { left: 80, right: 48, top: layout.top, height: layout.height, bottom: 24, containLabel: true },
    xAxis: {
      type: 'value',
      name: yName,
      max: isPercent ? 100 : undefined,
      axisLabel: isPercent ? { formatter: '{value}%' } : undefined
    },
    yAxis: { type: 'category', data: categories },
    series: [
      {
        type: 'bar',
        data,
        barMaxWidth: 32,
        label: {
          show: true,
          position: 'right',
          formatter: (p: { dataIndex: number; value: number }) => {
            const pt = panel.series[p.dataIndex]
            return pt?.displayValue ?? formatTooltipValue(panel.unitKind, p.value)
          }
        }
      }
    ]
  }
}

function buildLinePanelOption(panel: LlmChartPanel, layout: { top: number; height: number }, showTitle: boolean): Record<string, unknown> {
  const yName = panel.yAxisName || yAxisSuffix(panel.unitKind)
  return {
    ...(showTitle ? { title: { text: panel.panelTitle, top: layout.top - 28, left: 'center' } } : {}),
    grid: { left: 48, right: 24, top: layout.top, height: layout.height, containLabel: true },
    xAxis: { type: 'category', data: panel.series.map((s) => s.label) },
    yAxis: { type: 'value', name: yName },
    series: [{ type: 'line', data: panel.series.map((s) => s.value), smooth: true }]
  }
}

function buildPiePanelOption(panel: LlmChartPanel, layout: { top: number; height: number }, showTitle: boolean): Record<string, unknown> {
  return {
    ...(showTitle ? { title: { text: panel.panelTitle, top: layout.top - 28, left: 'center' } } : {}),
    series: [
      {
        type: 'pie',
        radius: '45%',
        center: ['50%', layout.top + layout.height / 2],
        data: panel.series.map((s) => ({
          name: s.label,
          value: s.value,
          label: s.displayValue ? { formatter: `{b}: ${s.displayValue}` } : undefined
        }))
      }
    ]
  }
}

function buildGaugePanelOption(panel: LlmChartPanel, layout: { top: number; height: number }, showTitle: boolean): Record<string, unknown> {
  const pt = panel.series[0]!
  return {
    ...(showTitle ? { title: { text: panel.panelTitle, top: layout.top - 28, left: 'center' } } : {}),
    series: [buildGaugeSeriesItem(panel, pt, ['50%', '58%'], '52%')]
  }
}

function buildStackedBarPanelOption(panel: LlmChartPanel, layout: { top: number; height: number }, showTitle: boolean): Record<string, unknown> {
  const base = buildBarPanelOption(panel, layout, showTitle)
  const series = (base.series as Record<string, unknown>[]) ?? []
  if (series[0]) series[0] = { ...series[0], stack: 'total' }
  return base
}

function buildScatterPanelOption(panel: LlmChartPanel, layout: { top: number; height: number }, showTitle: boolean): Record<string, unknown> {
  const yName = panel.yAxisName || yAxisSuffix(panel.unitKind)
  const data = panel.series.map((s, i) => {
    const xNum = coerceFiniteNumber(s.label)
    return [xNum != null ? xNum : i + 1, s.value]
  })
  return {
    ...(showTitle ? { title: { text: panel.panelTitle, top: layout.top - 28, left: 'center' } } : {}),
    grid: { left: 48, right: 24, top: layout.top, height: layout.height, containLabel: true },
    xAxis: { type: 'value', name: panel.timeKey || 'X', scale: true },
    yAxis: { type: 'value', name: yName },
    series: [{ type: 'scatter', data, symbolSize: 10 }]
  }
}

function buildHeatmapPanelOption(
  panel: LlmChartPanel,
  layout: { top: number; height: number },
  showTitle: boolean,
  matrix?: { rows: string[]; cols: string[]; values: number[][] }
): Record<string, unknown> {
  const rows = matrix?.rows?.length ? matrix.rows : panel.series.map((s) => s.label)
  const cols = matrix?.cols?.length ? matrix.cols : ['值']
  const values = matrix?.values?.length
    ? matrix.values
    : panel.series.map((s) => [s.value])
  const flat: Array<[number, number, number]> = []
  for (let ri = 0; ri < rows.length; ri++) {
    const rowVals = values[ri] ?? []
    for (let ci = 0; ci < cols.length; ci++) {
      const v = Number(rowVals[ci])
      if (Number.isFinite(v)) flat.push([ci, ri, v])
    }
  }
  return {
    ...(showTitle ? { title: { text: panel.panelTitle, top: layout.top - 28, left: 'center' } } : {}),
    grid: { left: 80, right: 40, top: layout.top, height: layout.height, containLabel: true },
    xAxis: { type: 'category', data: cols, splitArea: { show: true } },
    yAxis: { type: 'category', data: rows, splitArea: { show: true } },
    visualMap: { min: 0, max: Math.max(...flat.map((t) => t[2]), 1), calculable: true, orient: 'horizontal', left: 'center', bottom: 0 },
    series: [{ type: 'heatmap', data: flat, label: { show: true } }]
  }
}

function buildRadarPanelOption(panel: LlmChartPanel, layout: { top: number; height: number }, showTitle: boolean): Record<string, unknown> {
  const indicators = panel.series.map((s) => ({
    name: s.label,
    max: Math.max(s.value * 1.25, s.value + 1, 1)
  }))
  return {
    ...(showTitle ? { title: { text: panel.panelTitle, top: layout.top - 28, left: 'center' } } : {}),
    radar: { indicator: indicators, center: ['50%', layout.top + layout.height / 2], radius: '58%' },
    series: [
      {
        type: 'radar',
        data: [{ value: panel.series.map((s) => s.value), name: panel.panelTitle }]
      }
    ]
  }
}

function buildComboPanelOption(panel: LlmChartPanel, layout: { top: number; height: number }, showTitle: boolean): Record<string, unknown> {
  const categories = panel.series.map((s) => s.label)
  const mid = Math.ceil(panel.series.length / 2)
  const barPts = panel.series.slice(0, mid)
  const linePts = panel.series.slice(mid)
  const yName = panel.yAxisName || yAxisSuffix(panel.unitKind)
  return {
    ...(showTitle ? { title: { text: panel.panelTitle, top: layout.top - 28, left: 'center' } } : {}),
    grid: { left: 48, right: 48, top: layout.top, height: layout.height, containLabel: true },
    xAxis: { type: 'category', data: categories },
    yAxis: [
      { type: 'value', name: yName },
      { type: 'value', name: yName, splitLine: { show: false } }
    ],
    series: [
      {
        type: 'bar',
        name: '柱',
        data: panel.series.map((s, i) => (i < mid ? s.value : null)),
        barMaxWidth: 40
      },
      {
        type: 'line',
        name: '线',
        yAxisIndex: 1,
        data: panel.series.map((s, i) => (i >= mid ? s.value : null)),
        smooth: true
      }
    ]
  }
}

function buildPanelOption(panel: LlmChartPanel, layout: { top: number; height: number }, showTitle: boolean): Record<string, unknown> {
  switch (panel.chartType) {
    case 'pie':
      return buildPiePanelOption(panel, layout, showTitle)
    case 'line':
      return buildLinePanelOption(panel, layout, showTitle)
    case 'gauge':
      return buildGaugePanelOption(panel, layout, showTitle)
    case 'horizontal_bar':
      return buildHorizontalBarPanelOption(panel, layout, showTitle)
    case 'stacked_bar':
      return buildStackedBarPanelOption(panel, layout, showTitle)
    case 'scatter':
      return buildScatterPanelOption(panel, layout, showTitle)
    case 'heatmap':
      return buildHeatmapPanelOption(panel, layout, showTitle)
    case 'radar':
      return buildRadarPanelOption(panel, layout, showTitle)
    case 'combo':
      return panel.series.length >= 3 ? buildComboPanelOption(panel, layout, showTitle) : buildBarPanelOption(panel, layout, showTitle)
    default:
      return buildBarPanelOption(panel, layout, showTitle)
  }
}

function gaugeMaxValue(panel: LlmChartPanel, val: number): number {
  if (panel.unitKind === 'percent' || panel.unitKind === 'ratio') return 100
  return Math.max(val * 1.5, val + 10, 1)
}

/** 多 panel 垂直堆叠：percent 布局 + 独立 gridIndex / axisIndex，避免 gauge 与 bar 重叠 */
function buildMultiPanelOption(panels: LlmChartPanel[], chartTitle: string): Record<string, unknown> {
  const n = panels.length
  const titles: Record<string, unknown>[] = [
    { text: chartTitle, left: 'center', top: 6, textStyle: { fontSize: 14, fontWeight: 600 } }
  ]
  const grids: Record<string, unknown>[] = []
  const xAxes: Record<string, unknown>[] = []
  const yAxes: Record<string, unknown>[] = []
  const series: Record<string, unknown>[] = []

  const topPad = 12
  const bottomPad = 3
  const gap = 3.5
  const usable = 100 - topPad - bottomPad - gap * (n - 1)
  const weights = panels.map((p) => (p.chartType === 'gauge' ? 1.35 : p.chartType === 'bar' ? 1.15 : 1))
  const weightSum = weights.reduce((a, b) => a + b, 0)

  panels.forEach((panel, i) => {
    const slotH = (usable * weights[i]!) / weightSum
    let slotTop = topPad
    for (let j = 0; j < i; j++) slotTop += (usable * weights[j]!) / weightSum + gap
    const slotCenter = slotTop + slotH / 2
    const subTitleTop = Math.max(2, slotTop - 1.2)
    titles.push({
      text: panel.panelTitle,
      left: 'center',
      top: `${subTitleTop}%`,
      textStyle: { fontSize: 11, color: '#94a3b8', fontWeight: 500 }
    })

    const yName = panel.yAxisName || yAxisSuffix(panel.unitKind)
    const gi = grids.length

    if (panel.chartType === 'bar' || panel.chartType === 'stacked_bar') {
      const categories = panel.series.map((s) => s.label)
      const data = panel.series.map((s) => {
        const fmt = s.displayValue ?? formatTooltipValue(panel.unitKind, s.value)
        return { value: s.value, label: { show: true, position: 'top', formatter: fmt } }
      })
      const rotate = categories.some((c) => c.length > 5)
      grids.push({
        left: '10%',
        right: '6%',
        top: `${slotTop + 5}%`,
        height: `${Math.max(slotH - 8, 14)}%`,
        containLabel: true
      })
      xAxes.push({
        type: 'category',
        data: categories,
        gridIndex: gi,
        axisLabel: { interval: 0, rotate: rotate ? 18 : 0, fontSize: 10 }
      })
      yAxes.push({ type: 'value', name: yName, gridIndex: gi, splitLine: { lineStyle: { opacity: 0.25 } } })
      series.push({
        type: 'bar',
        xAxisIndex: gi,
        yAxisIndex: gi,
        data,
        barMaxWidth: 40,
        ...(panel.chartType === 'stacked_bar' || panel.stack ? { stack: 'total' } : {})
      })
    } else if (panel.chartType === 'scatter') {
      grids.push({
        left: '10%',
        right: '6%',
        top: `${slotTop + 5}%`,
        height: `${Math.max(slotH - 8, 14)}%`,
        containLabel: true
      })
      xAxes.push({ type: 'value', name: panel.timeKey || 'X', gridIndex: gi, scale: true })
      yAxes.push({ type: 'value', name: yName, gridIndex: gi })
      series.push({
        type: 'scatter',
        xAxisIndex: gi,
        yAxisIndex: gi,
        data: panel.series.map((s, idx) => {
          const xNum = coerceFiniteNumber(s.label)
          return [xNum != null ? xNum : idx + 1, s.value]
        }),
        symbolSize: 8
      })
    } else if (panel.chartType === 'heatmap') {
      const rows = panel.series.map((s) => s.label)
      const flat: Array<[number, number, number]> = panel.series.map((s, ri) => [0, ri, s.value])
      grids.push({
        left: '12%',
        right: '8%',
        top: `${slotTop + 4}%`,
        height: `${Math.max(slotH - 6, 16)}%`,
        containLabel: true
      })
      xAxes.push({ type: 'category', data: ['值'], gridIndex: gi, splitArea: { show: true } })
      yAxes.push({ type: 'category', data: rows, gridIndex: gi, splitArea: { show: true } })
      series.push({ type: 'heatmap', xAxisIndex: gi, yAxisIndex: gi, data: flat, label: { show: true, fontSize: 9 } })
    } else if (panel.chartType === 'radar') {
      series.push({
        type: 'radar',
        center: ['50%', `${slotCenter}%`],
        radius: `${Math.min(slotH * 0.38, 24)}%`,
        data: [{ value: panel.series.map((s) => s.value), name: panel.panelTitle }],
        indicator: panel.series.map((s) => ({ name: s.label, max: Math.max(s.value * 1.25, 1) }))
      })
    } else if (panel.chartType === 'combo' && panel.series.length >= 3) {
      const categories = panel.series.map((s) => s.label)
      const mid = Math.ceil(panel.series.length / 2)
      grids.push({
        left: '10%',
        right: '10%',
        top: `${slotTop + 5}%`,
        height: `${Math.max(slotH - 8, 14)}%`,
        containLabel: true
      })
      xAxes.push({ type: 'category', data: categories, gridIndex: gi, axisLabel: { fontSize: 10 } })
      yAxes.push({ type: 'value', name: yName, gridIndex: gi })
      yAxes.push({ type: 'value', name: yName, gridIndex: gi, splitLine: { show: false } })
      series.push({
        type: 'bar',
        xAxisIndex: gi,
        yAxisIndex: gi,
        data: panel.series.map((s, idx) => (idx < mid ? s.value : null)),
        barMaxWidth: 36
      })
      series.push({
        type: 'line',
        xAxisIndex: gi,
        yAxisIndex: gi + 1,
        data: panel.series.map((s, idx) => (idx >= mid ? s.value : null)),
        smooth: true
      })
    } else if (panel.chartType === 'horizontal_bar') {
      const categories = panel.series.map((s) => s.label)
      const isPercent = panel.unitKind === 'percent'
      const isRatio = panel.unitKind === 'ratio'
      const maxVal = Math.max(...panel.series.map((s) => s.value), 1)
      grids.push({
        left: '14%',
        right: '10%',
        top: `${slotTop + 5}%`,
        height: `${Math.max(slotH - 8, 14)}%`,
        containLabel: true
      })
      xAxes.push({
        type: 'value',
        name: isRatio ? panel.yAxisName || '配比（分母）' : yName,
        gridIndex: gi,
        max: isPercent ? 100 : isRatio ? Math.ceil(maxVal * 1.25) : undefined,
        axisLabel: isPercent ? { formatter: '{value}%' } : undefined
      })
      yAxes.push({ type: 'category', data: categories, gridIndex: gi, axisLabel: { fontSize: 10 } })
      series.push({
        type: 'bar',
        xAxisIndex: gi,
        yAxisIndex: gi,
        data: panel.series.map((s) => s.value),
        barMaxWidth: 28,
        label: {
          show: true,
          position: 'right',
          formatter: (p: { dataIndex: number; value: number }) => {
            const pt = panel.series[p.dataIndex]
            return pt?.displayValue ?? formatTooltipValue(panel.unitKind, p.value)
          }
        }
      })
    } else if (panel.chartType === 'line') {
      grids.push({
        left: '10%',
        right: '6%',
        top: `${slotTop + 5}%`,
        height: `${Math.max(slotH - 8, 14)}%`,
        containLabel: true
      })
      xAxes.push({
        type: 'category',
        data: panel.series.map((s) => s.label),
        gridIndex: gi,
        axisLabel: { fontSize: 10 }
      })
      yAxes.push({ type: 'value', name: yName, gridIndex: gi, splitLine: { lineStyle: { opacity: 0.25 } } })
      series.push({
        type: 'line',
        xAxisIndex: gi,
        yAxisIndex: gi,
        data: panel.series.map((s) => s.value),
        smooth: true,
        symbolSize: 6
      })
    } else if (panel.chartType === 'pie') {
      series.push({
        type: 'pie',
        center: ['50%', `${slotCenter}%`],
        radius: `${Math.min(slotH * 0.38, 22)}%`,
        data: panel.series.map((s) => ({
          name: s.label,
          value: s.value,
          label: s.displayValue ? { formatter: `{b}: ${s.displayValue}` } : undefined
        }))
      })
    } else {
      const pt = panel.series[0]!
      const gaugeRadius = `${Math.min(Math.max(slotH * 0.32, 14), 24)}%`
      series.push(buildGaugeSeriesItem(panel, pt, ['50%', `${slotCenter}%`], gaugeRadius))
    }
  })

  const hasCartesian = grids.length > 0
  return {
    title: titles,
    tooltip: { trigger: hasCartesian ? 'axis' : 'item' },
    grid: grids.length ? grids : undefined,
    xAxis: xAxes.length === 1 ? xAxes[0] : xAxes.length ? xAxes : undefined,
    yAxis: yAxes.length === 1 ? yAxes[0] : yAxes.length ? yAxes : undefined,
    series,
    _layout: { panelCount: n, layoutMode: 'stacked' as const }
  }
}

function layoutForSinglePanel(panel: LlmChartPanel): { top: number; height: number } {
  const catN = panel.series.length
  if (panel.chartType === 'horizontal_bar') {
    return { top: 72, height: Math.max(180, catN * 56 + 48) }
  }
  if (panel.chartType === 'scatter' || panel.chartType === 'heatmap') {
    return { top: 64, height: Math.max(280, 260) }
  }
  if (panel.chartType === 'radar') {
    return { top: 48, height: 320 }
  }
  if (panel.chartType === 'combo' || panel.chartType === 'stacked_bar') {
    return { top: 56, height: Math.max(260, 240 + Math.max(0, catN - 4) * 24) }
  }
  if (panel.chartType === 'gauge') {
    return { top: 48, height: 220 }
  }
  if (panel.chartType === 'bar' || panel.chartType === 'line') {
    return { top: 56, height: Math.max(260, 240 + Math.max(0, catN - 4) * 24) }
  }
  return { top: 56, height: 320 }
}

function mergePanelOptions(panels: LlmChartPanel[], chartTitle: string): unknown {
  const n = panels.length
  if (n === 1) {
    const panel = panels[0]!
    const layout = layoutForSinglePanel(panel)
    const part = buildPanelOption(panel, layout, false)
    return {
      title: { text: chartTitle, subtext: panel.panelTitle !== chartTitle ? panel.panelTitle : undefined },
      tooltip: { trigger: panel.chartType === 'pie' || panel.chartType === 'gauge' ? 'item' : 'axis' },
      _layout: {
        panelCount: 1,
        layoutMode: 'single' as const,
        categoryCount: panel.series.length,
        primaryChartType: panel.chartType
      },
      ...part
    }
  }
  const built = buildMultiPanelOption(panels, chartTitle)
  const maxCats = Math.max(...panels.map((p) => p.series.length), 1)
  const primary = panels.find((p) => p.chartType === 'horizontal_bar')?.chartType ?? panels[0]?.chartType ?? 'bar'
  return {
    ...built,
    _layout: {
      panelCount: n,
      layoutMode: 'stacked' as const,
      categoryCount: maxCats,
      primaryChartType: primary
    }
  }
}

function buildEchartsOptionFromPlan(plan: LlmChartPlan): unknown {
  return mergePanelOptions(plan.panels, plan.chartTitle)
}

function factLabel(f: CodeFact): string {
  return String(f.label ?? f.key ?? '').trim()
}

function planCoversFact(plan: LlmChartPlan, fact: CodeFact): boolean {
  const key = String(fact.key ?? '').trim().toLowerCase()
  const label = factLabel(fact).toLowerCase()
  const keyTail = key.includes('.') ? key.split('.').pop()! : key
  for (const panel of plan.panels) {
    for (const s of panel.series) {
      const sk = String(s.sourceKey ?? '').trim().toLowerCase()
      const sl = humanizeSeriesLabel(s.label, s.sourceKey).toLowerCase()
      if (key && (sk === key || sk.endsWith(`.${keyTail}`))) return true
      if (label && (sl === label || sl === keyTail)) return true
    }
  }
  return false
}

function buildTableRowsFromFacts(facts: CodeFact[]): Array<{ label: string; value: string }> {
  return normalizeTableRows(
    facts
      .map((f) => {
        const label = humanizeSeriesLabel(factLabel(f) || String(f.key ?? ''), f.key)
        if (!label) return null
        return { label, value: formatFactTableValue(f) }
      })
      .filter(Boolean) as Array<{ label: string; value: string }>
  )
}

function mergeTableRows(
  primary: Array<{ label: string; value: string }> | undefined,
  facts: CodeFact[]
): Array<{ label: string; value: string }> {
  const normalizedPrimary = normalizeTableRows(
    (primary ?? []).map((r) => ({
      label: humanizeSeriesLabel(r.label, r.label),
      value: formatDisplayText(r.value) || r.value
    }))
  )
  return normalizeTableRows([...normalizedPrimary, ...buildTableRowsFromFacts(facts)])
}

function panelTitleForUnitKind(uk: ChartUnitKind): string {
  if (uk === 'ratio') return '配比指标'
  if (uk === 'currency') return '金额指标'
  if (uk === 'percent') return '比率指标'
  if (uk === 'count') return '数量指标'
  return '其他指标'
}

export type EnrichChartPlanOpts = {
  /** visualize 专用：只保留 chart_plan 内 series，不合并全部 facts */
  chartOnly?: boolean
}

/** 用 Code facts 补全 chart_plan 遗漏项（结构层，不猜领域语义） */
export function enrichChartPlanWithPayload(
  plan: LlmChartPlan,
  payload: CodeAuthorityPayload,
  opts?: EnrichChartPlanOpts
): LlmChartPlan {
  const synced = syncChartPlanWithAuthorityTriplet(plan, payload)
  if (opts?.chartOnly) {
    const tableRows = collectTableRowsFromPlan(synced)
    return normalizeChartPlan({ ...synced, tableRows }) ?? { ...synced, tableRows }
  }

  const chartableFacts = filterChartableFacts(payload.facts)
  const tableRows = mergeTableRows(synced.tableRows, chartableFacts)
  const panelsCopy = synced.panels.map((p) => ({ ...p, series: [...p.series] }))
  const missingByBucket = new Map<string, { uk: ChartUnitKind; cg: string; series: LlmChartSeriesPoint[] }>()

  let batchMax = 0
  for (const f of chartableFacts) {
    const c = coerceChartNumericValue(f.value, String(f.value ?? ''))
    if (c && c.value > batchMax) batchMax = c.value
  }

  for (const f of chartableFacts) {
    if (planCoversFact({ ...synced, panels: panelsCopy }, f)) continue
    const coerced = coerceChartNumericValue(f.value, String(f.value ?? ''))
    if (!coerced) continue
    const uk = coerced.unitKind ?? inferUnitKindFromCoerce(f, coerced, batchMax)
    const cg = supplementaryComparableGroup(uk)
    const bucketKey = `${uk}::${cg}`
    const pt: LlmChartSeriesPoint = {
      label: humanizeSeriesLabel(factLabel(f) || String(f.key ?? ''), f.key),
      value: coerced.value,
      displayValue: coerced.displayValue ?? String(f.value ?? ''),
      sourceKey: f.key,
      unitKind: uk,
      comparableGroup: cg
    }
    const bucket = missingByBucket.get(bucketKey) ?? { uk, cg, series: [] }
    bucket.series.push(pt)
    missingByBucket.set(bucketKey, bucket)
  }

  const extraPanels: LlmChartPanel[] = []
  for (const { uk, cg, series } of missingByBucket.values()) {
    if (!series.length) continue
    const host = panelsCopy.find(
      (p) =>
        p.unitKind === uk &&
        p.visualRole !== 'composition' &&
        p.chartType !== 'pie' &&
        p.chartType !== 'gauge' &&
        (p.chartType === 'bar' || p.chartType === 'horizontal_bar')
    )
    if (host) {
      host.series = dedupeSeriesByLabel([...host.series, ...series])
      continue
    }
    extraPanels.push({
      panelTitle: panelTitleForUnitKind(uk),
      chartType: uk === 'ratio' ? 'horizontal_bar' : uk === 'percent' ? 'horizontal_bar' : 'bar',
      unitKind: uk,
      visualRole: 'comparison',
      comparableGroup: cg,
      series
    })
  }

  const merged: LlmChartPlan = {
    ...synced,
    tableRows,
    panels: [...panelsCopy, ...extraPanels]
  }
  return normalizeChartPlan(merged) ?? merged
}

function seriesNumericValuesFromList(series: unknown[]): number[] {
  const out: number[] = []
  for (const s of series) {
    const row = s as { data?: unknown[] }
    const data = Array.isArray(row?.data) ? row.data : []
    for (const d of data) {
      const n =
        typeof d === 'number'
          ? d
          : typeof d === 'object' && d != null
            ? coerceFiniteNumber((d as { value?: unknown }).value)
            : coerceFiniteNumber(d)
      if (n != null) out.push(Math.abs(n))
    }
  }
  return out
}

function seriesNumericValues(option: unknown): number[] {
  const o = option as { series?: unknown | unknown[] }
  const series = Array.isArray(o?.series) ? o.series : o?.series ? [o.series] : []
  return seriesNumericValuesFromList(series)
}

/** 按 grid / 独立 gauge|pie 拆分 series，避免 stacked 多 panel 被误判为同图混量纲 */
function groupSeriesForScaleCheck(option: unknown): unknown[][] {
  const o = option as {
    series?: unknown | unknown[]
    grid?: unknown | unknown[]
    _layout?: { layoutMode?: string; panelCount?: number }
  }
  const series = Array.isArray(o.series) ? o.series : o.series ? [o.series] : []
  if (!series.length) return []

  const layout = o._layout
  const grids = Array.isArray(o.grid) ? o.grid : o.grid ? [o.grid] : []
  const stackedMulti =
    layout?.layoutMode === 'stacked' && Number(layout?.panelCount ?? 0) > 1 && series.length > 1

  if (stackedMulti) {
    const byGrid = new Map<number, unknown[]>()
    series.forEach((s, idx) => {
      const row = s as { gridIndex?: number; xAxisIndex?: number; type?: string }
      const t = String(row.type ?? '')
      const gi =
        row.gridIndex ?? row.xAxisIndex ?? (t === 'gauge' || t === 'pie' ? 10_000 + idx : 0)
      const arr = byGrid.get(gi) ?? []
      arr.push(s)
      byGrid.set(gi, arr)
    })
    if (byGrid.size > 1 || grids.length > 1) return [...byGrid.values()]
  }

  return [series]
}

/** 同一 panel 内：多命名 series 且数量级悬殊，或单 series 内数据跨量级 */
function seriesGroupHasMixedScales(series: unknown[]): boolean {
  if (!series.length) return false
  const nums = seriesNumericValuesFromList(series)
  if (nums.length < 2) return false

  const names = new Set(
    series.map((s) => String((s as { name?: unknown }).name ?? '').trim()).filter(Boolean)
  )
  const max = Math.max(...nums)
  const min = Math.min(...nums.filter((n) => n > 0))
  if (!min || !max) return false
  const wideSpan = max >= 50 && min <= max / 20
  if (!wideSpan) return false
  if (series.length >= 2 && names.size >= 2) return true
  return series.length === 1 || wideSpan
}

/** 结构层：内嵌 ECharts 是否把不可比量纲塞进同一 panel（多 panel 垂直堆叠不算混用） */
export function embeddedChartHasMixedScales(option: unknown): boolean {
  if (!option || typeof option !== 'object') return false
  const groups = groupSeriesForScaleCheck(option)
  return groups.some((g) => seriesGroupHasMixedScales(g))
}

function collectTableRowsFromPlan(plan: LlmChartPlan): Array<{ label: string; value: string }> {
  if (plan.tableRows?.length) return normalizeTableRows(plan.tableRows)
  const rows: Array<{ label: string; value: string }> = []
  for (const panel of plan.panels) {
    for (const s of panel.series) {
      rows.push({
        label: humanizeSeriesLabel(s.label, s.sourceKey),
        value: s.displayValue ?? formatTooltipValue(panel.unitKind, s.value, s.displayValue)
      })
    }
  }
  return normalizeTableRows(rows)
}

export type AssembleVisualizeOpts = {
  /** 默认 true：visualize 只输出图表及 chart series 对应的数据表 */
  chartOnly?: boolean
}

/** 将启发模型图表规划组装为带 ECHARTS / TABLE 的 visualize Markdown（visualize Agent 只生图） */
export function assembleVisualizeFromChartPlan(
  plan: LlmChartPlan,
  banner = '',
  payload?: CodeAuthorityPayload,
  opts?: AssembleVisualizeOpts
): string {
  const chartOnly = opts?.chartOnly ?? true
  const enriched = payload
    ? enrichChartPlanWithPayload(plan, payload, { chartOnly })
    : plan
  const normalized = normalizeChartPlan(enriched)
  if (!normalized?.panels.length) return ''
  // 禁止把 snake_case / 字段名原样写进面向用户的图与表
  if (!chartPlanHasUserFacingLabels(normalized)) return ''
  const prefix = banner ? `${banner}\n\n` : ''
  const option = buildEchartsOptionFromPlan(normalized)
  const tableRows = collectTableRowsFromPlan(normalized)
  const table = factsMarkdownTable(
    tableRows.map((r) => ({ label: r.label, value: r.value })),
    '项目',
    '数值'
  )
  return [
    `${prefix}## 可视化`,
    '',
    '<!--ECHARTS_OPTION-->',
    JSON.stringify(option, null, 2),
    '<!--/ECHARTS_OPTION-->',
    '',
    '<!--TABLE_DATA-->',
    table,
    '<!--/TABLE_DATA-->'
  ].join('\n')
}

/** Code 内已含 echarts_option 时确定性包装（不跑启发模型） */
export function codePayloadSupportsDeterministicVisualize(payload: CodeAuthorityPayload): boolean {
  return readEmbeddedChartOption(payload.data) != null
}

export function buildVisualizeFromEmbeddedChart(payload: CodeAuthorityPayload, banner = ''): string | null {
  const embedded = readEmbeddedChartOption(payload.data)
  if (!embedded) return null
  const prefix = banner ? `${banner}\n\n` : ''
  const embeddedPlan = readChartPlanFromData(payload.data)
  const table = embeddedPlan
    ? factsMarkdownTable(
        collectTableRowsFromPlan(embeddedPlan).map((r) => ({ label: r.label, value: r.value })),
        '项目',
        '数值'
      )
    : ''
  return [
    `${prefix}## 可视化`,
    '',
    '<!--ECHARTS_OPTION-->',
    JSON.stringify(embedded, null, 2),
    '<!--/ECHARTS_OPTION-->',
    ...(table
      ? [
          '',
          '<!--TABLE_DATA-->',
          table,
          '<!--/TABLE_DATA-->'
        ]
      : [])
  ].join('\n')
}

/** @deprecated 仅兼容旧调用；visualize 请走 assembleVisualizeFromChartPlan 或 buildVisualizeFromEmbeddedChart */
export function buildDeterministicVisualizeFromCode(
  payload: CodeAuthorityPayload,
  banner = '',
  _question = ''
): string | null {
  return buildVisualizeFromEmbeddedChart(payload, banner)
}

export function buildDeterministicReportFromCode(
  payload: CodeAuthorityPayload,
  banner = ''
): string {
  const prefix = banner ? `${banner.trim()}\n\n` : ''
  const displayFacts = payload.facts.filter((f) => !isStructuralMetadataFactKey(String(f.key ?? '')))
  const body = formatFactsAsDeepSeekReply({
    facts: displayFacts.map((f) => ({ key: f.key, value: f.value, source: f.source })),
    answer: payload.answer.length >= 12 ? payload.answer : undefined,
    sourceHint: 'Code'
  })
  const tableFacts = displayFacts.length > 10 ? displayFacts.slice(0, 10) : displayFacts
  const table = factsMarkdownTable(tableFacts, '项目', '数值')
  const tableNote =
    displayFacts.length > 10 ? `\n\n> 表格仅展示前 10 项，共 ${displayFacts.length} 项。` : ''
  return `${prefix}${body}\n\n### 数据明细\n${table}${tableNote}`
}

function seriesNumbers(option: unknown): number[] {
  const o = option as { series?: unknown | unknown[] }
  const series = Array.isArray(o?.series) ? o.series : o?.series ? [o.series] : []
  const out: number[] = []
  for (const s of series) {
    const row = s as { data?: unknown[] }
    const data = Array.isArray(row?.data) ? row.data : []
    for (const d of data) {
      const n =
        typeof d === 'number'
          ? d
          : typeof d === 'object' && d != null
            ? coerceFiniteNumber((d as { value?: unknown }).value)
            : null
      if (n != null) out.push(n)
    }
  }
  return out
}

function numbersMismatch(a: number[], b: number[], tolerance = 1): boolean {
  if (!a.length || !b.length) return false
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (Math.abs(a[i]! - b[i]!) > tolerance) return true
  }
  return a.length !== b.length
}

/** 结构层：当前 visualize 是否与 Code 确定性规划一致（code_authority 路径也必须校验） */
function assessCanonicalChartPlanMismatch(
  payload: CodeAuthorityPayload,
  vizText: string
): CodeDownstreamConsistencyResult {
  const vizBody = extractTaggedBlockBody(vizText, 'ECHARTS_OPTION')
  if (!vizBody) return { pass: true }
  let vizOption: unknown
  try {
    vizOption = JSON.parse(vizBody)
  } catch {
    return { pass: true }
  }
  if (embeddedChartHasMixedScales(vizOption)) {
    return {
      pass: false,
      reason: '图表同一 panel 混用不可比量纲（如金额与比率/小数）',
      retryIntent: 'visualize'
    }
  }
  const expectedPlan = normalizeChartPlan(
    readChartPlanFromData(payload.data) ?? buildChartPlanFromFactsStructural(payload)
  )
  if (!expectedPlan?.panels.length) return { pass: true }
  const expectedMd = assembleVisualizeFromChartPlan(expectedPlan, '', undefined, { chartOnly: true })
  const expectedBody = extractTaggedBlockBody(expectedMd, 'ECHARTS_OPTION')
  if (!expectedBody) return { pass: true }
  try {
    const expectedOption = JSON.parse(expectedBody)
    const expNums = seriesNumbers(expectedOption).sort((x, y) => y - x)
    const vizNums = seriesNumbers(vizOption).sort((x, y) => y - x)
    if (!expNums.length || !vizNums.length) return { pass: true }
    if (numbersMismatch(expNums, vizNums, 0.5)) {
      return {
        pass: false,
        reason: '图表 series 数值与 Code 结构化规划不一致，须按 Code facts/data 重组装',
        retryIntent: 'visualize'
      }
    }
  } catch {
    return { pass: true }
  }
  return { pass: true }
}

function assessRatioMislabeledAsPercent(
  payload: CodeAuthorityPayload,
  texts: string[]
): CodeDownstreamConsistencyResult {
  const combined = texts.filter(Boolean).join('\n')
  if (!combined.trim()) return { pass: true }

  for (const f of payload.facts) {
    const raw = String(f.value ?? '')
    const coerced = coerceChartNumericValue(f.value, raw)
    if (!coerced || coerced.unitKind !== 'ratio') continue
    const canonical = coerced.displayValue ?? raw
    if (!canonical || canonical.includes('%')) continue
    const label = humanizeSeriesLabel(String(f.label ?? f.key ?? ''), f.key)
    if (!label) continue
    const mislabeled = formatChartNumber(coerced.value, 'percent')
    if (!mislabeled.includes('%')) continue
    for (const line of combined.split('\n')) {
      if (!line.includes('|')) continue
      const lower = line.toLowerCase()
      if (!lower.includes(label.toLowerCase())) continue
      if (line.includes(mislabeled) && !line.includes(canonical)) {
        return {
          pass: false,
          reason: `表格将配比 ${canonical} 误标为 ${mislabeled}，须保留配比原文`,
          retryIntent: 'visualize'
        }
      }
    }
  }
  return { pass: true }
}

/** 结构层：下游图表数字是否与 Code 内嵌 chart 冲突（LLM 规划路径由 LLM 审计补充） */
export function assessCodeDownstreamConsistencyStructural(params: {
  results?: Record<string, unknown>
  final?: string
  extractPayload?: ExtractPayloadFn
  evidence?: Array<{ kind?: string; mode?: string }>
}): CodeDownstreamConsistencyResult {
  const financeGate = assessCodeFinanceConsistencyStructural({
    final: params.final,
    results: params.results,
    extractPayload: params.extractPayload
  })
  if (!financeGate.pass) return financeGate

  const results = params.results && typeof params.results === 'object' ? params.results : {}
  const payload = resolveCodeAuthorityPayload(results, params.extractPayload)
  if (!payload) return { pass: true }

  const vizText = String(results.visualize ?? '').trim()
  const reportText = String(results.report ?? '').trim()
  const finalText = String(params.final ?? '').trim()
  const ratioGate = assessRatioMislabeledAsPercent(payload, [vizText, reportText, finalText])
  if (!ratioGate.pass) return ratioGate

  if (reportText) {
    const skipOrphan = shouldSkipStructuralOrphanAudit(results)
    const extraAllowed = skipOrphan
      ? undefined
      : collectUpstreamEvidenceNumbers(results, params.extractPayload)
    const reportGate = assessReportOutputStructural(payload, reportText, {
      skipOrphanAudit: skipOrphan,
      extraAllowed
    })
    if (!reportGate.pass) return reportGate
  }

  if (!shouldSkipStructuralOrphanAudit(results)) {
    const extraAllowed = collectUpstreamEvidenceNumbers(results, params.extractPayload)
    const orphanTexts = [vizText, reportText].filter(Boolean)
    if (orphanTexts.length) {
      const orphanGate = assessDownstreamOrphanNumbers(payload, orphanTexts, { extraAllowed })
      if (!orphanGate.pass) return orphanGate
    }
  }

  const evidence = Array.isArray(params.evidence) ? params.evidence : []
  const vizFromCodeAuthority = evidence.some(
    (e) =>
      String(e?.kind ?? '') === 'visualize' &&
      (String(e?.mode ?? '') === 'code_authority_deterministic' ||
        String(e?.mode ?? '') === 'code_authority_llm')
  )

  if (!vizText && !finalText && !vizFromCodeAuthority) return { pass: true }

  // code_authority 路径：与 Code 确定性规划比对（不能只信内嵌 echarts_option）
  if (vizFromCodeAuthority) {
    const canonical = assessCanonicalChartPlanMismatch(payload, vizText)
    if (!canonical.pass) return canonical

    const codeChart = readEmbeddedChartOption(payload.data)
    if (!codeChart) return { pass: true }
    const codeNums = seriesNumbers(codeChart)
    const vizChartBody = extractTaggedBlockBody(vizText, 'ECHARTS_OPTION')
    if (vizChartBody && codeNums.length) {
      try {
        const vizOption = JSON.parse(vizChartBody)
        const vizNums = seriesNumbers(vizOption)
        if (vizNums.length && numbersMismatch(codeNums, vizNums)) {
          return {
            pass: false,
            reason: '图表 series 数值与 Code 内嵌 echarts_option 不一致',
            retryIntent: 'visualize'
          }
        }
      } catch {
        /* ignore */
      }
    }
    return { pass: true }
  }

  return { pass: true }
}

/** 结构归一化：保证 JSON 可解析；收支柱图结余按 income−expense 校正 */
export function normalizeCodeOutputStructural(
  codeRaw: string,
  extractPayload?: ExtractPayloadFn
): string {
  const txt = String(codeRaw ?? '').trim()
  if (!txt.startsWith('{')) return txt
  const obj = parseJsonObject(txt)
  if (!obj) return txt
  if (extractPayload) {
    const parsed = extractPayload(txt)
    if (Array.isArray(parsed.facts) && !Array.isArray(obj.facts)) obj.facts = parsed.facts
    if (parsed.data && typeof parsed.data === 'object') obj.data = parsed.data
    if (parsed.answer && !obj.answer) obj.answer = parsed.answer
  }
  const serialized = JSON.stringify(obj)
  return normalizeCodeFinanceOutputStructural(serialized, extractPayload)
}
