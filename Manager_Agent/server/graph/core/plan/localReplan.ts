/**
 * 执行中 Observation → 局部 Replan（LLM + Zod）。
 * 仅修订剩余 pending 步；不改已完成步；禁止关键词路由。
 */
import { z } from 'zod'
import type { Step } from '../../../utils/shared/taskPlan'
import { StepSchema } from '../../../utils/shared/taskPlan'
import { safeJsonParse } from '../shared/llmJson'
import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'
import { extractAdminSubtaskText } from '../stepIsolation/sanitize'
import { isGenericQueryFocus } from '../../../utils/route/managerSubAgentScopeLlm'
import { clipObsSummary, keepLastObservations } from '../shared/promptBudget'

const LocalReplanSchema = z.object({
  shouldReplan: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().max(300).optional(),
  remainingSteps: z
    .array(
      z.object({
        id: z.string().min(1).max(80).optional(),
        agent: StepSchema.shape.agent,
        query: z.string().min(1).max(2000),
        dependsOn: z.array(z.string().min(1)).optional(),
        optional: z.boolean().optional()
      })
    )
    .max(6)
    .optional()
})

export type LocalReplanDecision = z.infer<typeof LocalReplanSchema>

export function localReplanMaxPerRun(): number {
  const n = Number(process.env.MANAGER_LOCAL_REPLAN_MAX ?? '3')
  return Number.isFinite(n) && n >= 0 ? Math.min(5, Math.floor(n)) : 3
}

/**
 * A5：仍需根据 Observation 修订剩余计划，但已达本轮局部 replan 上限 → 强制回 Plan。
 */
export function shouldForcePlanRollback(input: {
  localReplanCount: number
  maxLocalReplans?: number
  wouldConsiderReplan: boolean
}): boolean {
  if (!input.wouldConsiderReplan) return false
  const max = typeof input.maxLocalReplans === 'number' ? input.maxLocalReplans : localReplanMaxPerRun()
  const n = Number(input.localReplanCount) || 0
  return n >= max
}

/** 从步骤列表剔除已熔断 Agent，避免 local replan / 人批计划写回空转 */
export function filterStepsExcludingCircuitAgents<T extends { agent?: string }>(
  steps: T[],
  circuitOpenAgents: Iterable<string>
): T[] {
  const open = new Set(
    [...circuitOpenAgents].map((a) => String(a || '').trim()).filter(Boolean)
  )
  if (!open.size) return steps
  return steps.filter((s) => !open.has(String(s.agent || '').trim()))
}

/**
 * 失败 Agent 已熔断时：不再为「再试同 Agent」烧 LLM。
 * - pending 去掉熔断 Agent 后仍有步 → 直接替换剩余（无 LLM）
 * - pending 实质只剩熔断 Agent → 应走 Plan HITL（由调用方 forceRollback）
 */
export function resolveCircuitBlockedReplan(input: {
  failedAgent: string
  pendingSteps: Step[]
  circuitOpenAgents: Iterable<string>
}): { kind: 'passthrough' } | { kind: 'strip_circuit'; kept: Step[]; skipped: Step[] } | { kind: 'force_plan_rollback'; skipped: Step[] } {
  const failed = String(input.failedAgent || '').trim()
  const open = new Set(
    [...input.circuitOpenAgents].map((a) => String(a || '').trim()).filter(Boolean)
  )
  if (!failed || !open.has(failed)) return { kind: 'passthrough' }

  const skipped = input.pendingSteps.filter((s) => open.has(String(s.agent || '').trim()))
  const kept = input.pendingSteps.filter((s) => !open.has(String(s.agent || '').trim()))
  if (!kept.length) return { kind: 'force_plan_rollback', skipped: skipped.length ? skipped : input.pendingSteps }
  return { kind: 'strip_circuit', kept, skipped }
}

export function shouldConsiderLocalReplan(input: {
  status?: string
  output?: string
  error?: string
  agent?: string
  /** 该 Agent 已 hard-down / 熔断 → 禁止烧 LLM replan */
  expertHardDown?: boolean
  circuitOpen?: boolean
}): boolean {
  if (input.expertHardDown || input.circuitOpen) return false
  const status = String(input.status || '').toLowerCase()
  if (status === 'error' || status === 'failed') return true
  const err = String(input.error || '').trim()
  if (err) return true
  const out = String(input.output || '').trim()
  if (!out || out.length < 12) return true
  return false
}

export type StepCompleteObservation = {
  step: Step
  status: string
  output?: string
  error?: string
}

