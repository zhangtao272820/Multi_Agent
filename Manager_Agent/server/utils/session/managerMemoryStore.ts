import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery } from '#agent-shared/agentPgClient'
import { recordMemory } from '#agent-shared/agentMemoryApi'
import { AMP_EXPERIENCE_SUCCESS_THRESHOLD } from '#agent-shared/agentMemoryPolicy'
import {
  isPostgresStorageEnabled,
  resolveStorageBackend,
  shouldWriteFile,
  shouldWritePostgres
} from '#agent-shared/storageBackend'
import { normalizeTenantId, requireTenantId } from '#agent-shared/tenantScope'
import { managerDataRoot, resolveManagerPolicyDir } from './managerPolicyDir'

export function resolveManagerStorageBackend(env: NodeJS.ProcessEnv = process.env) {
  return resolveStorageBackend(env.MANAGER_STORAGE_BACKEND, 'file')
}

function memoryJsonlPath(tenantId?: string): string {
  return path.join(resolveManagerPolicyDir(tenantId), 'manager-memory.jsonl')
}

function legacyMemoryJsonlPath(): string {
  return path.join(managerDataRoot(), 'manager-memory.jsonl')
}

/** per-tenant in-memory cache */
const memoryCacheByTenant = new Map<string, Array<Record<string, unknown>>>()

function cacheKey(tenantId: string) {
  return normalizeTenantId(tenantId)
}

export async function hydrateManagerMemoryCache(
  maxLines = 600,
  tenantId?: string
): Promise<void> {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveManagerStorageBackend()
  if (isPostgresStorageEnabled(backend)) {
    const res = await agentPgQuery<{ entry_type: string; ts: string; payload: Record<string, unknown> }>(
      `SELECT entry_type, ts, payload FROM mgr_memory_entries
       WHERE tenant_id = $1
       ORDER BY id DESC LIMIT $2`,
      [tid, maxLines]
    )
    if (res) {
      memoryCacheByTenant.set(
        cacheKey(tid),
        res.rows.reverse().map((r) => ({
          ts: r.ts instanceof Date ? (r.ts as Date).toISOString() : String(r.ts),
          type: r.entry_type,
          tenantId: tid,
          ...r.payload
        }))
      )
      return
    }
  }
  try {
    let raw = await fs.readFile(memoryJsonlPath(tid), 'utf8').catch(() => '')
    if (!raw.trim() && tid === 'default') {
      raw = await fs.readFile(legacyMemoryJsonlPath(), 'utf8').catch(() => '')
    }
    memoryCacheByTenant.set(
      cacheKey(tid),
      raw
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-maxLines)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    )
  } catch {
    memoryCacheByTenant.set(cacheKey(tid), [])
  }
}

export function readManagerMemorySync(maxLines = 520, tenantId?: string): Array<Record<string, unknown>> {
  const tid = normalizeTenantId(tenantId)
  const cache = memoryCacheByTenant.get(cacheKey(tid))
  if (cache?.length) return cache.slice(-maxLines)
  return []
}

export async function appendManagerMemory(entry: Record<string, unknown>): Promise<void> {
  const backend = resolveManagerStorageBackend()
  let tid: string
  try {
    tid = requireTenantId(entry.tenantId ?? entry.tenant_id)
  } catch {
    tid = normalizeTenantId(entry.tenantId ?? entry.tenant_id)
  }
  const row = { ts: new Date().toISOString(), tenantId: tid, ...entry }
  const entryType = String(entry.type || 'experience').slice(0, 32)
  const payload = { ...entry, tenantId: tid }

  if (shouldWritePostgres(backend)) {
    await recordMemory(
      {
        type: entryType as 'experience' | 'working' | 'semantic' | 'reflection',
        agent: 'manager',
        tenantId: tid,
        userKey: entry.userId ? String(entry.userId) : entry.user_id ? String(entry.user_id) : undefined,
        sessionId: entry.sessionId ? String(entry.sessionId) : undefined,
        successScore: Number(entry.successScore ?? entry.success_score),
        payload
      },
      process.env
    )
  }
  if (shouldWriteFile(backend)) {
    try {
      const dir = resolveManagerPolicyDir(tid)
      await fs.mkdir(dir, { recursive: true })
      await fs.appendFile(path.join(dir, 'manager-memory.jsonl'), `${JSON.stringify(row)}\n`, 'utf8')
    } catch {
      /* ignore */
    }
  }
  const key = cacheKey(tid)
  let cache = memoryCacheByTenant.get(key)
  if (!cache) cache = []
  cache.push(row)
  if (cache.length > 800) cache = cache.slice(-600)
  memoryCacheByTenant.set(key, cache)
}

export function experienceWriteThreshold(): number {
  return AMP_EXPERIENCE_SUCCESS_THRESHOLD
}
