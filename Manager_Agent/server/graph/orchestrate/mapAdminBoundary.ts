/**
 * 能力契约：地图/出行属 Admin（高德 get_travel_route 等），禁止 crawler 误绑。
 * 只校验/重绑编排产出（clauses / draft / blueprint），不做用户原话意图路由。
 * 对齐 weatherAdminBoundary：模板噪声剥离 + 真网页政策保留 crawler。
 */
import { ADMIN_CAPABILITY_GROUPS } from '#agent-shared/adminCapabilities'
import type { TaskClause } from '../core/routing/clauses'
import type { StepDispatchDraft } from '../core/proPuStack'
import type { PlanBlueprint } from '../llm/planBlueprintLlm'
import type { IntentClassifyResult } from '../llm/intentClassifyLlm'
import type { ExecutableAgent } from '../core/routing/routeFinalize'
import { stripCrawlerTemplateNoise } from './weatherAdminBoundary'

/** Admin 地图/出行能力域标记（SSOT：adminCapabilities 混合任务组 routeTerms） */
export function adminMapCapabilityTerms(): readonly string[] {
  const g = ADMIN_CAPABILITY_GROUPS.find((x) => x.intent === '混合任务')
  return g?.routeTerms?.length
    ? g.routeTerms
    : ['路线', '多久', '地铁', '公交', '驾车', '怎么走', '通勤', '出行', '高德', '地图']
}

/** 真网页/政策类信号：保留 crawler（与天气边界同构，避免地图词误伤政策抓取） */
const TRUE_WEB_POLICY_MARKERS = [
  '政策',
  '公告',
  '通知原文',
  '官网',
  '网页正文',
  '民政部',
  '新闻页面',
  '列表页',
  '最新通知',
  '公开资料抓取'
] as const

function includesAny(text: string, terms: readonly string[]): boolean {
  const t = String(text || '')
  if (!t) return false
  return terms.some((m) => m && t.includes(m))
}

/** 编排产出文本是否落在 Admin 地图/出行能力域（且非真网页政策抓取） */
export function textLooksLikeAdminMapCapability(text: string): boolean {
  const raw = String(text || '').trim()
  if (raw.length < 2) return false
  const lean = stripCrawlerTemplateNoise(raw) || raw
  if (includesAny(lean, TRUE_WEB_POLICY_MARKERS) && !includesAny(lean, adminMapCapabilityTerms())) {
    return false
  }
  // 「官网查地铁线路政策」等偏政策网页，不重绑
  if (
    includesAny(lean, ['政策', '公告', '官网', '民政部', '网页正文']) &&
    lean.includes('政策') &&
    !includesAny(lean, ['多久', '多久到', '怎么走', '从', '到站', '车程'])
  ) {
    return false
  }
  return includesAny(lean, adminMapCapabilityTerms())
}

export function clauseIsMapBoundToCrawler(clause: TaskClause): boolean {
  const agents = clause.agents ?? []
  if (!agents.includes('crawler' as TaskClause['agents'][number])) return false
  return textLooksLikeAdminMapCapability(String(clause.text || ''))
}

export function blueprintStepIsMapCrawler(step: { agent?: string; queryFocus?: string }): boolean {
  if (String(step.agent || '') !== 'crawler') return false
  return textLooksLikeAdminMapCapability(String(step.queryFocus || ''))
}

export type MapCrawlerRematerializeInput = {
  allowedAgents: ExecutableAgent[]
  clauses: TaskClause[]
  classify: IntentClassifyResult
  planBlueprint: PlanBlueprint | null
  stepDispatchDraft?: StepDispatchDraft[] | null
  needsWebSearch?: boolean
}

export type MapCrawlerRematerializeResult = MapCrawlerRematerializeInput & {
  changed: boolean
}

/**
 * 将误绑为 crawler 的地图/出行子句/draft/蓝图重绑为 admin；
 * 若已无真网页 crawler 绑定，则从 cap/dataSources 去掉 crawler 并关闭 needsWeb。
 */
