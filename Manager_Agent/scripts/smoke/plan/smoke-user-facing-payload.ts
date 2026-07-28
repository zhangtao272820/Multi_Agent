/**
 * D1 UserFacingPayload：mock plan + handoff，不绑单一问句、不拉 LLM。
 */
import {
  buildUserFacingPayload,
  composeFinalBundleFromGraphResult,
  formatUserFacingMainText,
  stripDeveloperJargon,
  stripStructuredExecReport
} from '../../../server/graph/core/output'
import { stripSynthPromptLeakage } from '../../../agent-repo-shared/synthOutputSanitize'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const cleaned = stripDeveloperJargon('db: agent_result (ok)\n男性 5 人')
assert(!/agent_result/i.test(cleaned), 'strips agent_result')
assert(!/\(ok\)/i.test(cleaned), 'strips (ok)')
assert(cleaned.includes('男性'), 'keeps Chinese conclusion')

const payload = buildUserFacingPayload({
  synth: '',
  intent: 'multi',
  results: {
    db: 'agent_result (ok)\n{"rows":12}',
    rag: '制度条文很长很长很长'
  },
  evidence: [
    {
      kind: 'db',
      handoff: { summary: '库表统计：男性 5 人、女性 3 人', evidenceRefs: ['table:t'], confidence: 0.9 }
    },
    {
      kind: 'rag',
      handoff: { summary: '制度要求按性别汇总申报', evidenceRefs: ['doc:1'], confidence: 0.8 }
    }
  ],
  meta: { lastStepRecords: [{ id: 's1', agent: 'db', status: 'ok' }] }
})

assert(payload.summary.includes('男性') || payload.summary.includes('制度'), 'uses handoff summaries')
assert(!/agent_result/i.test(payload.summary), 'summary has no agent_result')
assert(!/\(ok\)/i.test(payload.summary), 'summary has no (ok)')
assert(!/^db:/m.test(payload.summary), 'summary has no bare db:')
assert(payload.outcome === 'completed', 'default outcome completed')
assert(payload.outcomeLabel === '已完成', 'Chinese outcome label')

const main = formatUserFacingMainText(payload)
assert(!main.includes('## 执行摘要'), 'main text excludes exec summary')

const bundle = composeFinalBundleFromGraphResult({
  final: '',
  intent: 'multi',
  results: {
    db: 'agent_result (ok)\nraw dump should not dominate',
    clean: 'clean intermediate'
  },
  evidence: [
    { kind: 'db', handoff: { summary: '查询完成：共 8 人', evidenceRefs: [], confidence: 0.88 } }
  ],
  meta: {
    lastStepRecords: [{ id: 'a', agent: 'db', status: 'ok', summary: '查询完成：共 8 人' }]
  },
  plan: [
    { id: 'a', agent: 'db', query: '查人数' },
    { id: 'b', agent: 'rag', query: '查制度' }
  ]
})

assert(!/agent_result/i.test(bundle.userFacing.summary), 'compose bundle userFacing clean')
assert(
  bundle.userFacing.summary.includes('8') || bundle.userFacing.summary.includes('查询'),
  'compose prefers handoff over dump'
)
assert(bundle.text.includes('执行摘要') || bundle.userFacing.summary.length > 0, 'audit text or summary present')

const withSynth = composeFinalBundleFromGraphResult({
  final: '本轮结论：养老统计已汇总。',
  intent: 'multi',
  results: { db: 'agent_result (ok)' },
  plan: [
    { id: 'a', agent: 'db', query: 'x' },
    { id: 'b', agent: 'report', query: 'y' }
  ],
  meta: {}
})
assert(withSynth.userFacing.summary.includes('养老统计'), 'synth preferred when present')
assert(!/agent_result/i.test(withSynth.userFacing.summary), 'synth path still strips jargon if leaked')

/** D2：metrics / chart / table / actions 槽位 */
const withSlots = buildUserFacingPayload({
  synth: '结论：性别分布已汇总。',
  intent: 'multi',
  results: {
    visualize: [
      '<!--ECHARTS_OPTION-->',
      JSON.stringify({
        title: { text: '性别分布' },
        xAxis: { data: ['男性', '女性'] },
        series: [{ type: 'bar', data: [5, 3] }]
      }),
      '<!--/ECHARTS_OPTION-->',
      '<!--TABLE_DATA-->',
      '| 性别 | 人数 |',
      '| --- | --- |',
      '| 男性 | 5 |',
      '| 女性 | 3 |',
      '<!--/TABLE_DATA-->'
    ].join('\n'),
    clean: JSON.stringify({
      answer: '已整理事实',
      sources: [{ agent: 'db' }],
      facts: [
        { key: 'male', label: '男性', value: 5, source: 'db', confidence: 0.9 },
        { key: 'female', label: '女性', value: 3, source: 'db', confidence: 0.9 }
      ],
      quality: { conflicts: [], missing_fields: [], deduped_count: 0 },
      data: { mode: 'single_source', raw_source_count: 1 }
    })
  },
  meta: {
    needsHumanConfirm: true,
    humanConfirmAgent: 'admin',
    humanConfirmMessage: '拟发送邮件通知',
    humanConfirmId: 'confirm_test_1',
    adminPendingOps: ['send_email']
  }
})
assert(withSlots.chart?.title === '性别分布', 'chart title from visualize')
assert(withSlots.chart?.option && typeof withSlots.chart.option === 'object', 'chart option present')
assert(withSlots.table?.headers?.includes('性别'), 'table headers chinese')
assert((withSlots.metrics?.length || 0) >= 1, 'metrics from clean facts')
assert(withSlots.metrics!.some((m) => m.label === '男性'), 'metric label chinese')
assert(withSlots.actions?.length === 1, 'actions from needsHumanConfirm')
assert(withSlots.actions![0]!.status === 'awaiting_confirm', 'action awaiting confirm')
assert(withSlots.outcome === 'needs_human', 'needs_human outcome')

