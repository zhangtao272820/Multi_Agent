/**
 * B2 Prompt 预算 + B3 修订叙事：不拉 LLM。
 */
import {
  assertSystemPromptWithinBudget,
  clipChars,
  clipHandoffSummary,
  clipObsSummary,
  clipRulesBlock,
  clipSkillBlock,
  handoffSummaryMaxChars,
  keepLastObservations,
  obsKeepLast,
  promptBudgetSnapshot,
  promptBudgetSystemChars,
  warnIfSystemPromptOverBudget
} from '../../../server/graph/core/shared/promptBudget'
import { formatLocalReplanNarrative } from '../../../server/graph/orchestrate/orchestrationNarrative'
import { buildSpecialistHandoffFromStep } from '../../../server/utils/agents/specialistHandoff'
import {
  buildActionCardsFromHumanConfirm,
  failureReasonZh
} from '../../../server/graph/core/output/actionCard'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

process.env.MANAGER_PROMPT_BUDGET_RULES_CHARS = '500'
process.env.MANAGER_PROMPT_BUDGET_SKILL_CHARS = '450'
process.env.MANAGER_OBS_SUMMARY_MAX_CHARS = '120'
process.env.MANAGER_HANDOFF_SUMMARY_MAX_CHARS = '150'
process.env.MANAGER_OBS_KEEP_LAST = '2'
process.env.MANAGER_PROMPT_BUDGET_SYSTEM_CHARS = '3200'

const snap = promptBudgetSnapshot()
assert(snap.rulesChars === 500, 'rules budget from env')
assert(snap.skillChars === 450, 'skill budget from env')
assert(snap.obsSummaryChars === 120, 'obs budget from env')
assert(snap.handoffSummaryChars === 150, 'handoff budget from env')
assert(snap.obsKeepLast === 2, 'obs keep last from env')
assert(snap.systemChars === 3200, 'system budget from env')
assert(promptBudgetSystemChars() === 3200, 'system chars helper')
assertSystemPromptWithinBudget('短', 'test')
let threw = false
try {
  assertSystemPromptWithinBudget('X'.repeat(4000), 'test-over')
} catch {
  threw = true
}
assert(threw, 'over-budget system prompt throws')

let warned = false
const origWarn = console.warn
console.warn = (...args: unknown[]) => {
  if (String(args[0] || '').includes('[promptBudget]')) warned = true
  origWarn.apply(console, args as [any?, ...any[]])
}
assert(warnIfSystemPromptOverBudget('短', 'test-ok') === true, 'under budget returns true')
assert(!warned, 'under budget no warn')
assert(warnIfSystemPromptOverBudget('Y'.repeat(4000), 'test-soft') === false, 'over budget soft returns false')
assert(warned, 'over budget warns')
console.warn = origWarn
const stillLong = 'Y'.repeat(4000)
assert(stillLong.length === 4000, 'warn path must not truncate')

const plannerAddonLike = '## playbook\n' + ('agent-addon-rule\n'.repeat(80))
assert(clipSkillBlock(plannerAddonLike).length <= 450, 'planner playbook+addon clipped to skill budget')
assert(clipSkillBlock(plannerAddonLike).endsWith('…') || clipSkillBlock(plannerAddonLike).length < plannerAddonLike.length, 'long addon clipped')

const long = 'A'.repeat(800)
assert(clipRulesBlock(long).length <= 500, 'rules clipped')
assert(clipSkillBlock(long).length <= 450, 'skill clipped')
assert(clipObsSummary(long).length <= 120, 'obs clipped')
assert(clipHandoffSummary(long).length <= 150, 'handoff clipped')
assert(clipChars('short', 100) === 'short', 'short passes')

const kept = keepLastObservations([1, 2, 3, 4, 5], obsKeepLast())
assert(kept.join(',') === '4,5', 'keep last 2')

const handoff = buildSpecialistHandoffFromStep({
  agent: 'db',
  stepId: 's1',
  ok: true,
  output: '结论正文' + 'x'.repeat(500)
})
assert(handoff.summary.length <= handoffSummaryMaxChars() + 1, 'handoff respects budget')

const replanText = formatLocalReplanNarrative({
  kind: 'replan',
  reason: '证据不足',
  count: 2,
  max: 3,
  remainingSteps: 2
})
assert(replanText.includes('局部修订'), 'replan narrative')
assert(replanText.includes('证据不足'), 'includes reason')

const rollbackText = formatLocalReplanNarrative({
  kind: 'rollback',
  count: 3,
  max: 3
})
assert(rollbackText.includes('回退 Plan Mode'), 'rollback narrative')

const circuitText = formatLocalReplanNarrative({
  kind: 'circuit_skip',
  agent: 'crawler'
})
assert(circuitText.includes('熔断'), 'circuit narrative')
assert(circuitText.includes('不耗 LLM'), 'circuit saves LLM')

assert(failureReasonZh('captcha') === '需要完成验证码', 'captcha zh')
assert(failureReasonZh('need_login').includes('登录'), 'login zh')

const cards = buildActionCardsFromHumanConfirm({
  agent: 'admin',
  confirmId: 'c1',
  message: '拟发送邮件给张三',
  adminPendingOps: ['发邮件']
})
assert(cards.length === 1, 'one action card')
assert(cards[0]!.kind === 'admin_write', 'admin write kind')
assert(cards[0]!.status === 'awaiting_confirm', 'awaiting confirm')
assert(cards[0]!.title.includes('办公') || cards[0]!.summary.includes('邮件'), 'chinese title/summary')

const guiCards = buildActionCardsFromHumanConfirm({
  agent: 'gui',
  confirmId: 'g1',
  message: '打开站点并填写表单',
  failureType: 'captcha',
  pageUrl: 'https://example.com'
})
assert(guiCards[0]!.kind === 'gui_automate', 'gui kind')
assert(guiCards[0]!.failureReasonZh?.includes('验证码'), 'gui failure zh')

console.log('smoke-prompt-budget-action: ok')