export function rematerializeMapCrawlerMisbind(
  input: MapCrawlerRematerializeInput
): MapCrawlerRematerializeResult {
  let changed = false

  const clauses: TaskClause[] = input.clauses.map((c) => {
    if (!clauseIsMapBoundToCrawler(c)) return c
    changed = true
    const nextAgents = (c.agents ?? [])
      .map((a) => (String(a) === 'crawler' ? ('admin' as const) : a))
      .filter((a, i, arr) => arr.indexOf(a) === i) as TaskClause['agents']
    const leanText = stripCrawlerTemplateNoise(String(c.text || '')) || String(c.text || '')
    return {
      ...c,
      text: leanText.slice(0, 480),
      agents: nextAgents.length ? nextAgents : (['admin'] as TaskClause['agents']),
      layer: 'action' as const
    }
  })

  let stepDispatchDraft = input.stepDispatchDraft
  if (Array.isArray(stepDispatchDraft) && stepDispatchDraft.length) {
    stepDispatchDraft = stepDispatchDraft.map((d) => {
      if (String(d.agent || '') !== 'crawler') return d
      const scoped = String(d.scopedUserLanguage || '').trim()
      if (!textLooksLikeAdminMapCapability(scoped)) return d
      changed = true
      const lean = stripCrawlerTemplateNoise(scoped) || scoped
      return {
        ...d,
        agent: 'admin' as StepDispatchDraft['agent'],
        scopedUserLanguage: lean.slice(0, 480)
      }
    })
  }

  let planBlueprint = input.planBlueprint
  if (planBlueprint?.steps?.length) {
    const steps = planBlueprint.steps.map((s) => {
      if (!blueprintStepIsMapCrawler(s)) return s
      changed = true
      const leanFocus = stripCrawlerTemplateNoise(String(s.queryFocus || '')) || String(s.queryFocus || '')
      const focus = includesAny(leanFocus, adminMapCapabilityTerms())
        ? leanFocus.slice(0, 480)
        : String(s.queryFocus || '').slice(0, 480)
      return { ...s, agent: 'admin' as PlanBlueprint['steps'][number]['agent'], queryFocus: focus }
    })
    // 合并重复 admin 步：截图同构 crawler+admin 双出行步 → 保留一条地图焦点
    const seenAdmin = new Set<string>()
    const deduped: typeof steps = []
    for (const s of steps) {
      if (String(s.agent) !== 'admin') {
        deduped.push(s)
        continue
      }
      const focus = String(s.queryFocus || '').trim()
      const key = focus.slice(0, 80) || 'admin'
      if (seenAdmin.has(key)) continue
      const mapFocus = textLooksLikeAdminMapCapability(focus)
      if (mapFocus) {
        const genericIdx = deduped.findIndex(
          (x) =>
            String(x.agent) === 'admin' && !textLooksLikeAdminMapCapability(String(x.queryFocus || ''))
        )
        if (genericIdx >= 0) {
          deduped[genericIdx] = s
          seenAdmin.add(key)
          continue
        }
        // 已有另一条地图 admin：保留更具体（更长）的焦点
        const mapIdx = deduped.findIndex(
          (x) => String(x.agent) === 'admin' && textLooksLikeAdminMapCapability(String(x.queryFocus || ''))
        )
        if (mapIdx >= 0) {
          const prev = String(deduped[mapIdx].queryFocus || '')
          if (focus.length > prev.length) deduped[mapIdx] = s
          continue
        }
      }
      seenAdmin.add(key)
      deduped.push(s)
    }
    planBlueprint = { ...planBlueprint, steps: deduped }
  }

  const stillHasCrawlerClause = clauses.some((c) =>
    (c.agents ?? []).includes('crawler' as TaskClause['agents'][number])
  )
  const stillHasCrawlerDraft = (stepDispatchDraft ?? []).some((d) => String(d.agent || '') === 'crawler')
  const stillHasCrawlerBp = (planBlueprint?.steps ?? []).some((s) => String(s.agent) === 'crawler')
  const keepCrawler = stillHasCrawlerClause || stillHasCrawlerDraft || stillHasCrawlerBp

  let allowedAgents = [...input.allowedAgents]
  let classify = { ...input.classify }
  let needsWebSearch = input.needsWebSearch

  if (changed) {
    if (!allowedAgents.map(String).includes('admin')) {
      allowedAgents = [...allowedAgents, 'admin'] as ExecutableAgent[]
    }
    classify = {
      ...classify,
      needsAdmin: true,
      suggestedAgents: [...new Set([...(classify.suggestedAgents ?? []), 'admin'])]
    }
  }

  if (changed && !keepCrawler) {
    if (allowedAgents.map(String).includes('crawler')) {
      allowedAgents = allowedAgents.filter((a) => String(a) !== 'crawler') as ExecutableAgent[]
      changed = true
    }
    classify = {
      ...classify,
      needsWeb: false,
      dataSources: (classify.dataSources ?? []).filter((d) => d !== 'crawler') as IntentClassifyResult['dataSources'],
      suggestedAgents: (classify.suggestedAgents ?? []).filter((a) => a !== 'crawler')
    }
    needsWebSearch = false
  }

  return {
    allowedAgents,
    clauses,
    classify,
    planBlueprint,
    stepDispatchDraft,
    needsWebSearch,
    changed
  }
}

