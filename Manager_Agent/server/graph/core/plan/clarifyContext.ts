import type { Intent } from '../../../utils/shared/taskPlan'
import { textWantsVisualizeStructural } from '../../../utils/shared/visualizeMarkers'
import type { IntentClassifyResult } from '../../llm/intentClassifyLlm'

export type DbAnchorContext = {
  intentClassify?: Pick<IntentClassifyResult, 'isDbAnchored'> | null
  intent?: string
  probeDbMatched?: boolean
}

export type RagAnchorContext = {
  intentClassify?: Pick<
    IntentClassifyResult,
    | 'primaryIntent'
    | 'isDbAnchored'
    | 'planShortcut'
    | 'explicitWantsReport'
    | 'explicitWantsVisualize'
    | 'suggestedAgents'
  > | null
  intent?: string
}

/** 是否库表取数任务：由意图识别节点 / 路由 intent 判定，不用关键词表 */
export function isDbAnchoredTaskText(_text: string, ctx?: DbAnchorContext): boolean {
  if (ctx?.intentClassify?.isDbAnchored === true) return true
  if (ctx?.intentClassify?.isDbAnchored === false) return false
  if (String(ctx?.intent || '').trim() === 'db') return true
  return false
}

/** 是否知识库/文档检索任务：由意图识别节点 / 路由 intent 判定，不用关键词表 */
export function isRagAnchoredTaskText(_text: string, ctx?: RagAnchorContext): boolean {
  if (ctx?.intentClassify?.isDbAnchored === true) return false
  if (ctx?.intentClassify?.planShortcut === 'rag_only') return true
  if (ctx?.intentClassify?.primaryIntent === 'rag') return true
  const agents = ctx?.intentClassify?.suggestedAgents ?? []
  if (agents.length === 1 && agents[0] === 'rag') return true
  if (String(ctx?.intent || '').trim() === 'rag') return true
  if (looksLikeSimpleRagKbQuery(_text)) return true
  return false
}

/**
 * 结构性：纯知识库检索问句（无报告/图表/办公并列子目标）。
 * 用于在 intentClassify 尚未产出前纠正误判 wantsReport 与 experience 快路径污染。
 */
export function looksLikeSimpleRagKbQuery(text: string): boolean {
  const s = String(text || '').trim()
  if (!s || s.length > 200) return false
  const hasKb = /知识库|文档库|手册|制度|内部资料|知识库中|文档中|从知识库|在知识库/.test(s)
  if (!hasKb) return false
  // 并列出图/报告 → 非「纯检索」；图表类型词走 VISUALIZE_MARKERS SSOT
  if (textWantsVisualizeStructural(s)) return false
  if (/生成.{0,6}报告|写.{0,4}报告|分析报告|整理成报告|输出报告/.test(s)) return false
  if (/查完.{0,10}后|然后.{0,8}(创建|安排|邮件|待办|会议|日程)/.test(s)) return false
  return true
}

export function userExplicitlyWantsPipelineOutput(text: string): boolean {
  const s = String(text || '').trim()
  if (!s) return false
  if (textWantsVisualizeStructural(s)) return true
  return /生成.{0,6}报告|写.{0,4}报告|分析报告|整理成报告|输出报告/.test(s)
}

export function hasNamedSubjectForClarify(text: string, entityNames: string[]): boolean {
  const names = entityNames.map((n) => String(n || '').trim()).filter(Boolean)
  if (!names.length) return false
  const s = String(text || '')
  return names.some((name) => name.length >= 2 && s.includes(name))
}

export function isPlanEntityMissingIssue(issue: string): boolean {
  return String(issue || '').includes('关键实体丢失')
}

export type ClarifyQuestionContext = {
  text: string
  timeHints: string[]
  subjectHints: string[]
  entityNames: string[]
  planIssues?: string[]
  intent?: Intent
  probeDbMatched?: boolean
  intentClassify?: Pick<IntentClassifyResult, 'isDbAnchored'> | null
}

/** 生成澄清问题（无正则；依赖路由/规划已抽取的实体与结构化约束） */
export function buildClarifyQuestionsFromContext(ctx: ClarifyQuestionContext): string[] {
  const qs: string[] = []
  const names = [...new Set([...ctx.entityNames, ...ctx.subjectHints].map((x) => String(x || '').trim()).filter(Boolean))]
  const hasSubject = hasNamedSubjectForClarify(ctx.text, names) || names.length > 0
  const dbTask =
    isDbAnchoredTaskText(ctx.text, {
      intentClassify: ctx.intentClassify,
      intent: ctx.intent,
      probeDbMatched: ctx.probeDbMatched
    }) ||
    ctx.intent === 'db' ||
    ctx.intent === 'multi' ||
    Boolean(ctx.probeDbMatched)

  const entityMissingOnly =
    Array.isArray(ctx.planIssues) &&
    ctx.planIssues.length > 0 &&
    ctx.planIssues.every((i) => isPlanEntityMissingIssue(String(i || '')))

  if (entityMissingOnly && hasSubject && dbTask) {
    return []
  }

  if (!ctx.timeHints.length) {
    if (!(hasSubject && dbTask)) {
      qs.push('请补充时间范围（例如近3个月/2025年Q1）；不补充则默认查询该对象全部可用记录。')
    }
  }
  if (!hasSubject) {
    qs.push('请补充对象标识（例如姓名、编号、项目ID）。')
  }
  return qs.slice(0, 4)
}
