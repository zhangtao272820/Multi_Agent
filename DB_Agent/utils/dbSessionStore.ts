/**
 * DB Agent 会话存储：PG 权威（db_sessions / db_session_turns）+ 文件 fallback
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery } from '#agent-shared/agentPgClient'
import { AMP_TTL } from '#agent-shared/agentMemoryPolicy'
import {
  isPostgresStorageEnabled,
  resolveStorageBackend,
  shouldWriteFile,
  shouldWritePostgres
} from '#agent-shared/storageBackend'

export type DbSessionMessage = { role: 'user' | 'assistant'; content: string }
export type DbSession = { messages: DbSessionMessage[] }

const SESSION_MAX_TURNS = AMP_TTL.sessionTurnsMax

function sessionsDir() {
  return path.join(process.cwd(), '.data', 'db-sessions')
}

function sessionFile(sessionId: string) {
  return path.join(sessionsDir(), `${sessionId}.json`)
}

function normalizeMessages(raw: unknown): DbSessionMessage[] {
  const arr = Array.isArray((raw as { messages?: unknown })?.messages)
    ? (raw as { messages: unknown[] }).messages
    : Array.isArray(raw)
      ? raw
      : []
  return arr
    .map((m: { role?: string; content?: string }) => ({
      role: m?.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(m?.content ?? '').trim()
    }))
    .filter((m) => m.content)
    .slice(-SESSION_MAX_TURNS)
}

export function resolveDbStorageBackend(env: NodeJS.ProcessEnv = process.env) {
  return resolveStorageBackend(env.DB_AGENT_STORAGE_BACKEND, 'file')
}

async function readSessionFromFile(sessionId: string): Promise<DbSession> {
  const sid = String(sessionId || '').trim()
  if (!sid) return { messages: [] }
  try {
    const text = await fs.readFile(sessionFile(sid), 'utf8').catch(() => '')
    if (!text.trim()) return { messages: [] }
    return { messages: normalizeMessages(JSON.parse(text)) }
  } catch {
    return { messages: [] }
  }
}

async function writeSessionToFile(sessionId: string, messages: DbSessionMessage[]) {
  const sid = String(sessionId || '').trim()
  if (!sid) return
  await fs.mkdir(sessionsDir(), { recursive: true }).catch(() => undefined)
  await fs.writeFile(
    sessionFile(sid),
    JSON.stringify({ messages: messages.slice(-SESSION_MAX_TURNS) }, null, 2),
    'utf8'
  )
}

async function readSessionFromPg(sessionId: string): Promise<DbSession | null> {
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  const res = await agentPgQuery<{ role: string; content: string }>(
    `SELECT role, content FROM db_session_turns
     WHERE session_id = $1 ORDER BY turn_index ASC LIMIT $2`,
    [sid, SESSION_MAX_TURNS]
  )
  if (!res) return null
  return {
    messages: res.rows
      .map((r) => ({
        role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: String(r.content ?? '').trim()
      }))
      .filter((m) => m.content)
  }
}

async function writeSessionToPg(sessionId: string, messages: DbSessionMessage[], userId?: string) {
  const sid = String(sessionId || '').trim()
  if (!sid) return false
  const capped = messages.slice(-SESSION_MAX_TURNS)
  const uid = String(userId || '').trim() || null
  const upsert = await agentPgQuery(
    `INSERT INTO db_sessions (id, user_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET
       user_id = COALESCE(EXCLUDED.user_id, db_sessions.user_id),
       updated_at = NOW()`,
    [sid, uid]
  )
  if (!upsert) return false
  const del = await agentPgQuery(`DELETE FROM db_session_turns WHERE session_id = $1`, [sid])
  if (!del) return false
  for (let i = 0; i < capped.length; i++) {
    const m = capped[i]!
    const ins = await agentPgQuery(
      `INSERT INTO db_session_turns (session_id, turn_index, role, content) VALUES ($1,$2,$3,$4)`,
      [sid, i, m.role, m.content]
    )
    if (!ins) return false
  }
  return true
}

export async function readDbSession(sessionId: string): Promise<DbSession> {
  const backend = resolveDbStorageBackend()
  if (isPostgresStorageEnabled(backend)) {
    const pg = await readSessionFromPg(sessionId)
    if (pg && pg.messages.length) return pg
    if (backend === 'postgres' && pg) return pg
  }
  return readSessionFromFile(sessionId)
}

export async function writeDbSession(
  sessionId: string,
  session: DbSession,
  opts?: { userId?: string; title?: string; customTitle?: boolean }
): Promise<void> {
  const backend = resolveDbStorageBackend()
  const messages = session.messages.slice(-SESSION_MAX_TURNS)
  if (shouldWritePostgres(backend)) {
    try {
      await writeSessionToPg(sessionId, messages, opts?.userId)
      if (opts?.title || opts?.customTitle) {
        await agentPgQuery(
          `UPDATE db_sessions SET
             title = COALESCE($2, title),
             custom_title = COALESCE($3, custom_title),
             updated_at = NOW()
           WHERE id = $1`,
          [sessionId, opts?.title ?? null, opts?.customTitle ?? null]
        ).catch(() => undefined)
      }
    } catch {
      /* file fallback */
    }
  }
  if (shouldWriteFile(backend)) {
    await writeSessionToFile(sessionId, messages).catch(() => undefined)
  }
}

