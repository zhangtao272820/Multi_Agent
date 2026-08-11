/**
 * Manager finalize → adm_tool_experience 同步（Admin Agent 长期记忆联邦写入）
 */

import { agentPgQuery } from './agentPgClient'
import { shouldSyncAdminExperience, type RunOutcomeInput } from './agentOutcomePolicy'
import {
  emptyQuestionResult,
  experienceSnippet,
  experienceSyncSource,
  experienceSyncSourcePlane,
  guardExperiencePg,
  normalizeExperienceQuestionKey,
  type ExperienceSyncOpts,
  type ExperienceSyncResult
} from './experienceBridgeContract'
import { normalizeTenantId } from './tenantScope'

export function isAdminExperienceBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_ADMIN_EXPERIENCE_SYNC ?? '1').trim() !== '0'
}

const SCENARIO_TOOL: Record<string, string> = {
  daily_briefing: 'daily_briefing',
  email_triage: 'triage_emails',
  meeting_prep: 'prepare_meeting',
  ask_database: 'ask_database',
  weekly_report: 'weekly_report',
  meeting_minutes: 'extract_meeting_actions',
  lobster_automation: 'lobster_browser_task',
  travel_route: 'amap_route',
  feishu_calendar: 'sync_feishu_calendar',
  feishu_notify: 'send_feishu_message',
  reminder_notify: 'schedule_reminder'
}

function inferScenario(input: { scenarioKey?: string; intent?: string }): string | undefined {
  const key = String(input.scenarioKey || input.intent || '')
    .trim()
    .slice(0, 64)
  return key || undefined
}

function buildAdminHint(input: {
  question: string
  resultText: string
  scenario?: string
  toolName?: string
}): string {
  const scenario = String(input.scenario || 'general').slice(0, 64)
  const tool = String(input.toolName || 'admin').slice(0, 64)
  const snippet = experienceSnippet(input.resultText)
  return `场景=${scenario}；工具=${tool}；结果摘要=${snippet || input.question.slice(0, 80)}`
}

export async function syncAdminExperienceFromManagerRun(
  input: RunOutcomeInput & {
    question: string
    scenarioKey?: string
    intent?: string
    tenantId?: string
  },
  env: NodeJS.ProcessEnv = process.env,
  opts?: ExperienceSyncOpts
): Promise<ExperienceSyncResult> {
  if (!isAdminExperienceBridgeEnabled(env)) return { synced: false, reason: 'disabled' }
  if (!shouldSyncAdminExperience(input, env, opts)) return { synced: false, reason: 'not_eligible' }
  const pgGuard = guardExperiencePg(env)
  if (pgGuard) return pgGuard

  const question = String(input.question || '').trim()
  const question_norm = normalizeExperienceQuestionKey(question)
  const empty = emptyQuestionResult(question_norm)
  if (empty) return empty

  const adminText = String(input.results.admin ?? input.results.Admin ?? '')
  const scenario = inferScenario({ scenarioKey: input.scenarioKey, intent: input.intent })
  const toolName = (scenario && SCENARIO_TOOL[scenario]) || 'admin_task'
  const hint = buildAdminHint({ question, resultText: adminText, scenario, toolName })

  const tid = normalizeTenantId(input.tenantId || env.AGENT_TENANT_ID || env.TENANT_ID)
  const res = await agentPgQuery(
    `INSERT INTO adm_tool_experience
      (ts, question_norm, tool_name, scenario, hint, source, status, run_id, tools_json, tenant_id, source_plane)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', NULL, '[]'::jsonb, $7, $8)`,
    [
      new Date().toISOString(),
      question_norm,
      toolName,
      scenario ?? null,
      hint,
      experienceSyncSource(opts),
      tid,
      experienceSyncSourcePlane(opts)
    ],
    env
  )
  return res ? { synced: true } : { synced: false, reason: 'write_failed' }
}
