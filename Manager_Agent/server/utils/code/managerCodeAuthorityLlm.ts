import { z } from 'zod'
import type { ChatOpenAI } from '@langchain/openai'
import { createManagerChatOpenAI } from '../chat/managerChatOpenAI'
import { safeJsonParse } from '../../graph/core/shared/llmJson'
import { readAgentLlmJsonMaxTokens } from '#agent-shared/agentLlmSpeed'
import type { CodeAuthorityPayload, CodeDownstreamConsistencyResult, LlmChartPlan } from '#agent-shared/codeAuthorityPayload'
import {
  assembleVisualizeFromChartPlan,
  hasEchartsOptionBlock,
  enrichChartPlanWithPayload,
  coerceChartNumericValue,
  normalizeChartPlan,
  readChartPlanFromData,
  syncChartPlanWithAuthorityTriplet,
  buildChartPlanFromFactsStructural,
  filterChartableFacts,
  inferUnitKindFromCoerce
} from '#agent-shared/codeAuthorityPayload'
import { CODE_AUTHORITY_RULE } from '#agent-shared/codeFirstAuthority'
import { chartPlanLanguageRule, reportPlanLanguageRule } from '#agent-shared/taskLanguage'
import type { ReportPlan } from '#agent-shared/reportPlan'

const EnrichSchema = z.object({
  should_normalize: z.boolean(),
  answer: z.string().optional(),
  facts: z
    .array(
      z.object({
        key: z.string(),
        value: z.union([z.string(), z.number(), z.boolean()]),
        label: z.string().optional()
      })
    )
    .optional(),
  data: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional()
})

const SeriesPointSchema = z.object({
  label: z.string(),
  value: z.union([z.number(), z.string()]),
  display_value: z.string().optional(),
  source_key: z.string().optional(),
  unit_kind: z.enum(['currency', 'percent', 'count', 'ratio', 'index', 'duration', 'other']).optional(),
  comparable_group: z.string().optional()
})

const CHART_TYPE_ENUM = [
  'bar',
  'line',
  'pie',
  'gauge',
  'horizontal_bar',
  'stacked_bar',
  'scatter',
  'heatmap',
  'radar',
  'combo'
] as const

const ChartPanelSchema = z.object({
  panel_title: z.string(),
  chart_type: z.enum(CHART_TYPE_ENUM).optional(),
  visual_role: z.enum(['comparison', 'composition', 'trend', 'kpi', 'distribution']).optional(),
  unit_kind: z.enum(['currency', 'percent', 'count', 'ratio', 'index', 'duration', 'other']).optional(),
  comparable_group: z.string().optional(),
  y_axis_name: z.string().optional(),
  time_key: z.string().optional(),
  group_by: z.string().optional(),
  stack: z.boolean().optional(),
  dual_axis: z.boolean().optional(),
  series: z.array(SeriesPointSchema).min(1)
})

const ChartPlanSchema = z.object({
  chart_title: z.string(),
  chart_note: z.string().optional(),
  panels: z.array(ChartPanelSchema).min(1).optional(),
  chart_type: z.enum(CHART_TYPE_ENUM).optional(),
  visual_role: z.enum(['comparison', 'composition', 'trend', 'kpi', 'distribution']).optional(),
  unit_kind: z.enum(['currency', 'percent', 'count', 'ratio', 'index', 'duration', 'other']).optional(),
  comparable_group: z.string().optional(),
  y_axis_name: z.string().optional(),
  series: z.array(SeriesPointSchema).min(2).optional(),
  table_rows: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  confidence: z.number().min(0).max(1).optional()
})

const ReportFindingSchema = z.object({
  claim: z.string(),
  evidence_keys: z.array(z.string()).min(1),
  display_values: z.array(z.string()).optional()
})

