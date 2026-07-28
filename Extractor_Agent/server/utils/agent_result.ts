import { inferCrawlerFailureTags, inferCrawlerRouteSuggestion } from "./crawl_route_suggestion";

export type AgentSource = {
  type: "url" | "doc" | "table" | "sql";
  ref: string;
};

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
};

type CrawlItem = Record<string, unknown>;

export function buildCrawlerAgentResult(params: {
  items?: CrawlItem[];
  outputContent?: string;
  status?: string;
  trace_id?: string;
  latency_ms?: number;
  serp_fallback?: boolean;
  clarifyReason?: string;
  stats?: Record<string, unknown>;
  taskPlan?: { needsLogin?: boolean; preferredChannel?: string };
  lastError?: string;
  meta?: Record<string, unknown>;
  failureTags?: string[];
  planNeedsLogin?: boolean;
}): AgentResult {
  const sources: AgentSource[] = [];
  const seen = new Set<string>();
  for (const item of params.items || []) {
    const url = String(item?.url ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ type: "url", ref: url });
  }
  const answer = String(params.outputContent || "").trim();
  const itemCount = params.items?.length ?? 0;
  const routeSuggestion = inferCrawlerRouteSuggestion({
    status: params.status,
    clarifyReason: params.clarifyReason,
    itemCount,
    stats: params.stats,
    taskPlan: params.taskPlan,
    lastError: params.lastError,
    failureTags: params.failureTags ?? (Array.isArray(params.meta?.failure_tags) ? (params.meta!.failure_tags as string[]) : undefined),
    planNeedsLogin: params.planNeedsLogin,
  });
  const failureTags = inferCrawlerFailureTags({
    status: params.status,
    clarifyReason: params.clarifyReason,
    itemCount,
    stats: params.stats,
    taskPlan: params.taskPlan,
    lastError: params.lastError,
    failureTags: params.failureTags,
    planNeedsLogin: params.planNeedsLogin,
  });
  const ok =
    String(params.status || "").toLowerCase() === "ok" ||
    sources.length > 0 ||
    Boolean(answer);
  const needsClarify =
    String(params.status || "").toLowerCase() === "needs_clarification" ||
    (!ok && itemCount === 0 && !answer);
  return {
    ok,
    agent: "crawler",
    trace_id: params.trace_id,
    answer: answer || undefined,
    sources: sources.length ? sources : undefined,
    structured: {
      content_trust: "untrusted",
      content_trust_source: "crawler",
      itemCount,
      status: params.status,
      ...(params.serp_fallback ? { serp_fallback: true } : {}),
      ...(params.meta?.seed_first ? { seed_first: true } : {}),
      ...(params.meta?.manager_seed_count != null
        ? { manager_seed_count: params.meta.manager_seed_count }
        : {}),
      ...(params.meta?.cloud_scrape_calls != null
        ? { cloud_scrape_calls: params.meta.cloud_scrape_calls }
        : {}),
      ...(params.meta?.extract_path ? { extract_path: params.meta.extract_path } : {}),
      ...(params.meta?.llm_extract_calls != null ? { llm_extract_calls: params.meta.llm_extract_calls } : {}),
      ...(params.meta?.template_hit ? { template_hit: true } : {}),
      ...(params.meta?.patch_hit ? { patch_hit: true, patch_id: params.meta.patch_id } : {}),
      ...(routeSuggestion ? { route_suggestion: routeSuggestion } : {}),
      ...(failureTags.length ? { failure_tags: failureTags } : {}),
      ...(params.stats?.cloud_scrape_calls != null
        ? { cloud_scrape_calls: params.stats.cloud_scrape_calls }
        : {}),
      ...(params.stats?.manager_seed_count != null
        ? { manager_seed_count: params.stats.manager_seed_count }
        : {}),
      preview: (params.items || []).slice(0, 3).map((it) => ({
        title: String(it?.title ?? "").slice(0, 120),
        url: String(it?.url ?? "").slice(0, 512),
        excerpt: String(it?.excerpt ?? it?.summary ?? "").slice(0, 200),
      })),
    },
    needs_clarify: needsClarify || undefined,
    error_code: ok ? undefined : routeSuggestion === "gui" ? "route_gui_suggested" : "empty_result",
    latency_ms: params.latency_ms,
  };
}
