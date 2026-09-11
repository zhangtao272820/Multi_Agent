/**
 * 成熟 UI 人话标签契约（不调 LLM）。
 */
import {
  formatAcceptanceRateZh,
  humanizeAcceptanceReason,
  humanizedBoardTipsByAgent,
  parseMaturitySliPayload,
  parseTaskBoardPayload,
  patchTaskBoardItemStatus,
  stepBoardStatusLabelZh,
  topologyLabelZh
} from '../../../app/composables/managerMaturityUi'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-maturity-ui] ${msg}`)
}

console.log('smoke-maturity-ui: start')

assert(stepBoardStatusLabelZh('replan') === '调整中', 'replan zh')
assert(stepBoardStatusLabelZh('success') === '已完成', 'success zh')
assert(humanizeAcceptanceReason('empty_evidence').includes('有效结果'), 'empty human')
assert(!humanizeAcceptanceReason('empty_evidence').includes('empty_evidence'), 'no raw code')
assert(topologyLabelZh('hub') === '主从协同', 'hub')
assert(formatAcceptanceRateZh(0.856) === '86%', 'rate')

{
  const p = parseTaskBoardPayload({
    topology: 'parallel',
    items: [{ id: '1', agent: 'db', query: '查数', status: 'running' }]
  })
  assert(p?.items.length === 1, 'parse board')
  const patched = patchTaskBoardItemStatus(p!.items, {
    stepId: '1',
    status: 'replan',
    error: 'empty_evidence'
  })
  assert(patched[0]!.status === 'replan', 'patch replan')
  assert(patched[0]!.reason === 'empty_evidence', 'keep reason')
  const tips = humanizedBoardTipsByAgent(patched)
  assert(tips.db?.includes('有效结果'), 'board tip human')
  assert(!JSON.stringify(tips).includes('empty_evidence'), 'tip no raw')
}

{
  const s = parseMaturitySliPayload({
    stepsTotal: 3,
    stepsAccepted: 2,
    stepsReplan: 1,
    stepsFailed: 0,
    acceptanceRate: 0.667,
    briefAttached: 1,
    specialistRoundsP95: 2,
    localReplanCount: 1,
    raceEnabled: false
  })
  assert(s?.raceEnabled === false, 'race off')
  assert(s?.stepsAccepted === 2, 'accepted')
}

console.log('smoke-maturity-ui: ok')
