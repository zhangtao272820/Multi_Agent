/**
 * 编排产出结构性 lint（Plan-and-Execute / LLMCompiler 对齐）。
 * 只检查 cap↔子句↔蓝图↔dataSources 一致性，不做用户原话正则意图分类。
 */

import { agentsFromClauses, type TaskClause } from '../core/routing/clauses'
import type { PlanBlueprint } from '../llm/planBlueprintLlm'
import { blueprintCoversRequiredAgents } from '../llm/planBlueprintLlm'
import type { IntentClassifyResult } from '../llm/intentClassifyLlm'
import { lintWeatherBoundToCrawler } from './weatherAdminBoundary'
import { lintMapBoundToCrawler } from './mapAdminBoundary'

const DATA_PLANE = new Set(['rag', 'db', 'crawler'])
const EXEC_COVER = new Set(['rag', 'db', 'crawler', 'clean', 'code', 'visualize', 'report', 'admin', 'gui'])

export type OrchestratorLintInput = {
  userTask: string
  allowedAgents: string[]
  clauses: TaskClause[]
  classify: IntentClassifyResult
  planBlueprint: PlanBlueprint | null
}

function norm(s: string): string {
  return String(s ?? '')
    .replace(/\s+/g, '')
    .trim()
}

/** 多步蓝图是否把整段用户原话复制到每步 queryFocus */
function blueprintRepeatsFullUserTask(blueprint: PlanBlueprint | null, userTask: string): boolean {
  if (!blueprint?.steps?.length || blueprint.steps.length < 2) return false
  const u = norm(userTask)
  if (u.length < 12) return false
  const dup = blueprint.steps.filter((s) => {
    const f = norm(String(s.queryFocus || ''))
    return f.length >= 12 && (f === u || u.includes(f) && f.length / u.length > 0.85)
  })
  return dup.length >= 2
}

/** 子句声明的数据面 agent 是否都在 cap 中 */
function missingClauseAgentsInCap(clauses: TaskClause[], cap: Set<string>): string[] {
  const issues: string[] = []
  for (const c of clauses) {
    for (const a of c.agents ?? []) {
      if (DATA_PLANE.has(a) && !cap.has(a)) {
        issues.push(`子句 ${c.id} 声明 ${a} 但 allowedAgents 未含 ${a}`)
      }
    }
  }
  return issues
}

/** dataSources 与子句/cap 数据面不一致 */
function dataSourceDrift(input: OrchestratorLintInput): string[] {
  const issues: string[] = []
  const ds = new Set((input.classify.dataSources ?? []).filter((d) => DATA_PLANE.has(d)))
  const fromClauses = new Set(agentsFromClauses(input.clauses).filter((a) => DATA_PLANE.has(a)))
  const capData = new Set(input.allowedAgents.filter((a) => DATA_PLANE.has(a)))

  for (const a of fromClauses) {
    if (!capData.has(a)) issues.push(`子句含数据面 ${a} 但 cap 缺失`)
    if (ds.size && !ds.has(a as 'rag' | 'db' | 'crawler')) {
      issues.push(`子句含 ${a} 但 dataSources 未声明`)
    }
  }
  for (const a of capData) {
    if (fromClauses.size && !fromClauses.has(a) && input.clauses.length >= 2) {
      issues.push(`cap 含 ${a} 但无子句绑定（复合任务须拆子句）`)
    }
  }
  return issues
}

/** crawler 出现在 cap/dataSources/蓝图，但无 crawler 绑定子句 */
function crawlerWithoutBoundClause(input: OrchestratorLintInput): string[] {
  const issues: string[] = []
  const hasCrawlerClause = input.clauses.some((c) => (c.agents ?? []).includes('crawler' as TaskClause['agents'][number]))
  const capHasCrawler = input.allowedAgents.map(String).includes('crawler')
  const dsHasCrawler = (input.classify.dataSources ?? []).includes('crawler')
  const bpHasCrawler = (input.planBlueprint?.steps ?? []).some((s) => String(s.agent) === 'crawler')
  if ((capHasCrawler || dsHasCrawler || bpHasCrawler) && !hasCrawlerClause) {
    issues.push('crawler 出现在 cap/dataSources/蓝图但无 crawler 子句绑定（禁止把知识库/数据库/天气整句当成联网）')
  }
  return issues
}

/** crawler 步 queryFocus 复制整段原话，或镜像仅 rag/db/admin 子句文本 */
function crawlerMirrorsNonWebClause(input: OrchestratorLintInput): string[] {
  const issues: string[] = []
  const crawlerSteps = (input.planBlueprint?.steps ?? []).filter((s) => String(s.agent) === 'crawler')
  if (!crawlerSteps.length) return issues
  const user = norm(input.userTask)
  for (const step of crawlerSteps) {
    const focus = norm(String(step.queryFocus || ''))
    if (!focus || focus.length < 8) continue
    if (user.length >= 12 && (focus === user || (user.includes(focus) && focus.length / user.length > 0.85))) {
      issues.push('蓝图 crawler queryFocus 重复整段用户原话，须按公网子句拆分')
      continue
    }
    for (const c of input.clauses) {
      const agents = c.agents ?? []
      if (agents.includes('crawler' as TaskClause['agents'][number])) continue
      if (!agents.some((a) => a === 'rag' || a === 'db' || a === 'admin')) continue
      const ct = norm(c.text)
      if (ct.length < 8) continue
      if (focus === ct || (ct.includes(focus) && focus.length / ct.length > 0.85) || (focus.includes(ct) && ct.length / focus.length > 0.85)) {
        issues.push(`蓝图 crawler queryFocus 镜像非公网子句 ${c.id}（rag/db/admin），须删除或改写为独立公网需求`)
        break
      }
    }
  }
  return issues
}

