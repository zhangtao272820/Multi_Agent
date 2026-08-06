/**
 * person_info 带地区/年龄筛选的确定性统计（Plan-only，LLM-First）。
 * 只读 assemble 后的 QueryPlan 槽位；禁止问句 regex 补槽。
 */
import type { DataSource } from "typeorm";
import type { QueryPlan } from "../nlu/query_plan";
import {
  inferExecutionShapeStructural,
  isFilteredPersonDistributionPlan,
  isRegionPopulationCountPlan,
  type QueryExecutionShape,
} from "../nlu/dbQueryExecutionShapeLlm";
import type { PlanCompletenessResult } from "../nlu/dbPlanCompletenessLlm";
import { getDomainTable } from "../domain_patch";
import { sanitizeAssistantText } from "../text";

export type PersonInfoStatFilters = {
  regionLike?: string;
  ageGte?: number;
  ageLte?: number;
};

function slotValue(plan: QueryPlan | null | undefined, hint: string): string {
  const h = hint.toLowerCase();
  const hit = plan?.filters?.slots?.find((s) => String(s.field_hint ?? "").toLowerCase().includes(h));
  return String(hit?.sql_match_value || hit?.value || "").trim();
}

function regionFromPlan(plan?: QueryPlan | null): string | undefined {
  if (!plan) return undefined;
  const fromSlot = slotValue(plan, "region") || slotValue(plan, "location");
  if (fromSlot) return fromSlot;
  const loc = (plan.entities?.locations ?? []).map((x) => String(x ?? "").trim()).find((x) => x.length >= 2);
  if (loc) return loc;
  // where/metrics 中的行政区划（读 Plan 字段）
  for (const w of [...(plan.filters?.where ?? []), ...(plan.metrics ?? [])]) {
    const m = String(w ?? "").match(/([\u4e00-\u9fff]{2,10}(?:区|市|县|省))/);
    if (m?.[1] && !/(?:数据库|查询|统计)/.test(m[1])) return m[1];
  }
  return undefined;
}

function ageRangeFromText(raw: string): { gte?: number; lte?: number } | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const range = t.match(/(\d{1,3})\s*[-~到至]\s*(\d{1,3})/);
  if (range) {
    const gte = Number(range[1]);
    const lte = Number(range[2]);
    if (Number.isFinite(gte) && Number.isFinite(lte) && gte <= lte) return { gte, lte };
  }
  return null;
}

function ageFromPlan(plan?: QueryPlan | null): { gte?: number; lte?: number } {
  const gteRaw = slotValue(plan ?? null, "age_gte") || slotValue(plan ?? null, "age");
  const lteRaw = slotValue(plan ?? null, "age_lte");
  const out: { gte?: number; lte?: number } = {};
  const fromSlot = ageRangeFromText(gteRaw);
  if (fromSlot) return fromSlot;
  const gte = Number(String(gteRaw).replace(/[^\d]/g, ""));
  const lte = Number(String(lteRaw).replace(/[^\d]/g, ""));
  if (Number.isFinite(gte) && gte > 0) out.gte = gte;
  if (Number.isFinite(lte) && lte > 0) out.lte = lte;
  if (out.gte != null || out.lte != null) return out;

  // 任意 slot 值中的年龄区间（field_hint 可能漏写成其它）
  for (const s of plan?.filters?.slots ?? []) {
    const hit = ageRangeFromText(`${s.value ?? ""} ${s.sql_match_value ?? ""}`);
    if (hit) return hit;
  }
  // 从 plan.where / metrics 结构化区间文本读取（非用户原话路由）
  for (const w of [...(plan?.filters?.where ?? []), ...(plan?.metrics ?? []), ...(plan?.dimensions ?? [])]) {
    const hit = ageRangeFromText(String(w));
    if (hit) return hit;
  }
  return out;
}

/** 计划是否显式指向「性别」维度（读 dimensions / gender 槽，非 metrics blob 关键词） */
function planMentionsGender(plan?: QueryPlan | null): boolean {
  if (!plan) return false;
  if ((plan.dimensions ?? []).some((d) => String(d).includes("性别"))) return true;
  return Boolean(
    plan.filters?.slots?.some((s) => {
      const h = String(s.field_hint ?? "").toLowerCase();
      return h.includes("gender") || h.includes("is_gender");
    }),
  );
}

function wantsPersonCount(plan?: QueryPlan | null): boolean {
  if (!plan || plan.intent !== "aggregation") return false;
  const shape = inferExecutionShapeStructural(plan)?.shape;
  if (shape === "scalar_lookup") return true;
  const dims = plan.dimensions?.length ?? 0;
  const metrics = plan.metrics?.filter(Boolean).length ?? 0;
  return metrics > 0 && dims === 0;
}

function wantsPersonGenderDistribution(
  plan?: QueryPlan | null,
  executionShape?: QueryExecutionShape | string | null,
): boolean {
  if (!plan) return false;
  if ((plan.entities?.names?.length ?? 0) > 0) return false;
  if (planMentionsGender(plan)) return true;
  // Plan 已是带过滤的人口分布 → 走人员主表确定性聚合，避免掉进可能漏槽位的自由 SQL
  if (isFilteredPersonDistributionPlan(plan) && parsePersonStatFilters(plan) != null) return true;
  // 执行形态已是 distribution 且已有人员过滤槽 → person_info 默认按性别聚合（避免明细列表）
  if (executionShape === "distribution" && parsePersonStatFilters(plan) != null) return true;
  if (executionShape === "distribution" && isFilteredPersonDistributionPlan(plan)) return true;
  const shape = inferExecutionShapeStructural(plan)?.shape;
  return shape === "distribution" && isFilteredPersonDistributionPlan(plan);
}

