/**
 * 统计类查询工具（分布/趋势）。
 */
import type { DataSource } from "typeorm";
import { DB_AGENT_DEFAULTS } from "../db_agent_env";
import type { QueryPlan } from "../nlu/query_plan";
import { isFilteredPersonDistributionPlan } from "../nlu/dbQueryExecutionShapeLlm";
import { resolveStatisticsKind, type StatisticsKind } from "../nlu/dbStatisticsRouteLlm";
import { getDomainTable } from "../domain_patch";
import { runPersonInfoStatsFastPath } from "../person";

function isDomainToolsEnabled() {
  return DB_AGENT_DEFAULTS.enableDomainSkills;
}

export type StatisticsResult =
  | { kind: "new_trend"; rows: any[]; emptyText?: string }
  | { kind: "age_trend"; rows: any[]; emptyText?: string }
  | { kind: "age_distribution"; rows: any[] }
  | { kind: "region_distribution"; rows: any[] }
  | { kind: "gender_distribution"; rows: any[] }
  | { kind: "crowd_distribution"; rows: any[] };

export async function statisticsToolRaw(
  ds: DataSource,
  question: string,
  opts?: { model?: import("@langchain/openai").ChatOpenAI | null; plan?: QueryPlan | null },
): Promise<StatisticsResult | null> {
  if (!isDomainToolsEnabled()) return null;
  const kind = await resolveStatisticsKind(opts?.model ?? null, question, opts?.plan);
  if (!kind) return null;
  return executeStatisticsKind(ds, kind);
}

async function executeStatisticsKind(ds: DataSource, kind: StatisticsKind): Promise<StatisticsResult | null> {
  const tPerson = getDomainTable("person_info", "person_info");
  const tCrowd = getDomainTable("person_crowd_type", "person_crowd_type");

  switch (kind) {
    case "new_trend": {
      const rows = await ds.query(
        `
SELECT
  DATE_FORMAT(create_time, '%Y-%m') AS month,
  COUNT(*) AS count
FROM ${tPerson}
WHERE create_time IS NOT NULL
GROUP BY month
ORDER BY month
LIMIT 60
      `,
      );
      return {
        kind: "new_trend",
        rows: Array.isArray(rows) ? rows : [],
        emptyText: "未找到可用于新增趋势统计的数据（create_time 为空）。",
      };
    }
    case "age_trend": {
      const rows = await ds.query(
        `
SELECT
  DATE_FORMAT(create_time, '%Y-%m') AS month,
  COUNT(*) AS count,
  AVG(age) AS avg_age
FROM ${tPerson}
WHERE create_time IS NOT NULL
GROUP BY month
ORDER BY month
LIMIT 60
      `,
      );
      return {
        kind: "age_trend",
        rows: Array.isArray(rows) ? rows : [],
        emptyText: "未找到可用于趋势统计的数据（create_time 为空）。",
      };
    }
    case "gender_distribution": {
      const rows = await ds.query(
        `
SELECT
  CASE
    WHEN is_gender = 1 THEN '男'
    WHEN is_gender = 2 THEN '女'
    ELSE '未知'
  END AS gender,
  COUNT(*) AS count
FROM ${tPerson}
GROUP BY gender
ORDER BY count DESC
      `,
      );
      return { kind: "gender_distribution", rows: Array.isArray(rows) ? rows : [] };
    }
    case "age_distribution": {
      const rows = await ds.query(
        `
SELECT
  CASE
    WHEN age IS NULL THEN '未知'
    WHEN age < 60 THEN '<60'
    WHEN age BETWEEN 60 AND 69 THEN '60-69'
    WHEN age BETWEEN 70 AND 79 THEN '70-79'
    WHEN age BETWEEN 80 AND 89 THEN '80-89'
    ELSE '90+'
  END AS age_bucket,
  COUNT(*) AS count
FROM ${tPerson}
GROUP BY age_bucket
ORDER BY
  CASE age_bucket
    WHEN '<60' THEN 1
    WHEN '60-69' THEN 2
    WHEN '70-79' THEN 3
    WHEN '80-89' THEN 4
    WHEN '90+' THEN 5
    ELSE 6
  END
      `,
      );
      return { kind: "age_distribution", rows: Array.isArray(rows) ? rows : [] };
    }
    case "crowd_distribution": {
      const rows = await ds.query(
        `
SELECT
  COALESCE(pct.name, '未知') AS crowd,
  COUNT(*) AS count
FROM ${tPerson} pi
LEFT JOIN ${tCrowd} pct ON pi.crowd_type_id = pct.id
GROUP BY crowd
ORDER BY count DESC
LIMIT 30
      `,
      );
      return { kind: "crowd_distribution", rows: Array.isArray(rows) ? rows : [] };
    }
    case "region_distribution": {
      const rows = await ds.query(
        `
SELECT
  COALESCE(NULLIF(TRIM(provinces_and_cities), ''), '未知') AS region,
  COUNT(*) AS count
FROM ${tPerson}
GROUP BY region
ORDER BY count DESC
LIMIT 30
      `,
      );
      return { kind: "region_distribution", rows: Array.isArray(rows) ? rows : [] };
    }
    default:
      return null;
  }
}

export async function statisticsTool(
  ds: DataSource,
  question: string,
  opts?: { model?: import("@langchain/openai").ChatOpenAI | null; plan?: QueryPlan | null },
) {
  const filtered = await runPersonInfoStatsFastPath(
    ds,
    opts?.plan,
    isFilteredPersonDistributionPlan(opts?.plan) ? "distribution" : undefined,
  );
  if (filtered) return filtered;
  const result = await statisticsToolRaw(ds, question, opts);
  if (!result) return null;
  if (result.kind === "new_trend") {
    if (!Array.isArray(result.rows) || result.rows.length === 0) return result.emptyText ?? "未找到可用于新增趋势统计的数据。";
    const lines = ["老人新增趋势（按月份，最近 60 个月）："];
    for (const r of result.rows as any[]) {
      lines.push(`- ${r.month}：新增 ${r.count}`);
    }
    return lines.join("\n");
  }
  if (result.kind === "age_trend") {
    if (!Array.isArray(result.rows) || result.rows.length === 0) return result.emptyText ?? "未找到可用于趋势统计的数据。";
    const lines = ["老人年龄趋势（按月份，最近 60 个月）："];
    for (const r of result.rows as any[]) {
      const avg = typeof r.avg_age === "number" ? r.avg_age.toFixed(1) : String(r.avg_age ?? "");
      lines.push(`- ${r.month}：人数 ${r.count}，平均年龄 ${avg}`);
    }
    return lines.join("\n");
  }
  if (result.kind === "age_distribution") {
    const lines = ["老人年龄分布："];
    for (const r of result.rows as any[]) lines.push(`- ${r.age_bucket}：${r.count}`);
    return lines.join("\n");
  }
  if (result.kind === "region_distribution") {
    const lines = ["老人地区分布（Top 30）："];
    for (const r of result.rows as any[]) lines.push(`- ${r.region}：${r.count}`);
    return lines.join("\n");
  }
  if (result.kind === "gender_distribution") {
    const lines = ["老人性别分布："];
    for (const r of result.rows as any[]) lines.push(`- ${r.gender}：${r.count}`);
    return lines.join("\n");
  }
  if (result.kind === "crowd_distribution") {
    const lines = ["老人“人群分类”分布（Top 30）："];
    for (const r of result.rows as any[]) lines.push(`- ${r.crowd}：${r.count}`);
    return lines.join("\n");
  }
  return null;
}