/** lint：编排产出仍把地图/出行绑在 crawler 上 */
export function lintMapBoundToCrawler(input: {
  clauses: TaskClause[]
  planBlueprint: PlanBlueprint | null
}): string[] {
  const issues: string[] = []
  for (const c of input.clauses) {
    if (clauseIsMapBoundToCrawler(c)) {
      issues.push(`子句 ${c.id} 将地图/出行语义绑到 crawler，须改 admin（get_travel_route）`)
    }
  }
  for (const s of input.planBlueprint?.steps ?? []) {
    if (blueprintStepIsMapCrawler(s)) {
      issues.push('蓝图 crawler 步承载地图/出行语义，须改 admin（get_travel_route）')
      break
    }
  }
  return issues
}

/**
 * 计划步级硬闸：任意 crawler 步 query 落在地图能力域 → 改为 admin。
 */
export function rematerializeMapCrawlerPlanSteps<
  T extends { id?: string; agent: string; query: string; dependsOn?: string[]; optional?: boolean }
>(plan: T[]): T[] {
  if (!Array.isArray(plan) || !plan.length) return plan
  let changed = false
  const next: T[] = []
  for (const step of plan) {
    if (String(step.agent) !== 'crawler') {
      next.push(step)
      continue
    }
    const q = String(step.query || '').trim()
    if (!textLooksLikeAdminMapCapability(q)) {
      next.push(step)
      continue
    }
    changed = true
    const lean = stripCrawlerTemplateNoise(q) || q
    next.push({
      ...step,
      agent: 'admin',
      query: lean.slice(0, 2000)
    } as T)
  }
  if (!changed) return plan

  const out: T[] = []
  let keptMapAdmin = false
  for (const s of next) {
    if (String(s.agent) !== 'admin') {
      out.push(s)
      continue
    }
    const q = String(s.query || '')
    const isMap = textLooksLikeAdminMapCapability(q)
    const isShell =
      q.includes('元数据') ||
      q.includes('执行状态') ||
      q.includes('系统日志') ||
      (q.includes('记录') && includesAny(q, ['出行', '路线', '地铁']) && !includesAny(q, ['多久', '怎么走', '从']))
    if (isShell && keptMapAdmin) continue
    if (isMap) {
      if (keptMapAdmin) {
        const idx = out.findIndex(
          (x) => String(x.agent) === 'admin' && !textLooksLikeAdminMapCapability(String(x.query || ''))
        )
        if (idx >= 0) {
          out[idx] = s
          continue
        }
        // 两条地图 admin：保留更具体的
        const mapIdx = out.findIndex(
          (x) => String(x.agent) === 'admin' && textLooksLikeAdminMapCapability(String(x.query || ''))
        )
        if (mapIdx >= 0) {
          const prev = String(out[mapIdx].query || '')
          if (q.length > prev.length) out[mapIdx] = s
          continue
        }
        continue
      }
      keptMapAdmin = true
    }
    out.push(s)
  }
  return out
}
