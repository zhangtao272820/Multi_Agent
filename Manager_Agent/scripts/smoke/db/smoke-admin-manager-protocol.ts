/**
 * 总管 ↔ AI_admin manager_task 协议 smoke（纯函数，无 WS）。
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const adminCapUrl = pathToFileURL(join(__dirname, '../../../agent-repo-shared/adminCapabilities.ts')).href

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

async function main() {
  const { inferAdminTaskFromActionText, normalizeAdminToolPlan, isAdminLegacyInferEnabled } =
    await import(adminCapUrl)
  const { buildManagerAdminTaskPayload, adminScopedQueryFromMeta } = await import(
    pathToFileURL(join(__dirname, '../../../server/utils/admin/managerAdminTaskPayload.ts')).href
  )
  const { collectSubAgentScopeCandidates, pickSubAgentScopeSync } = await import(
    pathToFileURL(join(__dirname, '../../../server/utils/route/managerSubAgentScopeLlm.ts')).href
  )
  const { stripAdminManagerGuards } = await import(
    pathToFileURL(join(__dirname, '../../../server/utils/route/managerSubAgentHelpers.ts')).href
  )

  assert(!isAdminLegacyInferEnabled(), 'ADMIN_NLU_MODE=full: legacy infer off')

  const e4Meta = {
    stepDispatchDraft: [{ agent: 'admin', scopedUserLanguage: '坐地铁从天津西站到天津站大概多久' }]
  }

  const scoped = adminScopedQueryFromMeta(e4Meta, '整句不应出现')
  assert(scoped.includes('地铁'), `admin scope from draft: ${scoped}`)

  const travel = buildManagerAdminTaskPayload({
    actionText: scoped,
    meta: e4Meta
  })
  assert(travel.source === 'manager', 'source=manager')
  assert(!travel.tool_plan?.length, 'default payload must not regex-infer tool_plan')
  assert(travel.action_text.includes('天津西站'), 'action_text carries scoped sub-query')

  const weather = buildManagerAdminTaskPayload({ actionText: '北京明天天气怎么样' })
  assert(!weather.tool_plan?.length, 'weather: no manager tool_plan (Admin slot LLM fills)')
  assert(weather.action_text.includes('北京'), 'weather action_text preserved')

  const tianjin = buildManagerAdminTaskPayload({ actionText: '查天津今日天气预报' })
  assert(!tianjin.intent_hint, 'no regex intent_hint by default')
  assert(!tianjin.tool_plan?.length, 'no regex weather tool_plan')

  const orchestratedWeather = buildManagerAdminTaskPayload({
    actionText: '查天津今日天气预报',
    orchestratedToolPlan: [{ name: 'get_weather', args: {} }]
  })
  assert(orchestratedWeather.tool_plan?.[0]?.name === 'get_weather', 'orchestrated weather tool')
  assert(orchestratedWeather.read_only === true, 'get_weather is read_only')
  assert(!orchestratedWeather.tool_plan?.[0]?.args?.city, 'city left to Admin slot LLM')

  const genericAdminMeta = {
    intent: 'multi',
    planBlueprint: {
      steps: [{ agent: 'admin', queryFocus: '查询天气预报或处理办公/地图类子任务（与取数/图表分离）' }]
    },
    taskClauses: [{ id: 'c1', text: '查天津今日天气预报', agents: ['admin'] }]
  }
  const genericAdminCandidates = collectSubAgentScopeCandidates('admin', genericAdminMeta, '查天津今日天气预报')
  const genericAdminScoped = pickSubAgentScopeSync(genericAdminCandidates)
  assert(genericAdminScoped.includes('天津'), `generic admin scope must prefer clause: ${genericAdminScoped}`)

  const genericAdminPayload = buildManagerAdminTaskPayload({
    actionText: '查天津今日天气预报',
    meta: genericAdminMeta
  })
  assert(genericAdminPayload.action_text.includes('天津'), `generic admin action_text: ${genericAdminPayload.action_text}`)

  const wrapped = buildManagerAdminTaskPayload({
    actionText:
      '仅处理下列个人助理能力：日程/提醒/邮件/待办；天气预报（get_weather）；高德路线与耗时。\n查天津今日天气预报\n【总管约束】只执行本条中的日程',
    meta: { intent: 'multi', stepDispatchDraft: [{ agent: 'admin', scopedUserLanguage: '查天津今日天气预报' }] }
  })
  assert(wrapped.action_text.includes('天津'), `wrapped admin action_text: ${wrapped.action_text}`)
  assert(!wrapped.action_text.includes('总管约束'), 'strip guard from action_text')
  assert(!wrapped.tool_plan?.length, 'wrapped payload no regex tool_plan')

  // 无 draft 时：preamble 在开头不得把 action_text 切空后回退成整段 guard
  const wrappedNoDraft = buildManagerAdminTaskPayload({
    actionText: [
      '仅处理下列个人助理能力：邮件/联系人/待办/日程/提醒；天气预报（get_weather）；高德路线与耗时。',
      '勿混入搜索/问数/玩法/简报/文件。会议与日程须 add_event 落库，禁止仅用 add_reminder。',
      '若已给出会议标题与时间，直接创建，勿追问知识库或图表相关缺失项。',
      '明天上午10点创建项目周会',
      '【总管约束】只执行本条中的日程/提醒/邮件/待办'
    ].join('\n')
  })
  assert(
    wrappedNoDraft.action_text.includes('项目周会') && wrappedNoDraft.action_text.includes('明天上午10点'),
    `preamble-first strip must keep meeting slots: ${wrappedNoDraft.action_text}`
  )
  assert(!wrappedNoDraft.action_text.includes('仅处理下列'), 'action_text must not keep preamble')
  assert(!wrappedNoDraft.action_text.includes('总管约束'), 'action_text must not keep trailing guard')

  // 多行：会议日程 + 设置提醒 — 不得只剩提醒句丢掉时间/标题
  const multiLineMeeting = stripAdminManagerGuards(
    [
      '仅处理下列个人助理能力：邮件/联系人/待办/日程/提醒',
      '帮我创建明天上午10点的会议日程，标题为「项目周会」',
      '并设置会议提醒',
      '【总管约束】只执行本条'
    ].join('\n')
  )
  assert(
    multiLineMeeting.includes('明天上午10点') && multiLineMeeting.includes('项目周会') && multiLineMeeting.includes('提醒'),
    `multi-line strip must keep title+time+reminder: ${multiLineMeeting}`
  )

  // 逗号拼接的 preamble+任务不得整段当 action
  const commaJoined = stripAdminManagerGuards(
    '仅处理下列个人助理能力：日程/提醒，若已给出会议标题与时间，直接创建，帮我创建明天上午10点的会议日程，标题为「项目周会」，并设置会议提醒'
  )
  assert(
    commaJoined.includes('项目周会') && commaJoined.includes('10点') && !commaJoined.startsWith('仅处理下列'),
    `comma-joined preamble strip: ${commaJoined}`
  )

  const compositePayload = buildManagerAdminTaskPayload({
    actionText: [
      '仅处理下列个人助理能力：邮件/联系人/待办/日程/提醒；天气预报（get_weather）；高德路线与耗时。',
      '在知识库中检索个人月度财务情况，提炼要点并生成对比图表，并帮我创建明天上午10点的会议日程，标题为「项目周会」，并设置会议提醒。',
      '【总管约束】只执行本条中的日程'
    ].join('\n'),
    meta: {
      intent: 'multi',
      taskClauses: [
        { id: 'c1', text: '检索个人月度财务情况', agents: ['rag'] },
        {
          id: 'c2',
          text: '帮我创建明天上午10点的会议日程，标题为「项目周会」，并设置会议提醒',
          agents: ['admin']
        }
      ]
    }
  })
  assert(
    compositePayload.action_text.includes('项目周会') &&
      (compositePayload.action_text.includes('明天') || compositePayload.action_text.includes('10点')),
    `composite finance+meeting action_text: ${compositePayload.action_text}`
  )
  assert(!compositePayload.action_text.includes('仅处理下列'), 'composite action_text no preamble')
  assert(!compositePayload.action_text.includes('知识库'), `composite must not keep rag dump: ${compositePayload.action_text}`)

  const listMail = buildManagerAdminTaskPayload({ actionText: '查看未读邮件' })
  assert(!listMail.tool_plan?.length, 'list emails: Admin NLU handles tool selection')

  const meeting = buildManagerAdminTaskPayload({
    actionText: '明天上午10点安排项目周会'
  })
  assert(!meeting.read_only, 'schedule without orchestrated tool_plan is not read_only')
  assert(!meeting.tool_plan?.length, 'schedule: no regex add_event')

  const meetingReminderUpgrade = buildManagerAdminTaskPayload({
    actionText: '帮我创建明天上午10点会议日程',
    orchestratedToolPlan: [
      { name: 'add_reminder', args: { content: 'AI 助理提醒', remind_time_str: '明天上午10点' } }
    ]
  })
  assert(
    meetingReminderUpgrade.tool_plan?.some((t) => t.name === 'add_event'),
    `orchestrated add_reminder+会议日程 → add_event: ${JSON.stringify(meetingReminderUpgrade.tool_plan)}`
  )
  assert(
    !meetingReminderUpgrade.tool_plan?.some((t) => t.name === 'add_reminder'),
    'must not keep bare add_reminder for 会议日程'
  )

  const rejectSearch = buildManagerAdminTaskPayload({
    actionText: '查天津天气',
    orchestratedToolPlan: [
      { name: 'web_search', args: { query: '天气' } },
      { name: 'get_weather', args: {} }
    ]
  })
  assert(rejectSearch.tool_plan?.length === 1 && rejectSearch.tool_plan[0]?.name === 'get_weather', 'drop web_search')

  process.env.ADMIN_NLU_MODE = 'legacy'
  const legacyTravel = buildManagerAdminTaskPayload({ actionText: scoped, meta: e4Meta })
  assert(legacyTravel.tool_plan?.[0]?.name === 'get_travel_route', 'legacy infer travel tool')
  delete process.env.ADMIN_NLU_MODE

  const normalized = normalizeAdminToolPlan(
    '坐地铁从天津西站到天津站大概多久',
    inferAdminTaskFromActionText('坐地铁从天津西站到天津站大概多久').tool_plan
  )
  assert(normalized === undefined || normalized.length === 0, 'legacy infer off → empty tool_plan')

  const { buildAdminExecMessage, buildAdminEffectiveQuery } = await import(
    pathToFileURL(join(__dirname, '../../../server/graph/core/stepIsolation/exec.ts')).href
  )
  const leanMsg = buildAdminExecMessage('坐地铁从天津西站到天津站大概多久', {
    autoConfirm: true,
    readOnlyOrchestration: true
  })
  assert(leanMsg.includes('天津西站'), `lean message keeps travel query: ${leanMsg}`)
  assert(!/仅处理下列个人助理能力/.test(leanMsg), 'buildAdminExecMessage must not inject preamble')
  assert(!/【总管约束】/.test(leanMsg), 'buildAdminExecMessage must not inject guard')
  assert(!/【只读编排】/.test(leanMsg), 'buildAdminExecMessage must not inject read-only line')
  assert(!/（强制）不要等待人工确认/.test(leanMsg), 'buildAdminExecMessage must not inject auto-confirm line')
  const leanEff = buildAdminEffectiveQuery('查天津今日天气预报', '查天津今日天气预报', '', true)
  assert(leanEff.includes('天津'), `effQuery keeps weather: ${leanEff}`)
  assert(!/仅处理下列个人助理能力/.test(leanEff), 'effQuery no preamble')

  console.log('smoke-admin-manager-protocol: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
