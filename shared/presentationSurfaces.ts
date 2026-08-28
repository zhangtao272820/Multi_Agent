/**
 * Presentation Plan → 渲染面（inline / artifact_panel）与 Artifact 描述符。
 * 结构推导，不读用户原话。
 */
import type { PresentationModule, PresentationPlan, PresentationModuleType } from './presentationPlan'
import { isPresentationPlanActive, planHasModule } from './presentationPlan'

export type PresentationSurface = 'inline' | 'artifact_panel'

export type ReplyArtifactKind = 'chart' | 'table' | 'report'

export type ReplyArtifactSlot = {
  id: string
  kind: ReplyArtifactKind
  title: string
  surface: PresentationSurface
  collapsed?: boolean
}

export type PresentationRenderItem = {
  type: PresentationModuleType
  surface: PresentationSurface
  collapsed?: boolean
  maxItems?: number
}

const ARTIFACT_MODULE_KIND: Partial<Record<PresentationModuleType, ReplyArtifactKind>> = {
  chart: 'chart',
  table: 'table',
  report_appendix: 'report'
}

/** 模块默认渲染面：report 档重型 widget 进 Artifact 面板（Cursor Canvas 风） */
export function resolveModuleSurface(
  module: PresentationModule,
  plan: PresentationPlan
): PresentationSurface {
  const type = module.type
  if (type === 'prose' || type === 'headline' || type === 'metrics' || type === 'suggestions' || type === 'actions' || type === 'sources') {
    return 'inline'
  }
  if (plan.replyTier === 'lite') return 'inline'
  if (plan.replyTier === 'standard') {
    if (type === 'report_appendix') return 'artifact_panel'
    if ((type === 'chart' || type === 'table') && module.collapsed) return 'artifact_panel'
    return 'inline'
  }
  if (['chart', 'table', 'report_appendix'].includes(type)) return 'artifact_panel'
  return 'inline'
}

export function buildPresentationRenderPlan(plan: PresentationPlan | null | undefined): PresentationRenderItem[] {
  if (!plan || !isPresentationPlanActive(plan)) return []
  return plan.modules.map((m) => ({
    type: m.type,
    surface: resolveModuleSurface(m, plan),
    collapsed: m.collapsed,
    maxItems: m.maxItems
  }))
}

export function moduleSurfaceForPlan(
  plan: PresentationPlan | null | undefined,
  type: PresentationModuleType
): PresentationSurface | null {
  if (!plan || !isPresentationPlanActive(plan)) return null
  const mod = plan.modules.find((m) => m.type === type)
  if (!mod) return null
  return resolveModuleSurface(mod, plan)
}

export function shouldRenderModuleInline(
  plan: PresentationPlan | null | undefined,
  type: PresentationModuleType
): boolean {
  if (!plan || !isPresentationPlanActive(plan)) return true
  if (!planHasModule(plan, type)) return false
  return moduleSurfaceForPlan(plan, type) === 'inline'
}

export function shouldRenderModuleInArtifactPanel(
  plan: PresentationPlan | null | undefined,
  type: PresentationModuleType
): boolean {
  if (!plan || !isPresentationPlanActive(plan)) return false
  if (!planHasModule(plan, type)) return false
  return moduleSurfaceForPlan(plan, type) === 'artifact_panel'
}

export function buildReplyArtifactSlots(input: {
  plan: PresentationPlan | null | undefined
  chartTitle?: string
  hasChart?: boolean
  hasTable?: boolean
  hasReport?: boolean
}): ReplyArtifactSlot[] {
  const plan = input.plan
  if (!plan || !isPresentationPlanActive(plan)) return []
  const out: ReplyArtifactSlot[] = []
  for (const mod of plan.modules) {
    const kind = ARTIFACT_MODULE_KIND[mod.type]
    if (!kind) continue
    if (kind === 'chart' && !input.hasChart) continue
    if (kind === 'table' && !input.hasTable) continue
    if (kind === 'report' && !input.hasReport) continue
    const surface = resolveModuleSurface(mod, plan)
    if (surface !== 'artifact_panel') continue
    const title =
      kind === 'chart'
        ? String(input.chartTitle || '数据图表').slice(0, 80)
        : kind === 'table'
          ? '数据明细'
          : '分析报告'
    out.push({
      id: `${kind}-${mod.type}`,
      kind,
      title,
      surface,
      collapsed: mod.collapsed
    })
  }
  return out
}

export function defaultArtifactTab(slots: ReplyArtifactSlot[]): ReplyArtifactKind {
  if (slots.some((s) => s.kind === 'chart')) return 'chart'
  if (slots.some((s) => s.kind === 'table')) return 'table'
  return 'report'
}

export function artifactTabLabel(kind: ReplyArtifactKind): string {
  if (kind === 'chart') return '图表'
  if (kind === 'table') return '数据表'
  return '报告'
}
