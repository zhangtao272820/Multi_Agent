import type { OpenAIEmbeddings } from "@langchain/openai";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { getRagEmbeddings } from "./embedding_query_cache";
import { createRagChatOpenAI } from "./rag_chat_openai";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { splitDocumentsStructured } from "./chunk_text";
import { getRagAgentEnv } from "./rag_agent_env";
import { type Bm25Hit } from "./bm25_lexical";
import { Bm25InvertedIndex } from "./bm25_inverted_index";
import { performOCR } from "./ocr";
import { looksLikeHtmlDocument, stripHtmlToPlainText } from "./html_text";
import { extractPptxText, isLegacyPptOle } from "./pptx_text";
import {
  buildIngestTimestamps,
  filterMemoryVectorsBySource,
  hashCorpusText,
  resolveSourceVersion,
  shouldSkipReembed,
} from "./ingest_meta";

const DATA_DIR = path.join(process.cwd(), ".data");
const VECTOR_STORE_PATH = path.join(DATA_DIR, "vector_store.json");
const DOCS_METADATA_PATH = path.join(DATA_DIR, "docs_metadata.json");
const BM25_INDEX_PATH = path.join(DATA_DIR, "bm25_index.json");
const LEGACY_VECTOR_STORE_PATH = path.join(process.cwd(), "data/vector_store.json");
const LEGACY_DOCS_METADATA_PATH = path.join(process.cwd(), "data/docs_metadata.json");

const bm25Index = new Bm25InvertedIndex();
let bm25Ready = false;
let bm25RebuildLock: Promise<void> | null = null;

type AnyVectorStore = MemoryVectorStore | PGVectorStore;

/** 分批写入向量库，兼容 DashScope 等 embedding API 的 batch≤10 限制 */
const addDocumentsInBatches = async (store: AnyVectorStore, docs: any[]) => {
  if (!docs.length) return;
  const batchSize = getRagAgentEnv().embeddingBatchSize;
  for (let i = 0; i < docs.length; i += batchSize) {
    await store.addDocuments(docs.slice(i, i + batchSize));
  }
};

let vectorStore: AnyVectorStore | null = null;
let vectorBackend: "memory" | "pgvector" = "memory";
let pgPool: Pool | null = null;

export type UploadedDocMeta = {
  name: string;
  summary?: string;
  type: string;
  content_hash?: string;
  ingest_at?: string;
  source_version?: string;
  chunk_count?: number;
  /** K 波：mineru | local_pdf | local_* */
  parser?: string;
};

let uploadedDocuments: UploadedDocMeta[] = [];
export type KeywordCandidate = {
  pageContent: string;
  metadata: Record<string, any>;
  matchedTerms: number;
};

type ProcessLimits = {
  maxUploadBytes: number;
  maxZipEntries: number;
  maxZipTotalUncompressedBytes: number;
  maxTotalChunks: number;
  totalChunks: number;
  totalZipEntries: number;
  totalZipUncompressedBytes: number;
};

export type ProcessDocumentOptions = {
  /** 调用方显式版本号；缺省用 content_hash 前 12 位 */
  source_version?: string;
  /** K 波解析器标记 */
  parser?: string;
  parser_provider?: string;
  /** 非严格模式：MinerU 失败回落本地 */
  parser_fallback?: string;
};

const getDefaultLimits = (): ProcessLimits => ({
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES ?? "52428800"),
  maxZipEntries: parseInt(process.env.MAX_ZIP_ENTRIES ?? "200"),
  maxZipTotalUncompressedBytes: parseInt(process.env.MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES ?? "209715200"),
  maxTotalChunks: parseInt(process.env.MAX_TOTAL_CHUNKS ?? "5000"),
  totalChunks: 0,
  totalZipEntries: 0,
  totalZipUncompressedBytes: 0,
});

const envBool = (v: any, defaultValue: boolean) => {
  if (v === undefined || v === null || v === "") return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
};

const normalizeBackend = (v: any): "memory" | "pgvector" => {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "pg" || s === "postgres" || s === "pgvector") return "pgvector";
  return "memory";
};

const sanitizeIdentifier = (input: string, fallback: string) => {
  const s = String(input || "").trim();
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) ? s : fallback;
};

// 确保持久化目录存在（Docker 挂载 /app/.data）
const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
};

const migrateLegacyDataFiles = () => {
  ensureDataDir();
  if (!fs.existsSync(DOCS_METADATA_PATH) && fs.existsSync(LEGACY_DOCS_METADATA_PATH)) {
    try {
      fs.copyFileSync(LEGACY_DOCS_METADATA_PATH, DOCS_METADATA_PATH);
      console.log("[Disk] Migrated legacy docs_metadata.json -> .data/");
    } catch (e) {
      console.warn("[Disk] Legacy docs metadata migration failed:", e);
    }
  }
  if (!fs.existsSync(VECTOR_STORE_PATH) && fs.existsSync(LEGACY_VECTOR_STORE_PATH)) {
    try {
      fs.copyFileSync(LEGACY_VECTOR_STORE_PATH, VECTOR_STORE_PATH);
      console.log("[Disk] Migrated legacy vector_store.json -> .data/");
    } catch (e) {
      console.warn("[Disk] Legacy vector store migration failed:", e);
    }
  }
};

const loadDocsMetadataFromDisk = () => {
  migrateLegacyDataFiles();
  if (!fs.existsSync(DOCS_METADATA_PATH)) return;
  try {
    uploadedDocuments = JSON.parse(fs.readFileSync(DOCS_METADATA_PATH, "utf-8"));
  } catch (e) {
    console.warn("[Disk] Failed to load docs metadata, reset to empty:", e);
    uploadedDocuments = [];
  }
};

const syncMetadataFromPgIfEmpty = async (pool: Pool, tableName: string, metadataColumnName: string) => {
  if (uploadedDocuments.length > 0) return;
  try {
    const res = await pool.query(
      `SELECT DISTINCT "${metadataColumnName}"->>'source' AS src FROM "${tableName}" WHERE "${metadataColumnName}"->>'source' IS NOT NULL`
    );
    const names = (res.rows ?? [])
      .map((r: { src?: string }) => String(r?.src ?? "").trim())
      .filter(Boolean);
    if (!names.length) return;
    uploadedDocuments = names.map((name) => ({
      name,
      type: name.includes(".") ? String(name.split(".").pop() || "unknown") : "unknown",
    }));
    saveDocsMetadataToDisk();
    console.log(`[PGVector] Rebuilt docs metadata from ${names.length} distinct sources.`);
  } catch (e) {
    console.warn("[PGVector] syncMetadataFromPgIfEmpty skipped:", e);
  }
};

