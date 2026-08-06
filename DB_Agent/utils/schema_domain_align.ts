/**
 * P0-8 Schema-First：由 schema 链接 + Table Judge 主表推断 data_domain，不读问句关键词表。
 */
import type { QueryPlan } from "./nlu/query_plan";
import type { SchemaTableJudgeResult } from "./schema_table_judge";
import {
  tableNameLooksLikeFootPressure,
  tableNameLooksLikeNursingChronic,
  tableNameLooksLikePersonHealthRecords,
  tableNameLooksLikePersonMaster,
} from "./schema_relations";

export type SchemaAlignFacts = {
  hasHealthTable: boolean;
  hasPersonMaster: boolean;
  hasHealthJoin: boolean;
  hasPersonHealthRecords: boolean;
  hasFootPressureTable: boolean;
};

function primaryTables(judge?: SchemaTableJudgeResult | null): string[] {
  return (judge?.primary_tables ?? []).filter(Boolean);
}

/** schema 接地前不做域修正；选表交给 Judge + sql_direct。 */
export function refinePlanBeforeSchemaGround(plan: QueryPlan): QueryPlan {
  return plan;
}

/** schema 接地后推断 data_domain（Judge 主表 + 表名结构，非问句正则） */
export function inferDataDomainFromSchema(input: {
  plan: QueryPlan;
  alignment: SchemaAlignFacts;
  tableJudge?: SchemaTableJudgeResult | null;
}): QueryPlan["data_domain"] {
  const { plan, alignment, tableJudge } = input;
  const primary = primaryTables(tableJudge);
  const lead = primary[0] || "";
  const leadIsPersonMaster = Boolean(lead && tableNameLooksLikePersonMaster(lead));
  const hasHealthInPrimary = primary.some((t) => tableNameLooksLikePersonHealthRecords(t));
  const planWantsBasic =
    plan.data_domain === "person_basic" ||
    (plan.intent === "detail" && plan.subject === "person" && plan.entities.names.length > 0);

  if (primary.some((t) => tableNameLooksLikeFootPressure(t))) return "general";
  if (primary.some((t) => tableNameLooksLikeNursingChronic(t))) return "general";
  if (alignment.hasFootPressureTable && !alignment.hasPersonHealthRecords) return "general";

  // 档案/具名人员：leading person master 或 plan 已 person_basic → 不因 primary 旁挂健康表翻成 person_health
  if (alignment.hasPersonMaster && (plan.data_domain === "person_basic" || leadIsPersonMaster) && planWantsBasic) {
    if (plan.data_domain === "person_health") {
      // 仅当 plan 显式健康域且 leading 就是健康表时才保留
      if (lead && tableNameLooksLikePersonHealthRecords(lead)) return "person_health";
    }
    return "person_basic";
  }

  // 健康域：leading 为健康表，或 plan 显式 person_health 且未声明 basic
  if (hasHealthInPrimary && plan.data_domain !== "person_basic") {
    if (lead && tableNameLooksLikePersonHealthRecords(lead)) return "person_health";
    if (plan.data_domain === "person_health") return "person_health";
    // 健康表仅在非 leading 位置：不抢占 person_basic/general
  }

  if (
    plan.intent === "detail" &&
    alignment.hasPersonMaster &&
    primary.some((t) => tableNameLooksLikePersonMaster(t)) &&
    !hasHealthInPrimary
  ) {
    if (plan.data_domain === "person_basic" || plan.entities.names.length > 0) {
      return "person_basic";
    }
  }

  if (plan.data_domain === "person_health" && alignment.hasPersonHealthRecords) return "person_health";
  if (plan.data_domain === "person_basic" && alignment.hasPersonMaster) return "person_basic";

  return "general";
}

/** 仅当 Judge 主表含健康档案明细且 schema 可 JOIN 时，才允许 person_health skill。 */
export function canUsePersonHealthSkill(
  alignment: SchemaAlignFacts,
  plan: QueryPlan,
  tableJudge?: SchemaTableJudgeResult | null,
): boolean {
  if (plan.data_domain !== "person_health") return false;
  const primary = primaryTables(tableJudge);
  if (primary.some((t) => tableNameLooksLikeNursingChronic(t))) return false;
  if (primary.some((t) => tableNameLooksLikeFootPressure(t))) return false;
  if (primary.length && !primary.some((t) => tableNameLooksLikePersonHealthRecords(t))) return false;
  if (alignment.hasFootPressureTable && !alignment.hasPersonHealthRecords) return false;
  return Boolean(alignment.hasPersonHealthRecords && (alignment.hasHealthJoin || alignment.hasHealthTable));
}

export function canUsePersonInfoSkill(
  alignment: SchemaAlignFacts,
  plan: QueryPlan,
  tableJudge?: SchemaTableJudgeResult | null,
): boolean {
  if (plan.intent !== "detail" || plan.data_domain !== "person_basic") return false;
  const primary = primaryTables(tableJudge);
  if (primary.length && !primary.some((t) => tableNameLooksLikePersonMaster(t))) return false;
  return Boolean(alignment.hasPersonMaster);
}
