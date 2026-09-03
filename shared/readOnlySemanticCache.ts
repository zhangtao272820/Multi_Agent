/**
 * 只读语义缓存契约：同租户 + 归一化问句；写路径永不缓存执行结果。
 */

export type SemanticCacheEntry = {
  tenantId: string
  queryNorm: string
  answer: string
  createdAtMs: number
}

const WRITE_PATH_INTENTS = new Set([
  'write',
  'delete',
  'update',
  'send',
  'email',
  'confirm',
  'execute',
  'admin_write'
])

export function normalizeSemanticQuery(text: string): string {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 512)
}

export function isWritePathIntent(intent: string, blastRadius?: string): boolean {
  const i = String(intent || '').trim().toLowerCase()
  const br = String(blastRadius || '').trim().toLowerCase()
  if (WRITE_PATH_INTENTS.has(i)) return true
  if (br === 't2' || br === 't3') return true
  return false
}

export function semanticCacheKey(tenantId: string, query: string): string {
  const tid = String(tenantId || 'default').trim().slice(0, 64) || 'default'
  return `${tid}:${normalizeSemanticQuery(query)}`
}

/** 进程内只读缓存（P1 契约；生产可换 Redis，写路径仍禁止 set） */
export class ReadOnlySemanticCache {
  private store = new Map<string, SemanticCacheEntry>()

  get(tenantId: string, query: string): SemanticCacheEntry | undefined {
    return this.store.get(semanticCacheKey(tenantId, query))
  }

  /** 仅读路径可写入；写路径 intent 时拒绝 */
  trySet(input: {
    tenantId: string
    query: string
    answer: string
    intent?: string
    blastRadius?: string
    nowMs?: number
  }): { ok: true } | { ok: false; reason: string } {
    if (isWritePathIntent(input.intent || '', input.blastRadius)) {
      return { ok: false, reason: 'write_path_not_cacheable' }
    }
    const key = semanticCacheKey(input.tenantId, input.query)
    this.store.set(key, {
      tenantId: String(input.tenantId || 'default'),
      queryNorm: normalizeSemanticQuery(input.query),
      answer: String(input.answer ?? ''),
      createdAtMs: Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now()
    })
    return { ok: true }
  }

  size(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }
}
