/**
 * Manager finalize → lob_gui_experience 同步（Lobster/GUI Agent 长期记忆联邦写入）
 */

import { agentPgQuery } from './agentPgClient'
import { shouldSyncGuiExperience, type RunOutcomeInput } from './agentOutcomePolicy'
import {
  emptyQuestionResult,
  experienceSnippet,
  experienceSyncSource,
  experienceSyncStatus,
  guardExperiencePg,
  normalizeExperienceQuestionKey,
  type ExperienceSyncOpts,
  type ExperienceSyncResult
} from './experienceBridgeContract'

export function isGuiExperienceBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_GUI_EXPERIENCE_SYNC ?? '1').trim() !== '0'
}

function buildGuiHint(input: {
  question: string
  resultText: string
  scenario?: string
  executionMode?: string
}): string {
  const parts = [
    input.scenario ? `场景=${input.scenario}` : '',
    input.executionMode ? `模式=${input.executionMode}` : '',
    experienceSnippet(input.resultText)
  ].filter(Boolean)
  return parts.join('；') || input.question.slice(0, 120)
}

export async function syncGuiExperienceFromManagerRun(
  input: RunOutcomeInput & {
    question: string
    scenario?: string
    executionMode?: string
  },
  env: NodeJS.ProcessEnv = process.env,
  opts?: ExperienceSyncOpts
): Promise<ExperienceSyncResult> {
  if (!isGuiExperienceBridgeEnabled(env)) return { synced: false, reason: 'disabled' }
  if (!shouldSyncGuiExperience(input, env, opts)) return { synced: false, reason: 'not_eligible' }
  const pgGuard = guardExperiencePg(env)
  if (pgGuard) return pgGuard

  const question = String(input.question || '').trim()
  const task_norm = normalizeExperienceQuestionKey(question)
  const empty = emptyQuestionResult(task_norm)
  if (empty) return empty

  const guiText = String(input.results.gui ?? input.results.Gui ?? '')
  const hint = buildGuiHint({
    question,
    resultText: guiText,
    scenario: input.scenario,
    executionMode: input.executionMode
  })

  const res = await agentPgQuery(
    `INSERT INTO lob_gui_experience
      (ts, task_norm, scenario, execution_mode, hint, source, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      new Date().toISOString(),
      task_norm,
      input.scenario?.slice(0, 64) ?? null,
      input.executionMode?.slice(0, 16) ?? null,
      hint,
      experienceSyncSource(opts),
      experienceSyncStatus(opts)
    ],
    env
  )
  return res ? { synced: true } : { synced: false, reason: 'write_failed' }
}