/** cap 含用户未要求的下游 agent（report/clean） */
function spuriousDownstreamAgents(input: OrchestratorLintInput): string[] {
  const issues: string[] = []
  const user = String(input.userTask || '')
  const cap = input.allowedAgents.map(String)
  const dataCount = cap.filter((a) => DATA_PLANE.has(a)).length
  const pipeline = input.classify.requiresAgentPipeline === true
  const wantsReport = /报告|总结|汇总|撰写|写一份/.test(user)
  const wantsClean = /清洗|去重|格式化|规整/.test(user)

  if (!wantsReport && cap.includes('report') && dataCount <= 1 && !pipeline) {
    issues.push('cap 含 report 但用户未要求报告/汇总')
  }
  if (!wantsClean && cap.includes('clean') && dataCount <= 1 && !pipeline) {
    issues.push('cap 含 clean 但用户未要求清洗/规整')
  }
  return issues
}

export function lintOrchestratorBundle(input: OrchestratorLintInput): string[] {
  const issues: string[] = []
  const userTask = String(input.userTask || '').trim()
  const cap = new Set(input.allowedAgents.map(String))
  const shortcut = input.classify.planShortcut
  const pipeline = input.classify.requiresAgentPipeline === true
  const dataAgentCount = input.allowedAgents.filter((a) => DATA_PLANE.has(a)).length

  if (shortcut === 'db_only' || shortcut === 'rag_only' || shortcut === 'admin_only') {
    if (input.allowedAgents.length > 2) {
      issues.push(`planShortcut=${shortcut} 但 cap 含 ${input.allowedAgents.length} 个 agent`)
    }
    if (pipeline && dataAgentCount <= 1) {
      issues.push(`单源 shortcut 不应 requiresAgentPipeline=true`)
    }
  }

  if (dataAgentCount >= 2 || input.clauses.length >= 2 || pipeline) {
    issues.push(...missingClauseAgentsInCap(input.clauses, cap))
    issues.push(...dataSourceDrift(input))
    issues.push(...crawlerWithoutBoundClause(input))
    issues.push(...crawlerMirrorsNonWebClause(input))

    const mustCover = input.allowedAgents.filter((a) => EXEC_COVER.has(a))
    if (!blueprintCoversRequiredAgents(input.planBlueprint, mustCover)) {
      issues.push(`蓝图未覆盖 cap：缺 ${mustCover.filter((a) => !input.planBlueprint?.steps?.some((s) => s.agent === a)).join('、')}`)
    }
    if (blueprintRepeatsFullUserTask(input.planBlueprint, userTask)) {
      issues.push('蓝图多步 queryFocus 重复整段用户原话，须按子句/agent 拆分')
    }
  } else {
    issues.push(...crawlerWithoutBoundClause(input))
    issues.push(...crawlerMirrorsNonWebClause(input))
  }

  if (input.clauses.length === 1 && dataAgentCount <= 1 && input.planBlueprint?.steps && input.planBlueprint.steps.length >= 4) {
    issues.push('单源简单任务蓝图步数过多，可能过度流水线')
  }
  if (dataAgentCount === 1 && input.planBlueprint?.steps && input.planBlueprint.steps.length >= 2) {
    const sole =
      [...new Set((input.classify.dataSources ?? []).map(String).filter((d) => d === 'db' || d === 'rag'))][0] ||
      input.allowedAgents.find((a) => a === 'db' || a === 'rag')
    const steps = input.planBlueprint.steps
    const allSame =
      sole &&
      steps.every((s) => String((s as { agent?: string })?.agent || '').trim() === sole)
    if (allSame) {
      issues.push('单源同 agent 蓝图步数≥2，须折叠为一步')
    }
  }
  if (dataAgentCount === 1 && input.clauses.length >= 2) {
    const sole =
      [...new Set((input.classify.dataSources ?? []).map(String).filter((d) => d === 'db' || d === 'rag'))][0] ||
      input.allowedAgents.find((a) => a === 'db' || a === 'rag')
    const allSame =
      sole &&
      input.clauses.every((c) => {
        const agents = (c.agents ?? []).map(String)
        return agents.length > 0 && agents.every((a) => a === sole)
      })
    if (allSame) {
      issues.push('单源同 agent 子句数≥2，须折叠为一步')
    }
  }

  issues.push(...spuriousDownstreamAgents(input))
  issues.push(...lintWeatherBoundToCrawler({ clauses: input.clauses, planBlueprint: input.planBlueprint }))
  issues.push(...lintMapBoundToCrawler({ clauses: input.clauses, planBlueprint: input.planBlueprint }))

  return [...new Set(issues)]
}

export function orchestratorLintSeverity(issues: string[]): 'ok' | 'warn' | 'fail' {
  if (!issues.length) return 'ok'
  const critical = issues.some(
    (i) =>
      i.includes('未覆盖') ||
      i.includes('未含') ||
      i.includes('缺失') ||
      i.includes('重复整段') ||
      i.includes('未声明') ||
      i.includes('无 crawler 子句') ||
      i.includes('镜像非公网子句') ||
      i.includes('须改 admin') ||
      i.includes('get_weather') ||
      i.includes('须折叠为一步')
  )
  return critical ? 'fail' : 'warn'
}