function wantsRegionPopulationCount(plan: QueryPlan | null | undefined, filters: PersonInfoStatFilters): boolean {
  if (!filters.regionLike || !plan) return false;
  if ((plan.entities?.names?.length ?? 0) > 0) return false;
  if (planMentionsGender(plan)) return false;
  return isRegionPopulationCountPlan(plan);
}

function isPersonDomain(plan?: QueryPlan | null, regionLike?: string, age?: { gte?: number; lte?: number }): boolean {
  if (!plan) return false;
  return (
    plan.subject === "person" ||
    plan.data_domain === "person_basic" ||
    Boolean(regionLike) ||
    age?.gte != null ||
    age?.lte != null
  );
}

/** 从 QueryPlan 提取 person_info 筛选（仅 Plan 槽位） */
export function parsePersonStatFilters(plan?: QueryPlan | null): PersonInfoStatFilters | null {
  if (!plan || (plan.confidence > 0 && plan.confidence < 0.5)) return null;

  const regionLike = regionFromPlan(plan);
  const age = ageFromPlan(plan);

  if (!isPersonDomain(plan, regionLike, age)) return null;

  const filters: PersonInfoStatFilters = {};
  if (regionLike) filters.regionLike = regionLike;
  if (age.gte != null) filters.ageGte = age.gte;
  if (age.lte != null) filters.ageLte = age.lte;

  if (!filters.regionLike && filters.ageGte == null && filters.ageLte == null) return null;
  return filters;
}

function buildPersonWhere(filters: PersonInfoStatFilters): { clause: string; values: unknown[] } {
  const parts = ["deleted = 0"];
  const values: unknown[] = [];
  if (filters.regionLike) {
    parts.push("(provinces_and_cities LIKE ? OR address LIKE ?)");
    const like = `%${filters.regionLike}%`;
    values.push(like, like);
  }
  if (filters.ageGte != null) {
    parts.push("age >= ?");
    values.push(filters.ageGte);
  }
  if (filters.ageLte != null) {
    parts.push("age <= ?");
    values.push(filters.ageLte);
  }
  return { clause: parts.join(" AND "), values };
}

/** 是否可走 person_info 域内确定性统计（供路由 / sql_direct 入口判断） */
export function personInfoStatsEligible(plan?: QueryPlan | null): boolean {
  return parsePersonStatFilters(plan) != null;
}

/** person_info 带筛选的计数/性别分布；失败返回 null 交 sql_direct */
export async function tryPersonInfoFilteredStats(
  ds: DataSource,
  plan?: QueryPlan | null,
  executionShape?: QueryExecutionShape | string | null,
  completeness?: PlanCompletenessResult | null,
): Promise<string | null> {
  // 完备门明确禁止快路径 → 回退 schema SQL
  if (completeness && !completeness.allow_person_fast_path) return null;

  const filters = parsePersonStatFilters(plan);
  if (!filters) return null;

  // 完备门标出缺槽且对应 filter 仍空 → 拒答假数
  const missing = new Set((completeness?.missing_slots ?? []).map((s) => s.toLowerCase()));
  if (
    (missing.has("age_gte") || missing.has("age_lte") || missing.has("age") || missing.has("age_range")) &&
    filters.ageGte == null &&
    filters.ageLte == null
  ) {
    return null;
  }
  if ((missing.has("region") || missing.has("location")) && !filters.regionLike) {
    return null;
  }

  const tPerson = getDomainTable("person_info", "person_info");
  const { clause, values } = buildPersonWhere(filters);

  if (wantsPersonGenderDistribution(plan, executionShape)) {
    const sql = `
SELECT
  CASE
    WHEN is_gender = 1 THEN '男'
    WHEN is_gender = 2 THEN '女'
    ELSE '未知'
  END AS gender,
  COUNT(*) AS count
FROM ${tPerson}
WHERE ${clause}
GROUP BY gender
ORDER BY count DESC`;
    const rows = (await ds.query(sql, values)) as Array<{ gender?: string; count?: number }>;
    if (!Array.isArray(rows) || rows.length === 0) {
      return sanitizeAssistantText("按当前条件未查到人员性别分布数据。");
    }
    const prefix = filters.regionLike ? `${filters.regionLike} ` : "";
    const lines = [`${prefix}人员性别分布（表 ${tPerson}）：`];
    for (const r of rows) lines.push(`- ${r.gender ?? "未知"}：${r.count ?? 0}`);
    return sanitizeAssistantText(lines.join("\n"));
  }

  if (wantsPersonCount(plan) || wantsRegionPopulationCount(plan, filters)) {
    const sql = `SELECT COUNT(*) AS count FROM ${tPerson} WHERE ${clause}`;
    const rows = (await ds.query(sql, values)) as Array<{ count?: number }>;
    const n = rows?.[0]?.count ?? 0;
    const prefix = filters.regionLike ? `${filters.regionLike} ` : "";
    return sanitizeAssistantText(`${prefix}人数：${n}`);
  }

  return null;
}

/** sql_direct / graph 统一入口：Plan 合格则执行 person_info 快路径 */
export async function runPersonInfoStatsFastPath(
  ds: DataSource,
  plan?: QueryPlan | null,
  executionShape?: QueryExecutionShape | string | null,
  completeness?: PlanCompletenessResult | null,
): Promise<string | null> {
  if (!personInfoStatsEligible(plan)) return null;
  return tryPersonInfoFilteredStats(ds, plan, executionShape, completeness);
}
