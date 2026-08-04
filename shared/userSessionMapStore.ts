/**
 * user-session 映射：PG `mgr_sessions.user_id` 为主，文件 `user-session-map.json` 为 dual 回退。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery } from './agentPgClient'
import { isPostgresStorageEnabled, resolveStorageBackend } from './storageBackend'
import { normalizeTenantId } from './tenantScope'

const MAP_FILE = 'user-session-map.json'

export function sanitizeUserId(raw: unknown): string | null {
  const s = String(raw || '').trim()
  if (!s || s.length > 64) return null
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  return s
}

type SessionMap = Record<string, { userId: string; updatedAt: string }>

function backendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isPostgresStorageEnabled(resolveStorageBackend(env.MANAGER_STORAGE_BACKEND, 'file'))
}

async function readFileMap(policyDir: string): Promise<SessionMap> {
  try {
    const raw = await fs.readFile(path.join(policyDir, MAP_FILE), 'utf8')
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? (o as SessionMap) : {}
  } catch {
    return {}
  }
}

async function writeFileMap(policyDir: string, map: SessionMap): Promise<void> {
  await fs.mkdir(policyDir, { recursive: true }).catch(() => undefined)
  await fs.writeFile(path.join(policyDir, MAP_FILE), JSON.stringify(map, null, 2), 'utf8')
}

export async function bindSessionUser(
  sessionId: string,
  userId: string,
  policyDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const uid = sanitizeUserId(userId)
  const sid = String(sessionId || '').trim()
  if (!uid || !sid) return uid

  if (backendEnabled(env)) {
    await agentPgQuery(
      `INSERT INTO mgr_sessions (id, user_id, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = NOW()`,
      [sid, uid],
      env
    )
  }

  const map = await readFileMap(policyDir)
  map[sid] = { userId: uid, updatedAt: new Date().toISOString() }
  await writeFileMap(policyDir, map)
  return uid
}

export async function bindSessionTenant(
  sessionId: string,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const sid = String(sessionId || '').trim()
  const tid = normalizeTenantId(tenantId, env)
  if (!sid) return tid
  if (backendEnabled(env)) {
    await agentPgQuery(
      `INSERT INTO mgr_sessions (id, tenant_id, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, updated_at = NOW()`,
      [sid, tid],
      env
    )
  }
  return tid
}

export async function resolveSessionTenantId(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const sid = String(sessionId || '').trim()
  if (!sid) return normalizeTenantId(undefined, env)
  if (backendEnabled(env)) {
    const res = await agentPgQuery<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM mgr_sessions WHERE id = $1`,
      [sid],
      env
    )
    const tid = String(res?.rows?.[0]?.tenant_id || '').trim()
    if (tid) return tid.slice(0, 64)
  }
  return normalizeTenantId(undefined, env)
}

export async function resolveSessionUserId(
  sessionId: string,
  policyDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const sid = String(sessionId || '').trim()
  if (!sid) return null

  if (backendEnabled(env)) {
    const res = await agentPgQuery<{ user_id: string | null }>(
      `SELECT user_id FROM mgr_sessions WHERE id = $1`,
      [sid],
      env
    )
    const mapped = sanitizeUserId(res?.rows?.[0]?.user_id)
    if (mapped) return mapped
  }

  const map = await readFileMap(policyDir)
  return sanitizeUserId(map[sid]?.userId)
}

export async function listSessionIdsForUser(
  userId: string,
  policyDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const uid = sanitizeUserId(userId)
  if (!uid) return []
  const ids = new Set<string>()

  if (backendEnabled(env)) {
    const res = await agentPgQuery<{ id: string }>(
      `SELECT id FROM mgr_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 500`,
      [uid],
      env
    )
    for (const row of res?.rows ?? []) ids.add(row.id)
  }

  const map = await readFileMap(policyDir)
  for (const [sid, v] of Object.entries(map)) {
    if (v?.userId === uid) ids.add(sid)
  }
  if ((uid.startsWith('sid_') || uid.includes('-')) && !ids.has(uid)) ids.add(uid)
  return [...ids]
}

export async function listKnownUserIds(policyDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const ids = new Set<string>()

  if (backendEnabled(env)) {
    const res = await agentPgQuery<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM mgr_sessions WHERE user_id IS NOT NULL LIMIT 1000`,
      [],
      env
    )
    for (const row of res?.rows ?? []) {
      const u = sanitizeUserId(row.user_id)
      if (u) ids.add(u)
    }
  }

  const map = await readFileMap(policyDir)
  for (const v of Object.values(map)) {
    const u = sanitizeUserId(v?.userId)
    if (u) ids.add(u)
  }
  return [...ids]
}

export async function removeSessionUserMapping(
  sessionId: string,
  policyDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const sid = String(sessionId || '').trim()
  if (!sid) return

  // 会话删除路径会先 DROP mgr_sessions；此处只清映射，不再 UPDATE 空壳行
  const map = await readFileMap(policyDir)
  if (map[sid]) {
    delete map[sid]
    await writeFileMap(policyDir, map)
  }
}

/** 一次性：文件映射 → PG */
export async function migrateUserSessionMapFromFile(
  policyDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ migrated: number }> {
  if (!backendEnabled(env)) return { migrated: 0 }
  const map = await readFileMap(policyDir)
  let migrated = 0
  for (const [sid, v] of Object.entries(map)) {
    const uid = sanitizeUserId(v?.userId)
    if (!uid) continue
    await agentPgQuery(
      `INSERT INTO mgr_sessions (id, user_id, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET user_id = COALESCE(mgr_sessions.user_id, EXCLUDED.user_id), updated_at = NOW()`,
      [sid, uid],
      env
    )
    migrated += 1
  }
  return { migrated }
}
