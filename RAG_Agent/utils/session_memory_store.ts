import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentPgQuery } from '#agent-shared/agentPgClient'
import {
  isPostgresStorageEnabled,
  resolveStorageBackend,
  shouldWriteFile,
  shouldWritePostgres
} from '#agent-shared/storageBackend'
import { normalizeTenantId, tenantPolicyDir } from '#agent-shared/tenantScope'

export type LayeredSessionMemory = {
  summary: string
  topics: string[]
  updatedAt: number
  tenantId?: string
}

const MAX_SESSIONS = 200
const SESSION_TTL_MS = 1000 * 60 * 60 * 6

const sessionCacheByTenant = new Map<string, Record<string, LayeredSessionMemory>>()

function resolveBackend() {
  return resolveStorageBackend(process.env.RAG_AGENT_STORAGE_BACKEND, 'file')
}

function memoryFile(tenantId?: string) {
  const dir = tenantPolicyDir(join(process.cwd(), '.data'), normalizeTenantId(tenantId))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'rag-session-memory.json')
}

function loadFileStore(tenantId?: string): Record<string, LayeredSessionMemory> {
  const p = memoryFile(tenantId)
  if (!existsSync(p)) return {}
  try {
    const o = JSON.parse(readFileSync(p, 'utf8'))
    return o && typeof o === 'object' ? (o as Record<string, LayeredSessionMemory>) : {}
  } catch {
    return {}
  }
}

function saveFileStore(store: Record<string, LayeredSessionMemory>, tenantId?: string) {
  if (!shouldWriteFile(resolveBackend())) return
  const now = Date.now()
  const entries = Object.entries(store).filter(([, v]) => now - (v.updatedAt ?? 0) <= SESSION_TTL_MS)
  entries.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
  writeFileSync(memoryFile(tenantId), JSON.stringify(Object.fromEntries(entries.slice(0, MAX_SESSIONS)), null, 0), 'utf8')
}

export async function hydrateRagSessionMemoryCache(tenantId?: string): Promise<void> {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveBackend()
  if (isPostgresStorageEnabled(backend)) {
    const res = await agentPgQuery<{
      session_id: string
      summary: string
      topics: string[]
      updated_at: string
    }>(`SELECT session_id, summary, topics, updated_at FROM rag_session_memory WHERE tenant_id = $1`, [tid])
    if (res) {
      const store: Record<string, LayeredSessionMemory> = {}
      const now = Date.now()
      for (const r of res.rows) {
        const updatedAt = r.updated_at instanceof Date ? r.updated_at.getTime() : Date.parse(String(r.updated_at))
        if (now - updatedAt > SESSION_TTL_MS) continue
        store[r.session_id] = {
          summary: r.summary,
          topics: Array.isArray(r.topics) ? r.topics : [],
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
          tenantId: tid
        }
      }
      sessionCacheByTenant.set(tid, store)
      return
    }
  }
  sessionCacheByTenant.set(tid, loadFileStore(tid))
}

function getStore(tenantId?: string): Record<string, LayeredSessionMemory> {
  const tid = normalizeTenantId(tenantId)
  let store = sessionCacheByTenant.get(tid)
  if (!store) {
    store = loadFileStore(tid)
    sessionCacheByTenant.set(tid, store)
  }
  return store
}

async function persistSession(id: string, mem: LayeredSessionMemory, tenantId?: string): Promise<void> {
  const tid = normalizeTenantId(tenantId ?? mem.tenantId)
  const backend = resolveBackend()
  if (shouldWritePostgres(backend)) {
    await agentPgQuery(
      `INSERT INTO rag_session_memory (session_id, summary, topics, updated_at, tenant_id)
       VALUES ($1,$2,$3,to_timestamp($4/1000.0),$5)
       ON CONFLICT (session_id) DO UPDATE SET
         summary = EXCLUDED.summary,
         topics = EXCLUDED.topics,
         updated_at = EXCLUDED.updated_at,
         tenant_id = EXCLUDED.tenant_id`,
      [id, mem.summary, JSON.stringify(mem.topics), mem.updatedAt, tid]
    )
  }
  saveFileStore(getStore(tid), tid)
}

export function getRagSessionMemoryPg(sessionId: string, tenantId?: string): LayeredSessionMemory {
  const id = String(sessionId || '').trim()
  const tid = normalizeTenantId(tenantId)
  if (!id) return { summary: '', topics: [], updatedAt: Date.now(), tenantId: tid }
  const store = getStore(tid)
  const hit = store[id]
  if (!hit) return { summary: '', topics: [], updatedAt: Date.now(), tenantId: tid }
  if (Date.now() - hit.updatedAt > SESSION_TTL_MS) {
    delete store[id]
    void persistSession(id, { summary: '', topics: [], updatedAt: Date.now(), tenantId: tid }, tid).catch(() => undefined)
    return { summary: '', topics: [], updatedAt: Date.now(), tenantId: tid }
  }
  return hit
}

export function updateRagSessionMemoryPg(
  sessionId: string,
  patch: Partial<Pick<LayeredSessionMemory, 'summary' | 'topics'>>,
  tenantId?: string
) {
  const id = String(sessionId || '').trim()
  const tid = normalizeTenantId(tenantId)
  if (!id) return
  const store = getStore(tid)
  const prev = store[id] ?? { summary: '', topics: [], updatedAt: Date.now(), tenantId: tid }
  store[id] = {
    summary: patch.summary !== undefined ? patch.summary : prev.summary,
    topics: patch.topics !== undefined ? patch.topics : prev.topics,
    updatedAt: Date.now(),
    tenantId: tid
  }
  void persistSession(id, store[id]!, tid).catch(() => undefined)
}

export function clearRagSessionMemoryPg(sessionId: string, tenantId?: string) {
  const id = String(sessionId || '').trim()
  const tid = normalizeTenantId(tenantId)
  if (!id) return
  const store = getStore(tid)
  delete store[id]
  const backend = resolveBackend()
  if (shouldWritePostgres(backend)) {
    void agentPgQuery(`DELETE FROM rag_session_memory WHERE session_id = $1 AND tenant_id = $2`, [id, tid]).catch(
      () => undefined
    )
  }
  saveFileStore(store, tid)
}
