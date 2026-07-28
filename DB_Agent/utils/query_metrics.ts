/**
 * 查询路径观测：direct / generic_stats / sql_agent 命中率与空结果率。
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type QueryPath = "generic_stats" | "sql_direct" | "sql_agent" | "statistics" | "person_info" | "person_health" | "other";

export type QueryMetricEvent = {
  path: QueryPath;
  ok: boolean;
  empty?: boolean;
  ms?: number;
  reason?: string;
  question?: string;
  data_domain?: string;
  tables?: string[];
  error_code?: string;
  trace_id?: string;
};

const counters: Record<string, number> = {};
const latencySamples: number[] = [];
const MAX_LAT_SAMPLES = 400;

let lastRunContext: {
  path: QueryPath;
  question?: string;
  data_domain?: string;
  tables?: string[];
  reason?: string;
} | null = null;

export type DbRunMeta = {
  path: QueryPath | string;
  data_domain?: string;
  intent?: string;
  candidate_tables?: string[];
  primary_tables?: string[];
  route_reason?: string;
  explore_skipped?: boolean;
  sql_direct_tried?: boolean;
  needs_clarification?: boolean;
  clarification_question?: string;
  missing_slots?: string[];
  task_stack_steps?: number;
  clarification_suggestions?: string[];
  explain_preflight?: string[];
  /** 运行配置快照（前端展示，可选） */
  domain?: string;
  profile?: string;
  query_ir_used?: boolean;
  agent_fallback?: boolean;
  sql_template_direct?: boolean;
  sql_plan_direct?: boolean;
  structural_plan_used?: boolean;
  query_tier?: string;
  query_tier_source?: string;
  execution_shape?: string;
  execution_shape_source?: string;
  llm_calls?: number;
  /** P0：当次成功执行的 SQL（供产物 learning / artifact 绑定） */
  executed_sql?: string;
  /** D1：终态空结果 / 失败码（友好话术不得冲掉） */
  empty?: boolean;
  error_code?: string;
  fail_reason?: string;
  turn_scope_mode?: string;
  context_history_turns?: number;
  manager_plan_used?: boolean;
};

let lastRunMeta: DbRunMeta | null = null;
let stashedExplainPreflight: string[] | undefined;
let stashedQueryTier: { tier: string; source?: string } | null = null;

export function stashQueryTier(tier: string, source?: string) {
  stashedQueryTier = { tier: String(tier), source: source ? String(source) : undefined };
}

export function consumeQueryTier(): { tier: string; source?: string } | null {
  const v = stashedQueryTier;
  stashedQueryTier = null;
  return v;
}

export function stashExplainPreflight(insights: string[]) {
  stashedExplainPreflight = insights.length ? insights.slice(0, 4) : undefined;
}

export function consumeExplainPreflight(): string[] | undefined {
  const v = stashedExplainPreflight;
  stashedExplainPreflight = undefined;
  return v;
}

export function setRunMeta(meta: DbRunMeta | null) {
  lastRunMeta = meta;
}

export function getRunMeta() {
  return lastRunMeta;
}

function metricsFile() {
  const dir = join(process.cwd(), ".data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "db-query-metrics.jsonl");
}

export function getLastRunContext() {
  return lastRunContext;
}

export function recordQueryMetric(ev: QueryMetricEvent) {
  lastRunContext = {
    path: ev.path,
    question: ev.question,
    data_domain: ev.data_domain,
    tables: ev.tables,
    reason: ev.reason,
  };
  const keyParts = [ev.path, ev.ok ? "ok" : "fail"];
  if (ev.empty) keyParts.push("empty");
  if (ev.reason) keyParts.push(ev.reason);
  if (ev.error_code) keyParts.push(`code:${ev.error_code}`);
  const key = keyParts.join(":");
  counters[key] = (counters[key] || 0) + 1;
  if (ev.error_code) {
    counters[`error_code:${ev.error_code}`] = (counters[`error_code:${ev.error_code}`] || 0) + 1;
  }
  if (typeof ev.ms === "number" && Number.isFinite(ev.ms)) {
    latencySamples.push(Math.max(0, Math.round(ev.ms)));
    if (latencySamples.length > MAX_LAT_SAMPLES) latencySamples.shift();
  }
  try {
    const line = JSON.stringify({ ...ev, at: new Date().toISOString() });
    appendFileSync(metricsFile(), `${line}\n`, "utf8");
  } catch {
    /* 观测失败不影响主链路 */
  }
}

export function getQueryMetricCounters() {
  return { ...counters };
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

/** D2：与 Manager SLI 对齐的最小汇总 */
export function getDbSliSummary() {
  const sorted = [...latencySamples].sort((a, b) => a - b);
  const errorCodes: Record<string, number> = {};
  for (const [k, v] of Object.entries(counters)) {
    if (k.startsWith("error_code:")) errorCodes[k.slice("error_code:".length)] = v;
  }
  return {
    p95Ms: percentile(sorted, 95),
    p50Ms: percentile(sorted, 50),
    samples: sorted.length,
    errorCodes,
  };
}

export function clearQueryMetrics() {
  for (const k of Object.keys(counters)) delete counters[k];
  lastRunContext = null;
  lastRunMeta = null;
  stashedExplainPreflight = undefined;
  latencySamples.length = 0;
  try {
    writeFileSync(metricsFile(), "", "utf8");
  } catch {
    /* ignore */
  }
}
