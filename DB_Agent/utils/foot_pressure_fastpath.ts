/**
 * 足底压力测试记录确定性快路径（避免落入 sql_agent ReAct 空转）。
 */
import type { DataSource } from "typeorm";
import type { QueryPlan } from "./nlu/query_plan";
import type { SchemaGroundResult } from "./schema_ground";
import { resolvePersonNameFromPlanOrQuestion } from "./query_route_policy";
import { queryFootPressureReportTool } from "./tools";
import {
  getFootLogTable,
  getFootMeasureTable,
  queryPlanWantsFootAreaDetail,
  tableNameLooksLikeFootPressure,
} from "./schema_relations";
import { getFootPressureMarkers } from "./domain_patch";

export function questionMentionsFootPressure(text: string): boolean {
  const t = String(text ?? "");
  return getFootPressureMarkers().some((m) => t.includes(m));
}

export function planMentionsFootPressure(plan?: QueryPlan | null): boolean {
  if (!plan) return false;
  const blob = [...plan.metrics, ...plan.dimensions, ...plan.filters.where, plan.data_domain || ""].join(" ");
  return questionMentionsFootPressure(blob);
}

export function schemaHasFootPressureTable(ground?: SchemaGroundResult | null): boolean {
  const tables = [
    ...(ground?.candidate_tables ?? []),
    ...(ground?.table_judge?.primary_tables ?? []),
    ...(ground?.table_judge?.auxiliary_tables ?? []),
  ];
  return tables.some((t) => tableNameLooksLikeFootPressure(t));
}

export function pickFootPressureMainTable(ground?: SchemaGroundResult | null): string | null {
  const main = getFootLogTable();
  const measure = getFootMeasureTable();
  const tables = new Set([
    ...(ground?.candidate_tables ?? []),
    ...(ground?.table_judge?.primary_tables ?? []),
  ]);
  if (tables.has(main)) return main;
  for (const t of tables) {
    if (tableNameLooksLikeFootPressure(t) && t !== measure) return t;
  }
  return tables.has(measure) ? measure : null;
}

export function shouldTryFootPressureFastPath(input: {
  question: string;
  plan?: QueryPlan | null;
  schemaGround?: SchemaGroundResult | null;
  /** 总管侧车仅作日志/诊断；不得单独触发足底快路径（表名含 foot 会误抢慢病等问句） */
  managerContextBlob?: string;
}): boolean {
  if (!schemaHasFootPressureTable(input.schemaGround)) return false;
  if (!resolvePersonNameFromPlanOrQuestion(input.plan ?? ({} as QueryPlan), input.question)) return false;
  // 仅问句或 plan metrics/domain 命中足底 markers；禁止 managerContextBlob / 表名触发
  return questionMentionsFootPressure(input.question) || planMentionsFootPressure(input.plan);
}

export type FootPressureFastPathResult = {
  answer: string;
  sql: string;
  rowCount: number;
};

export async function tryFootPressureFastPath(
  ds: DataSource,
  input: {
    question: string;
    plan?: QueryPlan | null;
    schemaGround?: SchemaGroundResult | null;
    limit?: number;
    managerContextBlob?: string;
    executionShape?: import("./nlu/dbQueryExecutionShapeLlm").QueryExecutionShape | null;
    wantsCount?: boolean;
  },
): Promise<FootPressureFastPathResult | null> {
  if (!shouldTryFootPressureFastPath(input)) return null;
  const personName = resolvePersonNameFromPlanOrQuestion(input.plan ?? ({} as QueryPlan), input.question);
  if (!personName) return null;

  const main = pickFootPressureMainTable(input.schemaGround);
  if (!main) return null;

  const wantCount =
    input.wantsCount === true ||
    input.executionShape === "scalar_lookup";
  const wantArea = !wantCount && queryPlanWantsFootAreaDetail(input.plan);
  const measure = getFootMeasureTable();
  const tables: string[] = wantArea ? [measure, main] : [main, measure];

  for (const table of tables) {
    if (!tableNameLooksLikeFootPressure(table)) continue;
    const text = await queryFootPressureReportTool(ds, {
      personName,
      table: table as "remote_activity_foot_log" | "remote_activity_foot_measure_log",
      limit: input.limit ?? 5,
      internal: true,
      answerMode: wantCount ? "count" : "detail",
    });
    if (text) {
      const countMatch = wantCount ? text.match(/次数[：:]\s*(\d+)\s*次/u) : null
      const rowCount = wantCount
        ? Math.max(0, Number(countMatch?.[1] ?? 0))
        : (text.match(/^记录 \d+：/gm) ?? []).length || 1
      return {
        answer: text,
        sql: wantCount
          ? `SELECT COUNT(*) FROM \`${table}\` WHERE name LIKE '%${personName}%'`
          : `SELECT * FROM \`${table}\` WHERE name LIKE '%${personName}%'`,
        rowCount,
      };
    }
  }
  return null;
}