const saveDocsMetadataToDisk = () => {
  ensureDataDir();
  fs.writeFileSync(DOCS_METADATA_PATH, JSON.stringify(uploadedDocuments));
};

/**
 * 持久化保存向量数据和元数据
 */
const saveToDisk = async () => {
  if (!vectorStore) return;
  ensureDataDir();
  // 文档元数据始终落盘（用于文档列表）
  saveDocsMetadataToDisk();
  if (vectorBackend === "memory") {
    // MemoryVectorStore 的简单持久化方案
    const memoryStore = vectorStore as MemoryVectorStore;
    const data = JSON.stringify(memoryStore.memoryVectors);
    fs.writeFileSync(VECTOR_STORE_PATH, data);
  }
  console.log(`[Disk] Saved metadata for ${uploadedDocuments.length} docs (backend=${vectorBackend}).`);
};

/**
 * 从磁盘加载向量数据和元数据
 */
const loadMemoryFromDisk = async (embeddings: OpenAIEmbeddings) => {
  ensureDataDir();
  loadDocsMetadataFromDisk();

  const store = new MemoryVectorStore(embeddings);
  
  // 加载向量数据
  if (fs.existsSync(VECTOR_STORE_PATH)) {
    const vectors = JSON.parse(fs.readFileSync(VECTOR_STORE_PATH, "utf-8"));
    store.memoryVectors = vectors;
    console.log(`[Disk] Loaded ${vectors.length} vectors from disk.`);
  }
  
  return store;
};

const getPgRuntimeConfig = () => {
  const connectionString = String(process.env.RAG_PG_CONNECTION_STRING ?? "").trim();
  if (!connectionString) {
    throw new Error("RAG_PG_CONNECTION_STRING is required when RAG_VECTOR_BACKEND=pgvector");
  }
  const tableName = sanitizeIdentifier(process.env.RAG_PG_TABLE_NAME ?? "rag_documents", "rag_documents");
  const idColumnName = sanitizeIdentifier(process.env.RAG_PG_ID_COLUMN ?? "id", "id");
  const vectorColumnName = sanitizeIdentifier(process.env.RAG_PG_VECTOR_COLUMN ?? "embedding", "embedding");
  const contentColumnName = sanitizeIdentifier(process.env.RAG_PG_CONTENT_COLUMN ?? "content", "content");
  const metadataColumnName = sanitizeIdentifier(process.env.RAG_PG_METADATA_COLUMN ?? "metadata", "metadata");
  const max = Number.parseInt(process.env.RAG_PG_POOL_MAX ?? "10", 10);
  const trigramThresholdRaw = Number.parseFloat(process.env.RAG_PG_TRGM_THRESHOLD ?? "0.12");
  return {
    connectionString,
    tableName,
    idColumnName,
    vectorColumnName,
    contentColumnName,
    metadataColumnName,
    poolMax: Number.isFinite(max) ? max : 10,
    trigramThreshold: Number.isFinite(trigramThresholdRaw) ? trigramThresholdRaw : 0.12,
  };
};

const getPgTableCount = async (pool: Pool, tableName: string) => {
  const res = await pool.query(`SELECT COUNT(*)::int AS c FROM "${tableName}"`);
  return Number(res.rows?.[0]?.c ?? 0);
};

const toPgJson = (v: any): Record<string, any> => {
  if (!v) return {};
  if (typeof v === "object") return v as Record<string, any>;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return {};
};

const migrateLegacyMemoryFileToPgIfNeeded = async (
  store: PGVectorStore,
  pool: Pool,
  tableName: string
) => {
  const enableMigration = envBool(process.env.RAG_MIGRATE_LEGACY_MEMORY_ON_BOOT, true);
  if (!enableMigration) return;
  if (!fs.existsSync(VECTOR_STORE_PATH)) return;
  const currentRows = await getPgTableCount(pool, tableName);
  if (currentRows > 0) return;

  try {
    const vectors = JSON.parse(fs.readFileSync(VECTOR_STORE_PATH, "utf-8"));
    if (!Array.isArray(vectors) || vectors.length === 0) return;
    const { Document } = await import("@langchain/core/documents");
    const docs = vectors
      .map((v: any) => {
        const pageContent = String(v?.content ?? v?.pageContent ?? "").trim();
        if (!pageContent) return null;
        const metadata = v?.metadata ?? {};
        return new Document({ pageContent, metadata });
      })
      .filter(Boolean);
    if (docs.length === 0) return;
    await addDocumentsInBatches(store, docs as any);
    console.log(`[PGVector] Migrated ${docs.length} legacy vectors from disk to "${tableName}".`);
  } catch (e) {
    console.warn("[PGVector] Legacy memory migration skipped due to parse/import error:", e);
  }
};

