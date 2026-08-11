/**
 * A1 协作姿态合同回归：不拉 LLM / 外部 Agent。
 */
import {
  assertPostureAllows,
  filterAgentsForPosture,
  hasDebugObservations,
  hasExplicitCollaborationPosture,
  postureAllowsDebugRerun,
  postureBlocksWriteSideEffects,
  postureForcesReadOnly,
  postureRequiresPlanPreview,
  resolveCollaborationPosture,
  resolveEffectiveCollaborationPosture
} from '../../../server/utils/platform/collaborationPosture'
import { shouldRequirePlanPreview } from '../../../server/graph/core/plan/planPreview'
import {
  llmUpgradeRequiresPlanPreview,
  planUpgradeMetaFromRaw
} from '../../../server/graph/core/plan/planUpgrade'
import type { Step } from '../../../server/utils/shared/taskPlan'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

assert(resolveCollaborationPosture({}) === 'agent', 'default posture is agent')
assert(resolveCollaborationPosture({ collaborationPosture: 'ask' }) === 'ask', 'meta posture ask')
assert(
  resolveCollaborationPosture({ clientContext: { collaborationPosture: 'plan' } }) === 'plan',
  'clientContext posture plan'
)
assert(
  resolveCollaborationPosture({
    collaborationPosture: 'debug',
    clientContext: { collaborationPosture: 'ask' }
  }) === 'debug',
  'meta wins over clientContext'
)

assert(!hasExplicitCollaborationPosture({ suggestedPosture: 'ask' }), 'suggested not explicit')
assert(resolveEffectiveCollaborationPosture({ suggestedPosture: 'ask' }) === 'ask', 'effective from suggested')
assert(
  resolveEffectiveCollaborationPosture({ collaborationPosture: 'agent', suggestedPosture: 'ask' }) === 'agent',
  'explicit beats suggested'
)

assert(postureForcesReadOnly('ask') && postureForcesReadOnly('debug'), 'ask/debug force read_only')
assert(!postureForcesReadOnly('agent') && !postureForcesReadOnly('plan'), 'agent/plan not always read_only')
assert(postureBlocksWriteSideEffects('ask'), 'ask blocks write')
assert(!assertPostureAllows('ask', 'write_admin').ok, 'ask blocks admin write')
assert(!assertPostureAllows('ask', 'code_edit_apply').ok, 'ask blocks code edit apply')
assert(assertPostureAllows('agent', 'write_admin').ok, 'agent allows admin write gate')

assert(
  filterAgentsForPosture(['db', 'admin', 'rag', 'gui'], 'ask').join(',') === 'db,rag',
  'ask filters write agents'
)
assert(
  filterAgentsForPosture(['db', 'admin'], 'agent').join(',') === 'db,admin',
  'agent keeps admin'
)

assert(postureRequiresPlanPreview('plan', {}), 'plan posture requires preview')
assert(!postureRequiresPlanPreview('plan', { planConfirmed: true }), 'confirmed skips plan posture gate')
assert(!postureRequiresPlanPreview('agent', {}), 'agent posture alone does not force preview')

process.env.MANAGER_PLAN_PREVIEW = 'auto'
const twoRead: Step[] = [
  { id: 'a', agent: 'db', query: '查A' },
  { id: 'b', agent: 'rag', query: '查B' }
]
assert(
  !shouldRequirePlanPreview({
    intent: 'multi',
    plan: twoRead,
    meta: { worldModelRisk: 0.1 }
  }),
  'low-risk auto still skips without plan posture'
)
assert(
  shouldRequirePlanPreview({
    intent: 'multi',
    plan: twoRead,
    meta: { worldModelRisk: 0.1, collaborationPosture: 'plan' }
  }),
  'plan posture forces preview over auto tier'
)

/** B1：编排升档信号与门禁求或 */
assert(
  shouldRequirePlanPreview({
    intent: 'multi',
    plan: twoRead,
    meta: { worldModelRisk: 0.1, needsPlanPreview: true, upgradeConfidence: 0.9 }
  }),
  'needsPlanPreview forces preview on low-risk auto'
)
assert(
  shouldRequirePlanPreview({
    intent: 'multi',
    plan: twoRead,
    meta: { worldModelRisk: 0.1, suggestedPosture: 'plan', upgradeConfidence: 0.9 }
  }),
  'suggestedPosture=plan forces preview'
)
assert(
  !shouldRequirePlanPreview({
    intent: 'multi',
    plan: twoRead,
    meta: {
      worldModelRisk: 0.1,
      needsPlanPreview: false,
      suggestedPosture: 'agent',
      upgradeConfidence: 0.3,
      complexity: 'low'
    }
  }),
  'low-confidence low-risk read-only does not force preview'
)
assert(
  shouldRequirePlanPreview({
    intent: 'multi',
    plan: [
      { id: 'a', agent: 'db', query: '查' },
      { id: 'b', agent: 'admin', query: '发信' }
    ],
    meta: {
      needsPlanPreview: false,
      suggestedPosture: 'agent',
      upgradeConfidence: 0.3,
      complexity: 'mid'
    }
  }),
  'low-confidence with write side conservatively forces preview'
)
assert(
  !shouldRequirePlanPreview({
    intent: 'db',
    plan: [{ id: 'a', agent: 'db', query: '查人数' }],
    meta: { needsPlanPreview: false, suggestedPosture: 'agent', complexity: 'low' }
  }),
  'single-hop read-only without upgrade still skips'
)

/** B1：编排 raw → meta patch → 门禁可读 */
const upgradeMeta = planUpgradeMetaFromRaw({
  complexity: 'high',
  needsPlanPreview: true,
  suggestedPosture: 'plan',
  upgradeReason: '多源写路径',
  upgradeConfidence: 0.88
})
assert(upgradeMeta.needsPlanPreview === true, 'meta patch needsPlanPreview')
assert(upgradeMeta.suggestedPosture === 'plan', 'meta patch suggestedPosture')
assert(upgradeMeta.complexity === 'high', 'meta patch complexity')
assert(Number(upgradeMeta.upgradeConfidence) === 0.88, 'meta patch upgradeConfidence')
assert(
  llmUpgradeRequiresPlanPreview({
    intent: 'multi',
    plan: twoRead,
    meta: { worldModelRisk: 0.1, ...upgradeMeta }
  }),
  'planUpgradeMetaFromRaw fields drive llmUpgradeRequiresPlanPreview'
)
assert(
  shouldRequirePlanPreview({
    intent: 'multi',
    plan: twoRead,
    meta: { worldModelRisk: 0.1, ...upgradeMeta }
  }),
  'planUpgradeMetaFromRaw fields drive shouldRequirePlanPreview'
)

assert(!hasDebugObservations({}), 'empty meta has no observations')
assert(!postureAllowsDebugRerun('debug', {}), 'debug without observation blocked')
assert(
  postureAllowsDebugRerun('debug', {
    stepRecords: [{ id: 's1', agent: 'db', status: 'failed', summary: 'empty' }]
  }),
  'debug with stepRecords allowed'
)
assert(!assertPostureAllows('debug', 'write_gui', {}).ok, 'debug without obs blocks write')
assert(
  assertPostureAllows('debug', 'read', {
    lastStepRecords: [{ id: 's1', agent: 'db', status: 'ok' }]
  }).ok,
  'debug with obs allows read'
)

console.log('smoke-collaboration-posture: ok')
