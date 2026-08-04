/**
 * 会话冷归档：超 TTL 的 mgr_session_turns → mgr_session_turns_archive
 */

import { agentPgQuery } from './agentPgClient'
import { AMP_TTL } from './agentMemoryPolicy'

export function isSessionArchiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_SESSION_ARCHIVE_JOB ?? '1').trim() !== '0'
}

export function sessionArchiveRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MGR_SESSION_ARCHIVE_RETENTION_DAYS ?? AMP_TTL.workingMemoryDays ?? 7)
  return Number.isFinite(n) && n >= 1 ? Math.min(365, Math.floor(n)) : 7
}

export async function runSessionArchiveJob(env: NodeJS.ProcessEnv = process.env): Promise<{
  archivedSessions: number
  archivedTurns: number
}> {
  if (!isSessionArchiveEnabled(env)) return { archivedSessions: 0, archivedTurns: 0 }
  const days = sessionArchiveRetentionDays(env)

  const moved = await agentPgQuery<{ cnt: string }>(
    `WITH stale AS (
       SELECT session_id, turn_index, role, content, run_id, ui_meta
       FROM mgr_session_turns
       WHERE created_at < NOW() - ($1 || ' days')::interval
     ),
     ins AS (
       INSERT INTO mgr_session_turns_archive (session_id, turn_index, role, content, run_id, ui_meta)
       SELECT session_id, turn_index, role, content, run_id, ui_meta FROM stale
       RETURNING session_id
     ),
     del AS (
       DELETE FROM mgr_session_turns
       WHERE created_at < NOW() - ($1 || ' days')::interval
       RETURNING session_id
     )
     SELECT COUNT(*)::text AS cnt FROM del`,
    [String(days)],
    env
  )

  const archivedTurns = Number(moved?.rows?.[0]?.cnt ?? 0)
  return { archivedSessions: archivedTurns > 0 ? 1 : 0, archivedTurns }
}
