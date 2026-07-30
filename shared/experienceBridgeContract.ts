/**
 * 经验联邦写入 / 召回 SSOT（右弼 Experience）
 * 各 *ExperienceBridge 共用规范化、来源标记与前置门禁；领域表仍由各 bridge 写入。
 */

import { isAgentPgConfigured } from './agentPgClient'
import { isConfirmedExperienceRow, isExperienceRecallConfirmedOnly } from './experienceRecallPolicy'

export type ExperienceDomain = 'manager' | 'db' | 'rag' | 'code' | 'crawler' | 'gui' | 'admin'

export type ExperienceSyncResult = {
  synced: boolean
  reason?: string
}

export type ExperienceSyncOpts = {
  force?: boolean
}

/** 问句规范化：跨域 experience 主键 / ILIKE 共用 */
export function normalizeExperienceQuestionKey(question: string, max = 120): string {
  return String(question ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，,。.;；:：!?？]/g, '')
    .slice(0, max)
}

export function experienceSnippet(text: string, max = 200): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** finalize 自动同步 vs 用户 👍 强制确认 */
export function experienceSyncSource(opts?: ExperienceSyncOpts): string {
  return opts?.force ? 'manager_feedback_confirmed' : 'manager_finalize_sync'
}

export function experienceSyncStatus(opts?: ExperienceSyncOpts): 'confirmed' | 'pending' {
  return opts?.force ? 'confirmed' : 'confirmed'
}

/**
 * 联邦 sync 公共前置：未配置 PG 则跳过。
 * 返回非 null 表示应立即 return（不可写）。
 */
export function guardExperiencePg(env: NodeJS.ProcessEnv = process.env): ExperienceSyncResult | null {
  if (!isAgentPgConfigured(env)) return { synced: false, reason: 'pg_not_configured' }
  return null
}

export function emptyQuestionResult(questionNorm: string): ExperienceSyncResult | null {
  if (!questionNorm) return { synced: false, reason: 'empty_question' }
  return null
}

/** 召回侧：统一确认门控（jsonl / 无 status 列兜底） */
export function mayRecallExperienceRow(
  row: { source?: string; userConfirmed?: boolean; status?: string },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isExperienceRecallConfirmedOnly(env)) return true
  return isConfirmedExperienceRow(row)
}

export {
  isConfirmedExperienceRow,
  isExperienceRecallConfirmedOnly
} from './experienceRecallPolicy'
