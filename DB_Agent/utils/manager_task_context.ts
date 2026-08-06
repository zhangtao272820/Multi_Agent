/**
 * Manager_Agent → DB_Agent 可选结构化载荷：总管拆解意图，DB 侧重 SQL 落地与安全执行。
 * turn_scope SSOT：#agent-shared/turnScope + managerSubAgentProtocol
 */
import { clipText } from "./nlu/text";
import { parseQueryPlan, type QueryPlan } from "./nlu/query_plan";
import type { SqlPreflightResult } from "./sql_preflight";
import { normalizeSqlPreflight } from "./sql_preflight";
import { assemblePlanSlotsOrNull, queryPlanReadyToSkipSlotLlm } from "./nlu/assemble_plan_slots";
import {
  parseTurnScopePayload,
  type TurnScopePayload,
} from "#agent-shared/turnScope";

export type { TurnScopePayload };

export type ManagerDbTaskContext = {
  source?: string;
  refined_question?: string;
  must_filters?: string[];
  schema_search_keywords?: string;
  sql_intent_summary?: string;
  risk_notes?: string[];
  hint_tables?: string[];
  hint_fields?: string[];
  schema_fk_hints?: string;
  query_plan_json?: string;
  prefetch_reuse?: boolean;
  prefetch_schema_ground_json?: string;
  execution_shape_hint?: string;
  answer_format_hint?: string;
  turn_scope?: TurnScopePayload;
};

function parseTurnScopeField(o: Record<string, unknown>): TurnScopePayload | undefined {
  return parseTurnScopePayload(o.turn_scope) ?? undefined;
}

export function shouldSuppressDbHistory(mgr: ManagerDbTaskContext | null | undefined): boolean {
  if (!mgr?.turn_scope) return false;
  if (mgr.turn_scope.narrow_output_followup) return false;
  return Boolean(mgr.turn_scope.suppress_history);
}

export function shouldSuppressDbExperienceReplay(mgr: ManagerDbTaskContext | null | undefined): boolean {
  return Boolean(mgr?.turn_scope?.suppress_experience_replay);
}

function dedupeStr(arr: string[], max = 24) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    const s = String(x ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function parseManagerDbTaskFromJson(raw: string | null | undefined): ManagerDbTaskContext | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
    const hint_tables = arr(o.hint_tables).slice(0, 8);
    const hint_fields = arr(o.hint_fields).slice(0, 12);
    const must_filters = arr(o.must_filters).slice(0, 12);
    const risk_notes = arr(o.risk_notes).slice(0, 8);
    const turn_scope = parseTurnScopeField(o);
    const hasAny =
      String(o.refined_question ?? "").trim() ||
      must_filters.length ||
      String(o.schema_search_keywords ?? "").trim() ||
      String(o.sql_intent_summary ?? "").trim() ||
      risk_notes.length ||
      hint_tables.length ||
      hint_fields.length ||
      String(o.schema_fk_hints ?? "").trim() ||
      String(o.query_plan_json ?? "").trim() ||
      o.prefetch_reuse === true ||
      String(o.prefetch_schema_ground_json ?? "").trim() ||
      String(o.execution_shape_hint ?? "").trim() ||
      String(o.answer_format_hint ?? "").trim() ||
      Boolean(turn_scope);
    if (!hasAny) return null;
    return {
      source: typeof o.source === "string" ? o.source : undefined,
      refined_question: String(o.refined_question ?? "").trim() || undefined,
      must_filters: must_filters.length ? must_filters : undefined,
      schema_search_keywords: String(o.schema_search_keywords ?? "").trim() || undefined,
      sql_intent_summary: String(o.sql_intent_summary ?? "").trim() || undefined,
      risk_notes: risk_notes.length ? risk_notes : undefined,
      hint_tables: hint_tables.length ? hint_tables : undefined,
      hint_fields: hint_fields.length ? hint_fields : undefined,
      schema_fk_hints: String(o.schema_fk_hints ?? "").trim() || undefined,
      query_plan_json: String(o.query_plan_json ?? "").trim() || undefined,
      prefetch_reuse: o.prefetch_reuse === true ? true : undefined,
      prefetch_schema_ground_json: String(o.prefetch_schema_ground_json ?? "").trim() || undefined,
      execution_shape_hint: String(o.execution_shape_hint ?? "").trim() || undefined,
      answer_format_hint: String(o.answer_format_hint ?? "").trim() || undefined,
      turn_scope,
    };
  } catch {
    return null;
  }
}

