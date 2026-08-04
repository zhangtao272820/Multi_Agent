/**
 * Manager 记忆统一读取：PG 优先，文件回退（dual/postgres 契约）
 * 多租户：可选 tenantId；缺省时用 normalizeTenantId
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery } from './agentPgClient'
import type { MemoryEventType } from './agentMemoryApi'
import { isPostgresStorageEnabled, resolveStorageBackend } from './storageBackend'
import { normalizeTenantId } from './tenantScope'

async function readJsonlTail(filePath: string, maxLines: number): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(filePath, 'utf8').catch(() => '')
  if (!raw.trim()) return []
  const lines = raw.split('\n').filter((l) => l.trim()).slice(-Math.max(1, maxLines))
  const out: Array<Record<string, unknown>> = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      /* skip */
    }
  }
  return out
}

async function readHistoryFromFile(
  policyDir: string,
  maxLines: number,
  typeFilter?: MemoryEventType[]
): Promise<Array<Record<string, unknown>>> {
  const jsonlPath = path.join(policyDir, 'manager-memory.jsonl')
  const jsonPath = path.join(policyDir, 'manager-memory.json')
  const fromJsonl = await fs.readFile(jsonlPath, 'utf8').catch(() => '')
  if (fromJsonl.trim()) {
    const rows = await readJsonlTail(jsonlPath, maxLines)
    if (!typeFilter?.length) return rows
    return rows.filter((r) => typeFilter.includes(String(r.type || 'experience') as MemoryEventType))
  }
  const fromJson = await fs.readFile(jsonPath, 'utf8').catch(() => '')
  if (!fromJson.trim()) return []
  try {
    const obj = JSON.parse(fromJson) as { history?: unknown[] }
    const history = Array.isArray(obj?.history) ? obj.history : []
    const rows = history.slice(-Math.max(1, maxLines)) as Array<Record<string, unknown>>
    if (!typeFilter?.length) return rows
    return rows.filter((r) => typeFilter.includes(String(r.type || 'experience') as MemoryEventType))
  } catch {
    return []
  }
}

async function readHistoryFromPg(
  types: MemoryEventType[],
  maxLines: number,
  tenantId: string,
  env: NodeJS.ProcessEnv
): Promise<Array<Record<string, unknown>> | null> {
  const res = await agentPgQuery<{ entry_type: string; ts: string; payload: Record<string, unknown> }>(
    `SELECT entry_type, ts, payload FROM mgr_memory_entries
     WHERE tenant_id = $1 AND entry_type = ANY($2)
     ORDER BY ts DESC
     LIMIT $3`,
    [tenantId, types, maxLines],
    env
  )
  if (!res) return null
  return res.rows.map((r) => ({
    type: r.entry_type,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    tenantId,
    ...r.payload
  }))
}

/** 读取 Manager 记忆条目：postgres/dual 读 PG；PG 空则回退 jsonl */
export async function readManagerMemoryEntries(
  policyDir: string,
  opts?: {
    types?: MemoryEventType[]
    maxLines?: number
    tenantId?: string
    env?: NodeJS.ProcessEnv
  }
): Promise<Array<Record<string, unknown>>> {
  const env = opts?.env ?? process.env
  const maxLines = Math.max(1, opts?.maxLines ?? 900)
  const types = opts?.types?.length ? opts.types : (['experience'] as MemoryEventType[])
  const tenantId = normalizeTenantId(opts?.tenantId, env)
  const backend = resolveStorageBackend(env.MANAGER_STORAGE_BACKEND, 'file')

  if (isPostgresStorageEnabled(backend)) {
    const pgRows = await readHistoryFromPg(types, maxLines, tenantId, env)
    if (pgRows?.length) return pgRows
  }

  return readHistoryFromFile(policyDir, maxLines, types)
}

export async function readManagerExperienceHistory(
  policyDir: string,
  maxLines = 900,
  env: NodeJS.ProcessEnv = process.env,
  tenantId?: string
): Promise<Array<Record<string, unknown>>> {
  return readManagerMemoryEntries(policyDir, { types: ['experience'], maxLines, env, tenantId })
}
