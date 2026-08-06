import type { TaskConstraints } from '../plan'
import type { Step } from '../../../utils/shared/taskPlan'
import {
  intentClassifyFromMeta,
  type IntentClassifyResult,
  type PlanShortcutKind
} from '../../llm/intentClassifyLlm'
import { rolloutHit } from '../evolution/featureRollout'
import { looksLikeSimpleRagKbQuery } from './clarifyContext'
import { canCoalesceRouteToSingleSource, type RouteAuthorityInput } from '../routing/routeAuthority'
import { shouldBlockDbOnlyCoalesce } from '../../orchestrate/routeOrchestration'

export type { PlanShortcutKind, IntentClassifyResult }

export type DbChartShortcutInput = {
  intent: string
  question: string
  /** 用户末轮原话；短路判定优先于 routedQuery，避免路由 LLM 扩写污染 */
  userMessage?: string
  routedQuery?: string
  allowedAgents?: string[]
  /** 路由模型本轮回显式 allowedAgents（权威，优先于 probe 污染列表） */
  routerLlmAllowed?: string[]
  /** decompose 子句标注的 agent */
  clauseAgents?: string[]
  constraints?: TaskConstraints
  probe?: {
    db?: { matched?: boolean; tables?: string[]; routingRelevant?: boolean }
    rag?: { hits?: number; hasDocs?: boolean }
  }
  sessionId?: string
  /** 意图识别节点输出（优先） */
  intentClassify?: IntentClassifyResult | null
  /** 测试 / 回放注入 */
  shortcutKind?: PlanShortcutKind
  meta?: unknown
}

const HEAVY_AGENTS = new Set(['crawler', 'code', 'clean', 'report', 'multimodal', 'music', 'video', 'gui'])

function shortcutUserText(input: DbChartShortcutInput): string {
  return String(input.userMessage || input.routedQuery || input.question || '').trim()
}

function resolveIntentClassify(input: DbChartShortcutInput): IntentClassifyResult | null {
  return input.intentClassify ?? intentClassifyFromMeta(input.meta) ?? null
}

function resolveShortcutKind(input: DbChartShortcutInput): PlanShortcutKind {
  if (input.shortcutKind) return input.shortcutKind
  const classify = resolveIntentClassify(input)
  if (classify?.planShortcut) return classify.planShortcut
  return 'none'
}

function hasDbProbe(input: DbChartShortcutInput): boolean {
  const tables = Array.isArray(input.probe?.db?.tables)
    ? input.probe!.db!.tables!.map((s) => String(s ?? '').trim()).filter(Boolean)
    : []
  return Boolean(input.probe?.db?.matched || input.probe?.db?.routingRelevant) && tables.length > 0
}

function hasRagProbe(input: DbChartShortcutInput): boolean {
  const hits = Number(input.probe?.rag?.hits ?? 0)
  return hits > 0 || Boolean(input.probe?.rag?.hasDocs)
}

/** probe 单侧命中：用于提前锁死单源，防止乱派 db+rag */
function probeFavorsDbOnly(input: DbChartShortcutInput): boolean {
  return hasDbProbe(input) && !hasRagProbe(input)
}

function probeFavorsRagOnly(input: DbChartShortcutInput): boolean {
  return hasRagProbe(input) && !hasDbProbe(input)
}

function metaPrimaryPlane(input: DbChartShortcutInput): string {
  const m = input.meta as { dataPlanePrimaryPlane?: string } | null | undefined
  return String(m?.dataPlanePrimaryPlane || '').trim().toLowerCase()
}

function wantsVisualize(input: DbChartShortcutInput): boolean {
  const classify = resolveIntentClassify(input)
  if (classify && !classify.explicitWantsVisualize) return false
  if (classify?.explicitWantsVisualize) return true
  return Boolean(input.constraints?.wantsVisualize)
}

function wantsReport(input: DbChartShortcutInput): boolean {
  const classify = resolveIntentClassify(input)
  if (classify && !classify.explicitWantsReport) return false
  if (classify?.explicitWantsReport) return true
  return Boolean(input.constraints?.wantsReport)
}

