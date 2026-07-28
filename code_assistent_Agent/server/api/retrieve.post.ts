import { defineEventHandler, readBody, createError } from 'h3'
import * as z from 'zod'
import path from 'node:path'
import { OpenAIEmbeddings } from '@langchain/openai'
import { runVectorSearch } from '../services/vectorSearch'
import { sanitizeIncomingQuestion } from '../utils/incoming_question'
import { getCodeAgentEnv } from '../utils/code_agent_env'
import { recordCodeQueryMetric } from '../utils/code_metrics'
import { getFileScoreAdjust } from '../utils/code_learning'
import { buildCodeRetrieveAgentResult } from '../utils/agent_result'
import { appendAgentTraceLog } from '../utils/trace_log'
import { ensureInternalAgentAccess } from '../utils/internal_auth'
import { applyPlatformRuntimeOverrides } from '../utils/platform_config'
import { mergeOpenAiRuntimeSecrets } from '../utils/runtime_secrets'

export default defineEventHandler(async (event) => {
  ensureInternalAgentAccess(event)
  const started = Date.now()
  const body = await readBody(event).catch(() => null)
  const parsed = z
    .object({
      query: z.string().min(1).optional(),
      message: z.string().min(1).optional(),
      root: z.string().optional(),
      extensions: z.array(z.string()).nullable().optional(),
      maxResults: z.number().int().min(1).max(50).optional(),
    })
    .safeParse(body)

  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid body' })
  }

  const raw = String(parsed.data.query ?? parsed.data.message ?? '').trim()
  if (!raw) {
    throw createError({ statusCode: 400, statusMessage: 'query 或 message 不能为空' })
  }

  const env = getCodeAgentEnv()
  const query = sanitizeIncomingQuestion(raw) || raw

  const runtime = mergeOpenAiRuntimeSecrets(await applyPlatformRuntimeOverrides(useRuntimeConfig() as any))
  const apiKey = runtime.openaiApiKey as string | undefined
  const baseURL = runtime.openaiBaseUrl as string | undefined
  const embeddingModel =
    typeof runtime.openaiEmbeddingModel === 'string' && runtime.openaiEmbeddingModel
      ? String(runtime.openaiEmbeddingModel)
      : 'text-embedding-v1'
  if (!apiKey) {
    throw createError({ statusCode: 500, statusMessage: 'Missing OPENAI_API_KEY' })
  }

  const embeddings = new OpenAIEmbeddings({
    apiKey,
    model: embeddingModel,
    configuration: {
      baseURL: String(baseURL || '').trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    timeout: (() => {
      const n = Number(process.env.AGENT_EMBEDDING_TIMEOUT_MS || 12_000)
      return Number.isFinite(n) && n >= 3_000 ? Math.min(60_000, Math.floor(n)) : 12_000
    })(),
    maxRetries: 0,
  } as any)

  const rootOverride = parsed.data.root ? path.resolve(parsed.data.root) : undefined
  const maxResults = parsed.data.maxResults ?? env.retrieveMaxResults

  try {
    const searchOut = await runVectorSearch({
      embeddings,
      embeddingModel,
      query,
      rootOverride,
      extensions: parsed.data.extensions ?? null,
      maxFiles: env.retrieveMaxFiles,
      maxCandidates: env.retrieveMaxCandidates,
      maxResults,
      maxCharsPerFile: 120_000,
      maxChunksPerFile: 18,
      overlapLines: 8,
      chunkChars: 2400,
      maxSnippetChars: 4000,
      maxPreviewChars: 220,
      refreshCache: false,
    })

    const rawResults = Array.isArray((searchOut as any)?.results) ? (searchOut as any).results : []
    const snippets = rawResults
      .map((h: any) => {
        const range = String(h?.range ?? '')
        const [startLine, endLine] = range.split('-').map((x: string) => Number.parseInt(x, 10))
        const path = String(h?.file ?? h?.path ?? '')
        const baseScore = typeof h?.score === 'number' ? h.score : 0
        return {
          path,
          score: Number((baseScore + getFileScoreAdjust(path)).toFixed(4)),
          preview: String(h?.preview ?? h?.snippet ?? '').slice(0, 500),
          startLine: Number.isFinite(startLine) ? startLine : undefined,
          endLine: Number.isFinite(endLine) ? endLine : undefined,
        }
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

    recordCodeQueryMetric({
      path: 'retrieve',
      ok: true,
      ms: Date.now() - started,
      question: query,
    })

    const traceId =
      String(event.node.req.headers['x-trace-id'] ?? event.node.req.headers['x-run-id'] ?? '').trim() || undefined
    const ms = Date.now() - started
    const agentResult = buildCodeRetrieveAgentResult({
      query,
      hits: snippets.length,
      snippets,
      trace_id: traceId,
      ms
    })
    void appendAgentTraceLog({
      agent: 'code',
      path: '/api/retrieve',
      trace_id: traceId,
      ok: agentResult.ok,
      latency_ms: ms,
      detail: `hits=${snippets.length}`
    })

    return {
      ok: true,
      query,
      ms,
      hits: snippets.length,
      snippets,
      agentResult
    }
  } catch (e: any) {
    recordCodeQueryMetric({
      path: 'retrieve',
      ok: false,
      ms: Date.now() - started,
      question: query,
      reason: String(e?.message || e || 'retrieve failed'),
    })
    throw e
  }
})
