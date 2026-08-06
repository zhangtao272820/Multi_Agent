/**
 * SQL 与查询计划 / 选表结论的对齐校验（通用，不绑定具体业务表）。
 */
import type { QueryPlan } from "./nlu/query_plan";
import type { SqlPreflightResult } from "./sql_preflight";
import type { SchemaTableJudgeResult } from "./schema_table_judge";
import { planWantsTableExtension, tableCommentLooksLikeExtensionDetail } from "./schema_relations";

export function guessTablesFromSql(sql: string): string[] {
  const out: string[] = [];
  const re = /\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/gi;
  let m: RegExpExecArray | null = null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(String(sql ?? "")))) {
    const t = String(m[1] ?? "").trim();
    if (t) out.push(t);
  }
  return Array.from(new Set(out));
}

/** 从查询计划与 preflight 汇总必须在 SQL 中体现的人员姓名 */
export function collectRequiredPersonNames(
  plan?: QueryPlan | null,
  preflight?: SqlPreflightResult | null,
): string[] {
  const names = new Set<string>();
  for (const n of plan?.entities?.names ?? []) {
    const s = String(n ?? "").trim();
    if (s.length >= 2) names.add(s);
  }
  for (const f of preflight?.must_filters ?? []) {
    const s = String(f ?? "").trim();
    if (!s) continue;
    for (const n of names) {
      if (s.includes(n)) continue;
    }
    const nameIdx = s.indexOf("姓名");
    if (nameIdx >= 0) {
      const tail = s
        .slice(nameIdx)
        .replace(/^人员姓名|^姓名/g, "")
        .replace(/^[=:：\s]+/, "")
        .trim();
      const token = tail.split(/[，,；;\s]/)[0]?.trim() ?? "";
      if (token.length >= 2 && token.length <= 12) names.add(token);
    } else if (/^[\u4e00-\u9fa5]{2,12}$/.test(s)) {
      names.add(s);
    }
  }
  return [...names];
}

export function sqlMissingRequiredPersonNames(sql: string, names: string[]): boolean {
  if (!names.length) return false;
  const s = String(sql ?? "");
  if (!s.trim()) return true;
  return names.some((n) => !s.includes(n));
}

/** 从查询计划汇总必须在 SQL 中体现的行政区划（纯区划名，避免漏 region 变成全市人数） */
export function collectRequiredRegions(
  plan?: QueryPlan | null,
  preflight?: SqlPreflightResult | null,
): string[] {
  const regions = new Set<string>();
  const push = (raw: string) => {
    const s = String(raw ?? "").trim();
    if (s.length < 2) return;
    const m = s.match(/([\u4e00-\u9fff]{2,10}(?:区|市|县|省))/);
    if (m?.[1]) {
      regions.add(m[1]);
      return;
    }
    if (/^[\u4e00-\u9fff]{2,12}$/.test(s)) regions.add(s);
  };
  for (const loc of plan?.entities?.locations ?? []) push(String(loc ?? ""));
  for (const slot of plan?.filters?.slots ?? []) {
    const h = String(slot.field_hint ?? "").toLowerCase();
    if (!(h.includes("region") || h.includes("location") || h.includes("address"))) continue;
    push(String(slot.sql_match_value || slot.value || ""));
  }
  for (const f of preflight?.must_filters ?? []) {
    const s = String(f ?? "");
    if (!s) continue;
    if (/地区|区域|区划|住址|地址/.test(s) || /区|市|县|省/.test(s)) push(s);
  }
  return [...regions];
}

export function sqlMissingRequiredRegions(sql: string, regions: string[]): boolean {
  if (!regions.length) return false;
  const s = String(sql ?? "");
  if (!s.trim()) return true;
  return regions.some((r) => !s.includes(r));
}

export type SqlPlanGuardResult = { ok: true } | { ok: false; reason: string; hint: string };

/** 附属表不得单独作为 FROM；未请求扩展维度时不得 JOIN 附属表 */
export function validateSqlAgainstSchemaJudge(
  sql: string,
  judge?: SchemaTableJudgeResult | null,
  queryPlan?: QueryPlan | null,
  tableComments?: Record<string, string>,
): SqlPlanGuardResult {
  if (!judge) return { ok: true };
  const tables = guessTablesFromSql(sql);
  const primary = new Set(judge.primary_tables ?? []);
  const auxiliary = new Set(judge.auxiliary_tables ?? []);
  if (!primary.size && !auxiliary.size) return { ok: true };

  const usesPrimary = tables.some((t) => primary.has(t));
  const usesAuxiliary = tables.filter((t) => auxiliary.has(t));

  if (usesAuxiliary.length && !usesPrimary) {
    const aux = usesAuxiliary[0]!;
    const main = judge.primary_tables[0] || "主记录表";
    return {
      ok: false,
      reason: "auxiliary_without_primary",
      hint: `禁止单独查询扩展从表 ${aux}；须以主记录表 ${main} 为 FROM，并按查询计划过滤。`,
    };
  }

  for (const aux of usesAuxiliary) {
    const comment = tableComments?.[aux] ?? "";
    const isExtension = tableCommentLooksLikeExtensionDetail(comment) || auxiliary.has(aux);
    if (!isExtension) continue;
    if (planWantsTableExtension(queryPlan, comment)) continue;
    if (tables.includes(aux)) {
      const main = judge.primary_tables[0] || "";
      return {
        ok: false,
        reason: "unrequested_extension_join",
        hint: `问题未要求扩展维度，禁止 JOIN ${aux}；只查主记录表 ${main || "（见智能选表）"} 即可。`,
      };
    }
  }

  return { ok: true };
}

export function validateSqlAgainstPlanFilters(
  sql: string,
  plan?: QueryPlan | null,
  preflight?: SqlPreflightResult | null,
): SqlPlanGuardResult {
  const names = collectRequiredPersonNames(plan, preflight);
  if (names.length && sqlMissingRequiredPersonNames(sql, names)) {
    return {
      ok: false,
      reason: "missing_name_filter",
      hint: `必须在 WHERE 或 JOIN 条件中过滤人员姓名：${names.join("、")}（与查询计划一致，禁止去掉姓名条件）。`,
    };
  }
  const regions = collectRequiredRegions(plan, preflight);
  if (regions.length && sqlMissingRequiredRegions(sql, regions)) {
    return {
      ok: false,
      reason: "missing_region_filter",
      hint: `必须在 WHERE 中落实地区条件：${regions.join("、")}（与查询计划一致，禁止只按年龄等其它条件统计全市）。`,
    };
  }
  return { ok: true };
}
