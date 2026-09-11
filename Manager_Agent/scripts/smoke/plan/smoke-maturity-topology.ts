/**
 * executionTopology + 升档 + 任务板契约（不调 LLM）。
 */
import {
  resolveExecutionTopology,
  resolveMaxParallelForTopology
} from '../../../server/graph/core/plan/executionTopology'
import {
  shouldEscalateRouteDecisionToMax,
  stateWithRouteEscalateHints
} from '../../../server/graph/core/routing/routeDecisionEscalate'
import { resolveRouteDecisionModelKind } from '../../../server/graph/core/shared/modelTier'
import {
  buildTaskBoardFromSteps,
  taskBoardMainPathComplete,
  formatTaskBoardForParent
} from '../../../server/graph/core/plan/taskBoard'
import type { Step } from '../../../server/utils/shared/taskPlan'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-maturity-topology] ${msg}`)
}

console.log('smoke-maturity-topology: start')

assert(resolveExecutionTopology({ orchestrationThickness: 'single_source' }) === 'solo', 'single → solo')
assert(
  resolveExecutionTopology({
    isMulti: true,
    allowedAgents: ['db', 'rag'],
    planSteps: [{ agent: 'db' }, { agent: 'rag' }]
  }) === 'parallel',
  'db∥rag → parallel'
)
assert(
  resolveExecutionTopology({
    isMulti: true,
    allowedAgents: ['db', 'rag', 'code'],
    planSteps: [
      { agent: 'db' },
      { agent: 'rag' },
      { agent: 'code', dependsOn: ['db', 'rag'] }
    ]
  }) === 'hub',
  'deps → hub'
)
assert(resolveExecutionTopology({ executionTopology: 'solo', isMulti: true }) === 'solo', 'LLM force solo')
assert(resolveExecutionTopology({ executionTopology: 'parallel_hub', isMulti: true }) === 'hub', 'alias parallel_hub→hub')
assert(resolveExecutionTopology({ executionTopology: 'fanout', isMulti: true }) === 'parallel', 'alias fanout→parallel')

{
  const { coerceExecutionTopology } = await import('../../../server/graph/core/plan/executionTopology')
  const { coerceTaskIntent, TaskOrchestratorSchema } = await import(
    '../../../server/graph/llm/taskOrchestrator/schemas'
  )
  assert(coerceExecutionTopology('parallel_hub') === 'hub', 'coerce parallel_hub')
  assert(coerceTaskIntent('hybrid_multi_source_analysis') === 'hybrid', 'coerce hybrid invent')
  const parsed = TaskOrchestratorSchema.safeParse({
    clauses: [{ text: '知识库与数据库对照并出图' }],
    routedQuery: '知识库与数据库对照并出图',
    taskIntent: 'hybrid_multi_source_analysis',
    executionTopology: 'parallel_hub',
    allowedAgents: ['rag', 'db', 'code'],
    suggestedAgents: ['rag', 'db', 'code']
  })
  assert(parsed.success, `schema must accept near-miss enums: ${parsed.success ? '' : parsed.error.message}`)
  assert(parsed.success && parsed.data.taskIntent === 'hybrid', 'parsed taskIntent hybrid')
  assert(parsed.success && parsed.data.executionTopology === 'hub', 'parsed topology hub')
}

{
  const steps = [
    { id: '1', agent: 'db', query: 'a' },
    { id: '2', agent: 'rag', query: 'b' }
  ] as Step[]
  assert(resolveMaxParallelForTopology({ topology: 'solo', steps }) === 1, 'solo parallel=1')
  assert(resolveMaxParallelForTopology({ topology: 'parallel', steps }) >= 2, 'parallel fan-out')
}

assert(
  !shouldEscalateRouteDecisionToMax({ meta: { sourceCommitment: 'clear', complexity: 'low' } }),
  'clear no escalate'
)
assert(
  shouldEscalateRouteDecisionToMax({ meta: { sourceCommitment: 'ambiguous' } }),
  'ambiguous escalate'
)
assert(shouldEscalateRouteDecisionToMax({ meta: { complexity: 'high' } }), 'high escalate')

{
  const hinted = stateWithRouteEscalateHints({ meta: {} }, { sourceCommitment: 'ambiguous' })
  assert(resolveRouteDecisionModelKind({} as NodeJS.ProcessEnv, hinted) === 'max', 'hinted → max kind')
  assert(
    resolveRouteDecisionModelKind({} as NodeJS.ProcessEnv, { meta: { sourceCommitment: 'clear' } }) ===
      'plus',
    'clear → plus kind'
  )
}

{
  const board = buildTaskBoardFromSteps(
    [
      { id: 'a', agent: 'db', query: '查人' },
      { id: 'b', agent: 'multimodal', query: '看图', optional: true }
    ] as Step[],
    { a: { status: 'ok' } }
  )
  assert(board[0].status === 'success', 'db done')
  assert(board[1].optional === true, 'optional step')
  assert(board[1].async !== true, 'no default async after music/video exit')
  assert(taskBoardMainPathComplete(board), 'main path complete')
  assert(formatTaskBoardForParent(board).includes('任务板'), 'board format')
}

console.log('smoke-maturity-topology: ok')