function isDbAnchored(input: DbChartShortcutInput): boolean {
  const classify = resolveIntentClassify(input)
  if (classify?.isDbAnchored === true) return true
  if (classify?.isDbAnchored === false) return false
  return String(input.intent || '').trim() === 'db'
}

function isRagAnchored(input: DbChartShortcutInput): boolean {
  const classify = resolveIntentClassify(input)
  if (classify?.isDbAnchored === true) return false
  if (classify?.planShortcut === 'rag_only') return true
  if (classify?.primaryIntent === 'rag') return true
  return String(input.intent || '').trim() === 'rag'
}

function needsAdmin(input: DbChartShortcutInput): boolean {
  const classify = resolveIntentClassify(input)
  if (classify?.needsAdmin) return true
  return String(input.intent || '').trim() === 'admin'
}

function allowedHasOnly(allowed: string[], permitted: Set<string>): boolean {
  if (!allowed.length) return true
  return allowed.every((a) => permitted.has(a))
}

function passesStructuralGate(kind: PlanShortcutKind, input: DbChartShortcutInput): boolean {
  if (kind === 'none') return false
  const text = shortcutUserText(input)
  if (!text) return false

  const allowed = (input.allowedAgents || []).map((a) => String(a).trim()).filter(Boolean)
  const intent = String(input.intent || '')
  const classify = resolveIntentClassify(input)
  const fromClassify = classify?.planShortcut === kind && Number(classify?.confidence ?? 0) >= 0.42

  const allowedHasSpurious = (extra: string[]) =>
    !fromClassify && allowed.some((a) => HEAVY_AGENTS.has(a) || extra.includes(a))

  const allowedHasSpuriousForRag = () => {
    if (fromClassify) return false
    const structuralSimple = looksLikeSimpleRagKbQuery(text)
    if (structuralSimple) {
      return allowed.some((a) => a === 'db' || a === 'admin')
    }
    const ragSimple =
      isRagAnchored(input) && !wantsReport(input) && !wantsVisualize(input) && !isDbAnchored(input)
    if (ragSimple) return allowed.some((a) => a === 'db' || a === 'admin')
    return allowedHasSpurious(['db', 'admin'])
  }

  if (kind === 'db_chart') {
    if (!isDbChartShortcutEnabled(input.sessionId)) return false
    if (intent === 'visualize' || intent === 'rag') return false
    if (!wantsVisualize(input) || !hasDbProbe(input)) return false
    if (allowed.length > 0) {
      if (!allowed.includes('db')) return false
      if (allowedHasSpurious(['rag', 'crawler', 'admin', 'multimodal', 'music', 'video', 'code'])) return false
    }
    return intent === 'db' || intent === 'multi' || allowed.includes('db')
  }

  if (kind === 'db_only') {
    if (!isSimpleIntentShortcutEnabled(input.sessionId)) return false
    if (text.length > 280) return false
    const probeDbOk = hasDbProbe(input)
    if (!isDbAnchored(input) && intent !== 'db' && !probeDbOk && !fromClassify) return false
    if (wantsVisualize(input) || wantsReport(input)) return false
    if (allowed.length > 0 && !allowed.includes('db') && !fromClassify && !probeDbOk) return false
    if (allowedHasSpurious(['rag', 'admin']) && !fromClassify && !probeDbOk) return false
    return intent === 'multi' || intent === 'db' || allowed.includes('db') || fromClassify || probeDbOk
  }

  if (kind === 'rag_only') {
    if (!isSimpleIntentShortcutEnabled(input.sessionId)) return false
    if (text.length > 280) return false
    if (wantsVisualize(input) || wantsReport(input) || isDbAnchored(input) || needsAdmin(input)) return false
    if (allowed.length && !allowed.includes('rag')) return false
    if (allowedHasSpuriousForRag()) return false
    return intent === 'multi' || intent === 'rag' || allowed.includes('rag') || fromClassify
  }

  if (kind === 'admin_only') {
    if (!isSimpleIntentShortcutEnabled(input.sessionId)) return false
    if (text.length > 240) return false
    if (!needsAdmin(input) && intent !== 'admin') return false
    if (wantsVisualize(input) || isDbAnchored(input)) return false
    if (allowed.length && !allowed.includes('admin')) return false
    if (allowedHasSpurious(['db', 'rag'])) return false
    return intent === 'multi' || intent === 'admin' || allowed.includes('admin') || fromClassify
  }

  return false
}