const ReportPlanSchema = z.object({
  title: z.string(),
  executive_summary: z.array(z.string()).min(1),
  key_findings: z.array(ReportFindingSchema).min(1),
  risks: z.array(z.object({ text: z.string(), because: z.string().optional() })).optional(),
  recommendations: z
    .array(z.object({ action: z.string(), priority: z.enum(['high', 'normal']).optional() }))
    .optional(),
  appendix_table: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  confidence: z.number().min(0).max(1).optional()
})

const DownstreamSchema = z.object({
  markdown: z.string(),
  confidence: z.number().min(0).max(1).optional()
})

const ConsistencySchema = z.object({
  pass: z.boolean(),
  reason: z.string().optional(),
  retry_intent: z.enum(['code', 'visualize', 'report']).optional(),
  synth_only: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional()
})

export type DownstreamKind = 'visualize' | 'report'

export function isCodeAuthorityLlmEnabled(): boolean {
  return String(process.env.MANAGER_CODE_AUTHORITY_LLM ?? process.env.MANAGER_CODE_FINANCE_LLM ?? '1').trim() !== '0'
}

/** P3-3：Code 后处理预填 chart_plan（默认开） */
export function isCodePrefillChartPlanEnabled(): boolean {
  return String(process.env.MANAGER_CODE_PREFILL_CHART_PLAN ?? '1').trim() !== '0'
}

/** visualize：结构层 chart_plan 优先，LLM 仅作语义规划兜底（与 clean 对齐） */
export function isVisualizeStructuralFirstEnabled(): boolean {
  return String(process.env.MANAGER_VISUALIZE_STRUCTURAL_FIRST ?? '1').trim() !== '0'
}

export function createCodeAuthorityLlmModel(input: {
  openaiApiKey?: string
  openaiBaseUrl?: string
  modelName?: string
}): ChatOpenAI | null {
  const apiKey = String(input.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '').trim()
  if (!apiKey) return null
  const model = String(
    input.modelName ?? process.env.MANAGER_MODEL_LOW_COST ?? process.env.MANAGER_MODEL_ROUTE ?? 'qwen-flash-2025-07-28'
  ).trim()
  const baseURL = String(input.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? '').trim() || undefined
  return createManagerChatOpenAI({
    apiKey,
    openaiBaseUrl: baseURL,
    modelName: model,
    temperature: 0,
    skipThinking: true,
    maxTokens: readAgentLlmJsonMaxTokens()
  })
}

function mergeEnrichedCodeJson(baseRaw: string, patch: z.infer<typeof EnrichSchema>): string | null {
  const obj = safeJsonParse(baseRaw) as Record<string, unknown> | null
  if (!obj || typeof obj !== 'object') return null
  if (!patch.should_normalize) return null
  if (patch.answer) obj.answer = patch.answer
  if (Array.isArray(patch.facts)) obj.facts = patch.facts
  if (patch.data && typeof patch.data === 'object') {
    obj.data = { ...(obj.data as Record<string, unknown> | undefined), ...patch.data }
  }
  return JSON.stringify(obj)
}