/** 用户主列不得泄漏执行摘要 / 已执行步骤 / 证据管线 */
const leakySynth = [
  '本月收入 6000、支出 5000，结余约 1000。',
  '',
  '### 月度收支明细',
  '- 收入稳定，支出可控。',
  '',
  '### 已执行步骤',
  '- ✓ rag：检索知识库财务数据（ok）',
  '- ✓ clean：对齐清洗（ok）',
  '',
  '### 证据',
  '- rag：检索个人月度财务状况',
  '- clean：对齐检索数据',
  's2 (clean): facts(1): 月收入：6000 月支出：5000',
  '',
  '### 后续建议',
  '- 如需深挖，可指定下一步关注点',
  '',
  '**小结**：财务状况整体健康。'
].join('\n')

const strippedLeak = stripStructuredExecReport(leakySynth)
assert(!/已执行步骤/.test(strippedLeak), 'strip drops 已执行步骤')
assert(!/### 证据/.test(strippedLeak), 'strip drops ### 证据')
assert(!/后续建议/.test(strippedLeak), 'strip drops 后续建议')
assert(!/facts\(1\)/.test(strippedLeak), 'strip drops facts echo')
assert(!/s2\s*\(clean\)/.test(strippedLeak), 'strip drops step-id echo')
assert(strippedLeak.includes('6000') && strippedLeak.includes('月度收支'), 'keeps user analysis')

const leakPayload = buildUserFacingPayload({
  synth: leakySynth,
  intent: 'multi',
  results: { rag: 'ok', clean: 'ok' },
  plan: undefined as any,
  meta: {}
})
assert(!/已执行步骤/.test(leakPayload.summary), 'userFacing summary no 已执行步骤')
assert(!/### 证据/.test(leakPayload.summary), 'userFacing summary no ### 证据')
assert(!/判定[：:]/.test(leakPayload.summary), 'userFacing summary no 判定')
assert(leakPayload.summary.includes('6000') || leakPayload.summary.includes('结余'), 'keeps finance conclusion')

const leakBundle = composeFinalBundleFromGraphResult({
  final: leakySynth,
  intent: 'multi',
  results: { rag: 'x', clean: 'y', code: 'z', visualize: 'v' },
  plan: [
    { id: 's1', agent: 'rag', query: '检索' },
    { id: 's2', agent: 'clean', query: '清洗' },
    { id: 's3', agent: 'code', query: '计算' },
    { id: 's4', agent: 'visualize', query: '图表' }
  ],
  meta: {
    lastStepRecords: [
      { id: 's1', agent: 'rag', status: 'ok' },
      { id: 's2', agent: 'clean', status: 'ok' },
      { id: 's3', agent: 'code', status: 'ok' },
      { id: 's4', agent: 'visualize', status: 'ok' }
    ]
  },
  routedQuery: '查知识库月度财务并出图'
})
assert(!/已执行步骤/.test(leakBundle.userFacing.summary), 'compose userFacing clean of steps')
assert(leakBundle.text.includes('执行摘要') || leakBundle.text.includes('已执行步骤'), 'audit text still has exec report')

const sanitized = stripSynthPromptLeakage(leakySynth)
assert(!/已执行步骤/.test(sanitized), 'synth sanitize drops steps')
assert(sanitized.includes('小结') || sanitized.includes('6000'), 'synth sanitize keeps user body')

const preambleLeak = [
  '主要回答如下。',
  'error: 仅处理下列个人助理能力（勿混入知识库检索/搜索/问数/玩法/画图/报告）：',
  '· 邮件：发信、收件箱、分拣、回复',
  '· 联系人：添加/查询通讯录',
  '· 待办：创建/列出/完成待办',
  'admin: empty_result',
  '### 失败'
].join('\n')
const cleanedPreamble = stripSynthPromptLeakage(preambleLeak)
assert(!/仅处理下列个人助理能力/.test(cleanedPreamble), 'strip admin preamble leak')
assert(!/^·\s*邮件/.test(cleanedPreamble), 'strip capability bullet')
assert(!/admin:\s*empty_result/i.test(cleanedPreamble), 'strip empty_result jargon')
assert(cleanedPreamble.includes('主要回答'), 'keeps user-facing lead')

console.log('smoke-user-facing-payload: ok')
