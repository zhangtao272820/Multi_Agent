import { sanitizeIncomingQuestion, parseManagerRagTaskFromJson } from "../utils/incoming_question";
import { runDocumentRetrieval } from "../utils/document_retrieval";
import { resolveUserKeyFromRequest } from "../utils/user_preferences";
import { resolveAgentUserId, checkUserAccess } from "../utils/agent_identity";
import { buildRagAgentResult, buildRagFailureResult } from "../utils/agent_result";
import { appendAgentTraceLog } from "../utils/trace_log";
import { ensureInternalAgentAccess } from "../utils/internal_auth";
import { applyPlatformModelOverrides } from "../utils/platform_config";
import { isManagerOrchestratedRequest } from "../utils/manager_orchestration";
import { setOrchestratedByManager, setManagerRagTask, setRetrievalUserKey, clearRetrievalUserKey } from "../utils/retrieval_context";
import { classifyRagThrownError, probeVectorReady } from "../utils/vectorReady";
import { recordRagQueryMetric } from "../utils/query_metrics";

/** 程序化检索（总管 prefetch / 旧版 retrieve-first）；用户与 UI 统一走 /api/chat → document_query */
export default defineEventHandler(async (event) => {
  ensureInternalAgentAccess(event);
  await applyPlatformModelOverrides({});
  const { withRagPoolSlot } = await import("../utils/ragPoolGate");
  const tenantId = String(event.context.ragTenantId || "default").trim() || "default";
  try {
    return await withRagPoolSlot("rag_chat", tenantId, async () => {
      return await handleRetrieve(event);
    });
  } catch (e: any) {
    if (e?.code === "rag_pool_overloaded" || e?.statusCode === 429) {
      throw createError({ statusCode: 429, statusMessage: String(e.message || "RAG busy") });
    }
    throw e;
  }
});

