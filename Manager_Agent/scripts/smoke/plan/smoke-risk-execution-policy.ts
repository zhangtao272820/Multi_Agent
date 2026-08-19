/**
 * A3 风险→执行策略表回归：不拉 LLM / 外部 Agent。
 */
import {
  gateCopy,
  inferActionKindFromAgent,
  planGateRequiresPreview,
  resolveRiskExecutionPolicy
} from '../../../server/graph/core/policy/riskExecutionPolicy'
import { resolveAdminAutoConfirm } from '../../../server/graph/core/db/writeGate'
import { shouldRequirePlanPreview } from '../../../server/graph/core/plan/planPreview'
import type { Step } from '../../../server/utils/shared/taskPlan'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const low = resolveRiskExecutionPolicy({ actionKind: 'readonly', meta: {} })
assert(low.tier === 'low', 'readonly is low')
assert(low.planGate === 'skip', 'low plan skip')
assert(low.actionGate === 'none', 'low action none')
assert(low.allowAutoConfirm, 'low allows auto')
assert(low.blast_radius === 't0', 'readonly blast t0')

const mid = resolveRiskExecutionPolicy({
  actionKind: 'multi_aggregate',
  meta: {},
  worldModelRisk: 0.45
})
assert(mid.tier === 'medium', 'multi aggregate medium')
assert(mid.planGate === 'preview', 'medium plan preview')
assert(!mid.allowAutoConfirm, 'medium no auto')

const highAdmin = resolveRiskExecutionPolicy({
  actionKind: 'admin_write',
  meta: {},
  securityRiskLevel: 'low'
})
assert(highAdmin.tier === 'high', 'admin_write is high')
assert(highAdmin.actionGate === 'require_confirm', 'high require confirm')
assert(!highAdmin.allowAutoConfirm, 'high ban auto')
assert(!highAdmin.preferDryRun, 'high no dry-run prefer')
assert(highAdmin.blast_radius === 't2', 'admin_write blast t2')

const codeDry = resolveRiskExecutionPolicy({
  actionKind: 'code_edit',
  meta: {},
  securityRiskLevel: 'low',
  worldModelRisk: 0.2
})
assert(codeDry.tier === 'medium', 'code_edit base medium')
assert(codeDry.preferDryRun, 'code_edit prefers dry-run')
assert(codeDry.actionGate === 'dry_run_then_confirm', 'code_edit dry-run then confirm')
assert(!codeDry.allowAutoConfirm, 'code_edit no auto')
assert(codeDry.blast_radius === 't1', 'code_edit blast t1')

assert(inferActionKindFromAgent('db') === 'readonly', 'db readonly')
assert(inferActionKindFromAgent('admin') === 'admin_write', 'admin write')
assert(inferActionKindFromAgent('admin', { readOnly: true }) === 'readonly', 'admin readOnly')
assert(gateCopy('dry_run').includes('试跑'), 'dry-run copy')
assert(gateCopy('action').includes('副作用'), 'action copy')
assert(gateCopy('plan').includes('执行'), 'plan copy')

const askBlock = resolveRiskExecutionPolicy({
  actionKind: 'admin_write',
  meta: { collaborationPosture: 'ask' }
})
assert(!askBlock.allowAutoConfirm, 'ask posture bans auto')
assert(askBlock.actionGate === 'require_confirm', 'ask + write still gated')

process.env.MANAGER_ADMIN_WRITE_GATE = '1'
assert(
  !resolveAdminAutoConfirm({ meta: { security: { riskLevel: 'high' } } }, '发邮件给张三'),
  'high security bans admin auto'
)
assert(
  !resolveAdminAutoConfirm({ meta: { collaborationPosture: 'ask' } }, '发邮件'),
  'ask posture bans admin auto via policy'
)

process.env.MANAGER_PLAN_PREVIEW = 'auto'
const writeSteps: Step[] = [
  { id: 'a', agent: 'db', query: '查' },
  { id: 'b', agent: 'admin', query: '发邮件' }
]
assert(
  shouldRequirePlanPreview({
    intent: 'multi',
    plan: writeSteps,
    meta: { security: { riskLevel: 'high' } }
  }),
  'high risk write forces plan preview'
)

const forceHigh = resolveRiskExecutionPolicy({
  actionKind: 'gui_write',
  meta: {},
  securityRiskLevel: 'high'
})
assert(planGateRequiresPreview(forceHigh), 'high requires preview')
assert(!forceHigh.allowAutoConfirm, 'gui high no auto')

import {
  resolveAdminAutoConfirmDecision,
  buildAutoConfirmAuditMetric
} from '../../../server/graph/core/executors/autoConfirmAudit'

const allowWrites = resolveAdminAutoConfirmDecision(
  { meta: { allowRiskyWrites: true } },
  '发邮件给王五'
)
assert(allowWrites.autoConfirm && allowWrites.reason === 'allowRiskyWrites', 'audit reason allowRiskyWrites')
const auditMetric = buildAutoConfirmAuditMetric({
  runId: 'smoke-risk-audit',
  reason: allowWrites.reason,
  autoConfirm: true,
  step: '发邮件给王五'
})
assert(auditMetric.phase === 'auto_confirm_audit', 'audit metric phase')
assert((auditMetric.extra as { auto_confirm_risky?: boolean }).auto_confirm_risky === true, 'audit flag')

const scheduleHitl = resolveAdminAutoConfirmDecision(
  { meta: { collaborationPosture: 'agent' } },
  '创建明天上午10点的会议日程，标题为「项目周会」，并设置会议提醒。'
)
assert(!scheduleHitl.autoConfirm, 'agent schedule must HITL (no silent auto_confirm)')
assert(
  !resolveAdminAutoConfirm(
    { meta: { collaborationPosture: 'agent' } },
    '创建明天上午10点的会议日程，标题为「项目周会」'
  ),
  'resolveAdminAutoConfirm schedule false under agent'
)
const emailDec = resolveAdminAutoConfirmDecision({ meta: { collaborationPosture: 'agent' } }, '发邮件给张三')
assert(!emailDec.autoConfirm, 'email still requires HITL under agent')
assert(
  !resolveAdminAutoConfirm({ meta: { collaborationPosture: 'ask' } }, '创建明天会议日程'),
  'ask posture still bans schedule auto'
)
const planConfirmed = resolveAdminAutoConfirmDecision(
  { meta: { collaborationPosture: 'plan', planConfirmed: true } },
  '添加待办：买菜'
)
assert(!planConfirmed.autoConfirm, 'plan confirmed todo still HITL (pending protocol)')

console.log('smoke-risk-execution-policy: ok')
