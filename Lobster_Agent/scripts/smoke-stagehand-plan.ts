/**
 * Stagehand plan loop smoke（无浏览器）
 */
import assert from 'node:assert/strict'
import {
  STAGEHAND_PLAN_MAX_STEPS,
  goalsNeedLeaveStart,
  resolveStagehandPlanSteps,
  stagehandStepInstruction,
} from '../server/services/stagehandPlanLoop'
import { defaultPlanStepsForTask } from '../server/services/lobsterTaskUnderstandSchema'
import { isLobsterRetryableFailure } from '../../shared/lobsterRunVerifyLite'
import {
  clearPlaybookCacheForTests,
  playbookCacheKey,
  savePlaybook,
  lookupPlaybook,
} from '../server/services/lobsterPlaybookCache'

process.env.LOBSTER_PLAYBOOK_CACHE = '1'
process.env.LOBSTER_PLAYBOOK_DIR = `${process.cwd()}/.data/lobster-smoke-playbook`
clearPlaybookCacheForTests()

const steps = defaultPlanStepsForTask({
  task: '打开 https://www.runoob.com/ ，点击第一个教程链接并提取标题',
  startUrl: 'https://www.runoob.com/',
  taskKind: 'navigate',
  goals: { must_leave_start: true, must_extract: true },
})
assert.ok(steps.length >= 2, 'plan has steps')
assert.equal(steps[0]?.op, 'goto')
assert.ok(steps.some((s) => s.op === 'click'), 'has click')
assert.ok(steps.some((s) => s.op === 'extract'), 'has extract')

const resolved = resolveStagehandPlanSteps({
  task: '填表',
  startUrl: 'https://httpbin.org/forms/post',
  taskSpec: {
    canonical_task: '填表',
    engine_hint: 'auto',
    task_kind: 'form_fill',
    browser_profile: 'managed',
    needs_login: false,
    explicitly_avoid_login: false,
    plan_steps: [],
    goals: { must_submit: true, must_extract: true },
    confidence: 0.9,
    rationale: 't',
    source: 'fallback',
  },
})
assert.ok(resolved.steps.some((s) => s.op === 'type' || s.op === 'submit'), 'form plan')
assert.ok(resolved.steps.length <= STAGEHAND_PLAN_MAX_STEPS, 'plan capped ≤6')

const longPlan = resolveStagehandPlanSteps({
  task: '多步',
  startUrl: 'https://example.com/',
  taskSpec: {
    canonical_task: '多步',
    engine_hint: 'auto',
    task_kind: 'multi_step',
    browser_profile: 'managed',
    needs_login: false,
    explicitly_avoid_login: false,
    plan_steps: Array.from({ length: 12 }, (_, i) => ({
      op: i === 11 ? ('extract' as const) : ('click' as const),
      target: `step-${i}`,
    })),
    goals: {},
    confidence: 0.9,
    rationale: 't',
    source: 'llm',
  },
})
assert.equal(longPlan.steps.length, STAGEHAND_PLAN_MAX_STEPS, 'hard cap 6')
assert.ok(longPlan.steps.some((s) => s.op === 'extract'), 'cap keeps extract')

assert.ok(goalsNeedLeaveStart({ must_leave_start: true }, ''))
assert.ok(goalsNeedLeaveStart({}, '点击第一个教程'))

const instr = stagehandStepInstruction(
  { op: 'click', target: '第一个教程', done_when: '进入详情' },
  '打开 runoob 点教程',
)
assert.ok(instr.includes('第一个教程'))

assert.equal(
  isLobsterRetryableFailure({
    status: 'done',
    result: { finalUrl: 'https://www.runoob.com/', answer: '首页' },
    verify: { reason: 'navigation_unverified' },
  }),
  true,
  'navigation_unverified retryable even with homepage url',
)

// 短剧本：保存后二次 resolve 应命中且步数 ≤ 首次
const pbSteps = [
  { op: 'goto' as const, target: 'https://www.runoob.com/' },
  { op: 'click' as const, target: '第一个教程' },
  { op: 'extract' as const, target: '标题' },
]
savePlaybook({
  startUrl: 'https://www.runoob.com/',
  taskKind: 'navigate',
  goals: { must_leave_start: true, must_extract: true },
  plan_steps: pbSteps,
})
const key = playbookCacheKey({
  startUrl: 'https://www.runoob.com/',
  taskKind: 'navigate',
  goals: { must_leave_start: true, must_extract: true },
})
assert.ok(lookupPlaybook({
  startUrl: 'https://www.runoob.com/',
  taskKind: 'navigate',
  goals: { must_leave_start: true, must_extract: true },
}), `lookup ${key}`)

const replay = resolveStagehandPlanSteps({
  task: '打开 runoob 点教程抽标题',
  startUrl: 'https://www.runoob.com/',
  taskSpec: {
    canonical_task: '打开 runoob 点教程抽标题',
    engine_hint: 'auto',
    task_kind: 'navigate',
    browser_profile: 'managed',
    needs_login: false,
    explicitly_avoid_login: false,
    plan_steps: [],
    goals: { must_leave_start: true, must_extract: true },
    confidence: 0.9,
    rationale: 't',
    source: 'fallback',
  },
})
assert.ok(replay.playbookKey, 'second resolve hits playbook')
assert.ok(replay.steps.length <= pbSteps.length, 'replay steps not longer')
assert.ok(replay.steps.some((s) => s.op === 'click'), 'replay has click')

clearPlaybookCacheForTests()
console.log('smoke-stagehand-plan: PASS')
