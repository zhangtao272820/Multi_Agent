/**
 * RAG 全局 query embedding 缓存 + 批量预热：同问句 TTL 内只调一次 API。
 */
import { OpenAIEmbeddings } from "@langchain/openai";
import { getRagAgentEnv } from "./rag_agent_env";

const TTL_MS = 180_000;
const MAX_ENTRIES = 512;
const QUERY_MAX_CHARS = 500;

type CacheRow = { at: number; vec: number[] };

const cache = new Map<string, CacheRow>();

let ragEmbeddings: OpenAIEmbeddings | null = null;
let ragEmbeddingsKey = "";

export function cacheKey(text: string): string {
  return String(text ?? "").trim().toLowerCase();
}

function clipQuery(text: string): string {
  const q = String(text ?? "").trim();
  return q.length > QUERY_MAX_CHARS ? q.slice(0, QUERY_MAX_CHARS) : q;
}

function prune() {
  if (cache.size <= MAX_ENTRIES) return;
  const sorted = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) {
    cache.delete(sorted[i]![0]);
  }
}

function storeVector(text: string, vec: number[]) {
  if (!vec?.length) return;
  cache.set(cacheKey(text), { at: Date.now(), vec });
  prune();
}

/** 拦截 embedQuery，所有向量检索/重排/经验库共用同一缓存层 */
export function wrapEmbeddingsWithQueryCache(embeddings: OpenAIEmbeddings): OpenAIEmbeddings {
  const rawEmbedQuery = embeddings.embedQuery.bind(embeddings);
  embeddings.embedQuery = async (document: string) => {
    const q = clipQuery(document);
    if (!q) return rawEmbedQuery(document);
    const hit = cache.get(cacheKey(q));
    if (hit && Date.now() - hit.at < TTL_MS) return hit.vec;
    const vec = await rawEmbedQuery(q);
    storeVector(q, vec);
    return vec;
  };
  return embeddings;
}

/** RAG 进程内单例 embedding 客户端（带 query 缓存） */
export function getRagEmbeddings(): OpenAIEmbeddings {
  const env = getRagAgentEnv();
  const key = [
    process.env.OPENAI_API_KEY?.slice(0, 8) ?? "",
    process.env.OPENAI_BASE_URL ?? "",
    env.embeddingModel,
  ].join("|");
  if (ragEmbeddings && ragEmbeddingsKey === key) return ragEmbeddings;
  const client = new OpenAIEmbeddings({
    openAIApiKey: process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY,
    configuration: {
      baseURL:
        String(process.env.OPENAI_BASE_URL || process.env.DASHSCOPE_BASE_URL || "").trim() ||
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    modelName: env.embeddingModel,
    timeout: (() => {
      const n = Number(process.env.AGENT_EMBEDDING_TIMEOUT_MS || 12_000);
      return Number.isFinite(n) && n >= 3_000 ? Math.min(60_000, Math.floor(n)) : 12_000;
    })(),
    maxRetries: 0,
  });
  ragEmbeddings = wrapEmbeddingsWithQueryCache(client);
  ragEmbeddingsKey = key;
  return ragEmbeddings;
}

/**
 * 批量预热未缓存 query（DashScope batch≤10），将 N 次单条 embed 合并为 ceil(N/10) 次。
 */
export async function ensureQueriesEmbedded(
  embeddings: OpenAIEmbeddings,
  texts: string[],
  batchSize?: number
): Promise<void> {
  const env = getRagAgentEnv();
  const bs = Math.max(1, Math.min(10, batchSize ?? env.embeddingBatchSize));
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const t of texts) {
    const q = clipQuery(t);
    if (!q) continue;
    const k = cacheKey(q);
    if (seen.has(k)) continue;
    seen.add(k);
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < TTL_MS) continue;
    missing.push(q);
  }
  if (!missing.length) return;

  try {
    for (let i = 0; i < missing.length; i += bs) {
      const batch = missing.slice(i, i + bs);
      const vecs = await embeddings.embedDocuments(batch);
      batch.forEach((q, j) => {
        const vec = vecs[j];
        if (vec?.length) storeVector(q, vec);
      });
    }
  } catch (e) {
    console.warn("[EmbeddingCache] batch prewarm failed, falling back to per-query:", e);
  }
}

export async function embedQueryCached(
  embeddings: OpenAIEmbeddings,
  text: string
): Promise<number[] | null> {
  const q = clipQuery(text);
  if (!q) return null;
  const hit = peekCachedQueryVector(q);
  if (hit) return hit;
  try {
    const vec = await embeddings.embedQuery(q);
    return vec?.length ? vec : null;
  } catch {
    return null;
  }
}

export function peekCachedQueryVector(text: string): number[] | null {
  const key = cacheKey(text);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.vec;
  return null;
}

export function clearEmbeddingQueryCache() {
  cache.clear();
  ragEmbeddings = null;
  ragEmbeddingsKey = "";
}
