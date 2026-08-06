/**
 * 编排 Reflexion Judge（参考 LangGraph Plan-and-Execute / Reflexion）。
 * 模型审查 cap、子句、蓝图是否与用户末轮一致；失败时产出可重试的修正提示。
 */

import { z } from 'zod'
import { safeJsonParse } from '../core/shared/llmJson'
import type { LlmInvokeFn } from './taskConstraintsLlm'
import type { OrchestratorDecision } from '../orchestrate/orchestratorInvariants'
import { formatAgentBoundaryPrompt, formatAdminCrawlerDisambiguationPrompt } from '../orchestrate/unifiedRouting'
import { routingDecisionLlmTier } from '../core/shared/modelTier'
import { resolveManagerEnvBool } from '../../utils/platform/managerEnvModes'

const JudgeSchema = z.object({
  accept: z.boolean(),
  issues: z.array(z.string()).max(8).default([]),
  fixHint: z.string().max(900).optional(),
  confidence: z.number().min(0).max(1).default(0.7),
  rationale: z.string().max(520).default('')
})

export type OrchestratorJudgeResult = {
  accept: boolean
  issues: string[]
  fixHint?: string
  confidence: number
  rationale: string
}

export function isOrchestratorJudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagerEnvBool('MANAGER_ORCHESTRATOR_JUDGE', env)
}

function formatDecisionForJudge(decision: OrchestratorDecision): string {
  const bp = decision.planBlueprint?.steps
    ?.map(
      (s, i) =>
        `${i + 1}. ${s.agent}：${String(s.queryFocus || '').slice(0, 120)}${s.clauseIds?.length ? ` [${s.clauseIds.join(',')}]` : ''}`
    )
    .join('\n')
  const clauses = decision.clauses
    .map((c) => `${c.id}: ${c.text.slice(0, 100)}${c.agents?.length ? ` → ${c.agents.join('+')}` : ''}`)
    .join('\n')
  return [
    `intent=${decision.intent}`,
    `allowedAgents=${decision.allowedAgents.join('→')}`,
    `dataSources=${(decision.intentClassify.dataSources || []).join('+') || '—'}`,
    `planShortcut=${decision.intentClassify.planShortcut}`,
    `isDbAnchored=${decision.intentClassify.isDbAnchored}`,
    `requiresAgentPipeline=${decision.intentClassify.requiresAgentPipeline}`,
    `子句:\n${clauses || '（无）'}`,
    `蓝图:\n${bp || '（无）'}`
  ].join('\n')
}

/**
 * LLM 审查编排决策；structuralIssues 来自确定性 lint，一并交给模型综合判断。
 */