export async function deleteDbSession(sessionId: string): Promise<void> {
  const sid = String(sessionId || '').trim()
  if (!sid) return
  await agentPgQuery(`DELETE FROM db_sessions WHERE id = $1`, [sid]).catch(() => undefined)
  await fs.unlink(sessionFile(sid)).catch(() => undefined)
}

export async function listDbSessionsForUser(userId: string): Promise<string[]> {
  const uid = String(userId || '').trim()
  if (!uid) return []
  const res = await agentPgQuery<{ id: string }>(
    `SELECT id FROM db_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 80`,
    [uid]
  ).catch(() => null)
  return res?.rows.map((r) => r.id) ?? []
}

export async function getDbSessionUserId(sessionId: string): Promise<string | null> {
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  const res = await agentPgQuery<{ user_id: string | null }>(
    `SELECT user_id FROM db_sessions WHERE id = $1`,
    [sid]
  ).catch(() => null)
  const uid = String(res?.rows?.[0]?.user_id || '').trim()
  return uid || null
}

export async function updateDbSessionMeta(
  sessionId: string,
  opts: { userId?: string; title?: string; customTitle?: boolean }
): Promise<void> {
  const sid = String(sessionId || '').trim()
  if (!sid) return
  const backend = resolveDbStorageBackend()
  if (!shouldWritePostgres(backend)) return
  await agentPgQuery(
    `INSERT INTO db_sessions (id, user_id, title, custom_title, updated_at)
     VALUES ($1, $2, $3, COALESCE($4, false), NOW())
     ON CONFLICT (id) DO UPDATE SET
       user_id = COALESCE(EXCLUDED.user_id, db_sessions.user_id),
       title = COALESCE(EXCLUDED.title, db_sessions.title),
       custom_title = COALESCE($4, db_sessions.custom_title),
       updated_at = NOW()`,
    [sid, String(opts.userId || '').trim() || null, opts.title ?? null, opts.customTitle ?? null]
  ).catch(() => undefined)
}

export async function getDbSessionMeta(sessionId: string) {
  const res = await agentPgQuery<{ title: string | null; custom_title: boolean; updated_at: Date | string }>(
    `SELECT title, custom_title, updated_at FROM db_sessions WHERE id = $1`,
    [sessionId]
  ).catch(() => null)
  const row = res?.rows?.[0]
  if (!row) return { title: '', customTitle: false, updatedAt: '' }
  return {
    title: String(row.title || ''),
    customTitle: Boolean(row.custom_title),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || '')
  }
}
