/**
 * Code Agent 向量经验库：成功问句 embedding 语义召回。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpenAIEmbeddings } from '@langchain/openai'
import { getCodeAgentEnv } from './code_agent_env'
import { normalizeQuestionKey } from './code_learning'
import type { CodeTaskKind } from './code_learning'

export type CodeExperienceVectorRow = {
  id: string
  ts: string
  question_norm: string
  question: string
  vector: number[]
  hint: string
  task_kind: CodeTaskKind
  hint_files?: string[]
}

export type EmbeddingClientConfig = {
  openaiApiKey: string
  openaiBaseUrl?: string
  embeddingModel?: string
}

function dataDir() {
  const dir = join(process.cwd(), '.data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function vectorsFile() {
  return join(dataDir(), 'code-experience-vectors.json')
}

function loadRows(): CodeExperienceVectorRow[] {
  const p = vectorsFile()
  if (!existsSync(p)) return []
  try {
    const o = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(o) ? (o as CodeExperienceVectorRow[]) : []
  } catch {
    return []
  }
}

function saveRows(rows: CodeExperienceVectorRow[]) {
  const max = getCodeAgentEnv().vectorExperienceMaxEntries
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
  const max = getCodeAgentEnv().embeddingMaxInputChars
  let s = String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max)
  return s
}

let embeddingsClient: OpenAIEmbeddings | null = null
let embeddingsKey = ''
const queryEmbedCache = new Map<string, { vec: number[]; ts: number }>()

function getEmbeddings(config: EmbeddingClientConfig): OpenAIEmbeddings | null {
  if (!config.openaiApiKey || !getCodeAgentEnv().enableVectorExperience) return null
  const model = config.embeddingModel || getCodeAgentEnv().openaiEmbeddingModel
  const key = [config.openaiApiKey.slice(0, 8), config.openaiBaseUrl ?? '', model].join('|')
  if (embeddingsClient && embeddingsKey === key) return embeddingsClient
  embeddingsClient = new OpenAIEmbeddings({
    apiKey: config.openaiApiKey,
    model,
    configuration: {
      baseURL:
        String(config.openaiBaseUrl || '').trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    timeout: (() => {
      const n = Number(process.env.AGENT_EMBEDDING_TIMEOUT_MS || 12_000)
      return Number.isFinite(n) && n >= 3_000 ? Math.min(60_000, Math.floor(n)) : 12_000
    })(),
    maxRetries: 0,
  } as any)
  embeddingsKey = key
  return embeddingsClient
}

async function embedQueryCached(text: string, embedder: OpenAIEmbeddings): Promise<number[]> {
  const clipped = clipTextForEmbedding(text)
  const cacheKey = normalizeQuestionKey(clipped)
  const ttlMs = getCodeAgentEnv().embeddingQueryCacheTtlSec * 1000
  const hit = queryEmbedCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < ttlMs) return hit.vec
  const vec = await embedder.embedQuery(clipped)
  queryEmbedCache.set(cacheKey, { vec, ts: Date.now() })
  return vec
}

export async function indexExperienceVector(input: {
  question: string
  hint: string
  task_kind: CodeTaskKind
  hint_files?: string[]
  embeddingConfig: EmbeddingClientConfig
}) {
  const env = getCodeAgentEnv()
  if (!env.enableVectorExperience) return
  const question = String(input.question ?? '').trim()
  const hint = String(input.hint ?? '').trim()
  if (!question || !hint || question.length < env.vectorIndexMinQuestionChars) return

  const embedder = getEmbeddings(input.embeddingConfig)
  if (!embedder) return

  const question_norm = normalizeQuestionKey(question)
  const rows = loadRows()
  const dup = rows.find((r) => r.question_norm === question_norm)
  const vec = await embedder.embedQuery(clipTextForEmbedding(question))
  if (dup) {
    dup.hint = hint
    dup.task_kind = input.task_kind
    dup.hint_files = input.hint_files
    dup.vector = vec
    dup.ts = new Date().toISOString()
    saveRows(rows)
    return
  }
  rows.push({
    id: `cev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    question_norm,
    question: question.slice(0, 300),
    vector: vec,
    hint,
    task_kind: input.task_kind,
    hint_files: input.hint_files,
  })
  saveRows(rows)
}

export async function recallVectorExperienceHints(input: {
  question: string
  task_kind?: CodeTaskKind
  embeddingConfig: EmbeddingClientConfig
  max?: number
}): Promise<Array<{ hint: string; score: number; hint_files?: string[] }>> {
  const env = getCodeAgentEnv()
  if (!env.enableVectorExperience) return []
  const embedder = getEmbeddings(input.embeddingConfig)
  if (!embedder) return []

  const rows = loadRows()
  if (!rows.length) return []

  const qVec = await embedQueryCached(input.question, embedder)
  const minScore = env.vectorExperienceMinScore
  const max = input.max ?? 3

  return rows
    .map((r) => ({
      hint: r.hint,
      hint_files: r.hint_files,
      score: cosineSimilarity(qVec, r.vector),
      kindMatch: !input.task_kind || r.task_kind === input.task_kind,
    }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => Number(b.kindMatch) - Number(a.kindMatch) || b.score - a.score)
    .slice(0, max)
    .map((r) => ({ hint: r.hint, score: r.score, hint_files: r.hint_files }))
}

export function getExperienceVectorSummary() {
  const rows = loadRows()
  return {
    entries: rows.length,
    maxEntries: getCodeAgentEnv().vectorExperienceMaxEntries,
    recent: rows.slice(-5).map((r) => ({
      question: r.question.slice(0, 60),
      task_kind: r.task_kind,
      hint_files: r.hint_files?.slice(0, 3),
    })),
  }
}

export function clearExperienceVectors() {
  try {
    writeFileSync(vectorsFile(), '[]', 'utf8')
    queryEmbedCache.clear()
  } catch {
    /* ignore */
  }
}
