import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { OpenAIEmbeddings } from '@langchain/openai'
import { readManagerExperienceHistory } from '#agent-shared/managerMemoryHistory'
import { isPgVectorEnabled, searchMgrEmbeddingsByVector, clearMgrMemoryEmbeddingsPg, PGVECTOR_DIM } from '#agent-shared/agentVectorPg'
import { isPostgresStorageEnabled, resolveStorageBackend } from '#agent-shared/storageBackend'
import { deriveScenarioKey } from '../text'

export type VectorMemoryRecord = {
  key: string
  user: string
  embedding: number[]
  intent?: string
  scenarioKey?: string
  successScore?: number
  memoryType: 'experience' | 'plan_outcome'
  ts?: string
}

const EMB_FILE = 'manager-memory-embeddings.jsonl'

let embedClient: OpenAIEmbeddings | null = null
let indexCache: { mtimeMs: number; records: VectorMemoryRecord[] } | null = null

const EMBED_QUERY_TTL_MS = 180_000
const EMBED_QUERY_MAX = 256
const queryEmbedCache = new Map<string, { at: number; vec: number[] }>()

function queryCacheKey(text: string) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function pruneQueryEmbedCache() {
  if (queryEmbedCache.size <= EMBED_QUERY_MAX) return
  const sorted = [...queryEmbedCache.entries()].sort((a, b) => a[1].at - b[1].at)
  for (let i = 0; i < sorted.length - EMBED_QUERY_MAX; i++) {
    queryEmbedCache.delete(sorted[i]![0])
  }
}

export function isVectorMemoryEnabled() {
  return String(process.env.MANAGER_VECTOR_MEMORY ?? '1').trim() !== '0'
}

function maxIndexLines() {
  const n = Number(process.env.MANAGER_VECTOR_INDEX_MAX_LINES ?? 1400)
  return Number.isFinite(n) && n >= 200 ? Math.min(5000, Math.floor(n)) : 1400
}

function vectorWeight() {
  const n = Number(process.env.MANAGER_VECTOR_SCORE_WEIGHT ?? 0.55)
  return Number.isFinite(n) && n >= 0.2 && n <= 0.85 ? n : 0.55
}

