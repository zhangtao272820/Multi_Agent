/**
 * 轻量 PostgreSQL 客户端：动态 import pg，缺包或未配置时优雅降级。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_MEMORY_SCHEMA_SQL } from './agentMemorySchema'
import { resolveAgentDatabaseUrl } from './storageBackend'

const __sharedDir = path.dirname(fileURLToPath(import.meta.url))

/** 从 repo 根 scripts/ 或 Nitro bundle 内解析 pg */
async function loadPgModule(): Promise<typeof import('pg') | null> {
  try {
    return (await import('pg')) as typeof import('pg')
  } catch {
    /* bundled / hoisted paths below */
  }
  try {
    const req = createRequire(import.meta.url)
    return req('pg') as typeof import('pg')
  } catch {
    /* fall through */
  }
  const roots = [
    process.cwd(),
    // Nitro 生产产物：pg 装在 .output/server/node_modules
    path.join(process.cwd(), '.output', 'server'),
    path.join(process.cwd(), 'Manager_Agent'),
    path.join(process.cwd(), 'Manager_Agent', '.output', 'server'),
    path.join(process.cwd(), '..', 'Manager_Agent'),
    path.join(__sharedDir, '..', 'Manager_Agent'),
    path.join(__sharedDir, '..', 'DB_Agent')
  ]
  for (const root of roots) {
    const pkg = path.join(root, 'package.json')
    if (!existsSync(pkg)) continue
    try {
      const req = createRequire(pkg)
      return req('pg') as typeof import('pg')
    } catch {
      /* try next */
    }
  }
  return null
}

export type PgQueryResult<T = Record<string, unknown>> = {
  rows: T[]
  rowCount: number | null
}

type PgPool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>
  end: () => Promise<void>
}

let poolPromise: Promise<PgPool | null> | null = null
let schemaReady = false

function normalizePgUrl(url: string): string {
  return url.replace(/^postgresql\+psycopg2:/, 'postgresql:')
}

export function isAgentPgConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveAgentDatabaseUrl(env))
}

function resolvePoolMax(env: NodeJS.ProcessEnv): number {
  const n = Number(env.AGENT_PG_POOL_MAX ?? 4)
  return Number.isFinite(n) && n >= 1 ? Math.min(32, Math.floor(n)) : 4
}

function resolveConnectTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.AGENT_PG_CONNECT_TIMEOUT_MS ?? 8_000)
  return Number.isFinite(n) && n >= 1_000 ? Math.min(60_000, Math.floor(n)) : 8_000
}

export async function getAgentPgPool(env: NodeJS.ProcessEnv = process.env): Promise<PgPool | null> {
  const url = resolveAgentDatabaseUrl(env)
  if (!url) return null
  if (!poolPromise) {
    poolPromise = (async () => {
      try {
        const pg = await loadPgModule()
        if (!pg) return null
        const pool = new pg.Pool({
          connectionString: normalizePgUrl(url),
          max: resolvePoolMax(env),
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: resolveConnectTimeoutMs(env)
        })
        pool.on('error', () => {})
        await ensureAgentMemorySchema(pool)
        return pool
      } catch {
        poolPromise = null
        return null
      }
    })()
  }
  return poolPromise
}

async function ensureAgentMemorySchema(pool: PgPool): Promise<void> {
  if (schemaReady) return
  await pool.query(AGENT_MEMORY_SCHEMA_SQL)
  schemaReady = true
}

export async function agentPgQuery<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
  env: NodeJS.ProcessEnv = process.env
): Promise<PgQueryResult<T> | null> {
  const pool = await getAgentPgPool(env)
  if (!pool) return null
  try {
    return (await pool.query(text, params)) as PgQueryResult<T>
  } catch {
    return null
  }
}

export async function pingAgentPg(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const res = await agentPgQuery<{ ok: number }>('SELECT 1 AS ok', [], env)
  return Boolean(res?.rows?.[0]?.ok)
}

/** 测试用：重置连接池 */
export function resetAgentPgPoolForTests(): void {
  poolPromise = null
  schemaReady = false
}
