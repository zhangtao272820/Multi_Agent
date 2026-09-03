/**
 * Manager finalize → ext_crawl_experience 同步（Extractor Agent 长期记忆联邦写入）
 */

import { agentPgQuery } from './agentPgClient'
import { shouldSyncCrawlerExperience, type RunOutcomeInput } from './agentOutcomePolicy'
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

export function isCrawlerExperienceBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_CRAWLER_EXPERIENCE_SYNC ?? '1').trim() !== '0'
}

function buildCrawlHint(input: {
  question: string
  resultText: string
  targetSite?: string
  channel?: string
  seedUrl?: string
}): string {
  const parts = [
    input.targetSite ? `站点=${input.targetSite}` : '',
    input.channel ? `通道=${input.channel}` : '',
    input.seedUrl ? `种子=${input.seedUrl.slice(0, 120)}` : '',
    experienceSnippet(input.resultText, 180)
  ].filter(Boolean)
  return parts.join('；') || input.question.slice(0, 120)
}

function inferTargetSite(text: string, seedUrl?: string): string | undefined {
  if (seedUrl) {
    try {
      return new URL(seedUrl).hostname.slice(0, 128)
    } catch {
      /* ignore */
    }
  }
  const m = text.match(/https?:\/\/[^\s/]+/)
  if (m?.[0]) {
    try {
      return new URL(m[0]).hostname.slice(0, 128)
    } catch {
      /* ignore */
    }
  }
  return undefined
}

export async function syncCrawlerExperienceFromManagerRun(
  input: RunOutcomeInput & {
    question: string
    targetSite?: string
    channel?: string
    seedUrl?: string
    contentType?: string
    fields?: string[]
  },
  env: NodeJS.ProcessEnv = process.env,
  opts?: ExperienceSyncOpts
): Promise<ExperienceSyncResult> {
  if (!isCrawlerExperienceBridgeEnabled(env)) return { synced: false, reason: 'disabled' }
  if (!shouldSyncCrawlerExperience(input, env, opts)) return { synced: false, reason: 'not_eligible' }
  const pgGuard = guardExperiencePg(env)
  if (pgGuard) return pgGuard

  const question = String(input.question || '').trim()
  const task_norm = normalizeExperienceQuestionKey(question)
  const empty = emptyQuestionResult(task_norm)
  if (empty) return empty

  const crawlerText = String(input.results.crawler ?? input.results.Crawler ?? '')
  const targetSite = input.targetSite || inferTargetSite(crawlerText, input.seedUrl)
  const hint = buildCrawlHint({
    question,
    resultText: crawlerText,
    targetSite,
    channel: input.channel,
    seedUrl: input.seedUrl
  })

  const res = await agentPgQuery(
    `INSERT INTO ext_crawl_experience
      (ts, task_norm, target_site, content_type, channel, seed_url, fields, hint, source, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      new Date().toISOString(),
      task_norm,
      targetSite ?? null,
      input.contentType?.slice(0, 64) ?? null,
      input.channel?.slice(0, 32) ?? null,
      input.seedUrl?.slice(0, 500) ?? null,
      JSON.stringify((input.fields || []).slice(0, 12)),
      hint,
      experienceSyncSource(opts),
      experienceSyncStatus(opts)
    ],
    env
  )
  return res ? { synced: true } : { synced: false, reason: 'write_failed' }
}