/** 启发模型：校正 Code JSON，便于下游图表/报告直接消费 */
export async function enrichCodeOutputByLlm(model: ChatOpenAI | null, codeRaw: string): Promise<string | null> {
  if (!model || !isCodeAuthorityLlmEnabled()) return null
  const txt = String(codeRaw ?? '').trim()
  if (!txt.startsWith('{')) return null
  try {
    const res = await model.invoke([
      [
        'system',
        [
          '你是 Code 计算输出归一化器。输入为 Code Agent 的 JSON（answer/facts/data）。',
          '任务：',
          '- 保证 answer 与 facts/data 数字一致、可复述',
          '- 若适合图表：可在 data 中补充 echarts_option（ECharts JSON）或 chart_series，数字必须来自 facts',
          '- 用户任务涉及可视化时：为 data.chart_plan 输出 panels（含 visual_role、unit_kind、comparable_group、series）；默认应尝试预填（≥2 个 chartable facts 时）',
          '- 仅**同一 comparable_group 且同一 unit_kind** 的指标可共 panel；不可比须拆 panel',
          '- visual_role 驱动 chart_type：composition→pie；trend→line；kpi→gauge；comparison→bar/horizontal_bar',
          '- series 可带点级 unit_kind / comparable_group；禁止引入输入中不存在的数字',
          '- 过滤 facts 中的噪声：HTML/URL/爬虫片段/元数据/纯数字键/过长 prose，不得进入 facts 或 chart',
          '- 英文 snake_case 键须补 label（与用户任务同语言），禁止原样展示 net_savings 等',
          '- 比率/百分数（含 savings_rate）unit_kind=percent，禁止与 currency 同 panel',
          '- data.ratios 放占比；data.monthly_finance 放金额三元组；扣款子项用 composition/pie',
          '- table_rows 仅含 chart panels 中展示的指标，不含噪声 fact',
          '- 子项数值是合计的主要部分（如 510 属于 560）须用 composition/pie 或拆 panel，禁止并列 bar 双计',
          '- 已自洽则 should_normalize=false',
          '- 若任务含 flow 型金额三元组（收入/支出/结余或同类 primary/secondary/delta）：写入 data.numeric_triplet 或兼容 data.monthly_finance；delta 须等于 primary−secondary',
          CODE_AUTHORITY_RULE,
          'schema: {"should_normalize":boolean,"answer":string|omit,"facts":[{"key":string,"value":string|number|boolean,"label":string}]|omit,"data":object|omit,"confidence":number}'
        ].join('\n')
      ],
      ['human', txt.slice(0, 6000)]
    ])
    const parsed = EnrichSchema.safeParse(safeJsonParse(String(res.content ?? '').trim()))
    if (!parsed.success || Number(parsed.data.confidence ?? 0) < 0.5) return null
    return mergeEnrichedCodeJson(txt, parsed.data)
  } catch {
    return null
  }
}

