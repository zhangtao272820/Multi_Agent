export type AgentSource = {
  type: "url" | "doc" | "table" | "sql";
  ref: string;
};

/** R3：标准失败码（细码；总管 normalize 映射 ExpertErrorCode） */
export type RagErrorCode =
  | "vector_not_ready"
  | "timeout"
  | "empty_result"
  | "needs_clarify"
  | "business";

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

type EvidenceRow = { source?: string; content?: string; ingest_at?: string; source_version?: string };

export function buildRagAgentResult(params: {
  query: string;
  needsClarify?: boolean;
  ms?: number;
  evidence?: EvidenceRow[];
  trace_id?: string;
  /** 显式失败码（向量未就绪 / 超时优先于空证据） */
  error_code?: RagErrorCode | string;
  detail?: string;
  usage?: { tokens?: number; usd?: number; actual?: boolean };
}): AgentResult {
  const sources: AgentSource[] = [];
  const citations: Array<Record<string, string>> = [];
  for (const row of params.evidence || []) {
    const ref = String(row?.source || "").trim();
    if (ref) sources.push({ type: "doc", ref });
    citations.push({
      source: ref,
      ...(row?.ingest_at ? { ingest_at: String(row.ingest_at) } : {}),
      ...(row?.source_version ? { source_version: String(row.source_version) } : {}),
    });
  }
  const needsClarify = Boolean(params.needsClarify);
  const explicit = String(params.error_code || "").trim();
  let error_code: string | undefined = explicit || undefined;
  if (!error_code) {
    if (needsClarify) error_code = "needs_clarify";
    else if (!sources.length) error_code = "empty_result";
  }
  const failed =
    Boolean(error_code) &&
    (error_code === "vector_not_ready" ||
      error_code === "timeout" ||
      error_code === "business" ||
      needsClarify ||
      !sources.length);
  return {
    ok: !failed,
    agent: "rag",
    trace_id: params.trace_id,
    answer: params.query,
    sources: sources.length ? sources : undefined,
    structured: {
      content_trust: "untrusted",
      content_trust_source: "rag",
      evidence_count: params.evidence?.length ?? 0,
      ms: params.ms,
      citations: citations.length ? citations : undefined,
      ...(params.detail ? { detail: params.detail } : {}),
      ...(error_code ? { error_code } : {}),
    },
    needs_clarify: needsClarify,
    error_code,
    latency_ms: params.ms,
    ...(params.usage ? { usage: params.usage } : {}),
  };
}

/** 失败专用：向量未就绪 / 超时等，勿伪装成空证据澄清 */
export function buildRagFailureResult(params: {
  error_code: RagErrorCode;
  query?: string;
  trace_id?: string;
  ms?: number;
  detail?: string;
}): AgentResult {
  return {
    ok: false,
    agent: "rag",
    trace_id: params.trace_id,
    answer: params.query || "",
    structured: {
      content_trust: "untrusted",
      content_trust_source: "rag",
      evidence_count: 0,
      ms: params.ms,
      error_code: params.error_code,
      ...(params.detail ? { detail: params.detail } : {}),
    },
    error_code: params.error_code,
    latency_ms: params.ms,
  };
}
