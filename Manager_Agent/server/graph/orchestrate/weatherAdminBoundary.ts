/**
 * 能力契约：天气预报属 Admin（get_weather），禁止 crawler 误绑。
 * 只校验/重绑编排产出（clauses / draft / blueprint），不做用户原话意图路由。
 * 用户清晰要公网/爬取（sourceCommitment/webFetchKind）时不得重绑。
 */
import { ADMIN_CAPABILITY_GROUPS } from '#agent-shared/adminCapabilities'
import type { TaskClause } from '../core/routing/clauses'
import type { StepDispatchDraft } from '../core/proPuStack'
import type { PlanBlueprint } from '../llm/planBlueprintLlm'
import type { IntentClassifyResult } from '../llm/intentClassifyLlm'
import type { ExecutableAgent } from '../core/routing/routeFinalize'
import {
  shouldSkipAdminApiCrawlerRematerialize,
  sourceCommitmentFromRaw
} from './sourceCommitment'

/** Admin 天气能力域标记（SSOT：adminCapabilities 天气组 routeTerms） */
export function adminWeatherCapabilityTerms(): readonly string[] {
  const g = ADMIN_CAPABILITY_GROUPS.find((x) => x.intent === '天气')
  return g?.routeTerms?.length ? g.routeTerms : ['天气', '气温', '下雨', '预报', '湿度', '风力', '穿衣']
}

/** 真网页/政策类信号：用户要公网政策/公告正文时保留 crawler。
 * 注意：禁止把 Planner 模板套话「从公开网页采集…」当成真网页信号，
 * 否则「模板 + 天津天气」永远无法重绑为 admin。
 */
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

/** Planner/编排常用 crawler 模板前缀（非用户真网页意图） */
const CRAWLER_TEMPLATE_NOISE = [
  '从公开网页采集',
  '与任务相关的事实信息',
  '与任务相关、可引用的客观信息',
  '可引用的客观信息'
] as const

function includesAny(text: string, terms: readonly string[]): boolean {
  const t = String(text || '')
  if (!t) return false
  return terms.some((m) => m && t.includes(m))
}

/** 去掉 crawler 模板套话后再判语义 */
export function stripCrawlerTemplateNoise(text: string): string {
  let s = String(text || '').trim()
  for (const n of CRAWLER_TEMPLATE_NOISE) {
    if (s.includes(n)) s = s.split(n).join(' ')
  }
  // 模板后常跟全角/半角冒号
  s = s.replace(/^[\s:：]+/, '').trim()
  return s.replace(/\s+/g, ' ').trim()
}

/** 编排产出文本是否落在 Admin 天气能力域（且非真网页政策抓取） */
export function textLooksLikeAdminWeatherCapability(text: string): boolean {
  const raw = String(text || '').trim()
  if (raw.length < 2) return false
  const lean = stripCrawlerTemplateNoise(raw) || raw
  // 强政策/公告信号且天气词很弱时保留 crawler
  if (includesAny(lean, TRUE_WEB_POLICY_MARKERS) && !includesAny(lean, adminWeatherCapabilityTerms())) {
    return false
  }
  if (includesAny(lean, TRUE_WEB_POLICY_MARKERS) && includesAny(lean, ['政策', '公告', '官网', '民政部'])) {
    // 「官网查天气政策」等：偏政策网页，不重绑
    if (!includesAny(lean, ['气温', '穿衣', '下雨', '湿度', '风力']) && lean.includes('政策')) {
      return false
    }
  }
  return includesAny(lean, adminWeatherCapabilityTerms())
}

export function clauseIsWeatherBoundToCrawler(clause: TaskClause): boolean {
  const agents = clause.agents ?? []
  if (!agents.includes('crawler' as TaskClause['agents'][number])) return false
  return textLooksLikeAdminWeatherCapability(String(clause.text || ''))
}

export function blueprintStepIsWeatherCrawler(step: { agent?: string; queryFocus?: string }): boolean {
  if (String(step.agent || '') !== 'crawler') return false
  return textLooksLikeAdminWeatherCapability(String(step.queryFocus || ''))
}

export type WeatherCrawlerRematerializeInput = {
  allowedAgents: ExecutableAgent[]
  clauses: TaskClause[]
  classify: IntentClassifyResult
  planBlueprint: PlanBlueprint | null
  stepDispatchDraft?: StepDispatchDraft[] | null
  needsWebSearch?: boolean
  /** 编排 raw：清晰公网意图时跳过重绑 */
  sourceCommitmentRaw?: Record<string, unknown> | null
}

export type WeatherCrawlerRematerializeResult = WeatherCrawlerRematerializeInput & {
  changed: boolean
}

/**
 * 将误绑为 crawler 的天气子句/draft/蓝图重绑为 admin；
 * 若已无真网页 crawler 绑定，则从 cap/dataSources 去掉 crawler 并关闭 needsWeb。
 * 用户清晰要公网/爬取（sourceCommitment/webFetchKind）时跳过。
 */
