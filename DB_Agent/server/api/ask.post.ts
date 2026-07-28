import { getDataSource } from "../../utils/db";
import {
  createConversationalRetrievalChain,
  formatChatHistory,
} from "../../utils/conversational_retrieval_chain";
import { getChatModel, getNluChatModel, getOrchestrationChatModel } from "../../utils/agent";
import { ensureRateLimit } from "../../utils/rate";
import { resolveAgentRuntimeConfig } from "../../utils/runtime";
import { getRunMeta } from "../../utils/query_metrics";
import { buildDbAgentResult } from "../utils/agent_result";
import { appendAgentTraceLog } from "../utils/trace_log";
import { ensureInternalAgentAccess } from "../utils/internal_auth";
import { applyPlatformModelOverrides } from "../utils/platform_config";
import { accumulateLlmUsage, resolveAgentUsage, type AgentUsage } from "#agent-shared/agentUsage";

export default defineEventHandler(async (event) => {
  ensureInternalAgentAccess(event);
  const started = Date.now();
  ensureRateLimit(event, { max: 40, refillPerSec: 14 });
  const body = await readBody<{
    question?: string;
    messages?: { role: string; content: string }[];
    dbId?: string;
    /** 与 manager_task_json 二选一；对象会序列化后传入链路 */
    managerTask?: Record<string, unknown>;
    manager_task_json?: string;
    session_id?: string;
    sessionId?: string;
  }>(event);

  const runtimeConfig = useRuntimeConfig(event) as any;
  let config = resolveAgentRuntimeConfig(runtimeConfig, body?.dbId);
  config = await applyPlatformModelOverrides(config);
  const ds = await getDataSource(config);
  const model = getChatModel(config);
  const nluModel = getNluChatModel(config);
  const orchestrationModel = getOrchestrationChatModel(config);

  const messages = Array.isArray(body?.messages) ? body!.messages! : null;
  const question =
    (messages?.length ? messages[messages.length - 1]?.content : body?.question) ?? "";

  if (!String(question).trim()) {
    throw createError({ statusCode: 400, statusMessage: "question 不能为空" });
  }

  const chat_history = messages?.length ? formatChatHistory(messages.slice(0, -1)) : [];

  const chain = createConversationalRetrievalChain({
    model,
    nluModel,
    largerModel: orchestrationModel,
    config,
    ds,
  });

  let capturedRunId: string | null = null;
  let llmUsageAcc: AgentUsage | undefined;
  const manager_task_json = (() => {
    if (typeof body?.manager_task_json === "string" && body.manager_task_json.trim()) return body.manager_task_json.trim();
    if (body?.managerTask && typeof body.managerTask === "object") {
      try {
        return JSON.stringify(body.managerTask);
      } catch {
        return "";
      }
    }
    return "";
  })();

  const answer = await chain.invoke(
    {
      chat_history,
      question: String(question),
      ...(manager_task_json ? { manager_task_json } : {}),
      session_id: String(body?.session_id ?? body?.sessionId ?? "").trim(),
    },
    {
      callbacks: [
        {
          handleChainStart(_chain, _inputs, runId) {
            if (!capturedRunId) capturedRunId = runId;
          },
          handleLLMStart(_llm, _prompts, runId) {
            if (!capturedRunId) capturedRunId = runId;
          },
          handleLLMEnd(output) {
            const gen = Array.isArray((output as any)?.generations)
              ? (output as any).generations?.[0]?.[0]
              : null;
            const raw =
              (output as any)?.llmOutput?.tokenUsage ??
              (output as any)?.llmOutput?.usage ??
              gen?.message?.usage_metadata ??
              gen?.usage_metadata ??
              null;
            llmUsageAcc = accumulateLlmUsage(llmUsageAcc, raw);
          },
        },
      ],
    },
  );

  if (capturedRunId) {
    try {
      event.node.res.setHeader("X-Langsmith-Run-Id", capturedRunId);
    } catch {}
  }

  const text = typeof answer === "string" ? answer : JSON.stringify(answer ?? {});
  const meta = getRunMeta();
  // D1：优先信任图终态 meta.empty / error_code（友好话术不得粉饰成功）
  const empty = meta?.needs_clarification
    ? false
    : meta?.empty === true
      ? true
      : meta?.error_code === "empty_result" || meta?.error_code === "schema_miss"
        ? true
        : (() => {
            const t = String(text || "").trim();
            if (!t) return true;
            const pats = [
              /没有查到/,
              /未查询到/,
              /无记录/,
              /暂无数据/,
              /查询结果为空/,
              /not\s+found/,
              /no\s+data/,
              /no\s+records/,
            ];
            if (pats.some((p) => p.test(t))) return true;
            if (t.length < 6) return true;
            return false;
          })();
  const reason = meta?.needs_clarification
    ? "needs_clarification"
    : meta?.fail_reason || (empty ? "no_data_or_unmatched" : "ok");
  const traceId =
    String(event.node.req.headers["x-trace-id"] ?? event.node.req.headers["x-run-id"] ?? "").trim() ||
    capturedRunId ||
    undefined;
  const latencyMs = Date.now() - started;

  const agentResult = buildDbAgentResult({
    answer: text,
    empty,
    reason,
    run_id: capturedRunId || undefined,
    trace_id: traceId,
    needs_clarification: Boolean(meta?.needs_clarification),
    clarification_question: meta?.clarification_question,
    explain_preflight: meta?.explain_preflight,
    executed_sql: meta?.executed_sql,
    error_code: meta?.error_code,
    path: meta?.path ? String(meta.path) : undefined,
    latency_ms: latencyMs,
    usage: resolveAgentUsage({ llmUsage: llmUsageAcc, answerText: text }),
  });

  void appendAgentTraceLog({
    agent: "db",
    path: "/api/ask",
    trace_id: traceId,
    ok: agentResult.ok,
    latency_ms: Date.now() - started,
    detail: reason,
  });

  return {
    answer: text,
    empty,
    reason,
    run_id: capturedRunId || undefined,
    meta: meta ?? undefined,
    needs_clarification: Boolean(meta?.needs_clarification),
    clarification_question: meta?.clarification_question,
    clarification_suggestions: meta?.clarification_suggestions,
    agentResult,
  };
});