export async function judgeOrchestratorDecision(input: {
  userTask: string
  decision: OrchestratorDecision
  structuralIssues?: string[]
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<OrchestratorJudgeResult> {
  const userTask = String(input.userTask || '').trim()
  const structural = (input.structuralIssues ?? []).filter(Boolean)

  if (!isOrchestratorJudgeEnabled()) {
    return {
      accept: structural.length === 0,
      issues: structural,
      confidence: structural.length ? 0.5 : 0.9,
      rationale: 'judge_disabled'
    }
  }

  try {
    const r = await input.llmInvoke(
      'route',
      input.state,
      [
        [
          'system',
          [
            '你是总管 Agent 的「编排审查员」（Semantic Router + Plan-and-Execute Reflexion）。',
            formatAgentBoundaryPrompt(),
            '【权威】仅【用户末轮】决定路由；Probe/经验不得扩大 Agent。',
            formatAdminCrawlerDisambiguationPrompt(),
            '审查项：',
            '1) 单源简单问句（如人口统计/SQL 查数）→ 应 db_only/rag_only，禁止无故加 clean/code/visualize/crawler；',
            '1b) 单源 DB 但问句含占比/比例/计算/汇总指标 → cap 须含 code，planShortcut=none；',
            '2) 复合问句（知识库+数据库+公网+出图）→ 每数据面子句独立、cap 含全部数据面、蓝图每步 queryFocus 不复制整段原话；',
            '3) 用户明确「知识库」→ cap 须含 rag；明确「数据库/查库」→ 须含 db 且 isDbAnchored=true；',
            '3b) taskIntent=document_retrieval（规范/标准/配比/津贴/补贴/护理要求）→ 须 rag_only，禁止仅因 Probe 命中养老业务表改 db；「分别是什么」仍可为单源 rag 并列条文。',
            '3c) taskIntent=structured_query（记录/统计/某人档案）→ db；Probe 表命中 ≠ structured_query。',
            '4) db 与 rag 是不同数据面，禁止因 Probe 命中文档就加 rag（除非用户要知识库或 taskIntent=document_retrieval）。',
            '5) 用户末轮含天气预报/气温/今日天气 → 须 admin（get_weather），禁止 crawler/needsWeb；若蓝图把天气标为 crawler 则 reject。',
            '5a) 用户末轮含地铁/公交/从A到B/多久到/出行耗时 → 须单一 admin（get_travel_route），禁止 crawler/needsWeb；「查一下」≠ 公网抓取；若蓝图把出行标为 crawler 或 crawler+admin 双步则 reject。',
            '5b) 用户已标明「知识库查…」「数据库查…」→ 禁止再为同义内容加 crawler；显式知识库/数据库子句 ≠ 公网政策正文；无独立公网子句却含 crawler/needsWeb → reject。',
            '5c) 蓝图每步 queryFocus 须为该 agent 子句片段，禁止复制整段用户原话分发给子 Agent。',
            '6) 浏览器交互（打开站点、站内搜索、点选/打开第 N 条、登录、填表、在页面内提取）→ **gui**，禁止 crawler/needsWeb/web_search；',
            '   例：「去百度搜索并打开第一条」「打开百度搜索 X 提取第一条」→ allowedAgents=[gui], needsWeb=false；',
            '7) 公网参考/政策正文/列表字段**静态抽取**（无浏览器操作）→ crawler + needsWeb=true，禁止 gui。',
            'accept=true 仅当编排与用户末轮语义一致且无遗漏/无过度流水线。',
            '只输出 JSON，无 markdown。'
          ].join('\n')
        ],
        [
          'human',
          [
            `【用户末轮】\n${userTask.slice(0, 1200)}`,
            `【当前编排】\n${formatDecisionForJudge(input.decision)}`,
            structural.length ? `【结构性 lint】\n${structural.join('\n')}` : '',
            'schema: {"accept":bool,"issues":["..."],"fixHint":"若 reject 给出一句修正指引","confidence":0-1,"rationale":"..."}'
          ]
            .filter(Boolean)
            .join('\n\n')
        ]
      ],
      { tier: routingDecisionLlmTier(input.state) }
    )
    const parsed = JudgeSchema.safeParse(safeJsonParse(String(r.text ?? '').trim()))
    if (!parsed.success) {
      return {
        accept: structural.length === 0,
        issues: structural.length ? structural : ['judge_parse_failed'],
        confidence: 0.45,
        rationale: 'judge JSON 解析失败'
      }
    }
    const mergedIssues = [...new Set([...structural, ...parsed.data.issues])]
    return {
      accept: parsed.data.accept && orchestratorLintAcceptable(mergedIssues, parsed.data.accept),
      issues: mergedIssues,
      fixHint: parsed.data.fixHint,
      confidence: parsed.data.confidence,
      rationale: parsed.data.rationale
    }
  } catch (e) {
    return {
      accept: structural.length === 0,
      issues: structural,
      confidence: 0.4,
      rationale: e instanceof Error ? e.message : 'judge_error'
    }
  }
}

function orchestratorLintAcceptable(issues: string[], modelAccept: boolean): boolean {
  if (!modelAccept) return false
  const critical = issues.some(
    (i) =>
      i.includes('未覆盖') ||
      i.includes('未含') ||
      i.includes('缺失') ||
      i.includes('重复整段') ||
      i.includes('未声明') ||
      i.includes('步数过多')
  )
  return !critical
}