/** 结构性纠偏：禁止 admin 伪 tool-call / preamble 写入剩余计划 */
function sanitizeAdminReplanQuery(query: string, userTask: string): string {
  const q = String(query || '').trim()
  const fromUser = extractAdminSubtaskText(userTask)
  const looksPseudoCall =
    /^[a-zA-Z_][\w]*\s*\(/.test(q) || q.includes('add_event(') || q.includes('add_reminder(')
  if (looksPseudoCall) return fromUser || q
  if (isGenericQueryFocus(q) || q.startsWith('仅处理下列')) return fromUser || extractAdminSubtaskText(q) || q
  const lean = extractAdminSubtaskText(q)
  return lean || fromUser || q
}

/**
 * 根据 Observation 修订剩余 pending 步。
 * confidence < 0.5 或 shouldReplan=false → null
 */
export async function llmLocalReplanRemaining(opts: {
  llmInvoke: LlmInvokeFn
  state: unknown
  question: string
  observation: StepCompleteObservation
  pendingSteps: Step[]
  completedSummaries: Array<{ id: string; agent: string; status: string; summary: string }>
  planConstraints?: string
  maxTotalSteps?: number
}): Promise<{ reason: string; remainingSteps: Step[] } | null> {
  const pending = Array.isArray(opts.pendingSteps) ? opts.pendingSteps : []
  if (!pending.length) return null
  if (!shouldConsiderLocalReplan(opts.observation)) return null

  const maxTotal = Math.max(1, Math.min(8, opts.maxTotalSteps ?? 8))
  const completedN = opts.completedSummaries.length
  const budget = Math.max(0, maxTotal - completedN)
  if (budget <= 0) return null

  const pendingLines = pending
    .map((s) => `- ${s.id} [${s.agent}] ${String(s.query || '').slice(0, 160)}`)
    .join('\n')
  const doneLines = keepLastObservations(opts.completedSummaries)
    .map((s) => `- ${s.id} [${s.agent}/${s.status}] ${clipObsSummary(s.summary).slice(0, 120)}`)
    .join('\n')

  try {
    const r = await opts.llmInvoke(
      'plan',
      opts.state,
      [
        [
          'system',
          [
            '你是执行中局部 replan 官。根据刚完成步骤的 Observation，决定是否修订**剩余未执行**步骤。',
            '只输出严格 JSON：',
            '{"shouldReplan":boolean,"confidence":0-1,"reason":"...","remainingSteps":[{"id":"...","agent":"db|rag|...","query":"...","dependsOn":[],"optional":false}]}',
            '规则：',
            '- 仅在失败、空结果、证据不足时 shouldReplan=true',
            '- remainingSteps 替换全部剩余 pending（可改写/删减/新增，条数≤预算）',
            '- 保留合理依赖；禁止编造权威数字；agent 必须是已有能力枚举',
            '- confidence<0.5 视为不修订',
            '- admin 的 query 必须是用户侧自然语言子任务（保留会议标题与时间表达），禁止写成 add_event(...) / tool(arg=...) 伪代码；工具选择由个人助手执行',
            '- admin 的 query 禁止只写能力边界/系统指令（如「仅处理下列个人助理能力」）'
          ].join('\n')
        ],
        [
          'human',
          [
            `用户目标：${String(opts.question || '').slice(0, 800)}`,
            opts.planConstraints ? `用户约束：${opts.planConstraints.slice(0, 400)}` : '',
            `刚完成：${opts.observation.step.id} [${opts.observation.step.agent}] status=${opts.observation.status}`,
            `输出摘要：${clipObsSummary(String(opts.observation.output || opts.observation.error || ''))}`,
            `已完成：\n${doneLines || '（无）'}`,
            `剩余 pending（预算≤${Math.min(budget, 6)}）：\n${pendingLines}`,
            `remainingSteps 最多 ${Math.min(budget, 6)} 条。`
          ]
            .filter(Boolean)
            .join('\n\n')
        ]
      ],
      { thinkingLabel: '局部修订计划' }
    )

    const parsed = LocalReplanSchema.safeParse(safeJsonParse(String(r.text || '').trim()))
    if (!parsed.success) return null
    if (!parsed.data.shouldReplan) return null
    if (Number(parsed.data.confidence ?? 0) < 0.5) return null
    const rawSteps = Array.isArray(parsed.data.remainingSteps) ? parsed.data.remainingSteps : []
    if (!rawSteps.length) return null

    const remainingSteps: Step[] = []
    const usedIds = new Set(opts.completedSummaries.map((c) => c.id))
    for (const raw of rawSteps.slice(0, Math.min(budget, 6))) {
      const agent = raw.agent
      let id = String(raw.id || '').trim() || `${agent}_re_${remainingSteps.length + 1}`
      while (usedIds.has(id)) id = `${id}_${remainingSteps.length + 1}`
      usedIds.add(id)
      const queryRaw = String(raw.query || '').trim()
      if (!queryRaw) continue
      const query =
        agent === 'admin' ? sanitizeAdminReplanQuery(queryRaw, String(opts.question || '')) : queryRaw
      if (!query) continue
      remainingSteps.push({
        id,
        agent,
        query: query.slice(0, 2000),
        dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter(Boolean).slice(0, 6) : undefined,
        optional: Boolean(raw.optional)
      })
    }
    if (!remainingSteps.length) return null
    return {
      reason: String(parsed.data.reason || 'observation_replan').slice(0, 300),
      remainingSteps
    }
  } catch {
    return null
  }
}

/** 纯函数：用新 remaining 替换 pending Map，并同步 steps 数组 */
export function applyRemainingStepsPatch(
  steps: Step[],
  pending: Map<string, Step>,
  remainingSteps: Step[],
  completedIds: Set<string>
): Step[] {
  for (const id of [...pending.keys()]) {
    pending.delete(id)
  }
  const kept = steps.filter((s) => completedIds.has(String(s.id || '').trim()) || !pending.has(String(s.id || '')))
  // rebuild: completed (in original order among completed) + new remaining
  const completedOrdered = steps.filter((s) => completedIds.has(String(s.id || '').trim()))
  const next = [...completedOrdered]
  for (const s of remainingSteps) {
    const id = String(s.id || '').trim()
    if (!id || completedIds.has(id)) continue
    if (next.some((x) => String(x.id) === id)) continue
    next.push(s)
    pending.set(id, s)
  }
  // mutate steps in place for fetcher loop
  steps.length = 0
  steps.push(...next)
  void kept
  return next
}
