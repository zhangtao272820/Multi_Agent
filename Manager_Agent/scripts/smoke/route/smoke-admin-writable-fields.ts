/**
 * Admin 可写字段侧车 / normalize 契约 smoke（无 LLM）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-admin-writable-fields] ${msg}`)
}

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

async function main() {
  const adminCapUrl = pathToFileURL(
    path.join(__dirname, '../../../agent-repo-shared/adminCapabilities.ts')
  ).href
  const { MANAGER_ADMIN_TOOL_NAMES, normalizeAdminToolPlan, isManagerAdminTool } = await import(adminCapUrl)
  const { buildManagerAdminTaskPayload } = await import(
    pathToFileURL(path.join(__dirname, '../../../server/utils/admin/managerAdminTaskPayload.ts')).href
  )

  assert(MANAGER_ADMIN_TOOL_NAMES.has('draft_email_reply'), 'whitelist has draft_email_reply')
  assert(MANAGER_ADMIN_TOOL_NAMES.has('modify_task'), 'whitelist has modify_task')
  assert(isManagerAdminTool('draft_email_reply'), 'isManagerAdminTool draft_email_reply')
  assert(isManagerAdminTool('modify_task'), 'isManagerAdminTool modify_task')

  const source =
    '创建明天上午10点的会议日程，标题为「项目周会」，详细内容是：明天项目总结和反思，并设置会议提醒'
  const scoped = '创建明天上午10点的会议日程，标题为「项目周会」，并设置会议提醒'

  const payload = buildManagerAdminTaskPayload({
    actionText: scoped,
    scopedText: scoped,
    sourceUserTask: source,
    orchestratedToolPlan: [
      {
        name: 'add_event',
        args: { title: '项目周会', description: '明天项目总结和反思', start_time_str: '明天上午10点' }
      }
    ]
  })
  assert(payload.source_user_task?.includes('详细内容'), `source_user_task kept: ${payload.source_user_task}`)
  assert(payload.action_text.includes('项目周会'), 'action_text scoped')
  assert(payload.tool_plan?.[0]?.name === 'add_event', 'add_event plan')
  assert(
    String(payload.tool_plan?.[0]?.args?.description || '') === '明天项目总结和反思',
    `description from plan: ${JSON.stringify(payload.tool_plan?.[0]?.args)}`
  )

  const titleAsDesc = normalizeAdminToolPlan(source, [
    { name: 'add_event', args: { title: '项目周会', description: '项目周会', start_time_str: '明天10点' } }
  ])
  assert(titleAsDesc?.[0]?.name === 'add_event', 'normalize add_event')
  assert(
    !String(titleAsDesc?.[0]?.args?.description || '').trim(),
    `title-as-description cleared: ${JSON.stringify(titleAsDesc?.[0]?.args)}`
  )

  const upgraded = normalizeAdminToolPlan('安排明天下午会议并提醒我', [
    { name: 'add_reminder', args: { content: '项目周会', remind_time_str: '明天下午' } }
  ])
  assert(upgraded?.[0]?.name === 'add_event', 'meeting reminder upgrades to add_event')
  assert(
    !String(upgraded?.[0]?.args?.description || '').trim() ||
      String(upgraded?.[0]?.args?.description) !== String(upgraded?.[0]?.args?.title),
    'upgrade does not force title into description'
  )

  const orch = readSource('Manager_Agent/server/graph/llm/orchestratorPromptProfiles.ts')
  assert(orch.includes('admin 可写字段') || orch.includes('详细内容'), 'orch mentions admin writable fields')

  const blueprint = readSource('Manager_Agent/server/graph/llm/planBlueprintLlm.ts')
  assert(blueprint.includes('admin 例外') || blueprint.includes('可写槽位'), 'blueprint keeps admin writable slots')
  assert(blueprint.includes('queryFocusMaxLen') || blueprint.includes('480'), 'admin queryFocus max relaxed')

  const skill = readSource('Manager_Agent/skills/admin_capabilities/skill.md')
  assert(skill.includes('source_user_task') || skill.includes('可写字段'), 'admin skill documents writable fields')

  const py = readSource('AI_admin_Agent/backend/app/core/admin_manager_plan_llm.py')
  assert(py.includes('source_user_task'), 'python plan uses source_user_task')
  assert(py.includes('draft_email_reply'), 'python whitelist has draft')
  assert(py.includes('_manager_writable_desc_needs_slot_llm'), 'writable desc slot llm gate')

  const nlu = readSource('AI_admin_Agent/backend/app/core/admin_nlu.py')
  assert(nlu.includes('event_description'), 'nlu has event_description')
  assert(nlu.includes('task_description'), 'nlu has task_description')

  const fast = readSource('AI_admin_Agent/backend/app/core/admin_plan_fastpath.py')
  assert(fast.includes('resolve_task_description'), 'fastpath task description helper')
  assert(fast.includes('禁止用 title 顶替') || fast.includes('event_description'), 'resolve_event_description uses slots not title')

  const inject = readSource('AI_admin_Agent/backend/app/core/admin_slot_inject.py')
  assert(inject.includes('event_description'), 'inject uses event_description')
  assert(inject.includes('task_description'), 'inject uses task_description')

  const todoPayload = buildManagerAdminTaskPayload({
    actionText: '添加待办周报',
    scopedText: '添加待办周报',
    sourceUserTask: '添加待办周报，详细说明是写本周进度与风险',
    orchestratedToolPlan: [
      { name: 'add_task', args: { title: '周报', description: '写本周进度与风险' } }
    ]
  })
  assert(
    String(todoPayload.tool_plan?.[0]?.args?.description || '') === '写本周进度与风险',
    `todo description kept: ${JSON.stringify(todoPayload.tool_plan?.[0]?.args)}`
  )
  assert(todoPayload.source_user_task?.includes('详细说明'), 'todo source_user_task kept')

  console.log('smoke-admin-writable-fields OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
