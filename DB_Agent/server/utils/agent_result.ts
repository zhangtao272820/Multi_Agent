export type AgentSource = {
  type: "url" | "doc" | "table" | "sql";
  ref: string;
};

/** D1：ask/plan 标准失败码（细码；总管 normalize 可映射到 ExpertErrorCode） */
export type DbErrorCode =
  | "timeout"
  | "schema_miss"
  | "empty_result"
  | "business"
  | "needs_clarify";

export type AgentResult = {
  ok: boolean;
  agent: string;
  trace_id?: string;
  answer?: string;
  sources?: AgentSource[];
  structured?: Record<string, unknown>;
  needs_clarify?: boolean;
  clarify_questions?: string[];
  error_code?: string;
  latency_ms?: number;
  /** G1：提供商或估算用量，供总管 runBudget */
  usage?: { tokens?: number; usd?: number; actual?: boolean };
};

/** 从 fail reason / path 映射标准码；禁止把空结果粉饰成成功。 */
export function resolveDbErrorCode(input: {
  empty?: boolean;
  needs_clarification?: boolean;
  fail_reason?: string;
  path?: string;
}): DbErrorCode | undefined {
  if (input.needs_clarification) return "needs_clarify";
  const reason = String(input.fail_reason || "").trim().toLowerCase();
  if (reason.includes("timeout") || reason.includes("timed_out") || reason.includes("aborted")) {
    return "timeout";
  }
  if (
    reason === "no_schema_ground" ||
    reason === "no_schema" ||
    reason.includes("schema_miss") ||
    reason.includes("schema")
  ) {
    return "schema_miss";
  }
  if (
    input.empty ||
    reason === "empty_result" ||
    reason === "empty_result_named" ||
    reason === "no_data_or_unmatched" ||
    reason === "empty_or_weak_answer" ||
    reason.includes("empty")
  ) {
    return "empty_result";
  }
  if (reason && reason !== "ok") return "business";
  return undefined;
}

export function buildDbAgentResult(params: {
  answer: string;
  empty: boolean;
  reason: string;
  run_id?: string;
  trace_id?: string;
  needs_clarification?: boolean;
  clarification_question?: string;
  explain_preflight?: string[];
  executed_sql?: string;
  /** 显式失败码；缺省时由 empty/reason 推导 */
  error_code?: DbErrorCode | string;
  path?: string;
  latency_ms?: number;
  usage?: { tokens?: number; usd?: number; actual?: boolean };
  evolutionApplied?: {
    promptPatches?: Array<{ id?: string; stage?: string; hits?: number }> | number;
    experienceHits?: number;
    banditArm?: string;
  };
}): AgentResult {
  const sources: AgentSource[] = [];
  if (params.run_id) sources.push({ type: "sql", ref: params.run_id });
  const needsClarify = Boolean(params.needs_clarification);
  const error_code =
    params.error_code ||
    resolveDbErrorCode({
      empty: params.empty,
      needs_clarification: needsClarify,
      fail_reason: params.reason,
      path: params.path,
    });
  const failed = params.empty || needsClarify || Boolean(error_code);
  return {
    ok: !failed,
    agent: "db",
    trace_id: params.trace_id,
    answer: params.answer,
    sources: sources.length ? sources : undefined,
    structured: {
      empty: params.empty,
      reason: params.reason,
      run_id: params.run_id,
      ...(params.path ? { path: params.path } : {}),
      ...(error_code ? { error_code } : {}),
      ...(params.executed_sql ? { executed_sql: params.executed_sql } : {}),
      ...(params.explain_preflight?.length ? { explain_preflight: params.explain_preflight } : {}),
      ...(params.evolutionApplied
        ? {
            evolutionApplied: {
              promptPatches: params.evolutionApplied.promptPatches ?? 0,
              experienceHits: Math.max(0, Math.floor(Number(params.evolutionApplied.experienceHits) || 0)),
              ...(params.evolutionApplied.banditArm
                ? { banditArm: String(params.evolutionApplied.banditArm).slice(0, 64) }
                : {}),
            },
          }
        : {}),
    },
    needs_clarify: needsClarify,
    clarify_questions: needsClarify && params.clarification_question ? [params.clarification_question] : undefined,
    error_code: error_code || undefined,
    latency_ms: params.latency_ms,
    ...(params.usage ? { usage: params.usage } : {}),
  };
}