/** 默认开启（eval 通过）；MANAGER_DB_CHART_SHORTCUT=0 全关；PCT 控制灰度 */
export function isDbChartShortcutEnabled(sessionId?: string): boolean {
  const raw = String(process.env.MANAGER_DB_CHART_SHORTCUT ?? '1').trim()
  if (raw === '0') return false
  return rolloutHit('MANAGER_DB_CHART_SHORTCUT_PCT', sessionId, 100)
}

export function isSimpleIntentShortcutEnabled(sessionId?: string): boolean {
  const raw = String(process.env.MANAGER_SIMPLE_INTENT_SHORTCUT ?? '1').trim()
  if (raw === '0') return false
  return rolloutHit('MANAGER_SIMPLE_INTENT_SHORTCUT_PCT', sessionId, 100)
}

/** @deprecated 使用 taskConstraints / intentClassify.explicitWantsReport */
export function userExplicitlyWantsReport(_text: string, constraints?: TaskConstraints | null): boolean {
  return Boolean(constraints?.wantsReport)
}

/** @deprecated 使用 taskConstraints / intentClassify.explicitWantsVisualize */
export function userExplicitlyWantsVisualize(_text: string, constraints?: TaskConstraints | null): boolean {
  return Boolean(constraints?.wantsVisualize)
}

export function shouldUseDbChartShortcut(input: DbChartShortcutInput): boolean {
  const kind = resolveShortcutKind(input)
  if (kind !== 'db_chart' && kind !== 'none') return false
  if (kind === 'db_chart') return passesStructuralGate('db_chart', input)
  if (wantsVisualize(input) && hasDbProbe(input)) return passesStructuralGate('db_chart', { ...input, shortcutKind: 'db_chart' })
  return false
}

export function buildDbChartShortcutPlan(input: DbChartShortcutInput): Step[] {
  const q = String(input.routedQuery || input.question || '').trim()
  return [
    { id: 'step_db', agent: 'db', query: `从数据库查询：${q}` },
    {
      id: 'step_visualize',
      agent: 'visualize',
      query: `基于数据库查询结果生成 ECharts 图表配置（option JSON）及可读表格：${q}`,
      dependsOn: ['step_db']
    }
  ]
}

export function shouldUseRagOnlyShortcut(input: DbChartShortcutInput): boolean {
  const authority: RouteAuthorityInput = {
    routerLlmAllowed: (input.routerLlmAllowed ?? input.allowedAgents ?? []) as RouteAuthorityInput['routerLlmAllowed'],
    clauseAgents: input.clauseAgents ?? [],
    intentClassify: resolveIntentClassify(input)
  }
  if (!canCoalesceRouteToSingleSource(authority)) return false
  if (input.routerLlmAllowed?.includes('admin')) return false
  if (input.routerLlmAllowed?.includes('visualize')) return false
  if (input.allowedAgents?.includes('admin')) return false
  const kind = resolveShortcutKind(input)
  const text = shortcutUserText(input)
  if (kind === 'rag_only') return passesStructuralGate('rag_only', input)
  if (kind !== 'none') return false
  const plane = metaPrimaryPlane(input)
  // probe 预判：仅 RAG 命中且非 db 锚点 → 强制单源
  if (
    probeFavorsRagOnly(input) &&
    !wantsVisualize(input) &&
    !wantsReport(input) &&
    !isDbAnchored(input) &&
    !needsAdmin(input) &&
    (plane === 'rag' || plane === '' || isRagAnchored(input) || looksLikeSimpleRagKbQuery(text))
  ) {
    return passesStructuralGate('rag_only', { ...input, shortcutKind: 'rag_only', intent: 'rag' })
  }
  if (
    looksLikeSimpleRagKbQuery(text) &&
    !wantsVisualize(input) &&
    !wantsReport(input) &&
    !isDbAnchored(input) &&
    !needsAdmin(input)
  ) {
    return passesStructuralGate('rag_only', { ...input, shortcutKind: 'rag_only', intent: 'rag' })
  }
  if (isRagAnchored(input) && !wantsVisualize(input) && !wantsReport(input) && !isDbAnchored(input) && !needsAdmin(input)) {
    return passesStructuralGate('rag_only', { ...input, shortcutKind: 'rag_only' })
  }
  return false
}

