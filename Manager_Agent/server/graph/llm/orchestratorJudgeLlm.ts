/**
 * 编排 Reflexion Judge（参考 LangGraph Plan-and-Execute / Reflexion）。
 * 模型审查 cap、子句、蓝图是否与用户末轮一致；失败时产出可重试的修正提示。
 */

import { z } from 'zod'
import { safeJsonParse } from '../core/shared/llmJson'
import type { LlmInvokeFn } from './taskConstraintsLlm'
import type { OrchestratorDecision } from '../orchestrate/orchestratorInvariants'
import { formatAgentBoundaryPromptCompact } from '../orchestrate/unifiedRouting'
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
            formatAgentBoundaryPromptCompact(),
            '【权威】仅【用户末轮】决定路由；Probe/经验不得扩大 Agent。',
            '审查项（delta）：',
            '1) 单源简单取数 → db_only/rag_only，禁无故加 clean/code/visualize/crawler；',
            '1b) 单源 DB 且要占比/计算 → cap 须含 code；',
            '2) 复合 → 每面子句独立、cap 覆盖；',
            '3) sourceCommitment=ambiguous → needsClarify；clear 锁面后禁因 Probe 翻面；',
            '4) 通道：未点公网天气/出行→admin；webFetchKind≠none→保留 crawler；站内点击→gui；',
            'accept=true 仅当与末轮一致且无遗漏/无过度流水线。',
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
