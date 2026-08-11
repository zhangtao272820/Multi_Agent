/**
 * D1 UserFacingPayload：mock plan + handoff，不绑单一问句、不拉 LLM。
 */
import {
  buildUserFacingPayload,
  composeFinalBundleFromGraphResult,
  formatAdminWriteUserFacingReply,
  formatUserFacingMainText,
  parseMarkdownTable,
  stripDeveloperJargon,
  stripStructuredExecReport,
  stripSystemAuditColumnsFromMarkdown,
  collectUnifiedSources,
  appendixOverlapsSummary,
  resolveReplyTier,
  isSystemAuditColumn
} from '../../../server/graph/core/output'
import { stripSynthPromptLeakage, looksLikeStepDumpSummary } from '../../../agent-repo-shared/synthOutputSanitize'
import {
  shouldPassthroughAdminWriteOnly,
  shouldPassthroughRagOnly,
  shouldPassthroughDbOnly
} from '../../../agent-repo-shared/deterministicPassthrough'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const cleaned = stripDeveloperJargon('db: agent_result (ok)\n男性 5 人')
assert(!/agent_result/i.test(cleaned), 'strips agent_result')
assert(!/\(ok\)/i.test(cleaned), 'strips (ok)')
assert(cleaned.includes('男性'), 'keeps Chinese conclusion')

const payload = buildUserFacingPayload({
  synth: '',
  intent: 'db',
  results: {
    db: 'agent_result (ok)\n{"rows":12}'
  },
  planSteps: [{ agent: 'db' }],
  evidence: [
    {
      kind: 'db',
      handoff: { summary: '库表统计：男性 5 人、女性 3 人', evidenceRefs: ['table:t'], confidence: 0.9 }
    }
  ],
  meta: { lastStepRecords: [{ id: 's1', agent: 'db', status: 'ok' }] }
})

assert(payload.summary.includes('男性'), 'uses handoff summaries')
assert(!/agent_result/i.test(payload.summary), 'summary has no agent_result')
assert(!/\(ok\)/i.test(payload.summary), 'summary has no (ok)')
assert(!/^db:/m.test(payload.summary), 'summary has no bare db:')
assert(payload.outcome === 'completed', 'default outcome completed')
assert(payload.outcomeLabel === '已完成', 'Chinese outcome label')

const main = formatUserFacingMainText(payload)
assert(!main.includes('## 执行摘要'), 'main text excludes exec summary')

