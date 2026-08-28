/**
 * Cursor 式 Generative UI：LLM 决定 replyTier + 模块组合；代码只渲染，不再硬编码「有 visualize 就上图」。
 */
import { z } from 'zod'
import { parseCleanPayload } from './cleanPayload'

export const REPLY_TIERS = ['lite', 'standard', 'report'] as const
export type PresentationReplyTier = (typeof REPLY_TIERS)[number]

export const PRESENTATION_MODULE_TYPES = [
  'prose',
  'headline',
  'metrics',
  'chart',
  'table',
  'report_appendix',
  'sources',
  'suggestions',
  'actions'
] as const
export type PresentationModuleType = (typeof PRESENTATION_MODULE_TYPES)[number]

export const PresentationModuleSchema = z.object({
  type: z.enum(PRESENTATION_MODULE_TYPES),
  collapsed: z.boolean().optional(),
  maxItems: z.number().int().min(1).max(40).optional()
})

export const PresentationPlanSchema = z.object({
  replyTier: z.enum(REPLY_TIERS),
  modules: z.array(PresentationModuleSchema).min(1).max(12),
  suggestions: z.array(z.string().max(140)).max(4).default([]),
  proseStyle: z.enum(['conversational', 'analytical', 'confirm']).default('conversational'),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(480).default(''),
  source: z.enum(['llm', 'structural_fallback']).optional()
})

export type PresentationPlan = z.infer<typeof PresentationPlanSchema>
export type PresentationModule = z.infer<typeof PresentationModuleSchema>

export const AVAILABLE_ARTIFACT_KINDS = [
  'db_result',
  'rag_result',
  'crawler_sources',
  'clean_facts',
  'visualize_chart',
  'visualize_table',
  'report_draft',
  'admin_action',
  'gui_preview',
  'code_facts',
  'media'
] as const
export type AvailableArtifactKind = (typeof AVAILABLE_ARTIFACT_KINDS)[number]

export type AvailableArtifact = {
  kind: AvailableArtifactKind
  label: string
  rowCount?: number
  hasRenderableChart?: boolean
}

export type OrchestrationThicknessHint = 'memory_capture' | 'single_source' | 'complex'

const ECHARTS_TAG_RE = /<!--\s*ECHARTS_OPTION\s*-->/i
const TABLE_TAG_RE = /<!--\s*TABLE_DATA\s*-->/i
const REPORT_TAG_RE = /<!--\s*REPORT\s*-->/i

export const PRESENTATION_PLAN_CONFIDENCE_GATE = 0.42

