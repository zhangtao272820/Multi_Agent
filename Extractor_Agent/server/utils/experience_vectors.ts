/**
 * P6 向量经验库：embedding 语义召回相似采集任务，补充 n-gram 经验回放。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpenAIEmbeddings } from '@langchain/openai'
import { getExtractorAgentEnv } from './extractor_agent_env'
import { normalizeTaskKey } from './crawl_learning'
import type { CrawlExperienceEntry } from './crawl_experience'

export type CrawlExperienceVectorRow = {
  id: string
  ts: string
  task_norm: string
  task: string
  vector: number[]
  hint: string
  target_site?: string
  content_type?: string
  channel?: string
}

export type EmbeddingClientConfig = {
  apiKey: string
  baseUrl?: string
  model?: string
}

function dataDir() {
  const dir = join(process.cwd(), '.data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function vectorsFile() {
  return join(dataDir(), 'extractor-experience-vectors.json')
}

function loadRows(): CrawlExperienceVectorRow[] {
  const p = vectorsFile()
  if (!existsSync(p)) return []
  try {
    const o = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(o) ? (o as CrawlExperienceVectorRow[]) : []
  } catch {
    return []
  }
}

function saveRows(rows: CrawlExperienceVectorRow[]) {
  const max = getExtractorAgentEnv().vectorExperienceMaxEntries
  writeFileSync(vectorsFile(), JSON.stringify(rows.slice(-max), null, 0), 'utf8')
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

export function clipTextForEmbedding(text: string): string {
  const max = getExtractorAgentEnv().embeddingMaxInputChars
  let s = String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[【】\[\]()（）]/g, '')
    .replace(/(请|帮我|麻烦|抓取|爬取|采集|提取)/g, '')
  if (s.length <= max) return s
  return s.slice(0, max)
}

let embedder: OpenAIEmbeddings | null = null
let embedderKey = ''
const queryCache = new Map<string, { vec: number[]; ts: number }>()

function getEmbedder(config: EmbeddingClientConfig): OpenAIEmbeddings | null {
  const env = getExtractorAgentEnv()
  if (!env.enableVectorExperience) return null
  const apiKey = String(config.apiKey ?? '').trim()
  if (!apiKey) return null
  const baseURL = String(config.baseUrl ?? env.qwenBaseUrl).trim()
  const model = String(config.model ?? env.embeddingModel).trim()
  const key = `${apiKey.slice(0, 8)}|${baseURL}|${model}`
  if (embedder && embedderKey === key) return embedder
  embedder = new OpenAIEmbeddings({
    apiKey,
    model,
    configuration: { baseURL: baseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    timeout: (() => {
      const n = Number(process.env.AGENT_EMBEDDING_TIMEOUT_MS || 12_000)
      return Number.isFinite(n) && n >= 3_000 ? Math.min(60_000, Math.floor(n)) : 12_000
    })(),
    maxRetries: 0,
  })
  embedderKey = key
  return embedder
}

async function embedQueryCached(text: string, client: OpenAIEmbeddings): Promise<number[]> {
  const clipped = clipTextForEmbedding(text)
  const cacheKey = normalizeTaskKey(clipped)
  const ttlMs = getExtractorAgentEnv().embeddingQueryCacheTtlSec * 1000
  const hit = queryCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < ttlMs) return hit.vec
  const vec = await client.embedQuery(clipped)
  queryCache.set(cacheKey, { vec, ts: Date.now() })
  if (queryCache.size > 120) {
    const oldest = [...queryCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 30)
    for (const [k] of oldest) queryCache.delete(k)
  }
  return vec
}

export async function indexCrawlExperienceVector(input: {
  task: string
  hint: string
  target_site?: string
  content_type?: string
  channel?: string
  embeddingConfig: EmbeddingClientConfig
}) {
  const env = getExtractorAgentEnv()
  if (!env.enableVectorExperience) return
  const task = String(input.task ?? '').trim()
  const hint = String(input.hint ?? '').trim()
  if (!task || !hint || task.length < env.vectorIndexMinTaskChars) return

  const client = getEmbedder(input.embeddingConfig)
  if (!client) return

  const task_norm = normalizeTaskKey(task)
  const rows = loadRows()
  const dup = rows.find((r) => r.task_norm === task_norm)
  if (dup) {
    dup.hint = hint
    dup.ts = new Date().toISOString()
    dup.target_site = input.target_site
    dup.content_type = input.content_type
    dup.channel = input.channel
    saveRows(rows)
    return
  }

  try {
    const clipped = clipTextForEmbedding(task)
    const vector = await client.embedQuery(clipped)
    rows.push({
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      task_norm,
      task: clipped.slice(0, 120),
      vector,
      hint,
      target_site: input.target_site,
      content_type: input.content_type,
      channel: input.channel,
    })
    saveRows(rows)
  } catch {
    /* embedding 失败不影响主链路 */
  }
}

export async function recallByVectorSimilarity(
  task: string,
  config: EmbeddingClientConfig,
  limit = 2,
): Promise<CrawlExperienceEntry[]> {
  const env = getExtractorAgentEnv()
  if (!env.enableVectorExperience) return []
  const client = getEmbedder(config)
  if (!client) return []

  const q = String(task ?? '').trim()
  if (!q || q.length < 4) return []

  const rows = loadRows()
  if (!rows.length) return []

  try {
    const queryVec = await embedQueryCached(q, client)
    const minScore = env.vectorExperienceMinScore
    const scored = rows
      .map((r) => ({ r, s: cosineSimilarity(queryVec, r.vector) }))
      .filter((x) => x.s >= minScore)
      .sort((a, b) => b.s - a.s)

    const seen = new Set<string>()
    const out: CrawlExperienceEntry[] = []
    for (const { r } of scored) {
      const k = `${r.hint}|${r.target_site ?? ''}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({
        ts: r.ts,
        task_norm: r.task_norm,
        target_site: r.target_site,
        content_type: r.content_type,
        channel: r.channel as CrawlExperienceEntry['channel'],
        hint: r.hint,
      })
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}

export function getExperienceVectorSummary() {
  const env = getExtractorAgentEnv()
  return {
    count: loadRows().length,
    enabled: env.enableVectorExperience,
    embeddingModel: env.embeddingModel,
    minScore: env.vectorExperienceMinScore,
  }
}

export function clearExperienceVectors() {
  try {
    writeFileSync(vectorsFile(), '[]', 'utf8')
  } catch {
    /* ignore */
  }
  queryCache.clear()
  embedder = null
  embedderKey = ''
}
