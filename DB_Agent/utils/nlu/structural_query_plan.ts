/**
 * 结构性 QueryPlan：low_token 下跳过 plan LLM。
 * P0-8a：只填 intent / entities.names / metrics（schema 检索词），不写 data_domain 地域槽（由 slot LLM + assemble 负责）。
 * D-P2-1：已下线问句 LOCATION_RE；禁止从原话 regex 剥地区。
 */
import type { QueryPlan } from "./query_plan";
import { defaultQueryPlan } from "./query_plan";
import { extractNameCandidatesFromQuestion } from "./signals";
import { getFootPressureMarkers } from "../domain_patch";
import { getDbAgentBlueprintEnv } from "../db_agent_env";

const HEALTH_METRIC_HINTS = ["健康", "血压", "血糖", "心率", "血氧", "体温", "体征", "指标"] as const;
const BASIC_METRIC_HINTS = ["基本信息", "基础信息", "联系方式", "电话", "手机", "住址", "地址", "年龄", "性别"] as const;
const STAT_MARKERS = ["分布", "占比", "结构", "趋势", "变化", "增长", "统计", "多少", "几个", "总数", "平均", "人数"] as const;
const ELDER_MARKERS = ["老人", "长者", "老年人"] as const;
const SCHEMA_MARKERS = ["有哪些表", "表结构", "字段", "列名", "information_schema", "数据库结构"] as const;
const COMPARE_MARKERS = ["对比", "比较", "哪个更", "谁更"] as const;
const TREND_MARKERS = ["趋势", "变化", "增长", "按月", "每月", "逐月"] as const;

function blobIncludes(blob: string, parts: readonly string[]): boolean {
  return parts.some((p) => blob.includes(p));
}

function compactBlob(question: string): string {
  return String(question ?? "").replace(/\s+/g, "");
}

function collectMetricHints(blob: string, parts: readonly string[]): string[] {
  return parts.filter((p) => blob.includes(p)).slice(0, 8);
}

export function inferQueryPlanStructural(question: string): QueryPlan {
  const plan = defaultQueryPlan();
  const blob = compactBlob(question);
  if (!blob || blob.length < 2) return plan;

  const names = extractNameCandidatesFromQuestion(question).slice(0, 3);
  plan.entities.names = names;

  const footMarkers = getFootPressureMarkers();

  if (blobIncludes(blob, SCHEMA_MARKERS)) {
    plan.intent = "schema_help";
    plan.confidence = 0.82;
    return plan;
  }

  const footHit = blobIncludes(blob, footMarkers);
  const healthHit = blobIncludes(blob, HEALTH_METRIC_HINTS);
  const basicHit = blobIncludes(blob, BASIC_METRIC_HINTS);
  const statHit = blobIncludes(blob, STAT_MARKERS);
  const trendHit = blobIncludes(blob, TREND_MARKERS);
  const compareHit = blobIncludes(blob, COMPARE_MARKERS);
  const elderHit = blobIncludes(blob, ELDER_MARKERS);

  if (elderHit) {
    plan.subject = "person";
    plan.data_domain = "person_basic";
    if (statHit && blobIncludes(blob, ["人数", "多少", "几个", "总数"])) {
      plan.metrics = Array.from(new Set([...(plan.metrics ?? []), "人数"])).slice(0, 8);
    }
  }
  // 基本信息/联系方式：锁定 person_basic，避免后续 Judge 把健康表留在 primary 后翻成 person_health
  if (basicHit && !healthHit && !footHit) {
    plan.subject = "person";
    plan.data_domain = "person_basic";
  }

  const metricHints = [
    ...collectMetricHints(blob, footMarkers),
    ...collectMetricHints(blob, healthHit && !basicHit ? HEALTH_METRIC_HINTS : []),
    ...collectMetricHints(blob, basicHit ? BASIC_METRIC_HINTS : []),
  ];
  if (metricHints.length) plan.metrics = Array.from(new Set(metricHints)).slice(0, 8);

  if (compareHit) {
    plan.intent = "comparison";
    plan.confidence = 0.68;
  } else if (statHit && trendHit) {
    plan.intent = "trend";
    plan.confidence = 0.72;
  } else if (statHit) {
    plan.intent = "aggregation";
    plan.confidence = 0.7;
  } else if (footHit || healthHit || basicHit || names.length) {
    plan.intent = "detail";
    plan.subject = names.length || basicHit ? "person" : "record";
    plan.confidence = names.length || basicHit ? 0.78 : 0.55;
  }

  if (plan.intent === "unknown" && statHit) {
    plan.intent = "aggregation";
    plan.confidence = 0.62;
  }

  return plan;
}

export function shouldUseStructuralQueryPlan(question: string): boolean {
  const env = getDbAgentBlueprintEnv();
  if (!env.enableStructuralPlan) return false;
  const p = inferQueryPlanStructural(question);
  return p.confidence >= env.structuralPlanMinConfidence && p.intent !== "unknown";
}

export function resolveStructuralOrNull(question: string): QueryPlan | null {
  if (!shouldUseStructuralQueryPlan(question)) return null;
  return inferQueryPlanStructural(question);
}