const loadPgVectorStore = async (embeddings: OpenAIEmbeddings) => {
  loadDocsMetadataFromDisk();
  const cfg = getPgRuntimeConfig();
  const pool = new Pool({
    connectionString: cfg.connectionString,
    max: cfg.poolMax,
  });
  pgPool = pool;
  // pgvector 镜像通常已预装 extension；确保扩展存在，便于首次启动
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");

  const store = await PGVectorStore.initialize(embeddings, {
    postgresConnectionOptions: {
      connectionString: cfg.connectionString,
    },
    tableName: cfg.tableName,
    columns: {
      idColumnName: cfg.idColumnName,
      vectorColumnName: cfg.vectorColumnName,
      contentColumnName: cfg.contentColumnName,
      metadataColumnName: cfg.metadataColumnName,
    },
  });
  const trigramIndexName = sanitizeIdentifier(
    `${cfg.tableName}_${cfg.contentColumnName}_trgm_idx`,
    "rag_documents_content_trgm_idx"
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS "${trigramIndexName}" ON "${cfg.tableName}" USING GIN ("${cfg.contentColumnName}" gin_trgm_ops)`
  );
  await migrateLegacyMemoryFileToPgIfNeeded(store, pool, cfg.tableName);
  await syncMetadataFromPgIfEmpty(pool, cfg.tableName, cfg.metadataColumnName);
  const rows = await getPgTableCount(pool, cfg.tableName);
  console.log(`[PGVector] Connected table "${cfg.tableName}", rows=${rows}.`);
  return store;
};

export const getUploadedDocuments = async () => {
  // 确保向量存储已加载，这样元数据也会被加载
  await getVectorStore();
  return uploadedDocuments;
};

const bm25RebuildPageSize = () => {
  const n = Number.parseInt(process.env.RAG_BM25_REBUILD_PAGE ?? "500", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(5000, n) : 500;
};

const collectBm25DocsFromMemory = (): { pageContent: string; metadata: Record<string, unknown> }[] => {
  const docs: { pageContent: string; metadata: Record<string, unknown> }[] = [];
  if (vectorStore && vectorBackend === "memory") {
    const memoryStore = vectorStore as MemoryVectorStore;
    for (const vec of memoryStore.memoryVectors ?? []) {
      const content = String((vec as any)?.content ?? "").trim();
      if (!content) continue;
      docs.push({
        pageContent: content,
        metadata: ((vec as any)?.metadata ?? {}) as Record<string, unknown>,
      });
    }
  }
  if (docs.length) return docs;
  if (!fs.existsSync(VECTOR_STORE_PATH)) return [];
  try {
    const vectors = JSON.parse(fs.readFileSync(VECTOR_STORE_PATH, "utf-8"));
    if (!Array.isArray(vectors)) return [];
    for (const vec of vectors) {
      const content = String(vec?.content ?? vec?.pageContent ?? "").trim();
      if (!content) continue;
      docs.push({
        pageContent: content,
        metadata: (vec?.metadata ?? {}) as Record<string, unknown>,
      });
    }
  } catch {
    return [];
  }
  return docs;
};

const collectBm25DocsFromPg = async (): Promise<
  { pageContent: string; metadata: Record<string, unknown> }[]
> => {
  if (!pgPool || vectorBackend !== "pgvector") return [];
  const cfg = getPgRuntimeConfig();
  const page = bm25RebuildPageSize();
  const out: { pageContent: string; metadata: Record<string, unknown> }[] = [];
  let offset = 0;
  for (;;) {
    const res = await pgPool.query(
      `SELECT "${cfg.contentColumnName}" AS content, "${cfg.metadataColumnName}" AS metadata
       FROM "${cfg.tableName}"
       ORDER BY "${cfg.idColumnName}"
       LIMIT $1 OFFSET $2`,
      [page, offset]
    );
    const rows = res.rows ?? [];
    if (!rows.length) break;
    for (const r of rows) {
      const content = String(r?.content ?? "").trim();
      if (!content) continue;
      out.push({ pageContent: content, metadata: toPgJson(r?.metadata) });
    }
    if (rows.length < page) break;
    offset += page;
  }
  return out;
};

const persistBm25Index = () => {
  try {
    ensureDataDir();
    fs.writeFileSync(BM25_INDEX_PATH, JSON.stringify(bm25Index.toJSON()));
  } catch (e) {
    console.warn("[BM25] persist skipped:", e);
  }
};

const tryLoadBm25FromDisk = (): boolean => {
  if (!fs.existsSync(BM25_INDEX_PATH)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(BM25_INDEX_PATH, "utf-8"));
    const n = bm25Index.loadFromJSON(raw);
    return n > 0;
  } catch (e) {
    console.warn("[BM25] load from disk failed:", e);
    return false;
  }
};

/** 从当前向量后端全量重建倒排（带锁） */
export const rebuildBm25Index = async (opts?: { preferDisk?: boolean }): Promise<number> => {
  if (bm25RebuildLock) {
    await bm25RebuildLock;
    return bm25Index.size;
  }
  bm25RebuildLock = (async () => {
    try {
      if (opts?.preferDisk && tryLoadBm25FromDisk()) {
        bm25Ready = true;
        console.log(`[BM25] loaded inverted index from disk docs=${bm25Index.size}`);
        return;
      }
      await getVectorStore();
      const docs =
        vectorBackend === "pgvector"
          ? await collectBm25DocsFromPg()
          : collectBm25DocsFromMemory();
      const n = bm25Index.rebuildFromDocs(docs);
      bm25Ready = true;
      persistBm25Index();
      console.log(`[BM25] rebuilt inverted index docs=${n} backend=${vectorBackend}`);
    } finally {
      bm25RebuildLock = null;
    }
  })();
  await bm25RebuildLock;
  return bm25Index.size;
};

const ensureBm25Index = async () => {
  await getVectorStore();
  if (bm25Ready && bm25Index.size > 0) return;
  if (bm25Ready && bm25Index.size === 0) return;
  await rebuildBm25Index({ preferDisk: true });
};

const syncBm25AfterUpsert = (docs: { pageContent?: string; metadata?: Record<string, unknown> }[]) => {
  for (const d of docs) {
    const content = String(d.pageContent ?? "").trim();
    if (!content) continue;
    bm25Index.upsertDoc({ pageContent: content, metadata: d.metadata ?? {} });
  }
  bm25Ready = true;
  persistBm25Index();
};

export const getBm25IndexStats = () => bm25Index.getStats();

/** H1：按 source 清除向量（不依赖元数据列表是否存在） */
export const purgeVectorsBySource = async (fileName: string): Promise<number> => {
  await getVectorStore();
  if (!vectorStore) return 0;
  let removed = 0;
  if (vectorBackend === "memory") {
    const memoryStore = vectorStore as MemoryVectorStore;
    const { kept, removed: n } = filterMemoryVectorsBySource(
      memoryStore.memoryVectors ?? [],
      fileName
    );
    memoryStore.memoryVectors = kept as typeof memoryStore.memoryVectors;
    removed = n;
  } else {
    const cfg = getPgRuntimeConfig();
    const col = cfg.metadataColumnName;
    if (pgPool) {
      const res = await pgPool.query(
        `DELETE FROM "${cfg.tableName}" WHERE COALESCE("${col}"->>'source','') = $1`,
        [fileName]
      );
      removed = Number(res.rowCount ?? 0);
    }
  }
  bm25Index.removeBySource(fileName);
  if (bm25Ready) persistBm25Index();
  return removed;
};

export const countVectorsBySource = async (fileName: string): Promise<number> => {
  await getVectorStore();
  if (!vectorStore) return 0;
  if (vectorBackend === "memory") {
    const memoryStore = vectorStore as MemoryVectorStore;
    return (memoryStore.memoryVectors ?? []).filter(
      (v) => String(v.metadata?.source ?? "") === fileName
    ).length;
  }
  const cfg = getPgRuntimeConfig();
  const col = cfg.metadataColumnName;
  if (!pgPool) return 0;
  const res = await pgPool.query(
    `SELECT COUNT(*)::int AS c FROM "${cfg.tableName}" WHERE COALESCE("${col}"->>'source','') = $1`,
    [fileName]
  );
  return Number(res.rows?.[0]?.c ?? 0);
};

export const deleteDocument = async (fileName: string) => {
  await getVectorStore();

  const index = uploadedDocuments.findIndex((d) => d.name === fileName);
  await purgeVectorsBySource(fileName);
  try {
    const { purgeGraphBySource } = await import("./policy_graph_store");
    purgeGraphBySource(fileName);
  } catch (e) {
    console.warn("[PolicyGraph] purge on delete skipped:", e);
  }
  if (index !== -1) {
    uploadedDocuments.splice(index, 1);
  }
  await saveToDisk();
  return index !== -1;
};

export const getVectorStore = async () => {
  if (!vectorStore) {
    const embeddings = getRagEmbeddings();
    vectorBackend = normalizeBackend(process.env.RAG_VECTOR_BACKEND ?? "memory");
    vectorStore =
      vectorBackend === "pgvector"
        ? await loadPgVectorStore(embeddings)
        : await loadMemoryFromDisk(embeddings);
    console.log(`[VectorStore] backend=${vectorBackend}`);
    // 冷启动：优先磁盘倒排，否则从向量后端重建（含 pgvector）
    void rebuildBm25Index({ preferDisk: true }).catch((e) =>
      console.warn("[BM25] boot rebuild failed:", e)
    );
  }
  return vectorStore;
};

export const getVectorBackend = async (): Promise<"memory" | "pgvector"> => {
  await getVectorStore();
  return vectorBackend;
};

export type VectorStoreHealthAudit = {
  backend: "memory" | "pgvector";
  metadataDocCount: number;
  vectorRowCount: number | null;
  pgDistinctSources: number | null;
  memoryVectorCount: number | null;
  consistent: boolean;
  reconciled: boolean;
  /** 硬告警：会导致 ready=false（meta/vector 真漂移等） */
  warnings: string[];
  /** 软告警：升级期字段缺失等，不阻断检索 */
  softWarnings: string[];
  /** H6：元数据缺 ingest_at 的文档占比 0～1 */
  missingIngestAtRatio: number | null;
  /** 元数据缺 content_hash 的文档占比 0～1 */
  missingContentHashRatio: number | null;
};

/** pgvector / memory 与 docs_metadata 对账；ready 探针可调用 */
export async function auditVectorStoreHealth(opts?: { reconcile?: boolean }): Promise<VectorStoreHealthAudit> {
  await getVectorStore();
  const warnings: string[] = [];
  let reconciled = false;
  let vectorRowCount: number | null = null;
  let pgDistinctSources: number | null = null;
  let memoryVectorCount: number | null = null;

  if (vectorBackend === "pgvector" && pgPool) {
    const cfg = getPgRuntimeConfig();
    vectorRowCount = await getPgTableCount(pgPool, cfg.tableName);
    try {
      const res = await pgPool.query(
        `SELECT COUNT(DISTINCT "${cfg.metadataColumnName}"->>'source')::int AS c FROM "${cfg.tableName}" WHERE "${cfg.metadataColumnName}"->>'source' IS NOT NULL`
      );
      pgDistinctSources = Number(res.rows?.[0]?.c ?? 0);
    } catch {
      warnings.push("pg_distinct_source_query_failed");
    }
    if (opts?.reconcile !== false && uploadedDocuments.length === 0 && (pgDistinctSources ?? 0) > 0) {
      await syncMetadataFromPgIfEmpty(pgPool, cfg.tableName, cfg.metadataColumnName);
      reconciled = uploadedDocuments.length > 0;
    }
    if (uploadedDocuments.length > 0 && vectorRowCount === 0) {
      warnings.push("metadata_has_docs_but_pg_empty");
    }
    if (
      (pgDistinctSources ?? 0) > 0 &&
      uploadedDocuments.length > 0 &&
      uploadedDocuments.length !== pgDistinctSources
    ) {
      warnings.push("metadata_pg_source_count_mismatch");
    }
  } else if (vectorStore) {
    const mem = vectorStore as MemoryVectorStore;
    memoryVectorCount = Array.isArray(mem.memoryVectors) ? mem.memoryVectors.length : 0;
    vectorRowCount = memoryVectorCount;
    if (uploadedDocuments.length > 0 && memoryVectorCount === 0) {
      warnings.push("metadata_has_docs_but_memory_empty");
    }
    if (fs.existsSync(VECTOR_STORE_PATH) && memoryVectorCount === 0 && uploadedDocuments.length === 0) {
      warnings.push("legacy_vector_file_present_but_empty_memory");
    }
  }

  const metaN = uploadedDocuments.length;
  const missingIngestAt =
    metaN > 0 ? uploadedDocuments.filter((d) => !String(d.ingest_at || "").trim()).length / metaN : null;
  const missingHash =
    metaN > 0 ? uploadedDocuments.filter((d) => !String(d.content_hash || "").trim()).length / metaN : null;
  const softWarnings: string[] = [];
  if ((missingIngestAt ?? 0) > 0.25) softWarnings.push("many_docs_missing_ingest_at");
  if ((missingHash ?? 0) > 0.25) softWarnings.push("many_docs_missing_content_hash");

  return {
    backend: vectorBackend,
    metadataDocCount: uploadedDocuments.length,
    vectorRowCount,
    pgDistinctSources,
    memoryVectorCount,
    consistent: warnings.length === 0,
    reconciled,
    warnings,
    softWarnings,
    missingIngestAtRatio: missingIngestAt,
    missingContentHashRatio: missingHash,
  };
};

export const searchKeywordCandidates = async (params: {
  terms: string[];
  sources?: string[];
  limit?: number;
}): Promise<KeywordCandidate[]> => {
  await getVectorStore();
  const terms = Array.from(new Set((params.terms ?? []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean)));
  if (!terms.length) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit ?? 24))));
  const sourceFilters = Array.from(new Set((params.sources ?? []).map((s) => String(s || "").trim()).filter(Boolean)));

  const searchFromMemoryFile = (): KeywordCandidate[] => {
    if (!fs.existsSync(VECTOR_STORE_PATH)) return [];
    try {
      const vectors = JSON.parse(fs.readFileSync(VECTOR_STORE_PATH, "utf-8"));
      if (!Array.isArray(vectors)) return [];
      const out: KeywordCandidate[] = [];
      for (const vec of vectors) {
        const metadata = (vec?.metadata ?? {}) as Record<string, any>;
        const source = String(metadata?.source ?? "");
        if (sourceFilters.length > 0 && !sourceFilters.includes(source)) continue;
        const content = String(vec?.content ?? vec?.pageContent ?? "");
        const lc = content.toLowerCase();
        if (!lc) continue;
        let matched = 0;
        for (const term of terms) {
          if (lc.includes(term)) matched += 1;
        }
        if (!matched) continue;
        out.push({
          pageContent: content,
          metadata,
          matchedTerms: matched,
        });
      }
      out.sort((a, b) => b.matchedTerms - a.matchedTerms || a.pageContent.length - b.pageContent.length);
      return out.slice(0, limit);
    } catch (e) {
      console.warn("[KeywordFallback] Failed to search local vector_store.json:", e);
      return [];
    }
  };

  if (vectorBackend === "pgvector" && pgPool) {
    const cfg = getPgRuntimeConfig();
    const contentCol = cfg.contentColumnName;
    const metadataCol = cfg.metadataColumnName;
    const sourceClause =
      sourceFilters.length > 0
        ? `AND COALESCE("${metadataCol}"->>'source','') = ANY($2::text[])`
        : "";
    const sql = `
      SELECT
        "${contentCol}" AS content,
        "${metadataCol}" AS metadata,
        (
          SELECT COUNT(*)
          FROM unnest($1::text[]) AS term
          WHERE lower("${contentCol}") LIKE '%' || term || '%'
        )::int AS matched
        ,
        (
          SELECT COALESCE(SUM(similarity(lower("${contentCol}"), term)), 0)
          FROM unnest($1::text[]) AS term
        )::float AS sim
      FROM "${cfg.tableName}"
      WHERE (
        SELECT COALESCE(COUNT(*), 0)
        FROM unnest($1::text[]) AS term
        WHERE
          lower("${contentCol}") LIKE '%' || term || '%'
          OR similarity(lower("${contentCol}"), term) >= $${sourceFilters.length > 0 ? "3" : "2"}
      ) > 0
      ${sourceClause}
      ORDER BY matched DESC, sim DESC, length("${contentCol}") ASC
      LIMIT $${sourceFilters.length > 0 ? "4" : "3"}
    `;
    const values: any[] = [terms];
    if (sourceFilters.length > 0) values.push(sourceFilters);
    values.push(cfg.trigramThreshold);
    values.push(limit);
    const rows = (await pgPool.query(sql, values)).rows ?? [];
    const pgResults: KeywordCandidate[] = rows.map((r: any) => ({
      pageContent: String(r?.content ?? ""),
      metadata: toPgJson(r?.metadata),
      matchedTerms: Number(r?.matched ?? 0),
    }));
    if (pgResults.length > 0) return pgResults;
    // PG 未命中时回退到本地向量文件关键词检索，兜住迁移/编码/过滤异常。
    return searchFromMemoryFile();
  }

  const memoryStore = vectorStore as MemoryVectorStore;
  const memoryVectors = (memoryStore as any)?.memoryVectors ?? [];
  const out: KeywordCandidate[] = [];
  for (const vec of memoryVectors) {
    const metadata = (vec?.metadata ?? {}) as Record<string, any>;
    const source = String(metadata?.source ?? "");
    if (sourceFilters.length > 0 && !sourceFilters.includes(source)) continue;
    const content = String(vec?.content ?? "");
    const lc = content.toLowerCase();
    if (!lc) continue;
    let matched = 0;
    for (const term of terms) {
      if (lc.includes(term)) matched += 1;
    }
    if (!matched) continue;
    out.push({
      pageContent: content,
      metadata,
      matchedTerms: matched,
    });
  }
  out.sort((a, b) => b.matchedTerms - a.matchedTerms || a.pageContent.length - b.pageContent.length);
  const memoryResults = out.slice(0, limit);
  if (memoryResults.length > 0) return memoryResults;
  return searchFromMemoryFile();
};

export type Bm25Candidate = Bm25Hit;

/** BM25 词法检索（倒排索引；与向量结果 RRF 融合；含 pgvector 通路） */
export const searchBm25Candidates = async (params: {
  terms: string[];
  sources?: string[];
  limit?: number;
}): Promise<Bm25Candidate[]> => {
  await ensureBm25Index();
  const terms = Array.from(
    new Set((params.terms ?? []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean))
  );
  if (!terms.length) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit ?? 24))));
  const sourceFilters = Array.from(
    new Set((params.sources ?? []).map((s) => String(s || "").trim()).filter(Boolean))
  );
  return bm25Index.search(terms, limit, sourceFilters.length ? sourceFilters : undefined);
};

const generateSummary = async (text: string) => {
  const model = createRagChatOpenAI({
    modelName: getRagAgentEnv().summaryModel,
    maxTokens: 200,
    jsonTask: true,
  });
  
  const response = await model.invoke(`请为以下文档内容生成一个简短的摘要（不超过100字）：\n\n${text.substring(0, 3000)}`);
  return response.content.toString();
};

/**
 * 文档处理服务
 * 对应架构图中的：文档解析服务 -> 文本分块 -> 向量化存储
 * H1：同名 upsert（先 purge）+ content_hash 幂等跳过 + ingest_at/source_version
 */
export const processDocument = async (
  file: Blob | Buffer,
  fileName: string,
  limits?: ProcessLimits,
  opts?: ProcessDocumentOptions
): Promise<number> => {
  const normalizeFilename = (name: string) => {
    const s = String(name || "").trim();
    if (!s) return "unknown";
    const looksBroken = /[\u0000-\u001f\u007f-\u00ff]/.test(s);
    if (!looksBroken) return s;
    try {
      const recovered = Buffer.from(s, "latin1").toString("utf8").trim();
      return recovered || s;
    } catch {
      return s;
    }
  };

  fileName = normalizeFilename(fileName);
  const buffer = file instanceof Buffer ? file : Buffer.from(await (file as Blob).arrayBuffer());
  console.log(`[Process] Parsing: ${fileName}, Size: ${buffer.length} bytes, Magic: ${buffer.slice(0, 4).toString('hex')}`);
  
  const effectiveLimits = limits ?? getDefaultLimits();

  if (buffer.length > effectiveLimits.maxUploadBytes) {
    throw new Error(`File too large: ${buffer.length} > ${effectiveLimits.maxUploadBytes}`);
  }

  let fileType = fileName.split('.').pop()?.toLowerCase() || 'unknown';
  if (fileType === "zip") {
    try {
      if (buffer.slice(0, 4).toString('hex') !== "504b0304") {
        throw new Error("Invalid .zip file: magic number mismatch");
      }
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip(buffer);
      const zipEntries = zip.getEntries();
      console.log(`[ZIP] Found ${zipEntries.length} entries in ${fileName}`);
      
      if (zipEntries.length > effectiveLimits.maxZipEntries) {
        throw new Error(`ZIP too many entries: ${zipEntries.length} > ${effectiveLimits.maxZipEntries}`);
      }

      let totalChunks = 0;
      for (const entry of zipEntries) {
        const entryName = normalizeFilename(entry.name);
        if (!entry.isDirectory && (
          entryName.endsWith(".txt") || 
          entryName.endsWith(".pdf") || 
          entryName.endsWith(".docx") ||
          entryName.endsWith(".md") ||
          entryName.endsWith(".csv") ||
          entryName.endsWith(".xlsx") ||
          entryName.endsWith(".xls") ||
          entryName.endsWith(".json") ||
          entryName.endsWith(".html") ||
          entryName.endsWith(".htm") ||
          entryName.endsWith(".pptx") ||
          entryName.endsWith(".png") ||
          entryName.endsWith(".jpg") ||
          entryName.endsWith(".jpeg") ||
          entryName.endsWith(".bmp") ||
          entryName.endsWith(".tiff")
        )) {
          const data = entry.getData();
          effectiveLimits.totalZipEntries += 1;
          effectiveLimits.totalZipUncompressedBytes += data.length;
          if (effectiveLimits.totalZipUncompressedBytes > effectiveLimits.maxZipTotalUncompressedBytes) {
            throw new Error(`ZIP uncompressed data too large: ${effectiveLimits.totalZipUncompressedBytes} > ${effectiveLimits.maxZipTotalUncompressedBytes}`);
          }
          totalChunks += await processDocument(data, entryName, effectiveLimits, opts);
        }
      }
      return totalChunks;
    } catch (zipErr: any) {
      console.error(`[ZIP Error] ${fileName}:`, zipErr.message);
      throw zipErr;
    }
  }

  // K 波：优先 MinerU 重解析（PDF/Office/图片）；失败回落本地或严格拒收
  try {
    const {
      parseWithMineru,
      heavyParseToDocuments,
      shouldAttemptHeavyParse,
      shouldRejectOnHeavyFailure,
      HeavyParseStrictError,
    } = await import("./heavy_parse_client");
    if (shouldAttemptHeavyParse(fileName)) {
      const heavy = await parseWithMineru({ buffer, fileName });
      if (heavy.ok) {
        const heavyDocs = await heavyParseToDocuments({
          result: heavy,
          fileName,
          fileType,
        });
        console.log(
          `[HeavyParse] ${fileName} provider=${heavy.provider} chars=${heavy.chars} blocks=${heavy.blocks.length} ms=${heavy.ms}`
        );
        return upsertParsedDocuments(heavyDocs as any[], fileName, fileType, effectiveLimits, {
          ...opts,
          parser: "mineru",
          parser_provider: heavy.provider,
        });
      }
      if (shouldRejectOnHeavyFailure({ fileName })) {
        throw new HeavyParseStrictError(
          `MinerU 重解析失败，已拒绝入库（严格模式）：${fileName} — ${heavy.reason}`
        );
      }
      console.warn(`[HeavyParse] fallback local for ${fileName}: ${heavy.reason}`);
      opts = {
        ...opts,
        parser: opts?.parser || `local_fallback`,
        parser_provider: opts?.parser_provider || `fallback:${heavy.reason}`,
        parser_fallback: "local",
      };
    } else if (shouldRejectOnHeavyFailure({ fileName })) {
      // 严格模式但未配置 URL / 未开 heavy → 仍应拒收 HEAVY 扩展，避免静默空解析
      const env = getRagAgentEnv();
      if (env.heavyParseStrict && env.enableHeavyParse && !String(env.mineruApiUrl || "").trim()) {
        const { HeavyParseStrictError: Err } = await import("./heavy_parse_client");
        throw new Err(`MinerU 未配置 MINERU_API_URL，严格模式拒绝入库：${fileName}`);
      }
    }
  } catch (heavyErr: any) {
    if (heavyErr?.code === "heavy_parse_strict_failed" || heavyErr?.name === "HeavyParseStrictError") {
      throw heavyErr;
    }
    const { shouldRejectOnHeavyFailure, HeavyParseStrictError } = await import("./heavy_parse_client");
    if (shouldRejectOnHeavyFailure({ fileName })) {
      throw new HeavyParseStrictError(
        `MinerU 重解析异常，已拒绝入库（严格模式）：${fileName} — ${heavyErr?.message || heavyErr}`
      );
    }
    console.warn(`[HeavyParse] error, fallback local for ${fileName}:`, heavyErr?.message || heavyErr);
  }

  let docs = [];

  try {
    // 1. 文档解析服务 (拓展更多格式)
    if (fileType === "pdf") {
      const pdfParseModule: any = await import("pdf-parse");
      // pdf-parse v2+ exports a PDFParse class; older versions export a callable function.
      const PDFParseCtor =
        pdfParseModule?.PDFParse ??
        pdfParseModule?.default?.PDFParse ??
        null;

      let text = "";
      if (typeof PDFParseCtor === "function") {
        const parser = new PDFParseCtor({ data: buffer });
        try {
          const textResult = await parser.getText();
          text = textResult?.text ?? "";
          const pages = Array.isArray(textResult?.pages) ? textResult.pages : [];
          if (pages.length > 0) {
            const { Document } = await import("@langchain/core/documents");
            docs = pages
              .map((page: any) => {
                const pageText = String(page?.text ?? "").trim();
                if (!pageText) return null;
                return new Document({
                  pageContent: pageText,
                  metadata: {
                    source: fileName,
                    fileType,
                    page: page?.num ?? undefined,
                  },
                });
              })
              .filter(Boolean);
          }
        } finally {
          if (typeof parser.destroy === "function") {
            await parser.destroy();
          }
        }
      } else {
        const pdfParseFn = pdfParseModule?.default ?? pdfParseModule;
        if (typeof pdfParseFn !== "function") {
          throw new Error("pdf-parse export is not callable and PDFParse class not found");
        }
        const parsed = await pdfParseFn(buffer);
        text = parsed?.text ?? "";
      }
      if (docs.length === 0) {
        const { Document } = await import("@langchain/core/documents");
        docs = [new Document({ pageContent: text, metadata: { source: fileName, fileType } })];
      }
    } else if (fileType === "docx" || fileType === "doc") {
      const magic = buffer.slice(0, 4).toString('hex');
      const { Document } = await import("@langchain/core/documents");
      
      if (magic === "504b0304") {
        // Modern .docx (ZIP structure)
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer: buffer });
        docs = [new Document({ pageContent: result.value, metadata: { source: fileName, fileType } })];
      } else if (magic === "d0cf11e0") {
        // Legacy .doc (OLECF structure)
        const WordExtractor = (await import("word-extractor")).default;
        const extractor = new WordExtractor();
        const extracted = await extractor.extract(buffer);
        docs = [new Document({ pageContent: extracted.getBody(), metadata: { source: fileName, fileType } })];
      } else {
        throw new Error(`Unsupported Word format: Magic number ${magic} not recognized for ${fileName}`);
      }
    } else if (["png", "jpg", "jpeg", "bmp", "tiff", "gif", "webp"].includes(fileType)) {
      // 1.2 OCR 识别 (针对扫描件/图片)
      const text = await performOCR(buffer, fileName);
      const { Document } = await import("@langchain/core/documents");
      // R4：OCR/上传片段入模前打 untrusted，不得当指令
      docs = [
        new Document({
          pageContent: text,
          metadata: {
            source: fileName,
            isOCR: true,
            fileType,
            content_trust: "untrusted",
            content_trust_source: "ocr_upload",
          },
        }),
      ];
    } else if (fileType === "xlsx" || fileType === "xls") {
      const { parseSpreadsheetBuffer } = await import("./spreadsheet_parse");
      const text = parseSpreadsheetBuffer(buffer, fileName);
      const { Document } = await import("@langchain/core/documents");
      docs = [new Document({ pageContent: text, metadata: { source: fileName, fileType } })];
    } else if (fileType === "pptx") {
      const text = await extractPptxText(buffer);
      if (!text.trim()) throw new Error(`PPTX 未解析到文本内容: ${fileName}`);
      const { Document } = await import("@langchain/core/documents");
      docs = [new Document({ pageContent: text, metadata: { source: fileName, fileType: "pptx" } })];
    } else if (fileType === "ppt" || isLegacyPptOle(buffer)) {
      throw new Error(`旧版 .ppt 暂不支持，请将 ${fileName} 另存为 .pptx 后上传`);
    } else if (fileType === "html" || fileType === "htm" || looksLikeHtmlDocument(buffer, fileName)) {
      const text = stripHtmlToPlainText(buffer.toString("utf-8"));
      const { Document } = await import("@langchain/core/documents");
      docs = [new Document({ pageContent: text, metadata: { source: fileName, fileType: "html" } })];
    } else if (["md", "csv", "json", "txt"].includes(fileType)) {
      const text = buffer.toString('utf-8');
      const { Document } = await import("@langchain/core/documents");
      docs = [new Document({ pageContent: text, metadata: { source: fileName, fileType } })];
    } else {
      // 默认作为文本处理
      const text = buffer.toString('utf-8');
      const { Document } = await import("@langchain/core/documents");
      docs = [new Document({ pageContent: text, metadata: { source: fileName, fileType } })];
    }
  } catch (err: any) {
    console.error(`[Parse Error] ${fileName}:`, err.message);
    throw new Error(`无法解析文件 ${fileName}: ${err.message}`);
  }

  if (docs.length === 0) return 0;

  const inferredType = fileType === "unknown" ? "txt" : fileType;
  const localParser =
    fileType === "pdf"
      ? "local_pdf"
      : fileType === "docx" || fileType === "doc"
        ? "local_word"
        : ["png", "jpg", "jpeg", "bmp", "tiff", "gif", "webp"].includes(fileType)
          ? "local_ocr"
          : fileType === "xlsx" || fileType === "xls"
            ? "local_spreadsheet"
            : fileType === "pptx"
              ? "local_pptx"
              : fileType === "html" || fileType === "htm"
                ? "local_html"
                : "local_text";
  return upsertParsedDocuments(docs as any[], fileName, inferredType, effectiveLimits, {
    ...opts,
    parser: opts?.parser || localParser,
  });
};

/**
 * H1/H6：已解析 Document[] → hash 幂等 / purge upsert / 版本元数据
 */
export async function upsertParsedDocuments(
  docs: { pageContent?: string; metadata?: Record<string, unknown> }[],
  fileName: string,
  fileType: string,
  limits?: ProcessLimits,
  opts?: ProcessDocumentOptions
): Promise<number> {
  const store = await getVectorStore();
  const effectiveLimits = limits ?? getDefaultLimits();
  if (!docs.length) return 0;

  const fullText = docs.map((d) => String(d.pageContent ?? "")).join("\n");
  const contentHash = hashCorpusText(fullText);
  const sourceVersion = resolveSourceVersion({
    explicit: opts?.source_version,
    contentHash,
  });
  const { ingest_at, processedAt } = buildIngestTimestamps();

  const existingMeta = uploadedDocuments.find((d) => d.name === fileName);
  if (shouldSkipReembed(existingMeta?.content_hash, contentHash)) {
    const existingCount =
      existingMeta.chunk_count && existingMeta.chunk_count > 0
        ? existingMeta.chunk_count
        : await countVectorsBySource(fileName);
    console.log(
      `[Upload] unchanged content_hash=${contentHash.slice(0, 12)}… skip re-embed: ${fileName} (chunks=${existingCount})`
    );
    existingMeta.ingest_at = ingest_at;
    existingMeta.source_version = sourceVersion;
    existingMeta.chunk_count = existingCount;
    await saveToDisk();
    // 嵌入幂等跳过时，若制度图缺失/脏骨架仍补抽，避免「加了图却永远是坏图」
    try {
      const { policyGraphNeedsRefresh } = await import("./policy_graph_store");
      if (policyGraphNeedsRefresh(fileName)) {
        const { extractAndUpsertPolicyGraph } = await import("./policy_graph_extract");
        const graphRes = await extractAndUpsertPolicyGraph({
          source: fileName,
          content_hash: contentHash,
          text: fullText,
        });
        if (graphRes.ok) {
          console.log(
            `[PolicyGraph] refresh ${fileName} nodes=${graphRes.nodeCount} edges=${graphRes.edgeCount} via=${graphRes.source}`
          );
        }
      }
    } catch (graphErr) {
      console.warn(`[PolicyGraph] refresh skipped for ${fileName}:`, graphErr);
    }
    return existingCount;
  }

  const env = getRagAgentEnv();
  const splitDocs = await splitDocumentsStructured(docs as any);

  const docsWithMetadata = splitDocs.map((doc) => ({
    ...doc,
    metadata: {
      ...doc.metadata,
      source: fileName,
      fileType,
      chunkSize: env.chunkSize,
      chunkOverlap: env.chunkOverlap,
      processedAt,
      ingest_at,
      source_version: sourceVersion,
      content_hash: contentHash,
      parser: opts?.parser || String(doc.metadata?.parser || "local_text"),
      parser_provider: opts?.parser_provider || doc.metadata?.parser_provider,
      ...(opts?.parser_fallback
        ? {
            parser_fallback: opts.parser_fallback,
            content_trust: doc.metadata?.content_trust || "untrusted",
            content_trust_source:
              doc.metadata?.content_trust_source || "heavy_parse_fallback_local",
          }
        : {}),
    },
  }));

  const remaining = Math.max(0, effectiveLimits.maxTotalChunks - effectiveLimits.totalChunks);
  if (remaining <= 0) {
    throw new Error(`Chunk budget exceeded: ${effectiveLimits.totalChunks} >= ${effectiveLimits.maxTotalChunks}`);
  }
  if (docsWithMetadata.length > remaining) {
    throw new Error(
      `Chunk budget exceeded: need ${docsWithMetadata.length}, remaining ${remaining}, max ${effectiveLimits.maxTotalChunks}`
    );
  }

  const purged = await purgeVectorsBySource(fileName);
  if (purged > 0) {
    console.log(`[Upload] purged ${purged} old vectors for ${fileName} before upsert`);
  }

  await addDocumentsInBatches(store, docsWithMetadata);
  effectiveLimits.totalChunks += docsWithMetadata.length;
  syncBm25AfterUpsert(docsWithMetadata);

  let summary = "";
  try {
    summary = await generateSummary(fullText);
  } catch (summaryErr) {
    console.warn(`[Summary Warning] Failed to generate summary for ${fileName}:`, summaryErr);
    summary = "摘要生成失败，但文档已存入向量数据库。";
  }

  const metaRow: UploadedDocMeta = {
    name: fileName,
    summary,
    type: fileType,
    content_hash: contentHash,
    ingest_at,
    source_version: sourceVersion,
    chunk_count: docsWithMetadata.length,
    parser: opts?.parser || String(docsWithMetadata[0]?.metadata?.parser || "local_text"),
  };
  const idx = uploadedDocuments.findIndex((d) => d.name === fileName);
  if (idx === -1) {
    console.log(`[Upload Success] Document added to list: ${fileName}`);
    uploadedDocuments.push(metaRow);
  } else {
    console.log(`[Upload Success] Document upserted in list: ${fileName}`);
    uploadedDocuments[idx] = { ...uploadedDocuments[idx], ...metaRow };
  }

  await saveToDisk();

  // M2：制度图抽取（失败不阻断入库；hash 未变时上面已 early-return）
  try {
    const { extractAndUpsertPolicyGraph } = await import("./policy_graph_extract");
    const graphRes = await extractAndUpsertPolicyGraph({
      source: fileName,
      content_hash: contentHash,
      text: fullText,
    });
    if (graphRes.ok) {
      console.log(
        `[PolicyGraph] ${fileName} nodes=${graphRes.nodeCount} edges=${graphRes.edgeCount} via=${graphRes.source}`
      );
    }
  } catch (graphErr) {
    console.warn(`[PolicyGraph] extract skipped for ${fileName}:`, graphErr);
  }

  return docsWithMetadata.length;
}

/** 按原文 source 名写入纯文本语料（reindex / 测试用，不走格式解析器） */
export async function upsertTextDocument(
  fileName: string,
  text: string,
  opts?: ProcessDocumentOptions & { fileType?: string }
): Promise<number> {
  const { Document } = await import("@langchain/core/documents");
  const fileType = opts?.fileType || "txt";
  const docs = [
    new Document({
      pageContent: String(text ?? ""),
      metadata: { source: fileName, fileType },
    }),
  ];
  return upsertParsedDocuments(docs, fileName, fileType, undefined, opts);
}

/**
 * H6：从已存向量按 source 重建正文后重新切分嵌入（无原始文件时的 best-effort）。
 */
export const reindexAllFromStore = async (): Promise<{ sources: number; chunks: number }> => {
  await getVectorStore();
  const bySource = new Map<string, { texts: string[]; fileType: string }>();

  const push = (source: string, text: string, fileType?: string) => {
    const s = String(source || "").trim();
    const t = String(text || "").trim();
    if (!s || !t) return;
    const row = bySource.get(s) ?? { texts: [], fileType: fileType || "txt" };
    if (fileType) row.fileType = fileType;
    row.texts.push(t);
    bySource.set(s, row);
  };

  if (vectorBackend === "memory") {
    const memoryStore = vectorStore as MemoryVectorStore;
    for (const v of memoryStore.memoryVectors ?? []) {
      const meta = v.metadata ?? {};
      const parent = String(meta.parent_text ?? "").trim();
      const text = parent || String((v as any).content ?? (v as any).pageContent ?? "").trim();
      push(String(meta.source ?? ""), text, String(meta.fileType ?? "") || undefined);
    }
  } else if (pgPool) {
    const cfg = getPgRuntimeConfig();
    const res = await pgPool.query(
      `SELECT "${cfg.contentColumnName}" AS content, "${cfg.metadataColumnName}" AS metadata FROM "${cfg.tableName}"`
    );
    for (const row of res.rows ?? []) {
      const meta = row.metadata ?? {};
      const parent = String(meta.parent_text ?? "").trim();
      const text = parent || String(row.content ?? "").trim();
      push(String(meta.source ?? ""), text, String(meta.fileType ?? "") || undefined);
    }
  }

  // 快照后再写，避免边扫边改
  const snapshot = [...bySource.entries()];
  let totalChunks = 0;
  for (const [source, { texts, fileType }] of snapshot) {
    const sorted = [...texts].sort((a, b) => b.length - a.length);
    const kept: string[] = [];
    for (const t of sorted) {
      if (kept.some((u) => u.includes(t))) continue;
      // 去掉被本段包含的更短段
      for (let i = kept.length - 1; i >= 0; i--) {
        if (t.includes(kept[i]!)) kept.splice(i, 1);
      }
      kept.push(t);
    }
    const merged = kept.join("\n\n");
    const existing = uploadedDocuments.find((d) => d.name === source);
    const n = await upsertTextDocument(source, merged, {
      fileType: existing?.type || fileType || "txt",
      source_version: existing?.source_version,
    });
    totalChunks += n;
  }
  return { sources: snapshot.length, chunks: totalChunks };
};