export function presentationPlanFromMeta(meta: unknown): PresentationPlan | null {
  const raw = (meta as { presentationPlan?: unknown } | null)?.presentationPlan
  const parsed = PresentationPlanSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function planHasModule(
  plan: PresentationPlan | null | undefined,
  type: PresentationModuleType
): boolean {
  if (!plan) return false
  return plan.modules.some((m) => m.type === type)
}

export function isPresentationPlanActive(plan: PresentationPlan | null | undefined): boolean {
  return Boolean(plan && Number(plan.confidence) >= PRESENTATION_PLAN_CONFIDENCE_GATE)
}

export function resolveEffectiveReplyTier(
  plan: PresentationPlan | null | undefined,
  structuralFallback: PresentationReplyTier
): PresentationReplyTier {
  if (isPresentationPlanActive(plan)) return plan!.replyTier
  return structuralFallback
}

export type PresentationModuleSlots = {
  metrics?: unknown[]
  chart?: unknown
  table?: unknown
}

export function applyPresentationToSlots<T extends PresentationModuleSlots>(
  slots: T,
  plan: PresentationPlan | null | undefined
): T {
  if (!isPresentationPlanActive(plan)) return slots
  const out = { ...slots }
  if (!planHasModule(plan, 'metrics')) delete out.metrics
  if (!planHasModule(plan, 'chart')) delete out.chart
  if (!planHasModule(plan, 'table')) delete out.table
  return out
}

export function shouldIncludeReportAppendix(
  plan: PresentationPlan | null | undefined,
  replyTier: PresentationReplyTier
): boolean {
  if (replyTier !== 'report') return false
  if (!isPresentationPlanActive(plan)) return true
  return planHasModule(plan, 'report_appendix')
}

export function shouldShowHeadline(
  plan: PresentationPlan | null | undefined,
  replyTier: PresentationReplyTier
): boolean {
  if (replyTier === 'lite') return false
  if (isPresentationPlanActive(plan)) return planHasModule(plan, 'headline')
  return true
}

export function shouldShowSources(plan: PresentationPlan | null | undefined): boolean {
  if (!isPresentationPlanActive(plan)) return true
  return planHasModule(plan, 'sources')
}

export function shouldShowDbDataBlock(plan: PresentationPlan | null | undefined): boolean {
  if (!isPresentationPlanActive(plan)) return true
  return planHasModule(plan, 'table')
}

export function formatPresentationPlanForSynth(plan: PresentationPlan): string {
  const modules = plan.modules
    .map((m) => {
      let s = m.type
      if (m.collapsed) s += '(折叠)'
      if (m.maxItems) s += `[≤${m.maxItems}]`
      return s
    })
    .join(', ')
  return [
    '【展示计划·必守】像 Cursor：正文与面板分工——下列模块由系统单独渲染，你专注 prose。',
    `档位：${plan.replyTier}；文体：${plan.proseStyle}`,
    `模块：${modules}`,
    planHasModule(plan, 'chart')
      ? '正文对图表含义 ≤2 句；数字勿与图表/指标重复。'
      : '本轮不展示图表；禁止写「见下图/图表如下」。',
    planHasModule(plan, 'table')
      ? '明细表由系统渲染；正文只解读要点，勿重复整张表或宽表列。'
      : '本轮不展示数据表；禁止在正文铺 ORM 宽表。',
    planHasModule(plan, 'metrics')
      ? '关键指标由系统 KPI 条展示；正文勿逐条重复同一数字。'
      : '',
    planHasModule(plan, 'suggestions')
      ? '可接着问的方向由系统 suggestions 芯片展示；正文末段勿写「你还可以问…」套话。'
      : '可按档位在末段写 1～2 句自然拓展（与主题相关）。',
    planHasModule(plan, 'headline') ? '首段开门见山；headline 由系统从首句提取。' : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function countDbRows(evidence?: unknown[]): number {
  for (const ev of Array.isArray(evidence) ? evidence : []) {
    if (String((ev as { kind?: string })?.kind || '') !== 'db') continue
    const rows = (ev as { agentResult?: { structured?: { rows?: unknown[] } } })?.agentResult?.structured
      ?.rows
    if (Array.isArray(rows)) return rows.length
  }
  return 0
}

/** 从专家结果结构枚举可用 artifacts（不读用户原话） */
export function buildAvailableArtifacts(input: {
  results?: Record<string, unknown>
  evidence?: unknown[]
  meta?: Record<string, unknown>
  planSteps?: Array<{ agent?: string }>
}): AvailableArtifact[] {
  const bag = input.results && typeof input.results === 'object' ? input.results : {}
  const out: AvailableArtifact[] = []
  const dbText = String(bag.db ?? '').trim()
  if (dbText.length >= 8) {
    out.push({
      kind: 'db_result',
      label: '数据库查询结果',
      rowCount: countDbRows(input.evidence) || undefined
    })
  }
  const ragText = String(bag.rag ?? '').trim()
  if (ragText.length >= 8) out.push({ kind: 'rag_result', label: '知识库检索结果' })
  const crawlerText = String(bag.crawler ?? '').trim()
  if (crawlerText.length >= 8) out.push({ kind: 'crawler_sources', label: '联网来源列表' })
  const cleanRaw = String(bag.clean ?? '').trim()
  if (cleanRaw) {
    const clean = parseCleanPayload(cleanRaw)
    if (clean?.facts?.length) {
      out.push({ kind: 'clean_facts', label: `清洗指标(${clean.facts.length})` })
    }
  }
  const vizText = String(bag.visualize ?? '').trim()
  if (vizText) {
    if (ECHARTS_TAG_RE.test(vizText)) {
      out.push({ kind: 'visualize_chart', label: 'ECharts 图表', hasRenderableChart: true })
    }
    if (TABLE_TAG_RE.test(vizText)) out.push({ kind: 'visualize_table', label: '可视化数据表' })
  }
  const reportText = String(bag.report ?? '').trim()
  if (reportText.length >= 16 || REPORT_TAG_RE.test(reportText)) {
    out.push({ kind: 'report_draft', label: '报告草稿' })
  }
  if (String(bag.admin ?? '').trim()) out.push({ kind: 'admin_action', label: 'Admin 写操作回执' })
  if (String(bag.gui ?? '').trim()) out.push({ kind: 'gui_preview', label: 'GUI 操作预览' })
  const codeRaw = String(bag.code ?? '').trim()
  if (codeRaw.startsWith('{')) {
    try {
      const obj = JSON.parse(codeRaw) as { facts?: unknown[] }
      if (Array.isArray(obj.facts) && obj.facts.length) {
        out.push({ kind: 'code_facts', label: `计算指标(${obj.facts.length})` })
      }
    } catch {
      /* ignore */
    }
  }
  if (String(bag.multimodal ?? bag.music ?? bag.video ?? '').trim()) {
    out.push({ kind: 'media', label: '媒体输出' })
  }
  return out
}

function artifactKinds(artifacts: AvailableArtifact[]): Set<AvailableArtifactKind> {
  return new Set(artifacts.map((a) => a.kind))
}

/** LLM 不可用时的最小兜底（保守 prose，不复制旧硬编码全量 widget 规则） */
export function assembleStructuralPresentationFallback(input: {
  thickness: OrchestrationThicknessHint
  artifacts: AvailableArtifact[]
}): PresentationPlan {
  const kinds = artifactKinds(input.artifacts)
  if (input.thickness === 'memory_capture') {
    return {
      replyTier: 'lite',
      modules: [{ type: 'prose' }],
      suggestions: [],
      proseStyle: 'confirm',
      confidence: 0.35,
      rationale: 'memory_capture structural fallback',
      source: 'structural_fallback'
    }
  }
  if (input.thickness === 'single_source') {
    const modules: PresentationModule[] = [{ type: 'prose' }]
    if (kinds.has('db_result')) modules.push({ type: 'table', collapsed: true, maxItems: 20 })
    if (kinds.has('rag_result') || kinds.has('crawler_sources')) modules.push({ type: 'sources' })
    return {
      replyTier: 'standard',
      modules,
      suggestions: [],
      proseStyle: 'conversational',
      confidence: 0.35,
      rationale: 'single_source structural fallback',
      source: 'structural_fallback'
    }
  }
  const modules: PresentationModule[] = [{ type: 'prose' }, { type: 'headline' }]
  if (kinds.has('clean_facts') || kinds.has('code_facts')) modules.push({ type: 'metrics', maxItems: 8 })
  if (kinds.has('visualize_chart')) modules.push({ type: 'chart' })
  if (kinds.has('visualize_table') || kinds.has('db_result')) {
    modules.push({ type: 'table', collapsed: false })
  }
  if (kinds.has('report_draft')) modules.push({ type: 'report_appendix', collapsed: true })
  if (kinds.has('rag_result') || kinds.has('crawler_sources')) modules.push({ type: 'sources' })
  modules.push({ type: 'suggestions' })
  return {
    replyTier: 'report',
    modules,
    suggestions: [],
    proseStyle: 'analytical',
    confidence: 0.35,
    rationale: 'complex structural fallback',
    source: 'structural_fallback'
  }
}

export function formatArtifactsForPresentationLlm(artifacts: AvailableArtifact[]): string {
  if (!artifacts.length) return '（暂无结构化专家产物，仅 prose）'
  return artifacts
    .map((a) => {
      const parts = [a.kind, a.label]
      if (a.rowCount != null) parts.push(`rows=${a.rowCount}`)
      if (a.hasRenderableChart) parts.push('chart=ready')
      return `- ${parts.join(' · ')}`
    })
    .join('\n')
}
