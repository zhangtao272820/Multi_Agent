/**
 * Manager finalize → rag_learning_signals 同步（RAG Agent 长期记忆联邦写入）
 */

import { agentPgQuery } from './agentPgClient'
import { shouldSyncRagExperience, type RunOutcomeInput } from './agentOutcomePolicy'
import {
  emptyQuestionResult,
  experienceSnippet,
  experienceSyncSource,
  guardExperiencePg,
  normalizeExperienceQuestionKey,
  type ExperienceSyncOpts,
  type ExperienceSyncResult
} from './experienceBridgeContract'

export function isRagExperienceBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_RAG_EXPERIENCE_SYNC ?? '1').trim() !== '0'
}

function buildRagHint(input: {
  question: string
  resultText: string
  ragPath?: string
  sources?: string[]
}): string {
  const path = String(input.ragPath || 'document_query').slice(0, 64)
  const sources = (input.sources || []).filter(Boolean).slice(0, 4)
  const snippet = experienceSnippet(input.resultText)
  const sourcePart = sources.length ? `来源：${sources.join('、')}` : ''
  return [`路径=${path}`, sourcePart, snippet ? `结果摘要=${snippet}` : ''].filter(Boolean).join('；')
}

function extractRagSources(input: RunOutcomeInput & { ragSources?: string[] }): string[] {
  if (input.ragSources?.length) return input.ragSources.slice(0, 4)
  const ragText = String(input.results.rag ?? input.results.RAG ?? '')
  const m = ragText.match(/来源[:：]\s*([^\n]+)/)
  if (m?.[1]) {
    return m[1]
      .split(/[、,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4)
  }
  return []
}

export async function syncRagExperienceFromManagerRun(
  input: RunOutcomeInput & {
    question: string
    ragPath?: string
    ragSources?: string[]
  },
  env: NodeJS.ProcessEnv = process.env,
  opts?: ExperienceSyncOpts
): Promise<ExperienceSyncResult> {
  if (!isRagExperienceBridgeEnabled(env)) return { synced: false, reason: 'disabled' }
  if (!shouldSyncRagExperience(input, env, opts)) return { synced: false, reason: 'not_eligible' }
  const pgGuard = guardExperiencePg(env)
  if (pgGuard) return pgGuard

  const question = String(input.question || '').trim()
  const question_norm = normalizeExperienceQuestionKey(question)
  const empty = emptyQuestionResult(question_norm)
  if (empty) return empty

  const ragText = String(input.results.rag ?? input.results.RAG ?? '')
  const sources = extractRagSources(input)
  const hint = buildRagHint({
    question,
    resultText: ragText,
    ragPath: input.ragPath,
    sources
  })

  const res = await agentPgQuery(
    `INSERT INTO rag_learning_signals
      (at, question, question_norm, score, comment, path, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      new Date().toISOString(),
      question.slice(0, 500),
      question_norm,
      1,
      hint.slice(0, 500),
      String(input.ragPath || 'document_query').slice(0, 64),
      sources[0] || experienceSyncSource(opts)
    ],
    env
  )
  return res ? { synced: true } : { synced: false, reason: 'write_failed' }
}
