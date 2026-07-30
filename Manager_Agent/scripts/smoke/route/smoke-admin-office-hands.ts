/**
 * 总管可编排 Admin 扩展面：简报 / 会前 / 工作区文件（契约 smoke，无 LLM）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatAdminCrawlerDisambiguationPrompt,
  formatAgentBoundaryPrompt
} from '../../../server/graph/orchestrate/unifiedRouting'
import {
  MANAGER_ADMIN_TOOL_NAMES,
  adminTaskLlmToolCatalog,
  adminStepQueryPreamble,
  isManagerAdminTool
} from '../../../agent-repo-shared/adminCapabilities'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-admin-office-hands] ${msg}`)
}

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

const catalog = adminTaskLlmToolCatalog()
for (const t of [
  'daily_briefing',
  'weekly_report',
  'prepare_meeting',
  'extract_meeting_actions',
  'add_tasks_from_minutes',
  'list_files',
  'read_file_content',
  'write_file',
  'move_file',
  'create_directory',
  'read_office_document',
  'write_office_document',
  'list_email_attachments',
  'save_email_attachment',
  'draft_email_reply',
  'modify_task'
]) {
  assert(MANAGER_ADMIN_TOOL_NAMES.has(t), `whitelist has ${t}`)
  assert(isManagerAdminTool(t), `isManagerAdminTool(${t})`)
  assert(catalog.includes(t), `catalog mentions ${t}`)
}

assert(!MANAGER_ADMIN_TOOL_NAMES.has('web_search'), 'web_search still forbidden')
assert(!MANAGER_ADMIN_TOOL_NAMES.has('lobster_browser_task'), 'lobster still forbidden')
assert(!MANAGER_ADMIN_TOOL_NAMES.has('ask_database'), 'ask_database still forbidden')
assert(!MANAGER_ADMIN_TOOL_NAMES.has('fetch_url_content'), 'fetch_url still forbidden')

const disambig = formatAdminCrawlerDisambiguationPrompt()
assert(disambig.includes('daily_briefing'), 'disambig mentions daily_briefing')
assert(disambig.includes('prepare_meeting'), 'disambig mentions prepare_meeting')
assert(disambig.includes('list_files'), 'disambig mentions list_files')
assert(disambig.includes('禁止') && disambig.includes('gui'), 'disambig keeps gui out of office hands')

const boundary = formatAgentBoundaryPrompt()
assert(boundary.includes('简报') || boundary.includes('工作区文件'), 'boundary mentions expanded admin purpose')

const preamble = adminStepQueryPreamble()
assert(preamble.includes('daily_briefing'), 'preamble has briefing')
assert(preamble.includes('prepare_meeting'), 'preamble has meeting prep')
assert(preamble.includes('list_files'), 'preamble has files')

const skill = readSource('Manager_Agent/skills/admin_capabilities/skill.md')
assert(skill.includes('办公六类') || skill.includes('简报'), 'skill documents expanded scope')
assert(skill.includes('工作区') || skill.includes('list_files'), 'skill mentions workspace files')
assert(skill.includes('联网搜索') || skill.includes('浏览器'), 'skill still forbids search/browser via admin')

const pyPlan = readSource('AI_admin_Agent/backend/app/core/admin_manager_plan_llm.py')
assert(pyPlan.includes('"daily_briefing"'), 'python MANAGER_ADMIN_TOOLS has daily_briefing')
assert(pyPlan.includes('"write_file"'), 'python MANAGER_ADMIN_TOOLS has write_file')

const gate = readSource('AI_admin_Agent/backend/app/core/admin_write_gate_contract.py')
assert(gate.includes('"write_file"'), 'write_gate includes write_file')
assert(gate.includes('"move_file"'), 'write_gate includes move_file')

console.log('smoke-admin-office-hands OK')
