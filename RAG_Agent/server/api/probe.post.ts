import { getUploadedDocuments } from "../utils/vectorStore";
import { sanitizeIncomingQuestion } from "../utils/incoming_question";
import { runDocumentRetrieval } from "../utils/document_retrieval";
import { applyPlatformModelOverrides } from "../utils/platform_config";
import { isManagerOrchestratedRequest } from "../utils/manager_orchestration";
import { setOrchestratedByManager, clearRetrievalUserKey, setManagerRagTask } from "../utils/retrieval_context";
import { parseManagerRagTaskFromJson } from "../utils/incoming_question";

/**
 * 总管路由探针：混合检索快路径（BM25+向量+RRF+进程内重排），与 /api/retrieve 召回一致、延迟可控。
 * 契约：evidence 为权威成对字段；sources/snippets 等长同序（禁止 Set 去重后按索引 zip）。
 */
export default defineEventHandler(async (event) => {
  await applyPlatformModelOverrides({});
  const orchestrated = isManagerOrchestratedRequest(event);
  setOrchestratedByManager(orchestrated);

  try {
    const body = await readBody<{ query?: string; k?: number; manager_rag_task_json?: string }>(event);
    const managerTask = parseManagerRagTaskFromJson(body?.manager_rag_task_json);
    setManagerRagTask(managerTask);
    const query = String(body?.query ?? "").trim();
    const kRaw = Number(body?.k ?? 3);
    const k = Number.isFinite(kRaw) && kRaw > 0 ? Math.max(1, Math.min(12, Math.floor(kRaw))) : 3;
    const docs = await getUploadedDocuments();

    if (!query) {
      return {
        ok: true,
        hasDocs: docs.length > 0,
        hits: 0,
        evidence: [],
        sources: [],
        snippets: [],
        uniqueSources: [],
        mode: "idle",
      };
    }

    const sanitized = sanitizeIncomingQuestion(query, managerTask) || query;
    const result = await runDocumentRetrieval({
      query: sanitized,
      rawQuery: query,
      probeMode: true,
    });

    const paired = (result.evidence || [])
      .slice(0, k)
      .map((e) => {
        const content = String(e.content ?? "").replace(/\s+/g, " ").trim().slice(0, 480);
        const source = String(e.source ?? "").trim() || "unknown";
        return content ? { source, content } : null;
      })
      .filter((row): row is { source: string; content: string } => Boolean(row));

    const sources = paired.map((e) => e.source);
    const snippets = paired.map((e) => e.content);
    const uniqueSources = Array.from(new Set(sources));

    return {
      ok: true,
      hasDocs: docs.length > 0,
      hits: paired.length,
      evidence: paired,
      sources,
      snippets,
      uniqueSources,
      mode: "hybrid_probe",
      rerank_mode: result.rerankMode,
      routing_mode: result.routingMode,
      needs_clarify: result.needsClarify,
      agentic_rounds: result.agenticRounds ?? 0,
      ms: result.ms,
    };
  } finally {
    clearRetrievalUserKey();
  }
});
