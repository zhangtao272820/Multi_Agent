/**
 * 步级 Acceptance Gate 契约（不调 LLM）。
 */
import { acceptStepResult, taskBoardHasOpenMainSteps } from '../../../server/graph/core/plan/stepAcceptance'
import { buildTaskBoardFromSteps, applyAcceptanceToBoardItem } from '../../../server/graph/core/plan/taskBoard'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-step-acceptance] ${msg}`)
}

console.log('smoke-step-acceptance: start')

{
  const v = acceptStepResult({
    agent: 'db',
    status: 'ok',
    output: 'ok',
    agentResult: {
      ok: true,
      agent: 'db',
      answer: '3 rows',
      structured: { row_count: 3, rows: [{ a: 1 }] }
    }
  })
  assert(v.accepted === true, 'good db accepted')
  assert(v.boardStatus === 'success', 'success board')
}

{
  const v = acceptStepResult({
    agent: 'db',
    status: 'ok',
    output: 'empty',
    agentResult: {
      ok: true,
      agent: 'db',
      answer: '无',
      structured: { row_count: 0, rows: [] }
    }
  })
  assert(v.accepted === false, 'empty reject')
  assert(v.boardStatus === 'replan', 'empty → replan')
}

{
  const v = acceptStepResult({
    agent: 'rag',
    status: 'ok',
    output: 'partial',
    agentResult: {
      ok: true,
      agent: 'rag',
      answer: '见下',
      structured: { gaps: ['缺主题:报销流程'], self_check: { ok: false } }
    }
  })
  assert(v.accepted === false, 'gaps reject')
  assert(v.reason.includes('gaps') || v.reason === 'self_check_failed', 'gap or self_check')
}

{
  const v = acceptStepResult({
    agent: 'admin',
    status: 'ok',
    output: '请补充时间',
    agentResult: { ok: false, agent: 'admin', needs_clarify: true, answer: '请补充时间' }
  })
  assert(v.accepted === false, 'clarify reject')
}

{
  const board = buildTaskBoardFromSteps(
    [
      { id: 'a', agent: 'db', query: 'q1' },
      { id: 'b', agent: 'rag', query: 'q2' }
    ] as any,
    { a: { status: 'ok' }, b: { status: 'ok' } }
  )
  const patched = board.map((it, i) =>
    i === 1
      ? applyAcceptanceToBoardItem(it, false, 'replan')
      : applyAcceptanceToBoardItem(it, true, 'success')
  )
  assert(patched[1]!.status === 'replan', 'board replan')
  assert(taskBoardHasOpenMainSteps(patched) === true, 'open main')
}

console.log('smoke-step-acceptance: ok')
