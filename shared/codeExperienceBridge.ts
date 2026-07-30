/**
 * Manager finalize → code_query_experience 同步（Code Agent 长期记忆联邦写入）
 */

import { agentPgQuery } from './agentPgClient'
import { shouldSyncCodeExperience, type RunOutcomeInput } from './agentOutcomePolicy'
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

export function isCodeExperienceBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_CODE_EXPERIENCE_SYNC ?? '1').trim() !== '0'
}

function inferTaskKind(input: { taskKind?: string; resultText: string }): string {
  const explicit = String(input.taskKind || '').trim()
  if (explicit) return explicit.slice(0, 32)
  const text = String(input.resultText || '').toLowerCase()
  if (/echarts|chart|visualiz/.test(text)) return 'visualize'
  if (/sql|query|select/.test(text)) return 'sql'
  if (/test|pytest|jest/.test(text)) return 'test'
  if (/refactor|rename/.test(text)) return 'refactor'
  return 'compute'
}

function buildCodeHint(input: {
  question: string
  resultText: string
  taskKind?: string
  hintFiles?: string[]
}): string {
  const kind = inferTaskKind(input)
  const files = (input.hintFiles || []).filter(Boolean).slice(0, 4)
  const snippet = experienceSnippet(input.resultText)
  const filePart = files.length ? `关注文件=${files.join(',')}` : ''
  return [`路径=${kind}`, filePart, snippet ? `结果摘要=${snippet}` : ''].filter(Boolean).join('；')
}

export async function syncCodeExperienceFromManagerRun(
  input: RunOutcomeInput & {
    question: string
    taskKind?: string
    hintFiles?: string[]
  },
  env: NodeJS.ProcessEnv = process.env,
  opts?: ExperienceSyncOpts
): Promise<ExperienceSyncResult> {
  if (!isCodeExperienceBridgeEnabled(env)) return { synced: false, reason: 'disabled' }
  if (!shouldSyncCodeExperience(input, env, opts)) return { synced: false, reason: 'not_eligible' }
  const pgGuard = guardExperiencePg(env)
  if (pgGuard) return pgGuard

  const question = String(input.question || '').trim()
  const question_norm = normalizeExperienceQuestionKey(question)
  const empty = emptyQuestionResult(question_norm)
  if (empty) return empty

  const codeText = String(input.results.code ?? input.results.Code ?? '')
  const taskKind = inferTaskKind({ taskKind: input.taskKind, resultText: codeText })
  const hint = buildCodeHint({
    question,
    resultText: codeText,
    taskKind,
    hintFiles: input.hintFiles
  })

  const res = await agentPgQuery(
    `INSERT INTO code_query_experience
      (ts, question_norm, task_kind, hint_files, hint, source, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      new Date().toISOString(),
      question_norm,
      taskKind,
      JSON.stringify((input.hintFiles || []).slice(0, 8)),
      hint,
      experienceSyncSource(opts),
      experienceSyncStatus(opts)
    ],
    env
  )
  return res ? { synced: true } : { synced: false, reason: 'write_failed' }
}
