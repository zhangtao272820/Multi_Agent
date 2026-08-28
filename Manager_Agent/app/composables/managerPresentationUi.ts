/**
 * Cursor 式 Presentation UI 辅助（纯函数，可 smoke）。
 */
import type { TurnGroup, UserFacingPayload } from './managerChatTypes'

export type ReplyArtifactKind = 'chart' | 'table' | 'report'

const PLAN_CONF = 0.42

export function activePresentationPlan(turn?: TurnGroup): UserFacingPayload['presentationPlan'] | null {
  const plan =
    turn?.userFacing?.presentationPlan ||
    (turn as { presentationPlan?: UserFacingPayload['presentationPlan'] })?.presentationPlan
  if (!plan || Number(plan.confidence ?? 0) < PLAN_CONF) return null
  return plan
}

export function planHasModuleType(turn: TurnGroup | undefined, type: string): boolean {
  const plan = activePresentationPlan(turn)
  if (!plan?.modules?.length) return true
  return plan.modules.some((m) => m.type === type)
}

function moduleEntry(turn: TurnGroup | undefined, type: string) {
  const plan = activePresentationPlan(turn)
  return plan?.modules?.find((m) => m.type === type) || null
}

/** report 档 / standard+collapsed → 进 Artifact，不进气泡 inline */
export function modulePrefersArtifactPanel(turn: TurnGroup | undefined, type: string): boolean {
  const plan = activePresentationPlan(turn)
  if (!plan) return false
  const mod = moduleEntry(turn, type)
  if (!mod) return false
  if (plan.replyTier === 'report' && ['chart', 'table', 'report_appendix'].includes(type)) return true
  if (plan.replyTier === 'standard' && (type === 'chart' || type === 'table') && mod.collapsed) return true
  if (type === 'report_appendix' && plan.replyTier !== 'lite') return true
  return false
}

export function artifactPanelSlots(turn?: TurnGroup) {
  const slots = turn?.userFacing?.artifacts || []
  return slots.filter((a) => a.surface === 'artifact_panel')
}

export function hasArtifactPanel(turn?: TurnGroup): boolean {
  return artifactPanelSlots(turn).length > 0
}

export function shouldShowInlineChart(turn?: TurnGroup, hasChartData?: boolean): boolean {
  if (!hasChartData) return false
  const slots = turn?.userFacing?.artifacts || []
  if (slots.length) return slots.some((a) => a.kind === 'chart' && a.surface === 'inline')
  const plan = activePresentationPlan(turn)
  if (!plan) return true
  if (!planHasModuleType(turn, 'chart')) return false
  if (modulePrefersArtifactPanel(turn, 'chart')) return false
  return true
}

export function shouldShowInlineTable(turn?: TurnGroup, hasTableData?: boolean): boolean {
  if (!hasTableData) return false
  const slots = turn?.userFacing?.artifacts || []
  if (slots.length) return slots.some((a) => a.kind === 'table' && a.surface === 'inline')
  const plan = activePresentationPlan(turn)
  if (!plan) return true
  if (!planHasModuleType(turn, 'table')) return false
  if (modulePrefersArtifactPanel(turn, 'table')) return false
  return true
}

/** 报告附录已进 Artifact 时，气泡内不再重复「详细说明」 */
export function shouldShowInlineReportAppendix(turn?: TurnGroup): boolean {
  const slots = turn?.userFacing?.artifacts || []
  if (slots.some((a) => a.kind === 'report' && a.surface === 'artifact_panel')) return false
  if (modulePrefersArtifactPanel(turn, 'report_appendix')) return false
  return true
}

export function turnHasEditedReport(turn?: TurnGroup): boolean {
  return Boolean(turn?.userFacing?.reportEdited)
}

/** 流式阶段：重型模块进面板时，正文应剥掉 ECharts/TABLE/REPORT 标签 */
export function shouldStripAuxBlocksDuringStream(turn?: TurnGroup): boolean {
  const plan = activePresentationPlan(turn)
  if (!plan) return false
  if (plan.replyTier === 'report') return true
  return (plan.modules || []).some((m) =>
    ['chart', 'table', 'report_appendix'].includes(m.type) && modulePrefersArtifactPanel(turn, m.type)
  )
}

/** 流式气泡：预告 Artifact 面板将出现 */
export function streamingArtifactHint(turn?: TurnGroup): string {
  const plan = activePresentationPlan(turn)
  if (!plan || plan.replyTier === 'lite') return ''
  const kinds: string[] = []
  for (const m of plan.modules || []) {
    if (m.type === 'chart' && modulePrefersArtifactPanel(turn, 'chart')) kinds.push('图表')
    if (m.type === 'table' && modulePrefersArtifactPanel(turn, 'table')) kinds.push('数据表')
    if (m.type === 'report_appendix' && modulePrefersArtifactPanel(turn, 'report_appendix')) {
      kinds.push('报告')
    }
  }
  if (!kinds.length && plan.replyTier === 'report') return '分析面板将在回答完成后打开'
  if (!kinds.length) return ''
  return `完成后可在右侧面板查看：${[...new Set(kinds)].join(' · ')}`
}

export function artifactTabLabel(kind: ReplyArtifactKind): string {
  if (kind === 'chart') return '图表'
  if (kind === 'table') return '数据表'
  return '报告'
}

export function pickDefaultArtifactTab(turn?: TurnGroup): ReplyArtifactKind {
  const slots = artifactPanelSlots(turn)
  if (slots.some((s) => s.kind === 'chart')) return 'chart'
  if (slots.some((s) => s.kind === 'table')) return 'table'
  if (slots.some((s) => s.kind === 'report')) return 'report'
  const plan = activePresentationPlan(turn)
  if (planHasModuleType(turn, 'chart') && modulePrefersArtifactPanel(turn, 'chart')) return 'chart'
  if (planHasModuleType(turn, 'table') && modulePrefersArtifactPanel(turn, 'table')) return 'table'
  if (plan?.replyTier === 'report') return 'report'
  return 'report'
}

export function resolveReportMarkdownSource(turn: TurnGroup | undefined, fallbacks: {
  resolveReportBody: (text: string, t: TurnGroup) => string
  resultText?: string
}): string {
  if (!turn) return ''
  const appendix = String(turn.userFacing?.appendix || '').trim()
  if (appendix.length >= 40) return appendix
  return fallbacks.resolveReportBody(String(fallbacks.resultText || turn.results?.[0]?.text || ''), turn)
}