/** 启发模型：从 Code facts 规划图表（选组/标签/数值，禁止混量纲） */
export async function planChartFromCodeByLlm(
  model: ChatOpenAI | null,
  payload: CodeAuthorityPayload,
  question: string,
  opts?: { retryReason?: string }
): Promise<LlmChartPlan | null> {
  if (!model || !isCodeAuthorityLlmEnabled()) return null
  const retryNote = String(opts?.retryReason ?? '').trim()
  const langRule = chartPlanLanguageRule(question)
  try {
    const res = await model.invoke([
      [
        'system',
        [
          '你是通用数据可视化规划器。输入为用户任务与 Code 的 answer/facts/data。',
          langRule,
          retryNote ? `【重规划】上次图表不可渲染，原因：${retryNote.slice(0, 200)}。请调整 panels/series 确保至少 1 个 panel 含 ≥2 个有效数值点。` : '',
          '任务（领域无关，适用于任意 Code 计算结果）：',
          '- 先判断每个 fact 的**量纲 unit_kind**与**可比组 comparable_group**（同组才可共轴）',
          '- 不可比指标（不同 unit_kind 或不同 comparable_group）必须拆成多个 panels',
          '- 为每项给出 label、value、display_value（含单位原文）、source_key；必要时在 series 点级标注 unit_kind/comparable_group',
          '- 为每个 panel 指定 visual_role，并据此选 chart_type：',
          '  · composition（部分-整体/占比）→ pie',
          '  · trend（时序/阶段变化）→ line（可设 time_key 标注时间轴语义）',
          '  · kpi（单一关键指标/得分/比率）→ gauge',
          '  · comparison（同类对照）→ bar 或 horizontal_bar',
          '  · distribution（分布/频次/矩阵）→ bar、heatmap 或 scatter',
          '- 可选 chart_type：stacked_bar（需 stack=true）、scatter、heatmap、radar、combo（dual_axis=true 时 bar+line 双轴）',
          '- group_by 表示分组维度（如 region、category）；time_key 表示时序轴语义（如 month、quarter）',
          '- value 必须来自 Code facts，禁止编造；禁止为单一 bug 场景写死分组',
          '- 排除噪声 fact（URL/HTML/403/作者日期/纯数字键/长 prose）；只选可量化指标入图',
          '- label 使用与用户任务一致的语言，禁止展示 raw snake_case key',
          '- 比率/百分数 unit_kind=percent，与 currency 分 panel；禁止把 savings_rate 等放进金额柱图',
          '- table_rows 仅列出 chart panels 中的 series，不含未入图 fact',
          '- 配比字符串（a:b 如 1:3、1:6）：unit_kind=ratio，value=冒号后数字，display_value 保留原文；用 horizontal_bar，禁止与 currency 同图',
          '- 禁止输出 ECharts grouped bar 把 ratio 与 currency 作为两个 series 共轴',
          '- 至少 1 个有效 panel；无法绘图则 confidence<0.5',
          CODE_AUTHORITY_RULE,
          '只输出 JSON schema:',
          '{"chart_title":string,"chart_note":string,',
          '"panels":[{"panel_title":string,',
          '"visual_role":"comparison"|"composition"|"trend"|"kpi"|"distribution",',
          '"chart_type":"bar"|"line"|"pie"|"gauge"|"horizontal_bar"|"stacked_bar"|"scatter"|"heatmap"|"radar"|"combo",',
          '"unit_kind":"currency"|"percent"|"count"|"ratio"|"index"|"duration"|"other",',
          '"comparable_group":string,"y_axis_name":string,"time_key":string,"group_by":string,"stack":boolean,"dual_axis":boolean,',
          '"series":[{"label":string,"value":number,"display_value":string,"source_key":string,',
          '"unit_kind":string,"comparable_group":string}]}],',
          '"table_rows":[{"label":string,"value":string}],"confidence":number}'
        ].join('\n')
      ],
      [
        'human',
        [
          `用户任务：${String(question ?? '').slice(0, 500)}`,
          `Code answer：${payload.answer.slice(0, 1200)}`,
          `Code facts：${JSON.stringify(payload.facts.slice(0, 32))}`,
          payload.data && Object.keys(payload.data).length
            ? `Code data：${JSON.stringify(payload.data).slice(0, 1200)}`
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      ]
    ])
    const parsed = ChartPlanSchema.safeParse(safeJsonParse(String(res.content ?? '').trim()))
    if (!parsed.success || Number(parsed.data.confidence ?? 0) < 0.5) return null
    const p = parsed.data

    let batchMax = 0
    for (const f of filterChartableFacts(payload.facts)) {
      const c = coerceChartNumericValue(f.value, String(f.value ?? ''))
      if (c && c.value > batchMax) batchMax = c.value
    }

    const mapSeries = (items: z.infer<typeof SeriesPointSchema>[], maxVal = batchMax) =>
      items
        .map((s) => {
          const coerced = coerceChartNumericValue(s.value, s.display_value)
          if (!coerced) return null
          const factLike = { key: s.source_key ?? s.label, value: s.value }
          return {
            label: String(s.label).trim(),
            value: coerced.value,
            displayValue: coerced.displayValue ?? s.display_value,
            sourceKey: s.source_key,
            unitKind: s.unit_kind ?? coerced.unitKind ?? inferUnitKindFromCoerce(factLike, coerced, maxVal),
            comparableGroup: s.comparable_group
          }
        })
        .filter(Boolean) as Array<{
        label: string
        value: number
        displayValue?: string
        sourceKey?: string
        unitKind?: z.infer<typeof SeriesPointSchema>['unit_kind']
        comparableGroup?: string
      }>

    let raw: LlmChartPlan
    if (p.panels?.length) {
      raw = {
        chartTitle: String(p.chart_title || '计算结果概览').trim() || '计算结果概览',
        chartNote: p.chart_note,
        panels: p.panels.map((panel) => ({
          panelTitle: String(panel.panel_title || '图表').trim() || '图表',
          chartType: panel.chart_type ?? 'bar',
          visualRole: panel.visual_role,
          unitKind: panel.unit_kind ?? 'other',
          comparableGroup: panel.comparable_group,
          yAxisName: panel.y_axis_name,
          timeKey: panel.time_key,
          groupBy: panel.group_by,
          stack: panel.stack,
          dualAxis: panel.dual_axis,
          series: mapSeries(panel.series)
        })),
        tableRows: p.table_rows?.map((r) => ({ label: r.label, value: r.value }))
      }
    } else if (p.series?.length) {
      raw = {
        chartTitle: String(p.chart_title || '计算结果概览').trim() || '计算结果概览',
        chartNote: p.chart_note,
        panels: [
          {
            panelTitle: String(p.chart_title || '计算结果概览').trim() || '计算结果概览',
            chartType: p.chart_type ?? 'bar',
            visualRole: p.visual_role,
            unitKind: p.unit_kind ?? 'other',
            comparableGroup: p.comparable_group,
            yAxisName: p.y_axis_name,
            timeKey: p.time_key,
            groupBy: p.group_by,
            stack: p.stack,
            dualAxis: p.dual_axis,
            series: mapSeries(p.series)
          }
        ],
        tableRows: p.table_rows?.map((r) => ({ label: r.label, value: r.value }))
      }
    } else {
      return null
    }
    return normalizeChartPlan(raw)
  } catch {
    return null
  }
}

/** 启发模型生成 visualize：只规划 chart_plan，ECharts 由结构层组装 */
export async function generateVisualizeFromCodeByLlm(
  model: ChatOpenAI | null,
  payload: CodeAuthorityPayload,
  question: string,
  banner = ''
): Promise<string | null> {
  const embeddedPlan = readChartPlanFromData(payload.data)
  if (embeddedPlan?.panels.length) {
    const synced = syncChartPlanWithAuthorityTriplet(embeddedPlan, payload)
    const enriched = enrichChartPlanWithPayload(synced, payload, { chartOnly: true })
    const out = assembleVisualizeFromChartPlan(enriched, banner, undefined, { chartOnly: true })
    if (hasEchartsOptionBlock(out)) return out
  }

  const plan = await planChartFromCodeByLlm(model, payload, question)
  if (plan?.panels.length) {
    const enriched = enrichChartPlanWithPayload(plan, payload, { chartOnly: true })
    const out = assembleVisualizeFromChartPlan(enriched, banner, undefined, { chartOnly: true })
    if (hasEchartsOptionBlock(out)) return out
  }

  const structural = buildChartPlanFromFactsStructural(payload)
  if (structural?.panels.length) {
    const enriched = enrichChartPlanWithPayload(structural, payload, { chartOnly: true })
    const out = assembleVisualizeFromChartPlan(enriched, banner, undefined, { chartOnly: true })
    if (hasEchartsOptionBlock(out)) return out
  }

  return null
}

/** 启发模型：从 Code facts 规划报告（对称 chart_plan；禁止直写完整 markdown） */
export async function planReportFromCodeByLlm(
  model: ChatOpenAI | null,
  payload: CodeAuthorityPayload,
  question: string
): Promise<ReportPlan | null> {
  if (!model || !isCodeAuthorityLlmEnabled()) return null
  if (!payload.facts.length) return null
  const langRule = reportPlanLanguageRule(question)
  try {
    const res = await model.invoke([
      [
        'system',
        [
          '你是通用数据分析报告规划器。输入为用户任务与 Code 的 answer/facts/data。',
          langRule,
          '只输出 JSON 规划（ReportPlan），禁止输出完整 markdown 正文。',
          '- executive_summary：1–4 条核心结论，数字须能在 Code facts 中找到',
          '- key_findings：每条 claim 必须附 evidence_keys（fact key 列表，须与 Code facts.key 一致）',
          '- display_values 可选，展示原文（如 1:3、16.67%）',
          '- risks / recommendations 可选；无依据时 confidence<0.5',
          '- appendix_table 仅列 chart/report 引用的指标，禁止 dump 全部 facts',
          CODE_AUTHORITY_RULE,
          'schema:',
          '{"title":string,"executive_summary":[string],',
          '"key_findings":[{"claim":string,"evidence_keys":[string],"display_values":[string]}],',
          '"risks":[{"text":string,"because":string}],"recommendations":[{"action":string,"priority":"high"|"normal"}],',
          '"appendix_table":[{"label":string,"value":string}],"confidence":number}'
        ].join('\n')
      ],
      [
        'human',
        [
          `用户任务：${String(question ?? '').slice(0, 500)}`,
          `Code answer：${payload.answer.slice(0, 1200)}`,
          `Code facts：${JSON.stringify(payload.facts.slice(0, 32))}`,
          payload.data && Object.keys(payload.data).length
            ? `Code data：${JSON.stringify(payload.data).slice(0, 1200)}`
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      ]
    ])
    const parsed = ReportPlanSchema.safeParse(safeJsonParse(String(res.content ?? '').trim()))
    if (!parsed.success || Number(parsed.data.confidence ?? 0) < 0.5) return null
    const p = parsed.data
    return {
      title: String(p.title || '分析报告').trim() || '分析报告',
      executive_summary: p.executive_summary.map((s) => String(s).trim()).filter(Boolean),
      key_findings: p.key_findings.map((f) => ({
        claim: String(f.claim).trim(),
        evidence_keys: f.evidence_keys.map((k) => String(k).trim()).filter(Boolean),
        display_values: f.display_values?.map((v) => String(v).trim()).filter(Boolean)
      })),
      risks: (p.risks ?? []).map((r) => ({
        text: String(r.text).trim(),
        because: r.because ? String(r.because).trim() : undefined
      })),
      recommendations: (p.recommendations ?? []).map((r) => ({
        action: String(r.action).trim(),
        priority: r.priority
      })),
      appendix_table: p.appendix_table?.map((r) => ({
        label: String(r.label).trim(),
        value: String(r.value).trim()
      })),
      confidence: p.confidence
    }
  } catch {
    return null
  }
}

/** 有 Code 但无法确定性渲染时：由启发模型仅依据 Code 生成 visualize/report Markdown */
export async function generateDownstreamFromCodeByLlm(
  model: ChatOpenAI | null,
  kind: DownstreamKind,
  payload: CodeAuthorityPayload,
  question: string,
  banner = ''
): Promise<string | null> {
  if (!model || !isCodeAuthorityLlmEnabled()) return null
  const role =
    kind === 'visualize'
      ? [
          '可视化 Agent：只输出图表，必须含 <!--ECHARTS_OPTION-->...<!--/ECHARTS_OPTION--> 完整 ECharts JSON。',
          '可选 <!--TABLE_DATA-->，但表格仅含 chart series 中的指标，禁止 dump 全部 facts。',
          '同一 panel 只展示同一 comparable_group + unit_kind；不可比指标须分 panel。',
          'visual_role 决定 chart_type（composition→pie, trend→line, kpi→gauge 等）。',
          'ECharts 数字必须来自 Code；禁止把百分数/比率与金额混在同一柱图。'
        ].join('')
      : [
          '报告 Agent：输出分析结论与 <!--REPORT--> 块（可选），数字必须来自 Code',
          '配比字符串（a:b 如 1:3）须保留原文或写分母人数，禁止误标为百分数'
        ].join(' ')
  try {
    const res = await model.invoke([
      [
        'system',
        [
          role,
          CODE_AUTHORITY_RULE,
          '- 禁止引用 Code 以外的数字',
          '- visualize 必须含合法 ECharts JSON，且 markdown 字段内必须含 <!--ECHARTS_OPTION-->...<!--/ECHARTS_OPTION-->',
          '- 图表 series 须与用户任务相关且量纲一致，数字全部来自 Code facts',
          'schema: {"markdown":string,"confidence":number}'
        ].join('\n')
      ],
      [
        'human',
        [
          `用户任务：${String(question ?? '').slice(0, 400)}`,
          `Code answer：${payload.answer.slice(0, 1200)}`,
          `Code facts：${JSON.stringify(payload.facts.slice(0, 20))}`,
          payload.data && Object.keys(payload.data).length
            ? `Code data：${JSON.stringify(payload.data).slice(0, 1500)}`
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      ]
    ])
    const parsed = DownstreamSchema.safeParse(safeJsonParse(String(res.content ?? '').trim()))
    if (!parsed.success || Number(parsed.data.confidence ?? 0) < 0.5) return null
    const md = String(parsed.data.markdown ?? '').trim()
    if (md.length < 40) return null
    if (kind === 'visualize' && !hasEchartsOptionBlock(md)) return null
    return banner && kind === 'visualize' ? `${banner}\n\n${md}` : md
  } catch {
    return null
  }
}

/** 启发模型：审计 final/visualize/report 是否与 Code 权威一致 */
export async function assessCodeDownstreamConsistencyByLlm(
  model: ChatOpenAI | null,
  input: {
    payload: CodeAuthorityPayload
    final?: string
    visualize?: string
    report?: string
    upstreamSummary?: string
    agentSummaries?: string
    multiSource?: boolean
  }
): Promise<CodeDownstreamConsistencyResult | null> {
  if (!model || !isCodeAuthorityLlmEnabled()) return null
  const finalText = String(input.final ?? '').trim().slice(0, 3000)
  const vizText = String(input.visualize ?? '').trim().slice(0, 3000)
  const reportText = String(input.report ?? '').trim().slice(0, 3000)
  if (!finalText && !vizText && !reportText) return null
  const multiSource = Boolean(input.multiSource)
  try {
    const res = await model.invoke([
      [
        'system',
        [
          '你是 Code 权威数据一致性审计员。',
          multiSource
            ? [
                '本任务含多数据源（DB/爬虫/RAG/admin 等）。正文/报告可同时引用 Code facts、上游合并事实与各子 Agent 摘要；',
                'admin 工具返回的天气/地图/日程等视为合法上游，不得以「Code facts 未列出」判 fail；',
                '基于上游已出现数字的合理推算（如 9×800=7200）允许；措辞性解读不算捏造；',
                '仅当数字与 Code 计算结果矛盾、或完全不在任何子 Agent 摘要/上游事实/Code 中时判 fail。',
                'report 步骤 defer 到 Synth 时：只审计 ECHARTS_OPTION/REPORT 块内数字；对话正文不因引用 admin/DB 合法数据而 fail。'
              ].join('')
            : 'Code 的 answer/facts/data 为图表/报告块数字来源；对话正文可概括表述，但 ECharts/REPORT 块数字须与 Code 一致。',
          '若仅正文措辞问题：synth_only=true，retry_intent=code。',
          '若图表/表格数字错误：retry_intent=visualize。',
          '若报告块错误：retry_intent=report。',
          'schema: {"pass":boolean,"reason":string,"retry_intent":"code"|"visualize"|"report"|omit,"synth_only":boolean,"confidence":number}'
        ].join('\n')
      ],
      [
        'human',
        [
          `Code answer：${input.payload.answer.slice(0, 1000)}`,
          `Code facts：${JSON.stringify(input.payload.facts.slice(0, 20))}`,
          input.upstreamSummary ? `上游摘要：${input.upstreamSummary.slice(0, 1200)}` : '',
          input.agentSummaries ? `子 Agent 输出摘要：\n${input.agentSummaries.slice(0, 2800)}` : '',
          finalText ? `拟回复：${finalText}` : '',
          vizText ? `visualize：${vizText}` : '',
          reportText ? `report：${reportText}` : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      ]
    ])
    const parsed = ConsistencySchema.safeParse(safeJsonParse(String(res.content ?? '').trim()))
    if (!parsed.success || Number(parsed.data.confidence ?? 0) < 0.5) return null
    return {
      pass: parsed.data.pass,
      reason: parsed.data.reason,
      retryIntent: parsed.data.retry_intent,
      synthOnly: Boolean(parsed.data.synth_only)
    }
  } catch {
    return null
  }
}