function managerRefinedQuestionTooNarrow(shortQ: string, fullQ: string): boolean {
  const s = String(shortQ ?? "").trim();
  const f = String(fullQ ?? "").trim();
  if (!s || !f || s.length >= f.length) return false;
  if (f.includes(s) && f.length > s.length) return true;
  return f.length >= s.length + 8;
}

export function resolveManagerStandaloneQuestion(
  rawQuestion: string,
  mgr: ManagerDbTaskContext | null | undefined,
): string {
  const raw = String(rawQuestion ?? "").trim();
  const refined = String(mgr?.refined_question ?? "").trim();
  if (!refined) return raw;
  if (!raw) return refined;
  if (managerRefinedQuestionTooNarrow(refined, raw)) return raw;
  if (raw.length >= refined.length) return raw;
  return refined;
}

/**
 * 总管已产出且过 assemblePlanSlots 的 query_plan。
 * 稀疏 stub（空地区/年龄/维度）不算完备，调用方不得据此跳过 Slot LLM。
 */
export function resolveManagerAssembledQueryPlan(
  mgr: ManagerDbTaskContext | null | undefined,
): QueryPlan | null {
  if (mgr?.source !== "manager") return null;
  const raw = String(mgr.query_plan_json ?? "").trim();
  if (!raw) return null;
  return assemblePlanSlotsOrNull(parseQueryPlan(raw));
}

export function shouldUseManagerAssembledQueryPlan(
  mgr: ManagerDbTaskContext | null | undefined,
): boolean {
  const plan = resolveManagerAssembledQueryPlan(mgr);
  return plan != null && queryPlanReadyToSkipSlotLlm(plan);
}

export { queryPlanReadyToSkipSlotLlm };

/**
 * 仅当总管 query_plan 槽位足以独立执行时才跳过 DB plan LLM。
 * 空 metrics/dimensions 的 detail/aggregation stub（常见于旧版预取伪造）不得短路 NLU。
 */
export function shouldPreferManagerQueryPlan(mgr: ManagerDbTaskContext | null | undefined): boolean {
  if (!mgr?.query_plan_json?.trim()) return false;
  // query_plan 复用与 prefetch_reuse（表锁）解耦：omit 场景可跳过 plan LLM 而不锁表
  const p = parseQueryPlan(mgr.query_plan_json);
  const hasNames = (p.entities?.names?.length ?? 0) > 0;
  const hasIds = (p.entities?.ids?.length ?? 0) > 0;
  const hasLocations = (p.entities?.locations?.length ?? 0) > 0;
  const hasWhere = (p.filters?.where?.length ?? 0) > 0;
  const hasMetrics = (p.metrics?.length ?? 0) > 0;
  const hasDimensions = (p.dimensions?.length ?? 0) > 0;
  const hasAnalysisSlots = hasMetrics || hasDimensions;
  const hasEntitySlots = hasNames || hasIds || hasLocations || hasWhere;
  if (!hasEntitySlots && !hasAnalysisSlots) return false;
  if (p.intent === "aggregation" || p.intent === "trend" || p.intent === "comparison") {
    return hasAnalysisSlots;
  }
  if (p.intent === "detail") {
    return hasNames || hasIds || hasWhere;
  }
  if (p.intent === "unknown") return hasNames || hasWhere || hasAnalysisSlots;
  return hasEntitySlots || hasAnalysisSlots;
}

/** Call-Fusion：总管已 scoped refined_question 时跳过 monolithic plan LLM */
export function shouldSkipMonolithicPlanLlmForManager(
  mgr: ManagerDbTaskContext | null | undefined,
): boolean {
  if (mgr?.source !== "manager") return false;
  return String(mgr.refined_question ?? "").trim().length >= 4;
}