const bundle = composeFinalBundleFromGraphResult({
  final: '',
  intent: 'db',
  results: {
    db: 'agent_result (ok)\nraw dump should not dominate'
  },
  evidence: [
    { kind: 'db', handoff: { summary: '查询完成：共 8 人', evidenceRefs: [], confidence: 0.88 } }
  ],
  meta: {
    lastStepRecords: [{ id: 'a', agent: 'db', status: 'ok', summary: '查询完成：共 8 人' }]
  },
  plan: [{ id: 'a', agent: 'db', query: '查人数' }]
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
assert(!/### 证据/.test(strippedLeak), 'strip drops ### 证据 nested under steps')
assert(!/后续建议/.test(strippedLeak), 'strip drops 后续建议 nested under steps')
assert(!/facts\(1\)/.test(strippedLeak), 'strip drops facts echo')
assert(!/s2\s*\(clean\)/.test(strippedLeak), 'strip drops step-id echo')
assert(strippedLeak.includes('6000') && strippedLeak.includes('月度收支'), 'keeps user analysis')

/** 用户对照分析里的独立 ### 证据 不得被掏空 */
const userEvidenceSection = [
  '林婉清足底压力指标整体接近同龄参考区间。',
  '',
  '### 库内测值',
  '- 左足弓高度：0.41',
  '',
  '### 证据',
  '- 万方文献：不同年龄足底压力参数对比',
  '- 数据库记录：平衡测量',
  '',
  '### 对照结论',
  '- 多数指标在参考范围内',
  '',
  '**小结**：建议结合临床随访。'
].join('\n')
const keptEvidence = stripStructuredExecReport(userEvidenceSection)
assert(keptEvidence.includes('### 证据'), 'keeps standalone ### 证据 in user analysis')
assert(keptEvidence.includes('万方文献'), 'keeps evidence bullets')
assert(keptEvidence.includes('对照结论'), 'keeps compare section')

const leakPayload = buildUserFacingPayload({
  synth: leakySynth,
  intent: 'multi',
  results: { rag: 'ok', clean: 'ok' },
  planSteps: [{ agent: 'rag' }, { agent: 'clean' }],
  meta: {}
})
assert(!/已执行步骤/.test(leakPayload.summary), 'userFacing summary no 已执行步骤')
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

/** admin: 前缀能力清单 + 数据来源说明 / 置信度 / 不可信 */
const adminPrefixedPreamble = [
  '明天 10:00 的「项目周会」已安排好。',
  'admin: 仅处理下列个人助理能力（勿混入知识库检索/搜索/问数/玩法/画图/报告）：',
  '· 邮件：发信、收件箱、分拣、回复',
  '· 联系人：添加/查询通讯录',
  '### 关于数据来源的说明',
  '虽然系统内部标记了置信度 0.75，且提示不可信外部数据，但执行结果稳定。',
  '```agent_result',
  'ok: true',
  '```',
  '## 执行摘要',
  'admin: 仅处理下列个人助理能力'
].join('\n')
const cleanedAdminLeak = stripSynthPromptLeakage(adminPrefixedPreamble)
assert(!/仅处理下列个人助理能力/.test(cleanedAdminLeak), 'strip admin: prefixed preamble')
assert(!/关于数据来源的说明/.test(cleanedAdminLeak), 'strip 关于数据来源的说明')
assert(!/置信度\s*0\.75/.test(cleanedAdminLeak), 'strip confidence parrot')
assert(!/不可信外部/.test(cleanedAdminLeak), 'strip untrusted parrot')
assert(!/```\s*agent_result/.test(cleanedAdminLeak), 'strip agent_result fence')
assert(cleanedAdminLeak.includes('项目周会'), 'keeps schedule confirmation')

const dirtyAdminSynthPayload = buildUserFacingPayload({
  synth: adminPrefixedPreamble,
  intent: 'admin',
  results: {
    admin: '已添加日程并设置提醒：项目周会 (2026年7月29日 10:00)'
  },
  evidence: [
    {
      kind: 'admin',
      handoff: {
        summary: '已添加日程并设置提醒：项目周会 (2026年7月29日 10:00)',
        evidenceRefs: [],
        confidence: 0.75
      }
    }
  ],
  meta: {}
})
assert(!/仅处理下列个人助理能力/.test(dirtyAdminSynthPayload.summary), 'userFacing strips admin preamble')
assert(!/置信度/.test(dirtyAdminSynthPayload.summary), 'userFacing strips confidence')
assert(!/执行摘要/.test(dirtyAdminSynthPayload.summary), 'userFacing strips exec summary')
assert(
  dirtyAdminSynthPayload.summary.includes('项目周会') || dirtyAdminSynthPayload.summary.includes('日程'),
  'userFacing keeps schedule fact'
)

assert(
  shouldPassthroughAdminWriteOnly({
    intent: 'admin',
    planSteps: [{ agent: 'admin' }],
    results: { admin: '已添加日程并设置提醒：项目周会 (2026年7月29日 10:00)' },
    evidence: [{ kind: 'admin', agentResult: { ok: true } }]
  }) === true,
  'admin-only write should passthrough'
)
assert(
  shouldPassthroughAdminWriteOnly({
    intent: 'multi',
    planSteps: [{ agent: 'admin' }, { agent: 'db' }],
    results: {
      admin: '已添加日程并设置提醒：项目周会',
      db: '库内有 5 人'
    },
    evidence: []
  }) === false,
  'admin+db must not passthrough'
)
assert(
  shouldPassthroughAdminWriteOnly({
    intent: 'admin',
    planSteps: [{ agent: 'admin' }],
    results: { admin: '【待确认】将创建日程：项目周会' },
    evidence: [{ kind: 'admin', agentResult: { ok: false } }]
  }) === false,
  'pending admin must not passthrough'
)

const adminPassthroughBundle = composeFinalBundleFromGraphResult({
  final: formatAdminWriteUserFacingReply({
    adminText: '已添加日程并设置提醒：项目周会 (2026年7月29日 10:00)',
    handoffSummary: '已添加日程并设置提醒：项目周会 (2026年7月29日 10:00)'
  }),
  intent: 'admin',
  results: { admin: '已添加日程并设置提醒：项目周会 (2026年7月29日 10:00)' },
  plan: [{ id: 's1', agent: 'admin', query: '创建项目周会' }],
  evidence: [
    {
      kind: 'admin',
      handoff: {
        summary: '已添加日程并设置提醒：项目周会 (2026年7月29日 10:00)',
        evidenceRefs: [],
        confidence: 0.75
      },
      agentResult: { ok: true, agent: 'admin' }
    }
  ],
  meta: { lastStepRecords: [{ id: 's1', agent: 'admin', status: 'ok' }] }
})
assert(
  adminPassthroughBundle.userFacing.summary.includes('项目周会'),
  'compose admin short confirmation'
)
assert(!/#{1,3}\s/.test(adminPassthroughBundle.userFacing.summary), 'admin userFacing no ### headings')
assert(!/执行摘要/.test(adminPassthroughBundle.userFacing.summary), 'admin userFacing no exec summary')
assert(!/仅处理下列个人助理能力/.test(adminPassthroughBundle.userFacing.summary), 'admin userFacing no preamble')
assert(!/别担心|后续建议|数据来源/.test(adminPassthroughBundle.userFacing.summary), 'admin userFacing no fluff')

const polishedAdmin = formatAdminWriteUserFacingReply({
  adminText: [
    'admin: 仅处理下列个人助理能力（勿混入知识库）：',
    '· 邮件：发信',
    '已添加日程并设置提醒：项目周会 (2026年7月29日 10:00)'
  ].join('\n'),
  handoffSummary: '已添加日程并设置提醒：项目周会 (2026年7月29日 10:00)'
})
assert(polishedAdmin.includes('项目周会'), 'formatAdmin keeps fact')
assert(!/仅处理下列/.test(polishedAdmin), 'formatAdmin drops preamble')
assert(polishedAdmin.length < 200, 'formatAdmin stays short')

/** 复杂多源 + report defer：主列须是对照叙述，禁止步骤 dump / report 已完成 */
const complexSynth = [
  '林婉清足底压力测值整体接近同龄参考区间，左足弓高度略偏高需关注。',
  '',
  '### 库内测值',
  '- 左足弓高度：0.41；左足宽：8.78',
  '',
  '### 公开参考',
  '- 万方文献摘要给出同龄足底压力参数区间',
  '',
  '### 对照结论',
  '- 多数指标落在参考范围内',
  '',
  '**小结**：建议结合临床随访。',
  '',
  '<!--REPORT-->',
  '## 分析报告',
  '',
  '受测者林婉清足底压力与同龄参考对照如下……',
  '<!--/REPORT-->'
].join('\n')

const complexBundle = composeFinalBundleFromGraphResult({
  final: complexSynth,
  intent: 'multi',
  results: {
    db: 'Record 1 Creator 林婉清 左足弓高度 0.41',
    crawler: '### 网页抓取列表 (共 1 条)\n| 序号 | 标题 |\n| 1 | 不同年龄足底压力 |',
    clean: '{"answer":"已机械合并 2 个数据源 (30 项事实)","sources":[],"facts":[]}',
    code: '{"answer":"已机械合并 2 个数据源","sources":[]}',
    report: ''
  },
  plan: [
    { id: 's1', agent: 'db', query: '取足底压力' },
    { id: 's2', agent: 'crawler', query: '检索参考区间' },
    { id: 's3', agent: 'clean', query: '清洗' },
    { id: 's4', agent: 'code', query: '对照计算' },
    { id: 's5', agent: 'report', query: '撰写报告' }
  ],
  evidence: [
    {
      kind: 'report',
      mode: 'deferred_to_synth',
      handoff: { summary: 'report 已完成', evidenceRefs: [], confidence: 0.5 }
    },
    {
      kind: 'clean',
      handoff: {
        summary: '{"answer":"已机械合并 2 个数据源 (30 项事实)","sources":[]}',
        evidenceRefs: [],
        confidence: 0.75
      }
    },
    {
      kind: 'db',
      handoff: { summary: 'Record 1 Creator 林婉清', evidenceRefs: [], confidence: 0.9 }
    },
    {
      kind: 'crawler',
      handoff: { summary: '### 网页抓取列表 (共 1 条)', evidenceRefs: [], confidence: 0.8 }
    }
  ],
  meta: {
    synthStreamBody: String(complexSynth.split('<!--REPORT-->')[0] || '').trim(),
    lastStepRecords: [
      { id: 's1', agent: 'db', status: 'ok' },
      { id: 's2', agent: 'crawler', status: 'ok' },
      { id: 's3', agent: 'clean', status: 'ok' },
      { id: 's4', agent: 'code', status: 'ok' },
      { id: 's5', agent: 'report', status: 'ok', summary: 'deferred_to_synth' }
    ]
  },
  routedQuery: '林婉清足底压力对照报告'
})
assert(complexBundle.userFacing.summary.includes('对照') || complexBundle.userFacing.summary.includes('参考区间'), 'complex summary keeps compare narrative')
assert(!/report\s*已完成/i.test(complexBundle.userFacing.summary), 'complex summary no report 已完成')
assert(!/已机械合并/.test(complexBundle.userFacing.summary), 'complex summary no clean JSON blob')
assert(!/查数据库[：:]/.test(complexBundle.userFacing.summary), 'complex summary no labeled db dump')
assert(
  Boolean(complexBundle.userFacing.appendix && /分析报告|对照/.test(complexBundle.userFacing.appendix)),
  'complex appendix has report body'
)

/** 负向：复杂任务无 synth → 不得拼步骤 dump */
const complexEmpty = buildUserFacingPayload({
  synth: '',
  intent: 'multi',
  results: {
    db: 'Record 1',
    crawler: '### 网页抓取列表',
    clean: '{"answer":"已机械合并 2 个数据源","sources":[]}',
    code: '{"answer":"ok"}'
  },
  planSteps: [
    { agent: 'db' },
    { agent: 'crawler' },
    { agent: 'clean' },
    { agent: 'code' },
    { agent: 'report' }
  ],
  evidence: [
    { kind: 'report', mode: 'deferred_to_synth', handoff: { summary: 'report 已完成', evidenceRefs: [], confidence: 0.5 } },
    { kind: 'clean', handoff: { summary: '{"answer":"已机械合并"}', evidenceRefs: [], confidence: 0.7 } }
  ],
  meta: {}
})
assert(!/report\s*已完成/i.test(complexEmpty.summary), 'empty heavy no report stub')
assert(!/已机械合并/.test(complexEmpty.summary), 'empty heavy no mechanical merge')
assert(!/查数据库[：:]/.test(complexEmpty.summary), 'empty heavy no step dump labels')
assert(/汇总未生成|暂无结论|重试/.test(complexEmpty.summary), 'empty heavy shows missing hint')

/** 系统审计列不得进用户表 / 正文 */
const auditTableMd = [
  '| 指标 | 测值 | 创建人 | 逻辑删除 | 创建时间 |',
  '| --- | --- | --- | --- | --- |',
  '| 左足弓指数 | 0.24 | admin | 0 | 2025-11-17 |',
  '| 右足弓指数 | 0.31 | admin | 0 | 2025-11-17 |'
].join('\n')
const parsedAudit = parseMarkdownTable(auditTableMd)
assert(parsedAudit, 'audit table still parses business cols')
assert(parsedAudit!.headers.includes('指标') && parsedAudit!.headers.includes('测值'), 'keeps business headers')
assert(!parsedAudit!.headers.some((h) => /创建人|逻辑删除|创建时间/.test(h)), 'drops system audit headers')
assert(parsedAudit!.rows[0]?.length === 2, 'rows trimmed to business cols')

const onlyAudit = parseMarkdownTable('| 创建人 | 逻辑删除 |\n| --- | --- |\n| a | 0 |')
assert(onlyAudit === null, 'all-system table becomes null')

const bodyWithAudit = [
  '林婉清足底压力对照如下。',
  '',
  auditTableMd,
  '',
  '### 建议',
  '- 结合临床随访。'
].join('\n')
const strippedBody = stripSystemAuditColumnsFromMarkdown(bodyWithAudit)
assert(!/创建人|逻辑删除/.test(strippedBody), 'markdown body drops audit cols')
assert(strippedBody.includes('左足弓指数') && strippedBody.includes('测值'), 'keeps business cells')
assert(strippedBody.includes('建议'), 'keeps advice section')

const auditPayload = buildUserFacingPayload({
  synth: [
    '右足弓指数略高于参考上限。',
    '',
    '### 结论摘要',
    '- 右足弓偏高，提示轻度扁平趋势。',
    '',
    auditTableMd,
    '',
    '## 执行摘要',
    '- ✓ crawler：检索参考区间',
    '- ✓ db：抽取记录'
  ].join('\n'),
  intent: 'multi',
  results: {
    db: 'x',
    crawler: 'y',
    visualize: ['<!--TABLE_DATA-->', auditTableMd, '<!--/TABLE_DATA-->'].join('\n')
  },
  planSteps: [{ agent: 'db' }, { agent: 'crawler' }, { agent: 'report' }],
  meta: {}
})
assert(!/执行摘要/.test(auditPayload.summary), 'userFacing strips exec summary')
assert(!/创建人|逻辑删除|agent_result/.test(auditPayload.summary), 'summary has no audit cols or jargon')
assert(auditPayload.table, 'table slot present')
assert(!auditPayload.table!.headers.some((h) => /创建人|逻辑删除|创建时间/.test(h)), 'table slot drops audit cols')
assert(auditPayload.table!.headers.includes('指标'), 'table slot keeps 指标')

const auditMain = formatUserFacingMainText(auditPayload)
assert(!/## 执行摘要|创建人|逻辑删除/.test(auditMain), 'main text clean of audit')

/** ### 执行摘要（h3）整段裁掉；逻辑删除标志 视为系统列 */
{
  const h3Leak = [
    '整体判断：右足弓略偏高。',
    '',
    '### 结论摘要',
    '- 右足弓需关注',
    '',
    '### 建议',
    '- 随访',
    '',
    '### 执行摘要',
    'rag: 从知识库抽取参考区间',
    'db: 查询受测者记录',
    'agent_result',
    'crawler: 检索公开标准',
    '### 后续建议',
    '如需深挖，可指定下一步关注点'
  ].join('\n')
  const cleanedH3 = stripStructuredExecReport(h3Leak)
  assert(!/执行摘要/.test(cleanedH3), 'h3 exec summary stripped')
  assert(!/\brag\s*:/.test(cleanedH3), 'pipeline rag line stripped')
  assert(!/后续建议/.test(cleanedH3), 'nested 后续建议 after exec stripped')
  assert(cleanedH3.includes('结论摘要') && cleanedH3.includes('右足弓'), 'keeps user analysis')

  assert(isSystemAuditColumn('逻辑删除标志'), '逻辑删除标志 is system col')
  assert(isSystemAuditColumn('逻辑删除'), '逻辑删除 is system col')
  assert(!isSystemAuditColumn('左足弓指数'), 'business col kept')

  const entityTable = parseMarkdownTable(
    ['| 逻辑删除标志 | 体检类型 | 左-足弓指 | 左-脚宽 |', '| --- | --- | --- | --- |', '| 0 | 平衡测量 | 0.41 | 8.78 |'].join(
      '\n'
    )
  )
  assert(entityTable, 'entity table parses after drop')
  assert(!entityTable!.headers.some((h) => /逻辑删除/.test(h)), 'entity table drops 逻辑删除标志')
}

/** 统一来源 index/excerpt；appendix 与正文消重 */
const unified = collectUnifiedSources({
  meta: {
    searchHits: [
      { title: '足底压力参考指南', url: 'https://example.com/a', snippet: '正常足弓指数约 0.21–0.28' }
    ],
    crawlerSources: [{ title: '万通医学', url: 'https://med.example.com', excerpt: '扁平足筛查标准' }]
  },
  evidence: [
    {
      kind: 'rag',
      citations: [{ source: '院内指南.pdf', excerpt: '右足弓偏高需关注', title: '院内指南' }]
    }
  ],
  max: 12
})
assert(unified.length >= 2, 'unified sources collected')
assert(unified[0]!.index === 1, 'sources start at index 1')
assert(unified.every((s) => s.index >= 1 && s.title), 'each source has index+title')
assert(unified.some((s) => s.excerpt), 'sources carry excerpt when available')

assert(
  appendixOverlapsSummary(
    '右足弓指数略高，提示轻度扁平趋势。建议随访。',
    '## 详细说明\n右足弓指数略高，提示轻度扁平趋势。建议随访。补充若干无关细节。'
  ),
  'appendix overlap detects duplicate lead'
)

const srcPayload = buildUserFacingPayload({
  synth: [
    '整体判断：右足弓略偏高[1]。',
    '',
    '### 结论摘要',
    '- 右足弓需关注',
    '',
    '<!--REPORT-->',
    '## 详细说明',
    '整体判断：右足弓略偏高。',
    '### 结论摘要',
    '- 右足弓需关注',
    '<!--/REPORT-->'
  ].join('\n'),
  intent: 'multi',
  results: { db: 'x', crawler: 'y', report: 'z' },
  planSteps: [{ agent: 'db' }, { agent: 'crawler' }, { agent: 'report' }],
  evidence: [
    {
      kind: 'crawler',
      citations: [{ source: '公开标准', title: '公开标准', url: 'https://ex.com/1', excerpt: '参考上限 0.28' }]
    }
  ],
  meta: {
    searchHits: [{ title: '公开标准', url: 'https://ex.com/1', snippet: '参考上限 0.28' }]
  }
})
assert(srcPayload.replyTier === 'report', 'multi+report is report tier')
assert(Array.isArray(srcPayload.sources) && srcPayload.sources!.length >= 1, 'payload has sources')
assert(srcPayload.sources![0]!.index === 1, 'payload source index=1')
assert(!srcPayload.appendix || !appendixOverlapsSummary(srcPayload.summary, srcPayload.appendix), 'no overlapping appendix')
assert(!/执行摘要/.test(srcPayload.summary), 'src payload no exec summary')

const liteTier = resolveReplyTier({
  intent: 'admin',
  results: { admin: '已添加日程' },
  planSteps: [{ agent: 'admin' }],
  adminSynthContext: true,
  multiSourceSynth: false,
  canShowAuxOutputs: false
})
assert(liteTier === 'lite', 'admin-only is lite')

const stdTier = resolveReplyTier({
  intent: 'db',
  results: { db: '男性 5 人' },
  planSteps: [{ agent: 'db' }],
  multiSourceSynth: false,
  canShowAuxOutputs: false
})
assert(stdTier === 'standard', 'single db is standard')

/** 回归：db 单步 + 富 synth 不得被「查数据库：」专才 dump 盖住 */
const dbDumpRaw = [
  '根据您的查询，找到 1 条相关记录：记录 1: 客户姓名：王建国 - 客户生日：1958-07-23 - 空腹血糖：6.8 - 餐后血糖：9.2 - 糖化血红蛋白：6.2'
].join('')
const medicalSynth = [
  '根据 2025-11-17 健康档案，王建国空腹血糖 6.8 mmol/L、餐后血糖 9.2 mmol/L、糖化血红蛋白 6.2%，整体评估为风险。',
  '',
  '### 血糖相关指标',
  '',
  '| 指标 | 测值 | 参考范围 | 状态 |',
  '| --- | --- | --- | --- |',
  '| 空腹血糖 | 6.8 mmol/L | 3.9-6.1 mmol/L | 偏高 |',
  '| 餐后血糖 | 9.2 mmol/L | <7.8 mmol/L | 偏高 |',
  '| 糖化血红蛋白 | 6.2% | <6.0% | 偏高 |'
].join('\n')

const dbRichSynthBundle = composeFinalBundleFromGraphResult({
  final: medicalSynth,
  intent: 'db',
  results: { db: dbDumpRaw },
  plan: [{ id: 's1', agent: 'db', query: '查王建国血糖' }],
  evidence: [
    {
      kind: 'db',
      handoff: {
        summary: `查数据库：${dbDumpRaw}`,
        evidenceRefs: [],
        confidence: 0.9
      }
    }
  ],
  meta: {
    synthStreamBody: medicalSynth,
    lastStepRecords: [{ id: 's1', agent: 'db', status: 'ok', summary: `查数据库：${dbDumpRaw}` }]
  }
})
assert(dbRichSynthBundle.userFacing.summary.includes('空腹血糖'), 'db+synth keeps medical narrative')
assert(dbRichSynthBundle.userFacing.summary.includes('风险'), 'db+synth keeps risk conclusion')
assert(!/查数据库[：:]/.test(dbRichSynthBundle.userFacing.summary), 'db+synth summary no labeled dump')
assert(!/^根据您的查询，找到/.test(dbRichSynthBundle.userFacing.summary.trim()), 'db+synth not raw record dump')

/** 无 synth、仅 handoff：不得出现裸「查数据库：」前缀 */
const dbHandoffOnly = buildUserFacingPayload({
  synth: '',
  intent: 'db',
  results: { db: dbDumpRaw },
  planSteps: [{ agent: 'db' }],
  evidence: [
    {
      kind: 'db',
      handoff: {
        summary: '查数据库：库表统计：男性 5 人、女性 3 人',
        evidenceRefs: [],
        confidence: 0.9
      }
    }
  ],
  meta: {}
})
assert(!/查数据库[：:]/.test(dbHandoffOnly.summary), 'handoff-only no phase label prefix')
assert(dbHandoffOnly.summary.includes('男性') || /暂无结论|汇总未生成/.test(dbHandoffOnly.summary), 'handoff-only keeps short conclusion or hint')

/** 回归：无阶段前缀的「根据您的查询，找到」dump + 流式正文更长 → summary 用完整 synth */
const recordDumpClipped = [
  '根据您的查询，找到 1 条相关记录：',
  '记录 1:',
  '客户姓名：王建国',
  '客户生日：1958-07-23',
  '空腹血糖(mmol/L)：6.8',
  '总胆固醇(mmol/L)：5.3',
  '糖化血红蛋白(%)：6.2',
  'C…'
].join('\n')
const recordDumpFull = [
  '根据您的查询，找到 1 条相关记录：记录 1: 客户姓名：王建国 - 客户生日：1958-07-23 - 空腹血糖(mmol/L)：6.8 - 餐后血糖(mmol/L)：9.2 - 总胆固醇(mmol/L)：5.3 - 糖化血红蛋白(%)：6.2 - C-反应蛋白(pg/L)：8.5 - 血尿酸：320'
].join('')
assert(looksLikeStepDumpSummary(recordDumpClipped), 'clipped record dump detected')
assert(looksLikeStepDumpSummary(recordDumpFull), 'full record dump detected')

const dbRecordAlign = composeFinalBundleFromGraphResult({
  final: recordDumpFull,
  intent: 'db',
  results: { db: recordDumpFull },
  plan: [{ id: 's1', agent: 'db', query: '查王建国' }],
  evidence: [
    {
      kind: 'db',
      handoff: { summary: recordDumpClipped, evidenceRefs: [], confidence: 0.9 }
    }
  ],
  meta: { synthStreamBody: recordDumpFull }
})
assert(dbRecordAlign.userFacing.summary.includes('餐后血糖'), 'record dump prefers full synth over clipped handoff')
assert(!/C…\s*$/.test(dbRecordAlign.userFacing.summary), 'record dump summary not clipped ellipsis')

// —— A5：人员档案多行「字段：值」不得当 step dump ——
const personProfile = [
  '姓名：龙奶奶',
  '性别：女',
  '年龄：82',
  '联系电话：13896377203',
  '详细地址：河西区陈塘庄街道幸福里001号',
  '紧急联系人：龙先生'
].join('\n')
assert(!looksLikeStepDumpSummary(personProfile), 'person profile field lines must not lookLikeStepDumpSummary')
const personFacing = buildUserFacingPayload({
  synth: personProfile,
  intent: 'db',
  results: { db: personProfile },
  planSteps: [{ agent: 'db' }],
  evidence: [
    {
      kind: 'db',
      handoff: { summary: personProfile, evidenceRefs: [], confidence: 0.92 }
    }
  ],
  meta: {}
})
assert(personFacing.summary.includes('13896377203'), 'userFacing keeps person phone')
assert(personFacing.summary.includes('龙奶奶'), 'userFacing keeps person name')
assert(
  shouldPassthroughDbOnly({
    intent: 'db',
    planSteps: [{ agent: 'db' }],
    results: { db: personProfile },
    evidence: [{ kind: 'db', empty: false }]
  }) === true,
  'A5 person profile should passthrough db-only'
)

// —— B1：单源 RAG 直通 ——
const ragRatio =
  '全失能老人的护理员配比标准是 1:3，也就是说每位护理员最多照顾 3 位全失能老人。'
assert(
  shouldPassthroughRagOnly({
    intent: 'rag',
    planSteps: [{ agent: 'rag' }],
    results: { rag: ragRatio },
    evidence: [{ kind: 'rag', agentResult: { ok: true } }]
  }) === true,
  'B1 rag ratio should passthrough rag-only'
)
assert(
  shouldPassthroughRagOnly({
    intent: 'rag',
    planSteps: [{ agent: 'rag' }],
    results: { rag: ragRatio },
    evidence: [{ kind: 'rag', agentResult: { ok: true } }],
    professionalMode: true
  }) === false,
  'professional mode disables rag passthrough'
)
const ragFacing = buildUserFacingPayload({
  synth: ragRatio,
  intent: 'rag',
  results: { rag: ragRatio },
  planSteps: [{ agent: 'rag' }],
  evidence: [
    {
      kind: 'rag',
      handoff: { summary: ragRatio, evidenceRefs: ['doc:养老机构服务规范.docx'], confidence: 0.9 }
    }
  ],
  meta: {}
})
assert(ragFacing.summary.includes('1:3'), 'userFacing keeps caregiver ratio 1:3')

const headlineReport = buildUserFacingPayload({
  synth:
    '王建国多项指标偏高，需关注空腹血糖与血压。\n\n### 关键发现\n- **空腹血糖** 5.8 mmol/L\n\n### 建议\n1. 复查血糖。',
  intent: 'multi',
  results: { db: 'x', rag: 'y' },
  planSteps: [{ agent: 'db' }, { agent: 'rag' }],
  meta: {}
})
assert(headlineReport.replyTier === 'report' || headlineReport.replyTier === 'standard', 'multi-ish gets non-lite tier')
assert(Boolean(headlineReport.headline), 'report/standard emits headline')
assert(
  String(headlineReport.headline).includes('王建国') || String(headlineReport.headline).includes('偏高'),
  'headline from first sentence'
)
assert(String(headlineReport.headline).length <= 80, 'headline clipped to 80')

const headlineLite = buildUserFacingPayload({
  synth: '已创建提醒：**周五例会**，时间 14:00。',
  intent: 'admin',
  results: { admin: 'ok' },
  planSteps: [{ agent: 'admin' }],
  meta: {}
})
assert(headlineLite.replyTier === 'lite', 'admin-only is lite')
assert(!headlineLite.headline, 'lite skips headline')

console.log('smoke-user-facing-payload: ok')