export function rematerializeWeatherCrawlerMisbind(
  input: WeatherCrawlerRematerializeInput
): WeatherCrawlerRematerializeResult {
  const slice = sourceCommitmentFromRaw(input.sourceCommitmentRaw)
  if (shouldSkipAdminApiCrawlerRematerialize(slice)) {
    return { ...input, changed: false }
  }

  let changed = false

  const clauses: TaskClause[] = input.clauses.map((c) => {
    if (!clauseIsWeatherBoundToCrawler(c)) return c
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
      if (!textLooksLikeAdminWeatherCapability(scoped)) return d
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
      if (!blueprintStepIsWeatherCrawler(s)) return s
      changed = true
      const leanFocus = stripCrawlerTemplateNoise(String(s.queryFocus || '')) || String(s.queryFocus || '')
      // 优先留下含天气的 lean 焦点，避免 admin 步仍带着「从公开网页采集」套话
      const focus = includesAny(leanFocus, adminWeatherCapabilityTerms())
        ? leanFocus.slice(0, 480)
        : String(s.queryFocus || '').slice(0, 480)
      return { ...s, agent: 'admin' as PlanBlueprint['steps'][number]['agent'], queryFocus: focus }
    })
    // 合并重复 admin 步：保留天气焦点更具体的一步
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
      // 若已有泛化 admin 步且本步是天气，用天气步替换泛化步
      const weatherFocus = textLooksLikeAdminWeatherCapability(focus)
      if (weatherFocus) {
        const genericIdx = deduped.findIndex(
          (x) =>
            String(x.agent) === 'admin' && !textLooksLikeAdminWeatherCapability(String(x.queryFocus || ''))
        )
        if (genericIdx >= 0) {
          deduped[genericIdx] = s
          seenAdmin.add(key)
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

/** lint：编排产出仍把天气绑在 crawler 上 */
export function lintWeatherBoundToCrawler(input: {
  clauses: TaskClause[]
  planBlueprint: PlanBlueprint | null
}): string[] {
  const issues: string[] = []
  for (const c of input.clauses) {
    if (clauseIsWeatherBoundToCrawler(c)) {
      issues.push(`子句 ${c.id} 将天气预报语义绑到 crawler，须改 admin（get_weather）`)
    }
  }
  for (const s of input.planBlueprint?.steps ?? []) {
    if (blueprintStepIsWeatherCrawler(s)) {
      issues.push('蓝图 crawler 步承载天气预报语义，须改 admin（get_weather）')
      break
    }
  }
  return issues
}

/**
 * 计划步级硬闸：任意 crawler 步 query 落在天气能力域 → 改为 admin。
 * 堵住 Planner / web-align 在编排之后重新塞入「采集网页查天气」。
 * 与编排侧同一谓词：清晰公网锁（webFetchKind≠none / clear+crawler）时 no-op，禁止抢权。
 */
export function rematerializeWeatherCrawlerPlanSteps<
  T extends { id?: string; agent: string; query: string; dependsOn?: string[]; optional?: boolean }
>(plan: T[], sourceCommitmentRaw?: Record<string, unknown> | null): T[] {
  if (!Array.isArray(plan) || !plan.length) return plan
  if (shouldSkipAdminApiCrawlerRematerialize(sourceCommitmentFromRaw(sourceCommitmentRaw))) {
    return plan
  }
  let changed = false
  const next: T[] = []
  for (const step of plan) {
    if (String(step.agent) !== 'crawler') {
      next.push(step)
      continue
    }
    const q = String(step.query || '').trim()
    if (!textLooksLikeAdminWeatherCapability(q)) {
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

  // 合并：保留含天气的 admin 步，丢掉「记录状态/元数据归档」类空壳 admin
  const out: T[] = []
  let keptWeatherAdmin = false
  for (const s of next) {
    if (String(s.agent) !== 'admin') {
      out.push(s)
      continue
    }
    const q = String(s.query || '')
    const isWeather = textLooksLikeAdminWeatherCapability(q)
    const isShell =
      q.includes('元数据') ||
      q.includes('执行状态') ||
      q.includes('系统日志') ||
      (q.includes('记录') && q.includes('天气') && !includesAny(q, ['创建', '查询', '查一下', '怎么样']))
    if (isShell && keptWeatherAdmin) continue
    if (isWeather) {
      if (keptWeatherAdmin) {
        // 替换先前非天气 admin
        const idx = out.findIndex(
          (x) => String(x.agent) === 'admin' && !textLooksLikeAdminWeatherCapability(String(x.query || ''))
        )
        if (idx >= 0) {
          out[idx] = s
          continue
        }
        continue
      }
      keptWeatherAdmin = true
    }
    out.push(s)
  }
  return out
}
