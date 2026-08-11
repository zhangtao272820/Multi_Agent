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
  chatWebReply: false,
  replyTier: 'report'
}
const multiSys = assembleSynthSystemPrompt(multi)
assert(multiSys.includes(SYNTH_PACK_MARKERS.multi_source), 'multi has multi_source')
assert(!multiSys.includes(SYNTH_PACK_MARKERS.admin_ack), 'multi omits admin_ack')
assert(!multiSys.includes('禁止报告体大章节名'), 'multi omits admin short-report ban')
assert(multiSys.includes('禁止编造写操作'), 'multi still forbids fabricating admin writes')
assert(multiSys.includes('禁止口头已发送'), 'multi forbids claiming mail sent without evidence')
assert(multiSys.includes('关键发现'), 'multi requires 关键发现 structure')
assert(multiSys.includes('输出合同'), 'multi has user-facing output contract')
assert(multiSys.includes('像 DeepSeek'), 'multi emphasizes DeepSeek tone')
assert(multiSys.includes('本轮回复档位：report'), 'multi marks report tier')
assert(multiSys.includes('消重'), 'multi has dedupe contract')
assert(multiSys.includes('分题'), 'multi has multi-topic contract')
assert(multiSys.includes('图表含义 ≤2 句') || multiSys.includes('图表含义'), 'multi caps chart narration')
assert(multiSys.includes('独立 ###') || multiSys.includes('分 ###'), 'multi requires topic sections')
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
  chatWebReply: false,
  replyTier: 'report'
}
const chartSys = assembleSynthSystemPrompt(chart)
assert(chartSys.includes(SYNTH_PACK_MARKERS.chart_report), 'chart has chart_report')
assert(chartSys.includes(SYNTH_PACK_MARKERS.code_authority), 'chart+code has code_authority')
assert(!chartSys.includes(SYNTH_PACK_MARKERS.admin_ack), 'chart omits admin_ack')
assert(!chartSys.includes('禁止报告体大章节名'), 'chart omits admin short-report ban')
assert(chartSys.includes('关键发现'), 'chart requires 关键发现 structure')
assert(chartSys.includes('输出合同'), 'chart has user-facing output contract')
assert(chartSys.includes('消重'), 'chart has dedupe contract')
assert(chartSys.includes('择一为主') || chartSys.includes('三重复述'), 'chart avoids triple repeat')
assert(!chartSys.includes('800～1200'), 'chart omits hard word-count budget')

const chatWeb: SynthPromptAssembleInput = {
  multiSourceSynth: false,
  canShowAuxOutputs: false,
  shouldShowCharts: false,
  adminSynthContext: false,
  codeAuthoritative: false,
  hasGuiResult: false,
  hasDbResult: false,
  chatWebReply: true,
  replyTier: 'standard'
}
const chatWebSys = assembleSynthSystemPrompt(chatWeb)
assert(chatWebSys.includes(SYNTH_PACK_MARKERS.gui_web), 'chat_web mounts gui_web pack')
assert(chatWebSys.includes('短开篇'), 'chat_web has knowledge intro structure')
assert(chatWebSys.includes('简单事实题'), 'chat_web allows short answers')
assert(chatWebSys.includes('本轮回复档位：standard'), 'chat_web marks standard tier')
assert(chatWebSys.includes('像 DeepSeek'), 'standard tier uses DeepSeek structure')
assert(chatWebSys.includes('输出合同'), 'chat_web has output contract')
assert(chatWebSys.includes('勿要点与表重复') || chatWebSys.includes('消重'), 'chat_web avoids list+table dup')
assert(!chatWebSys.includes('结构（必须，report 档）'), 'standard omits report-forced structure')

const stdDb: SynthPromptAssembleInput = {
  multiSourceSynth: false,
  canShowAuxOutputs: false,
  shouldShowCharts: false,
  adminSynthContext: false,
  codeAuthoritative: false,
  hasGuiResult: false,
  hasDbResult: true,
  chatWebReply: false,
  replyTier: 'standard'
}
const stdDbSys = assembleSynthSystemPrompt(stdDb)
assert(stdDbSys.includes(SYNTH_PACK_MARKERS.db_interpret), 'std db has db_interpret')
assert(stdDbSys.includes('像 DeepSeek'), 'std db uses DeepSeek structure')
assert(stdDbSys.includes('输出合同'), 'std db has output contract')
assert(stdDbSys.includes('无强制大表'), 'standard omits forced large table')
assert(!stdDbSys.includes('结构（必须，report 档）'), 'std db omits report structure')

const liteAdmin: SynthPromptAssembleInput = {
  ...adminOnly,
  replyTier: 'lite'
}
const liteSys = assembleSynthSystemPrompt(liteAdmin)
assert(liteSys.includes('本轮回复档位：lite'), 'lite marks tier')
assert(!liteSys.includes('结构（必须，report 档）'), 'lite omits report structure block')
assert(liteSys.includes('禁止报告体大章节名'), 'lite keeps admin short-report ban')
assert(liteSys.includes('1～3 句') || liteSys.includes('至多 8 句'), 'lite stays short')
assert(!liteSys.includes('### 关键发现'), 'lite omits report 关键发现 forced block')

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
  ['stdDb', stdDbSys],
  ['lite', liteSys],
  ['critic-admin', criticAdmin]
] as const) {
  const hits = findPromptHygieneViolations(text)
  assert(hits.length === 0, `${name} prompt hygiene clean (hits=${hits.join(',')})`)
}

console.log('smoke-synth-prompt-profiles: ok')
