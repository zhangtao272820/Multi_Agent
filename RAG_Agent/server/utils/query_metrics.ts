/**
 * RAG 检索与回答路径观测（进程内计数 + .data 落盘）。
 * R2：trace_id + 拒答率 / 空证据率 / retrieve P95 汇总。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

export type RagQueryPath =
  | "document_query"
  | "document_list"
  | "document_upload"
  | "direct_answer"
  | "clarify";

export type RagQueryMetricEvent = {
  path: RagQueryPath;
  ok: boolean;
  weak_evidence?: boolean;
  ms?: number;
  question?: string;
  intent?: string;
  sub_query_count?: number;
  routing_mode?: string;
  reason?: string;
  agentic_rounds?: number;
  rerank_mode?: string;
  ab_variant?: string;
  bandit_arm?: string;
  /** R2 */
  trace_id?: string;
  error_code?: string;
  refused?: boolean;
  empty_evidence?: boolean;
};

const counters: Record<string, number> = {};
const retrieveMsSamples: number[] = [];
const MAX_MS_SAMPLES = 500;

function metricsFile() {
  const dir = join(process.cwd(), ".data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "rag-query-metrics.jsonl");
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function recordRagQueryMetric(ev: RagQueryMetricEvent) {
  const key = `${ev.path}:${ev.ok ? "ok" : "fail"}${ev.weak_evidence ? ":weak" : ""}${
    ev.error_code ? `:${ev.error_code}` : ""
  }`;
  counters[key] = (counters[key] || 0) + 1;
  if (ev.refused) counters["sli:refused"] = (counters["sli:refused"] || 0) + 1;
  if (ev.empty_evidence) counters["sli:empty_evidence"] = (counters["sli:empty_evidence"] || 0) + 1;
  counters["sli:total"] = (counters["sli:total"] || 0) + 1;
  if (ev.path === "document_query" && typeof ev.ms === "number" && Number.isFinite(ev.ms)) {
    retrieveMsSamples.push(Math.max(0, Math.round(ev.ms)));
    if (retrieveMsSamples.length > MAX_MS_SAMPLES) retrieveMsSamples.shift();
  }
  try {
    const line = JSON.stringify({ ...ev, at: new Date().toISOString() });
    appendFileSync(metricsFile(), `${line}\n`, "utf8");
  } catch {
    /* 观测失败不影响主链路 */
  }
}

export function getRagQueryMetricCounters() {
  return { ...counters };
}

/** R2 汇总：拒答率 / 空证据率 / retrieve P95 */
export function getRagSliSummary() {
  const total = counters["sli:total"] || 0;
  const refused = counters["sli:refused"] || 0;
  const empty = counters["sli:empty_evidence"] || 0;
  const sorted = [...retrieveMsSamples].sort((a, b) => a - b);
  return {
    sampleCount: total,
    refusalRate: total > 0 ? refused / total : 0,
    emptyEvidenceRate: total > 0 ? empty / total : 0,
    retrieveP95Ms: percentile(sorted, 95),
    retrieveP50Ms: percentile(sorted, 50),
    retrieveSamples: sorted.length,
  };
}

export function readRecentRagMetrics(limit = 50): RagQueryMetricEvent[] {
  try {
    const file = metricsFile();
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as RagQueryMetricEvent;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as RagQueryMetricEvent[];
  } catch {
    return [];
  }
}