export function mergeManagerConstraintsIntoPlan(mgr: ManagerDbTaskContext | null | undefined, plan: QueryPlan): QueryPlan {
  if (!mgr) return plan;
  const where = dedupeStr([...(mgr.must_filters ?? []), ...(plan.filters?.where ?? [])], 24);
  return {
    ...plan,
    filters: {
      ...plan.filters,
      time_range: plan.filters?.time_range ?? { start: "", end: "", relative: "" },
      where,
      slots: [...(plan.filters?.slots ?? [])],
    },
  };
}

export function mergeManagerIntoPreflight(
  mgr: ManagerDbTaskContext | null | undefined,
  pre: SqlPreflightResult,
  fallbackQuestion: string,
): SqlPreflightResult {
  if (!mgr) return pre;
  const must = dedupeStr([...(mgr.must_filters ?? []), ...pre.must_filters], 16);
  const risks = dedupeStr([...(mgr.risk_notes ?? []), ...pre.risk_notes], 10);
  const mkw = String(mgr.schema_search_keywords ?? "").trim();
  let kw = String(pre.schema_search_keywords ?? "").trim();
  if (mkw) kw = clipText(`${mkw} ${kw}`.replace(/\s+/g, " ").trim(), 220);
  let refined = String(pre.refined_question ?? "").trim() || String(mgr.refined_question ?? "").trim() || fallbackQuestion;
  const mr = String(mgr.refined_question ?? "").trim();
  if (mr && (mr.length > refined.length + 8 || (mr.length >= 12 && !refined.includes(mr.slice(0, Math.min(8, mr.length)))))) {
    refined = mr;
  }
  const summary = [String(pre.sql_intent_summary ?? "").trim(), String(mgr.sql_intent_summary ?? "").trim()]
    .filter(Boolean)
    .join("；");
  const merged: SqlPreflightResult = {
    refined_question: refined,
    schema_search_keywords: kw || pre.schema_search_keywords,
    sql_intent_summary: clipText(summary, 200),
    must_filters: must,
    risk_notes: risks,
  };
  return normalizeSqlPreflight(merged, fallbackQuestion);
}

export function formatManagerContextBlob(mgr: ManagerDbTaskContext | null | undefined): string {
  if (!mgr) return "";
  return [
    mgr.schema_search_keywords,
    ...(mgr.hint_tables ?? []),
    ...(mgr.hint_fields ?? []),
    ...(mgr.must_filters ?? []),
  ]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

export function formatManagerTaskBlockForAgent(mgr: ManagerDbTaskContext | null | undefined): string {
  if (!mgr) return "";
  const lines: string[] = [];
  lines.push("[总管任务约束]（由上层编排传入；编写 SQL 须落实；勿在最终答复中复述本段标题）");
  if (mgr.sql_intent_summary?.trim()) lines.push(`意图摘要：${mgr.sql_intent_summary.trim()}`);
  if ((mgr.must_filters?.length ?? 0) > 0) lines.push(`必须条件：\n- ${mgr.must_filters!.join("\n- ")}`);
  if ((mgr.hint_tables?.length ?? 0) > 0) lines.push(`表线索（须以实际 schema 为准）：${mgr.hint_tables!.join("、")}`);
  if ((mgr.hint_fields?.length ?? 0) > 0) lines.push(`字段线索：${mgr.hint_fields!.join("、")}`);
  if (mgr.schema_fk_hints?.trim()) lines.push(mgr.schema_fk_hints.trim());
  if (mgr.schema_search_keywords?.trim()) lines.push(`检索补充词：${mgr.schema_search_keywords.trim()}`);
  if ((mgr.risk_notes?.length ?? 0) > 0) lines.push(`风险提示：\n- ${mgr.risk_notes!.join("\n- ")}`);
  return clipText(lines.join("\n"), 900);
}

export function executionShapeFromManagerTask(
  mgr: ManagerDbTaskContext | null | undefined,
): import("./nlu/dbQueryExecutionShapeLlm").QueryExecutionShape | null {
  const raw = String(mgr?.execution_shape_hint ?? "").trim();
  if (!raw) return null;
  const allowed = new Set([
    "scalar_lookup",
    "distribution",
    "trend",
    "detail_rows",
    "comparison",
    "freeform_sql",
  ]);
  return allowed.has(raw) ? (raw as import("./nlu/dbQueryExecutionShapeLlm").QueryExecutionShape) : null;
}