async function handleRetrieve(event: any) {
  const orchestrated = isManagerOrchestratedRequest(event);
  setOrchestratedByManager(orchestrated);
  const started = Date.now();
  const body = await readBody<{
    query?: string;
    message?: string;
    rawQuery?: string;
    skipLlmRerank?: boolean;
    skipEvidenceSelect?: boolean;
    fastPath?: boolean;
    userId?: string;
    manager_rag_task_json?: string;
  }>(event);

  const managerTask = parseManagerRagTaskFromJson(body?.manager_rag_task_json);
  setManagerRagTask(managerTask);

  const raw = String(body?.query ?? body?.message ?? body?.rawQuery ?? "").trim();
  if (!raw) {
    throw createError({
      statusCode: 400,
      statusMessage: "query、message 或 rawQuery 不能为空（总管预取须传非空问句）",
    });
  }

  const sanitized = sanitizeIncomingQuestion(raw, managerTask) || raw;
  const sessionId =
    String(event.node.req.headers["x-session-id"] ?? "").trim() ||
    String(event.node.req.headers["x-conversation-id"] ?? "").trim() ||
    undefined;
  const agentUserId = await resolveAgentUserId({
    headerUserId: String(event.node.req.headers["x-user-id"] ?? "").trim() || undefined,
    bodyUserId: body?.userId,
    sessionId,
    authorization: String(event.node.req.headers.authorization ?? ""),
  });
  const access = checkUserAccess(agentUserId);
  if (!access.allowed) {
    throw createError({ statusCode: 403, statusMessage: access.reason || "forbidden" });
  }
  const userKey = resolveUserKeyFromRequest({
    userId: agentUserId,
    headerUserId: agentUserId,
    sessionId,
  });

  const traceId =
    String(event.node.req.headers["x-trace-id"] ?? event.node.req.headers["x-run-id"] ?? "").trim() ||
    undefined;

  try {
    setRetrievalUserKey(userKey);

    // R3：向量未就绪 → 标准失败码，勿伪装空证据
    const vec = await probeVectorReady();
    if (!vec.ready) {
      const agentResult = buildRagFailureResult({
        error_code: "vector_not_ready",
        query: sanitized,
        trace_id: traceId,
        ms: Date.now() - started,
        detail: vec.detail,
      });
      recordRagQueryMetric({
        path: "document_query",
        ok: false,
        ms: agentResult.latency_ms,
        reason: "vector_not_ready",
        trace_id: traceId,
        error_code: "vector_not_ready",
      });
      void appendAgentTraceLog({
        agent: "rag",
        path: "/api/retrieve",
        trace_id: traceId,
        ok: false,
        latency_ms: Date.now() - started,
        detail: "vector_not_ready",
      });
      return {
        ok: false,
        query: sanitized,
        needsClarify: false,
        ms: agentResult.latency_ms,
        evidence: [],
        citations: [],
        agentResult,
        error_code: "vector_not_ready",
      };
    }

    const result = await runDocumentRetrieval({
      query: sanitized,
      rawQuery: String(body?.rawQuery ?? raw).trim() || sanitized,
      skipLlmRerank: orchestrated ? body?.skipLlmRerank !== false : Boolean(body?.skipLlmRerank),
      skipEvidenceSelect: orchestrated
        ? body?.skipEvidenceSelect !== false
        : Boolean(body?.skipEvidenceSelect),
      fastPath: orchestrated ? body?.fastPath !== false : Boolean(body?.fastPath),
      userKey,
    });

    const agentResult = buildRagAgentResult({
      query: result.effectiveQuery,
      // answer 由证据摘要填充（buildRagAgentResult）；勿再写问句
      needsClarify: result.needsClarify,
      ms: result.ms,
      evidence: result.evidence,
      trace_id: traceId,
      retrievalFailureMode: result.retrievalFailureMode || result.clarifyReason,
      retrievalLanes: result.retrievalLanes,
    });

    // 成功/弱证据路径由 document_retrieval.finish 记账，此处避免双计

    void appendAgentTraceLog({
      agent: "rag",
      path: "/api/retrieve",
      trace_id: traceId,
      ok: agentResult.ok,
      latency_ms: Date.now() - started,
      detail: result.rerankMode,
    });

    return {
      ok: agentResult.ok,
      query: result.effectiveQuery,
      needsClarify: result.needsClarify,
      ms: result.ms,
      intent: result.plan.intent,
      sub_queries: result.plan.sub_queries,
      routing_mode: result.routingMode,
      agentic_rounds: result.agenticRounds ?? 0,
      rerank_mode: result.rerankMode,
      clarify_reason: result.clarifyReason,
      retrieval_failure_mode: result.retrievalFailureMode || result.clarifyReason,
      experience_hits: result.experienceHits ?? 0,
      ab_variant: result.abVariant,
      bandit_arm: result.banditArm,
      retrieval_lanes: result.retrievalLanes ?? ["hybrid"],
      evidence: result.evidence,
      citations: result.evidence.map((e) => ({ source: e.source, quote: e.content })),
      agentResult,
      ...(agentResult.error_code ? { error_code: agentResult.error_code } : {}),
    };
  } catch (e: unknown) {
    const code = classifyRagThrownError(e);
    const detail = String(e instanceof Error ? e.message : e ?? "retrieve_failed").slice(0, 240);
    const agentResult = buildRagFailureResult({
      error_code: code,
      query: sanitized,
      trace_id: traceId,
      ms: Date.now() - started,
      detail,
    });
    recordRagQueryMetric({
      path: "document_query",
      ok: false,
      ms: agentResult.latency_ms,
      reason: code,
      trace_id: traceId,
      error_code: code,
    });
    void appendAgentTraceLog({
      agent: "rag",
      path: "/api/retrieve",
      trace_id: traceId,
      ok: false,
      latency_ms: Date.now() - started,
      detail: code,
    });
    return {
      ok: false,
      query: sanitized,
      needsClarify: false,
      ms: agentResult.latency_ms,
      evidence: [],
      citations: [],
      agentResult,
      error_code: code,
    };
  } finally {
    clearRetrievalUserKey();
  }
}
