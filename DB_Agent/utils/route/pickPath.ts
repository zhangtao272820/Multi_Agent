import type { QueryPlan } from "../nlu/query_plan";
import {
  inferExecutionShapeStructural,
  isFilteredPersonDistributionPlan,
} from "../nlu/dbQueryExecutionShapeLlm";
import type { QueryTier } from "../nlu/dbComplexityLlm";
import type { SchemaTableJudgeResult } from "../schema_table_judge";
import {
  canUsePersonHealthSkill,
  canUsePersonInfoSkill,
} from "../schema_domain_align";
import { personInfoStatsEligible } from "../person";
import type { QueryPath } from "../query_metrics";
import { looksLikePersonHealthQuery } from "./alignment";
import { pathScoreFromPrefs } from "./preferences";
import { resolvePersonNameFromPlanOrQuestion } from "./personResolve";
import type { RouteExecutionPath, RoutePreferenceRow, SchemaPlanAlignment } from "./types";

export function buildContextKey(plan: QueryPlan, alignment: SchemaPlanAlignment): string {
  const join = alignment.hasHealthJoin ? "join" : "nojoin";
  return `${plan.data_domain}:${plan.intent}:${plan.subject}:${join}`;
}

function canUseL1SkillFastPath(
  queryTier: QueryTier | null | undefined,
  domainSkills: boolean,
): boolean {
  return Boolean(domainSkills && queryTier === "L1");
}

function alignmentPrior(
  path: QueryPath,
  plan: QueryPlan,
  alignment: SchemaPlanAlignment,
): number {
  if (path === "person_health") {
    if (plan.data_domain === "person_health" && alignment.hasPersonHealthRecords && alignment.hasHealthJoin) {
      return 0.92;
    }
    if (plan.data_domain === "person_health" && alignment.hasPersonHealthRecords) return 0.72;
    return 0.15;
  }
  if (path === "person_info") {
    if (plan.data_domain === "person_basic" && plan.intent === "detail") return 0.85;
    if (plan.data_domain === "person_health") return 0.05;
    return 0.35;
  }
  if (path === "statistics" || path === "generic_stats") {
    const shape = inferExecutionShapeStructural(plan);
    if (shape?.shape === "distribution" || shape?.shape === "trend") return 0.88;
    if (["aggregation", "trend", "comparison"].includes(plan.intent)) return 0.35;
    return 0.25;
  }
  if (path === "sql_direct") {
    if (plan.intent === "detail" && alignment.schemaConfidence >= 0.55) return 0.7;
    if (["aggregation", "trend", "comparison"].includes(plan.intent)) return 0.55;
    return 0.45;
  }
  if (path === "sql_agent") {
    if (alignment.causalTags.includes("schema_missing_health_table")) return 0.75;
    if (plan.confidence < 0.4) return 0.8;
    return 0.5;
  }
  return 0.4;
}

function tierPrefersStructuredSql(tier: QueryTier | null | undefined): boolean {
  return tier === "L3" || tier === "L4" || tier === "L5" || tier === "L6" || tier === "L7";
}

