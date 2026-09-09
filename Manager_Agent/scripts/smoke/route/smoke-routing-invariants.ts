/**
 * 不可破坏契约护栏（Phase A）：单源透传 / 真 multi / 步进 session / packs 按需挂载。
 * CI：npm run smoke:routing-invariants
 */
import {
  isSingleSourceDbTask,
  isSingleSourceRagTask,
  isTrueMultiTask,
  resolveSubAgentStepSessionId
} from '../../../server/graph/core/routing/subAgentPassthrough'
import { assembleOrchestratorSystemPrompt, ORCH_PACK_MARKERS } from '../../../server/graph/llm/orchestratorPromptProfiles'
import { coerceTaskForm, formatTaskFormHint, TaskFormFieldSchema } from '../../../server/graph/core/routing/taskForms'
import { extractOrchestratorSlotHints } from '../../../server/graph/llm/taskOrchestrator/schemas'
import {
  buildSoftHandoffFromStep,
  formatSoftHandoffsForContinuation,
  mergeSoftHandoffsIntoMeta
} from '../../../server/graph/core/routing/softHandoff'
import { buildPlanPreviewPayload } from '../../../server/graph/core/plan/planPreview'
import {
  hasExplicitCollaborationPosture,
  resolveEffectiveCollaborationPosture
} from '../../../server/utils/platform/collaborationPosture'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-routing-invariants] ${msg}`)
}

console.log('smoke-routing-invariants: start')

// C1 单源判定
assert(isSingleSourceDbTask({ intent: 'db', allowedAgents: ['db'] }), 'C1 db intent')
assert(isSingleSourceDbTask({ planShortcut: 'db_only', allowedAgents: ['db', 'code'] }), 'C1 db_only+code still single')
assert(isSingleSourceRagTask({ intent: 'rag', allowedAgents: ['rag'] }), 'C1 rag intent')
assert(isSingleSourceRagTask({ planShortcut: 'rag_only' }), 'C1 rag_only')

// C2 真 multi vs 假 multi
assert(!isTrueMultiTask({ planShortcut: 'db_only', allowedAgents: ['db'] }), 'C2 fake multi db_only')
assert(
  isTrueMultiTask({
    allowedAgents: ['db', 'rag'],
    planBlueprint: { steps: [{ agent: 'db' }, { agent: 'rag' }] }
  }),
  'C2 true multi two planes'
)

// C3 步进 session
assert(resolveSubAgentStepSessionId({ runId: 'r', agent: 'db' }) === 'mgr-r-db', 'C3 db session')
assert(
  resolveSubAgentStepSessionId({ runId: 'r', agent: 'rag', stepId: 'c1' }) === 'mgr-r-rag-c1',
  'C3 rag step session'
)
assert(!resolveSubAgentStepSessionId({ runId: 'r', agent: 'db' }).includes('mgr-session'), 'C3 not manager sid')

// C4 packs 按需 + 无测试域绑定
const cold = assembleOrchestratorSystemPrompt({})
assert(cold.includes(ORCH_PACK_MARKERS.db_only), 'C4 cold mounts db_only')
assert(cold.includes(ORCH_PACK_MARKERS.gui_interact), 'C4 cold mounts gui_interact')
assert(!cold.includes(ORCH_PACK_MARKERS.multi_three), 'C4 cold omits multi_three')
assert(!/护理员配比|王建国|足底压力|个人月收入/.test(cold), 'C4 no test-domain few-shot')
assert(cold.includes('库存') || cold.includes('catalog') || cold.includes('db_catalog'), 'C4 teaches catalog inventory')
{
  const { assertNoDomainBleed } = await import('../fixtures/domainBleedDenyList')
  assertNoDomainBleed(cold, 'C4 cold assembleOrchestratorSystemPrompt')
}

const dbOnly = assembleOrchestratorSystemPrompt({ probeDbRelevant: true, probeRagHits: false })
assert(dbOnly.includes(ORCH_PACK_MARKERS.db_only), 'C4 db probe db_only')
assert(!dbOnly.includes(ORCH_PACK_MARKERS.multi_three), 'C4 db probe omits multi')

// taskForm 不得当 cap 闸
assert(coerceTaskForm('db_count') === 'db_count', 'taskForm coerce')
assert(coerceTaskForm('nope') === 'unknown', 'taskForm unknown')
assert(coerceTaskForm('hybrid') === undefined, 'taskIntent hybrid must not poison taskForm')
assert(coerceTaskForm('structured_query') === undefined, 'taskIntent collision dropped')
assert(formatTaskFormHint('db_count').includes('禁止据此扩'), 'taskForm hint warns no cap rewrite')
const hybridRaw = TaskFormFieldSchema.safeParse('hybrid')
assert(hybridRaw.success && hybridRaw.data === undefined, 'Zod field must accept hybrid without fail')
const slots = extractOrchestratorSlotHints({
  taskForm: 'hybrid',
  timeRange: { start: '2026-08-07', end: '2026-08-07', label: '今天' }
} as any)
assert(slots.taskForm === undefined, 'slot hints drop hybrid taskForm')
assert(slots.timeRange?.label === '今天', 'slot timeRange')

// Plan Todo 可见化
const preview = buildPlanPreviewPayload(
  [
    { id: 's1', agent: 'db', query: '查人数', taskForm: 'db_count' },
    { id: 's2', agent: 'rag', query: '查规范', taskForm: 'rag_standard' }
  ],
  'run1',
  'pv1',
  { intent: 'multi', meta: { suggestedPosture: 'plan' } }
)
assert(Array.isArray(preview.todos) && preview.todos.length === 2, 'plan todos present')
assert(preview.todos[0].title.includes('查人数'), 'todo title from query')
assert(preview.suggestedPosture === 'plan', 'preview carries suggestedPosture')

// 有效姿态：用户未选时采纳 suggestedPosture
assert(!hasExplicitCollaborationPosture({ suggestedPosture: 'ask' }), 'suggested is not explicit')
assert(resolveEffectiveCollaborationPosture({ suggestedPosture: 'ask' }) === 'ask', 'effective ask')
assert(
  resolveEffectiveCollaborationPosture({ collaborationPosture: 'agent', suggestedPosture: 'ask' }) === 'agent',
  'user explicit wins'
)

// softHandoff：父上下文只吃摘要，禁超长 raw
const longPad = 'RAWPAD'.repeat(400)
const sh = buildSoftHandoffFromStep({
  agent: 'db',
  stepId: 's1',
  ok: true,
  output: `共 42 人。${longPad}`,
  taskForm: 'db_count'
})
assert(sh.summary.includes('42'), 'soft handoff summary')
assert(sh.summary.length < longPad.length, 'soft handoff clips raw')
assert(sh.summary.length <= 700, 'soft handoff within budget')
const block = formatSoftHandoffsForContinuation([sh])
assert(block.includes('[HANDOFF:db]'), 'continuation soft handoff block')
assert(block.length < longPad.length, 'continuation block shorter than raw')
assert(!block.includes(longPad), 'continuation excludes full raw pad')
const merged = mergeSoftHandoffsIntoMeta({}, sh)
assert(merged.length === 1 && merged[0].stepId === 's1', 'merge softHandoffs')

console.log('smoke-routing-invariants: ok')