function memoryKey(user: string, memoryType: string) {
  const norm = String(user || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
  return createHash('sha256').update(`${memoryType}|${norm}`).digest('hex').slice(0, 24)
}

function getEmbeddingsClient() {
  if (!embedClient) {
    const timeoutRaw = Number(process.env.AGENT_EMBEDDING_TIMEOUT_MS || 12_000)
    const timeout = Number.isFinite(timeoutRaw) && timeoutRaw >= 3_000 ? Math.min(60_000, Math.floor(timeoutRaw)) : 12_000
    const baseURL =
      String(process.env.OPENAI_BASE_URL || process.env.DASHSCOPE_BASE_URL || '').trim() ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    embedClient = new OpenAIEmbeddings({
      apiKey: process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY,
      configuration: { baseURL },
      model: String(process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-v1').trim(),
      dimensions: PGVECTOR_DIM,
      timeout,
      maxRetries: 0
    })
  }
  return embedClient
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom ? dot / denom : 0
}

/** 向量分 + Jaccard + 场景 混合排序权重 */
export function blendRecallScore(vectorSim: number, jaccard: number, sceneMatch: number, successBoost = 0) {
  const vw = vectorWeight()
  const jw = (1 - vw) * 0.55
  const sw = (1 - vw) * 0.45
  return vw * vectorSim + jw * jaccard + sw * sceneMatch + successBoost
}

async function embeddingsPath(policyDir: string) {
  return path.join(policyDir, EMB_FILE)
}

async function loadIndex(policyDir: string): Promise<VectorMemoryRecord[]> {
  const p = await embeddingsPath(policyDir)
  let st: { mtimeMs: number } | null = null
  try {
    st = await fs.stat(p)
  } catch {
    return []
  }
  if (indexCache && indexCache.mtimeMs === st.mtimeMs) return indexCache.records

  const raw = await fs.readFile(p, 'utf8').catch(() => '')
  const lines = raw.split('\n').filter((l) => l.trim()).slice(-maxIndexLines())
  const records: VectorMemoryRecord[] = []
  for (const line of lines) {
    try {
      const o = JSON.parse(line)
      if (!Array.isArray(o?.embedding) || !o?.key) continue
      records.push({
        key: String(o.key),
        user: String(o.user || ''),
        embedding: o.embedding.map((x: unknown) => Number(x)).filter((x: number) => Number.isFinite(x)),
        intent: o.intent ? String(o.intent) : undefined,
        scenarioKey: o.scenarioKey ? String(o.scenarioKey) : undefined,
        successScore: typeof o.successScore === 'number' ? o.successScore : undefined,
        memoryType: o.memoryType === 'plan_outcome' ? 'plan_outcome' : 'experience',
        ts: typeof o.ts === 'string' ? o.ts : undefined
      })
    } catch {}
  }
  indexCache = { mtimeMs: st.mtimeMs, records }
  return records
}

function invalidateIndexCache() {
  indexCache = null
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const clean = texts.map((t) => String(t || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length >= 4)
  if (!clean.length) return []
  const client = getEmbeddingsClient()
  const out: number[][] = []
  const batchSize = 10
  for (let i = 0; i < clean.length; i += batchSize) {
    const batch = clean.slice(i, i + batchSize).map((t) => t.slice(0, 500))
    const vectors = await client.embedDocuments(batch)
    out.push(...vectors.map((v) => v.map((x) => Number(x))))
  }
  return out
}

export async function embedQuery(text: string): Promise<number[] | null> {
  const q = String(text || '').replace(/\s+/g, ' ').trim()
  if (q.length < 4) return null
  const key = queryCacheKey(q)
  const hit = queryEmbedCache.get(key)
  if (hit && Date.now() - hit.at < EMBED_QUERY_TTL_MS) return hit.vec
  const client = getEmbeddingsClient()
  const v = await client.embedQuery(q.slice(0, 500))
  const vec = v.map((x) => Number(x))
  queryEmbedCache.set(key, { at: Date.now(), vec })
  pruneQueryEmbedCache()
  return vec
}

/** 为单条记忆写入向量索引（finalize 后异步调用） */
export async function indexMemoryEntry(
  policyDir: string,
  entry: {
    user: string
    memoryType: 'experience' | 'plan_outcome'
    intent?: string
    scenarioKey?: string
    successScore?: number
    ts?: string
  }
): Promise<{ indexed: boolean; key?: string; reason?: string }> {
  if (!isVectorMemoryEnabled()) return { indexed: false, reason: 'disabled' }
  const user = String(entry.user || '').replace(/\s+/g, ' ').trim()
  if (user.length < 6) return { indexed: false, reason: 'short_text' }

  const key = memoryKey(user, entry.memoryType)
  const index = await loadIndex(policyDir)
  if (index.some((r) => r.key === key)) return { indexed: false, reason: 'exists', key }

  const [embedding] = await embedTexts([user.slice(0, 800)])
  if (!embedding?.length) return { indexed: false, reason: 'embed_failed' }

  const row = {
    key,
    user: user.slice(0, 500),
    embedding,
    intent: entry.intent,
    scenarioKey: entry.scenarioKey || deriveScenarioKey(user),
    successScore: entry.successScore,
    memoryType: entry.memoryType,
    ts: entry.ts || new Date().toISOString()
  }
  const p = await embeddingsPath(policyDir)
  await fs.mkdir(policyDir, { recursive: true }).catch(() => undefined)
  await fs.appendFile(p, `${JSON.stringify(row)}\n`, 'utf8')
  invalidateIndexCache()
  try {
    const { upsertManagerMemoryEmbedding } = await import('../../../utils/session/managerMemoryEmbeddingsStore')
    await upsertManagerMemoryEmbedding({
      memoryKey: key,
      userKey: '__global__',
      entryType: entry.memoryType,
      embedding,
      metadata: {
        user: user.slice(0, 500),
        intent: entry.intent,
        scenarioKey: entry.scenarioKey,
        successScore: entry.successScore
      },
      ts: row.ts
    })
  } catch {
    /* PG 向量可选 */
  }
  return { indexed: true, key }
}

/** 对候选文本批量算向量相似度（query 只 embed 一次） */
export async function vectorScoresForUsers(
  policyDir: string,
  queryText: string,
  users: string[],
  queryEmbedding?: number[] | null
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!isVectorMemoryEnabled()) return out

  const qEmb = queryEmbedding?.length ? queryEmbedding : await embedQuery(queryText).catch(() => null)
  if (!qEmb?.length) return out

  const index = await loadIndex(policyDir)
  const byUser = new Map<string, number>()
  for (const rec of index) {
    const sim = cosineSimilarity(qEmb, rec.embedding)
    const u = rec.user.slice(0, 500)
    const prev = byUser.get(u)
    if (prev == null || sim > prev) byUser.set(u, sim)
  }

  const backend = resolveStorageBackend(process.env.MANAGER_STORAGE_BACKEND, 'file')
  if (!byUser.size && isPostgresStorageEnabled(backend) && isPgVectorEnabled()) {
    const pgHits = await searchMgrEmbeddingsByVector(qEmb, 48).catch(() => [])
    for (const hit of pgHits) {
      const u = String((hit.metadata as Record<string, unknown>)?.user || '').replace(/\s+/g, ' ').trim().slice(0, 500)
      if (!u) continue
      const prev = byUser.get(u)
      if (prev == null || hit.score > prev) byUser.set(u, hit.score)
    }
  }

  for (const u of users) {
    const norm = String(u || '').replace(/\s+/g, ' ').trim().slice(0, 500)
    const sim = byUser.get(norm)
    if (sim != null) out.set(norm, sim)
    else {
      const key = memoryKey(norm, 'experience')
      const rec = index.find((r) => r.key === key)
      if (rec) out.set(norm, cosineSimilarity(qEmb, rec.embedding))
    }
  }
  return out
}

/** 全量/增量重建向量索引 */
export async function rebuildVectorIndex(policyDir: string, opts?: { maxEntries?: number }) {
  if (!isVectorMemoryEnabled()) return { ok: false, reason: 'disabled', indexed: 0 }
  const max = opts?.maxEntries ?? 600
  const history = await readManagerExperienceHistory(policyDir, max + 200)

  const targets: Array<{
    user: string
    memoryType: 'experience' | 'plan_outcome'
    intent?: string
    scenarioKey?: string
    successScore?: number
    ts?: string
  }> = []

  for (const h of history) {
    if (h?.type === 'experience' || h?.type === 'plan_outcome') {
      const user = String(h.user || '').trim()
      if (user.length < 6) continue
      targets.push({
        user,
        memoryType: h.type === 'plan_outcome' ? 'plan_outcome' : 'experience',
        intent: h.intent ? String(h.intent) : undefined,
        scenarioKey: typeof h.scenarioKey === 'string' ? h.scenarioKey : deriveScenarioKey(user),
        successScore: typeof h.successScore === 'number' ? h.successScore : undefined,
        ts: typeof h.ts === 'string' ? h.ts : undefined
      })
    }
  }

  const slice = targets.slice(-max)
  let indexed = 0
  let skipped = 0
  for (const t of slice) {
    const r = await indexMemoryEntry(policyDir, t)
    if (r.indexed) indexed += 1
    else skipped += 1
  }
  return { ok: true, indexed, skipped, scanned: slice.length }
}

export async function vectorIndexStats(policyDir: string) {
  const records = await loadIndex(policyDir)
  const exp = records.filter((r) => r.memoryType === 'experience').length
  const plan = records.filter((r) => r.memoryType === 'plan_outcome').length
  return { enabled: isVectorMemoryEnabled(), total: records.length, experience: exp, planOutcome: plan }
}

/** 清空向量记忆索引（换 embedding 模型后需全量重建时调用）。 */
export async function clearVectorMemoryIndex(policyDir: string) {
  const file = path.join(policyDir, EMB_FILE)
  try {
    await fs.writeFile(file, '', 'utf8')
  } catch {
    /* ignore */
  }
  indexCache = null
  queryEmbedCache.clear()
  embedClient = null
  await clearMgrMemoryEmbeddingsPg().catch(() => undefined)
}