export function pickExecutionPath(
  plan: QueryPlan,
  alignment: SchemaPlanAlignment,
  prefs: RoutePreferenceRow[],
  contextKey: string,
  question?: string,
  queryTier?: QueryTier | null,
  tableJudge?: SchemaTableJudgeResult | null,
  opts?: { schemaFirst?: boolean; domainSkills?: boolean },
): { path: RouteExecutionPath; scores: Partial<Record<QueryPath, number>>; reasons: string[] } {
  const candidates: QueryPath[] = [
    "person_health",
    "person_info",
    "statistics",
    "generic_stats",
    "sql_direct",
    "sql_agent",
  ];
  const scores: Partial<Record<QueryPath, number>> = {};
  for (const p of candidates) {
    const learned = pathScoreFromPrefs(prefs, contextKey, p);
    const prior = alignmentPrior(p, plan, alignment);
    scores[p] = prior * 0.62 + learned * 0.38;
  }

  const reasons: string[] = [];
  const personName = resolvePersonNameFromPlanOrQuestion(plan, question);
  const schemaFirst = opts?.schemaFirst !== false;
  const domainSkills = Boolean(opts?.domainSkills);

  if (plan.intent === "out_of_scope") {
    return { path: "sql_agent", scores, reasons: ["超出范围"] };
  }

  if (schemaFirst) {
    if (
      domainSkills &&
      personInfoStatsEligible(plan) &&
      (["aggregation", "comparison"].includes(plan.intent) || isFilteredPersonDistributionPlan(plan))
    ) {
      reasons.push("人员主表域内聚合/过滤分布（Plan 槽位完备）→statistics（优先于 L4 QueryIR）");
      return { path: "statistics", scores, reasons };
    }
    // 人员档案/联系方式：有姓名时常被抬到 L3/L5，仍须走 person_info，勿被 sql_direct 抢走
    if (domainSkills && canUsePersonInfoSkill(alignment, plan, tableJudge)) {
      reasons.push(
        queryTier && queryTier !== "L1"
          ? `人员主表档案（${queryTier}）→person_info（优先于 sql_direct）`
          : "Judge 确认人员主表→person_info",
      );
      return { path: "person_info", scores, reasons };
    }
    if (canUseL1SkillFastPath(queryTier, domainSkills)) {
      if (looksLikePersonHealthQuery(plan, alignment, tableJudge) && personName && plan.data_domain !== "person_basic") {
        reasons.push(`L1+Judge 确认健康档案主表→person_health（${personName}）`);
        return { path: "person_health", scores, reasons };
      }
    }
    if (tierPrefersStructuredSql(queryTier)) {
      reasons.push(`复杂度 ${queryTier}→sql_direct（QueryIR/CTE）`);
    } else {
      reasons.push("Schema-First：Plan→Schema Judge→sql_direct");
    }
    return { path: "sql_preflight", scores, reasons };
  }

  if (tierPrefersStructuredSql(queryTier)) {
    reasons.push(`复杂层级 ${queryTier}→sql_preflight→sql_direct（QueryIR/CTE）`);
    return { path: "sql_preflight", scores, reasons };
  }

  if (plan.data_domain === "person_basic" && plan.intent === "detail" && plan.subject === "person") {
    reasons.push("人员基础档案→person_info");
    return { path: "person_info", scores, reasons };
  }
  if (looksLikePersonHealthQuery(plan, alignment, tableJudge) && personName && plan.data_domain !== "person_basic") {
    reasons.push(`健康体征域+姓名（${personName}）→person_health_records JOIN 快路径`);
    return { path: "person_health", scores, reasons };
  }
  if (plan.data_domain === "person_health" && !alignment.hasPersonHealthRecords) {
    reasons.push("问句属健康域但 schema 无体征表→结构化 SQL");
    return { path: "sql_preflight", scores, reasons };
  }
  if (["aggregation", "trend", "comparison"].includes(plan.intent)) {
    const shape = inferExecutionShapeStructural(plan);
    if (shape?.shape === "distribution" || shape?.shape === "trend" || plan.intent === "trend") {
      reasons.push("执行形态为分布/趋势→statistics");
      return { path: "statistics", scores, reasons };
    }
    reasons.push("标量或复杂统计→结构化 SQL（QueryIR/sql_direct）");
    return { path: "sql_preflight", scores, reasons };
  }

  const ranked = (["sql_direct", "sql_agent", "person_health", "person_info"] as QueryPath[])
    .map((p) => ({ p, s: scores[p] ?? 0 }))
    .sort((a, b) => b.s - a.s);

  const best = ranked[0];
  if (best?.p === "person_health" && (scores.person_health ?? 0) >= 0.55 && alignment.hasPersonHealthRecords) {
    reasons.push(`Bandit 优选 person_health（${(best.s).toFixed(2)}）`);
    return { path: "person_health", scores, reasons };
  }

  const sqlDirectScore = scores.sql_direct ?? 0;
  const sqlAgentScore = scores.sql_agent ?? 0;
  const ctxTrials = prefs
    .filter((r) => r.contextKey === contextKey)
    .reduce((n, r) => n + r.trials, 0);
  if (ctxTrials >= 8 && sqlAgentScore > sqlDirectScore + 0.28) {
    reasons.push(`同上下文历史空结果偏多→直连 sql_agent（${sqlAgentScore.toFixed(2)}>${sqlDirectScore.toFixed(2)}）`);
    return { path: "sql_agent", scores, reasons };
  }

  reasons.push(`默认结构化路径 sql_preflight→sql_direct（${sqlDirectScore.toFixed(2)}）`);
  return { path: "sql_preflight", scores, reasons };
}

export function applyRouteSkillGates(
  path: RouteExecutionPath,
  reasons: string[],
  alignment: SchemaPlanAlignment,
  refinedPlan: QueryPlan,
  tableJudge: SchemaTableJudgeResult | null,
): RouteExecutionPath {
  if (path === "person_health" && !canUsePersonHealthSkill(alignment, refinedPlan, tableJudge)) {
    reasons.push("Judge 主表非健康档案→降级 sql_direct");
    return "sql_preflight";
  }
  if (path === "person_info" && !canUsePersonInfoSkill(alignment, refinedPlan, tableJudge)) {
    reasons.push("Judge 主表非人员档案→降级 sql_direct");
    return "sql_preflight";
  }
  return path;
}
