/**
 * P0：Synth / Critic prompt profile 选型 smoke（不拉 LLM）。
 * 断言：admin-only 不含长报告/结余细则；chart 含 chart pack；multi 含 multi pack。
 */
import {
  assembleSynthSystemPrompt,
  listSynthPromptProfiles,
  SYNTH_PACK_MARKERS,
  type SynthPromptAssembleInput
} from '../../../server/graph/llm/synthPromptProfiles'
import {
  assembleCriticSystemPrompt,
  criticPromptInputFromRun,
  CRITIC_PACK_MARKERS,
  selectCriticPromptPacks
} from '../../../server/graph/llm/criticPromptProfiles'
import { promptBudgetSystemChars, assertSystemPromptWithinBudget } from '../../../server/graph/core/shared/promptBudget'
import { findPromptHygieneViolations } from '../../../agent-repo-shared/promptHygiene'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const adminOnly: SynthPromptAssembleInput = {
  multiSourceSynth: false,
  canShowAuxOutputs: false,
  shouldShowCharts: false,
  adminSynthContext: true,
  codeAuthoritative: false,
  hasGuiResult: false,
  hasDbResult: false,
  chatWebReply: false
}
const adminProfiles = listSynthPromptProfiles(adminOnly)
assert(adminProfiles.includes('admin_ack'), 'admin-only selects admin_ack')
assert(!adminProfiles.includes('chart_report'), 'admin-only skips chart_report')
assert(!adminProfiles.includes('multi_source'), 'admin-only skips multi_source')
assert(!adminProfiles.includes('db_interpret'), 'admin-only skips db_interpret')
const adminSys = assembleSynthSystemPrompt(adminOnly)
assert(adminSys.includes(SYNTH_PACK_MARKERS.admin_ack), 'admin system has admin_ack marker')
assert(!adminSys.includes('800～1200'), 'admin system omits hard word-count budget')
assert(adminSys.includes('禁止报告体大章节名'), 'admin_ack keeps short-report ban')
assert(adminSys.includes('逻辑删除'), 'base forbids system audit columns')
assert(!adminSys.includes('结余=收入'), 'admin system omits finance/code balance rule')
assert(!adminSys.includes(SYNTH_PACK_MARKERS.multi_source), 'admin omits multi_source marker')
assertSystemPromptWithinBudget(adminSys, 'synth:admin_ack')

const multi: SynthPromptAssembleInput = {
  multiSourceSynth: true,
  canShowAuxOutputs: false,
  shouldShowCharts: false,
  adminSynthContext: false,
  codeAuthoritative: false,
  hasGuiResult: false,
  hasDbResult: true,
  chatWebReply: false
}
const multiSys = assembleSynthSystemPrompt(multi)
assert(multiSys.includes(SYNTH_PACK_MARKERS.multi_source), 'multi has multi_source')
assert(!multiSys.includes(SYNTH_PACK_MARKERS.admin_ack), 'multi omits admin_ack')
assert(!multiSys.includes('禁止报告体大章节名'), 'multi omits admin short-report ban')
assert(multiSys.includes('禁止编造写操作'), 'multi still forbids fabricating admin writes')
assert(multiSys.includes('结论摘要'), 'multi requires 结论摘要 structure')
assert(!multiSys.includes('800～1200'), 'multi omits hard word-count budget')
assert(!multiSys.includes('700～1000'), 'multi omits old hard word-count')

const chart: SynthPromptAssembleInput = {
  multiSourceSynth: false,
  canShowAuxOutputs: true,
  shouldShowCharts: true,
  adminSynthContext: false,
  codeAuthoritative: true,
  hasGuiResult: false,
  hasDbResult: true,
  chatWebReply: false
}
const chartSys = assembleSynthSystemPrompt(chart)
assert(chartSys.includes(SYNTH_PACK_MARKERS.chart_report), 'chart has chart_report')
assert(chartSys.includes(SYNTH_PACK_MARKERS.code_authority), 'chart+code has code_authority')
assert(!chartSys.includes(SYNTH_PACK_MARKERS.admin_ack), 'chart omits admin_ack')
assert(!chartSys.includes('禁止报告体大章节名'), 'chart omits admin short-report ban')
assert(chartSys.includes('结论摘要'), 'chart requires 结论摘要 structure')
assert(!chartSys.includes('800～1200'), 'chart omits hard word-count budget')

const chatWeb: SynthPromptAssembleInput = {
  multiSourceSynth: false,
  canShowAuxOutputs: false,
  shouldShowCharts: false,
  adminSynthContext: false,
  codeAuthoritative: false,
  hasGuiResult: false,
  hasDbResult: false,
  chatWebReply: true
}
const chatWebSys = assembleSynthSystemPrompt(chatWeb)
assert(chatWebSys.includes(SYNTH_PACK_MARKERS.gui_web), 'chat_web mounts gui_web pack')
assert(chatWebSys.includes('短开篇'), 'chat_web has knowledge intro structure')
assert(chatWebSys.includes('简单事实题'), 'chat_web allows short answers')

const criticAdmin = assembleCriticSystemPrompt(
  criticPromptInputFromRun({
    results: { admin: '已添加日程' },
    evidence: [{ kind: 'admin' }],
    planAgents: ['admin']
  })
)
assert(criticAdmin.includes(CRITIC_PACK_MARKERS.admin_write), 'critic admin pack on')
assert(!criticAdmin.includes(CRITIC_PACK_MARKERS.crawler), 'critic admin omits crawler pack')
assert(!criticAdmin.includes(CRITIC_PACK_MARKERS.code_chart), 'critic admin omits code_chart')

const criticFull = selectCriticPromptPacks({
  hasAdmin: true,
  hasRagOrDb: true,
  hasCrawler: true,
  hasCodeOrChart: true,
  hasGui: true,
  hasMultimodal: true
})
assert(criticFull.includes('admin_write') && criticFull.includes('code_chart'), 'full critic packs')

assert(promptBudgetSystemChars() >= 2000, 'system budget configured')

for (const [name, text] of [
  ['admin', adminSys],
  ['multi', multiSys],
  ['chart', chartSys],
  ['chatWeb', chatWebSys],
  ['critic-admin', criticAdmin]
] as const) {
  const hits = findPromptHygieneViolations(text)
  assert(hits.length === 0, `${name} prompt hygiene clean (hits=${hits.join(',')})`)
}

console.log('smoke-synth-prompt-profiles: ok')