export function buildRagOnlyShortcutPlan(input: DbChartShortcutInput): Step[] {
  const q = String(input.routedQuery || input.question || '').trim()
  return [{ id: 'step_rag', agent: 'rag', query: `从知识库/文档检索相关事实：${q}` }]
}

export function shouldUseAdminOnlyShortcut(input: DbChartShortcutInput & { allowedAgents?: string[] }): boolean {
  const kind = resolveShortcutKind(input)
  if (kind === 'admin_only') return passesStructuralGate('admin_only', input)
  if (kind !== 'none') return false
  if (String(input.intent) === 'admin') return passesStructuralGate('admin_only', { ...input, shortcutKind: 'admin_only' })
  if (needsAdmin(input)) return passesStructuralGate('admin_only', { ...input, shortcutKind: 'admin_only' })
  return false
}

export function buildAdminOnlyShortcutPlan(input: DbChartShortcutInput): Step[] {
  const q = String(input.routedQuery || input.question || '').trim()
  return [{ id: 'step_admin', agent: 'admin', query: q }]
}

export function shouldUseDbOnlyShortcut(input: DbChartShortcutInput): boolean {
  const classify = resolveIntentClassify(input)
  if (shouldBlockDbOnlyCoalesce(classify)) return false
  const authority: RouteAuthorityInput = {
    routerLlmAllowed: (input.routerLlmAllowed ?? input.allowedAgents ?? []) as RouteAuthorityInput['routerLlmAllowed'],
    clauseAgents: input.clauseAgents ?? [],
    intentClassify: resolveIntentClassify(input)
  }
  if (!canCoalesceRouteToSingleSource(authority)) return false
  const kind = resolveShortcutKind(input)
  if (kind === 'db_only') return passesStructuralGate('db_only', input)
  if (kind !== 'none') return false
  // probe 预判：仅 DB 命中且数据面为 db / 未声明 rag → 强制单源
  const plane = metaPrimaryPlane(input)
  if (
    probeFavorsDbOnly(input) &&
    !wantsVisualize(input) &&
    !wantsReport(input) &&
    (plane === 'db' || plane === '' || isDbAnchored(input) || String(input.intent || '') === 'db')
  ) {
    return passesStructuralGate('db_only', { ...input, shortcutKind: 'db_only', intent: 'db' })
  }
  if (isDbAnchored(input) && !wantsVisualize(input) && !wantsReport(input)) {
    return passesStructuralGate('db_only', { ...input, shortcutKind: 'db_only' })
  }
  return false
}

export function buildDbOnlyShortcutPlan(input: DbChartShortcutInput): Step[] {
  const q = shortcutUserText(input)
  return [{ id: 'step_db', agent: 'db', query: `从数据库查询：${q}` }]
}

/** 路由层：纯查库问句收敛 intent=db，避免 probe 误补 rag 后走 multi */
export function coalesceSimpleDbRoute(
  input: DbChartShortcutInput & { allowedAgents?: string[] }
): { intent: 'db'; allowedAgents: ['db'] } | null {
  if (!shouldUseDbOnlyShortcut(input)) return null
  return { intent: 'db', allowedAgents: ['db'] }
}

/** 路由层：纯知识库问句收敛 intent=rag，避免「多指标问答」被扩写为 clean/code/report 流水线 */
export function coalesceSimpleRagRoute(
  input: DbChartShortcutInput & { allowedAgents?: string[] }
): { intent: 'rag'; allowedAgents: ['rag'] } | null {
  if (!shouldUseRagOnlyShortcut(input)) return null
  return { intent: 'rag', allowedAgents: ['rag'] }
}
