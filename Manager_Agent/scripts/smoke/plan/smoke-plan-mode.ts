/**
 * Plan Mode 契约回归：不拉 LLM / 外部 Agent。
 */
import {
  shouldRequirePlanPreview,
  buildPlanPreviewPayload,
  mergeConfirmedPlanSteps,
  planPreviewMinSteps,
  isPlanPreviewEnabled,
  resolvePlanApproveTier
} from '../../../server/graph/core/plan/planPreview'
import { waitPlanConfirm, resolvePlanConfirm, cancelPlanConfirmsForRun } from '../../../server/utils/shared/planConfirmBridge'
import type { Step } from '../../../server/utils/shared/taskPlan'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const sampleSteps: Step[] = [
  { id: 's1', agent: 'db', query: '查人数' },
  { id: 's2', agent: 'rag', query: '查制度' },
  { id: 's3', agent: 'report', query: '写汇总', dependsOn: ['s1', 's2'] }
]

// 单跳不强制 Plan Mode
assert(
  !shouldRequirePlanPreview({ intent: 'db', plan: [{ id: 'a', agent: 'db', query: 'x' }], meta: {} }),
  'single db should not require plan preview'
)
assert(
  !shouldRequirePlanPreview({ intent: 'rag', plan: [{ id: 'a', agent: 'rag', query: 'x' }], meta: {} }),
  'single rag should not require plan preview'
)

// multi 且步数达标 → 需要 preview（默认 auto）
process.env.MANAGER_PLAN_PREVIEW = 'auto'
assert(isPlanPreviewEnabled(), 'plan preview auto should be enabled')
assert(planPreviewMinSteps() >= 2, 'min steps >= 2')
assert(
  shouldRequirePlanPreview({ intent: 'multi', plan: sampleSteps, meta: {} }),
  'multi with enough steps should require preview'
)
assert(
  !shouldRequirePlanPreview({ intent: 'multi', plan: sampleSteps, meta: { planConfirmed: true } }),
  'confirmed plan should skip preview'
)

// P1-A 分层 Approve：写副作用 → strict；低风险短只读 → auto
assert(
  resolvePlanApproveTier({
    intent: 'multi',
    plan: [
      { id: 'a', agent: 'db', query: '查' },
      { id: 'b', agent: 'admin', query: '发邮件' }
    ],
    meta: {}
  }) === 'strict',
  'admin write side should be strict'
)
assert(
  resolvePlanApproveTier({
    intent: 'multi',
    plan: [
      { id: 'a', agent: 'db', query: '查A' },
      { id: 'b', agent: 'rag', query: '查B' }
    ],
    meta: { worldModelRisk: 0.1 }
  }) === 'auto',
  'low-risk short read-only should be auto'
)
assert(
  !shouldRequirePlanPreview({
    intent: 'multi',
    plan: [
      { id: 'a', agent: 'db', query: '查A' },
      { id: 'b', agent: 'rag', query: '查B' }
    ],
    meta: { worldModelRisk: 0.1 }
  }),
  'auto tier should skip plan preview'
)
assert(
  shouldRequirePlanPreview({
    intent: 'multi',
    plan: [
      { id: 'a', agent: 'db', query: '查' },
      { id: 'b', agent: 'gui', query: '点按钮' }
    ],
    meta: {}
  }),
  'gui write side should force preview'
)

/** B1：needsPlanPreview / suggestedPosture 强制预览；低风险单跳不回归 */
assert(
  shouldRequirePlanPreview({
    intent: 'multi',
    plan: [
      { id: 'a', agent: 'db', query: '查A' },
      { id: 'b', agent: 'rag', query: '查B' }
    ],
    meta: { worldModelRisk: 0.1, needsPlanPreview: true }
  }),
  'B1 needsPlanPreview forces even on auto tier'
)
assert(
  shouldRequirePlanPreview({
    intent: 'db',
    plan: [{ id: 'a', agent: 'db', query: '查' }],
    meta: { needsPlanPreview: true, upgradeConfidence: 0.9 }
  }),
  'B1 needsPlanPreview can force non-multi when steps exist'
)

// Plan/Todo 可见化：preview payload 含 todos
const previewTodos = buildPlanPreviewPayload(sampleSteps, 'r1', 'p1', {
  intent: 'multi',
  meta: { suggestedPosture: 'plan' }
})
assert(Array.isArray(previewTodos.todos) && previewTodos.todos.length === sampleSteps.length, 'preview has todos')
assert(previewTodos.todos.every((t) => t.status === 'pending'), 'todos pending by default')
assert(previewTodos.suggestedPosture === 'plan', 'preview surfaces suggestedPosture')

// 确认后改写 query + 跳过一步
const merged = mergeConfirmedPlanSteps(sampleSteps, [
  { id: 's1', agent: 'db', query: '查本月人数', enabled: true },
  { id: 's2', agent: 'rag', query: '查制度', enabled: false },
  { id: 's3', agent: 'report', query: '写汇总（仅用库表）', enabled: true }
])
assert(merged.length === 2, 'disabled step should be dropped')
assert(merged[0]?.query === '查本月人数', 'query rewrite should stick')
assert(merged[1]?.agent === 'report', 'report step kept')
assert(Array.isArray(merged[1]?.dependsOn), 'dependsOn preserved from original')

const payload = buildPlanPreviewPayload(sampleSteps, 'run_1', 'prev_1', {
  intent: 'multi',
  meta: { planConstraints: '只用正式制度' }
})
assert(payload.hint.includes('Plan Mode'), 'hint should mention Plan Mode')
assert(payload.constraints === '只用正式制度', 'constraints echoed in payload')
assert(payload.steps.every((s) => s.enabled), 'preview steps start enabled')

// confirm bridge：未确认 resolve 失败；确认后成功
const waitP = waitPlanConfirm('run_bridge', 'prev_bridge', 2000)
const ok = resolvePlanConfirm('run_bridge', 'prev_bridge', {
  action: 'execute',
  steps: merged,
  constraints: '优先库表'
})
assert(ok, 'resolvePlanConfirm should hit waiter')
const decision = await waitP
assert(decision.action === 'execute', 'decision execute')
if (decision.action === 'execute') {
  assert(decision.constraints === '优先库表', 'constraints passed through bridge')
  assert((decision.steps?.length || 0) === 2, 'steps passed through bridge')
}

// cancel 干净结束
const waitCancel = waitPlanConfirm('run_c', 'prev_c', 2000)
cancelPlanConfirmsForRun('run_c')
const cancelled = await waitCancel
assert(cancelled.action === 'cancel', 'cancelPlanConfirmsForRun should cancel')

console.log('smoke-plan-mode: ok')
