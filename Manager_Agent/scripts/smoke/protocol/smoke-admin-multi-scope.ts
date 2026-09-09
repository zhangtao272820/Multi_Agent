/**
 * M4 复合任务：admin 子句 scope 与 pipeline 子句隔离 smoke（离线）
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickSubAgentScopeSync, collectSubAgentScopeCandidates, isGenericQueryFocus } from '../../../server/utils/route/managerSubAgentScopeLlm'
import { buildAgentScopedQuery } from '../../../server/graph/core/routing/clauses'
import { extractAdminSubtaskText } from '../../../server/graph/core/stepIsolation/sanitize'

const __dirname = dirname(fileURLToPath(import.meta.url))

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

async function main() {
  const {
    normalizeAdminToolPlan,
    adminTaskLlmToolCatalog,
    adminStepQueryPreamble,
    MANAGER_ADMIN_TOOL_NAMES
  } = await import(pathToFileURL(join(__dirname, '../../../agent-repo-shared/adminCapabilities.ts')).href)

  const catalog = adminTaskLlmToolCatalog()
  assert(catalog.includes('send_feishu_message'), 'catalog must include feishu')
  assert(catalog.includes('add_contact'), 'catalog must include contacts')
  assert(!catalog.includes('web_search'), 'catalog must not include web_search')
  assert(!catalog.includes('ask_database'), 'catalog must not include ask_database')
  assert(!catalog.includes('knowledge_retrieval'), 'catalog must not include knowledge_retrieval')

  const preamble = adminStepQueryPreamble()
  assert(preamble.includes('飞书'), 'preamble mentions feishu')
  assert(preamble.includes('联系人'), 'preamble mentions contacts')
  // preamble 仍保留作剥离/兼容文案；出站 WS 不得再注入

  assert(MANAGER_ADMIN_TOOL_NAMES.has('add_event'), 'allowlist has add_event')
  assert(!MANAGER_ADMIN_TOOL_NAMES.has('web_search'), 'allowlist excludes web_search')

  const { buildAdminExecMessage, buildAdminEffectiveQuery } = await import(
    pathToFileURL(join(__dirname, '../../../server/graph/core/stepIsolation/exec.ts')).href
  )
  const leanTravel = buildAdminExecMessage('坐地铁从天津西站到天津站大概多久', { autoConfirm: true })
  assert(leanTravel.includes('天津西站'), `lean travel keeps query: ${leanTravel}`)
  assert(!/仅处理下列个人助理能力/.test(leanTravel), 'lean WS message must not include preamble')
  assert(!/【总管约束】/.test(leanTravel), 'lean WS message must not include ADMIN_EXEC_GUARD')
  assert(!/（强制）不要等待人工确认/.test(leanTravel), 'lean WS message must not include auto-confirm line')
  const leanEff = buildAdminEffectiveQuery(
    '帮我添加明天下午3点的会议提醒',
    '知识库查补贴并帮我添加明天下午3点的会议提醒',
    '',
    true
  )
  assert(leanEff.includes('会议提醒'), `effQuery keeps admin clause: ${leanEff}`)
  assert(!/仅处理下列个人助理能力/.test(leanEff), 'effQuery must not include preamble')
  assert(!/【总管约束】/.test(leanEff), 'effQuery must not include guard')

  const upgraded = normalizeAdminToolPlan('帮我创建明天上午10点会议日程', [
    { name: 'add_reminder', args: { content: 'AI 助理提醒', remind_time_str: '明天上午10点' } }
  ])
  assert(upgraded?.some((t) => t.name === 'add_event'), `meeting must upgrade to add_event: ${JSON.stringify(upgraded)}`)
  assert(!upgraded?.some((t) => t.name === 'add_reminder'), `meeting must drop bare add_reminder: ${JSON.stringify(upgraded)}`)

  const droppedSearch = normalizeAdminToolPlan('查一下天气政策', [
    { name: 'web_search', args: { query: '天气' } },
    { name: 'get_weather', args: {} }
  ])
  assert(droppedSearch?.length === 1 && droppedSearch[0]?.name === 'get_weather', 'drop web_search keep get_weather')

  const meta = {
    taskClauses: [
      { id: 'c1', text: '知识库查失能老人补贴和高龄津贴标准', agents: ['rag'] },
      { id: 'c2', text: '数据库查河西区70-79岁老人性别分布', agents: ['db'] },
      { id: 'c3', text: '写一份对比报告', agents: ['report'] },
      { id: 'c4', text: '帮我添加明天下午3点的会议提醒', agents: ['admin'] }
    ],
    planBlueprint: {
      steps: [{ agent: 'admin', queryFocus: '查询天气预报或处理办公/地图类子任务（与取数/图表分离）' }]
    }
  }

  const adminCandidates = collectSubAgentScopeCandidates(
    'admin',
    meta,
    '仅处理下列个人助理能力：日程/提醒/邮件/待办'
  )
  const adminScoped = pickSubAgentScopeSync(adminCandidates)
  assert(adminScoped.includes('会议提醒'), `admin scope must pick clause: ${adminScoped}`)
  assert(!adminScoped.includes('失能老人'), `admin scope must not include rag clause: ${adminScoped}`)

  const cleanQ = buildAgentScopedQuery(
    'clean',
    meta.taskClauses as any,
    '知识库查失能老人补贴…并帮我添加明天下午3点的会议提醒'
  )
  assert(!cleanQ.includes('会议提醒'), `clean scope must drop admin clause: ${cleanQ}`)
  assert(cleanQ.includes('失能老人') || cleanQ.includes('河西区'), `clean keeps data clauses: ${cleanQ}`)

  const extracted = extractAdminSubtaskText(
    '仅处理下列个人助理能力：日程/提醒/邮件/待办\n帮我添加明天下午3点的会议提醒'
  )
  assert(extracted.includes('会议提醒'), `extract admin subtask: ${extracted}`)

  const compositeUser =
    '在知识库中检索个人月度财务情况，提炼要点并生成对比图表，并帮我创建明天上午10点的会议日程，标题为「项目周会」，并设置会议提醒。'
  const fromComposite = extractAdminSubtaskText(compositeUser)
  assert(fromComposite.includes('项目周会'), `composite must keep title 项目周会: ${fromComposite}`)
  assert(fromComposite.includes('会议日程') || fromComposite.includes('提醒'), `composite admin extract: ${fromComposite}`)

  // 已包装 preamble 的文本剥净后仍保槽
  const wrappedComposite = extractAdminSubtaskText(
    [
      '仅处理下列个人助理能力：邮件/联系人/待办/日程/提醒',
      '勿混入搜索/问数/玩法/简报/文件。会议与日程须 add_event 落库，禁止仅用 add_reminder。',
      '若已给出会议标题与时间，直接创建，勿追问知识库或图表相关缺失项。',
      compositeUser,
      '【总管约束】只执行本条中的日程'
    ].join('\n')
  )
  assert(
    wrappedComposite.includes('项目周会') && /10\s*点|明天|上午/.test(wrappedComposite),
    `wrapped composite extract must keep slots: ${wrappedComposite}`
  )
  assert(!wrappedComposite.includes('仅处理下列'), `wrapped extract must drop preamble: ${wrappedComposite}`)
  assert(!wrappedComposite.includes('知识库'), `wrapped extract must drop rag: ${wrappedComposite}`)

  const genericMeta = {
    taskClauses: [{ id: 'c1', text: '检索个人月度财务情况', agents: ['rag'] }],
    planBlueprint: {
      steps: [{ agent: 'admin', queryFocus: '查询天气预报或处理办公/地图类子任务（与取数/图表分离）' }]
    }
  }
  const genericScoped = pickSubAgentScopeSync(collectSubAgentScopeCandidates('admin', genericMeta, '处理办公类子任务'))
  assert(
    isGenericQueryFocus(genericScoped) || genericScoped.includes('办公'),
    `generic blueprint scope: ${genericScoped}`
  )
  assert(
    fromComposite.includes('10点') || fromComposite.includes('项目周会'),
    `user task must retain meeting slots: ${fromComposite}`
  )
  assert(
    /10\s*点|明天|上午/.test(fromComposite),
    `admin scope must retain time expression (not strip): ${fromComposite}`
  )
  assert(
    !fromComposite.includes('知识库') && !fromComposite.includes('图表'),
    `admin scope must drop rag/viz clauses: ${fromComposite}`
  )
  assert(
    fromComposite.includes('会议') || fromComposite.includes('项目周会') || fromComposite.includes('提醒'),
    `admin scope must keep meeting clause: ${fromComposite}`
  )

  const meetingReminderPlan = normalizeAdminToolPlan('帮我添加明天下午3点的会议提醒', [
    { name: 'add_reminder', args: { content: '会议提醒', remind_time_str: '明天下午3点' } }
  ])
  assert(
    meetingReminderPlan?.some((t) => t.name === 'add_event'),
    `会议提醒 must be add_event: ${JSON.stringify(meetingReminderPlan)}`
  )

  console.log('smoke-admin-multi-scope: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
