import type { GraphNode } from "@langchain/langgraph";
import {
  runCommentAlignedDetailFastPath,
  shouldUseCommentAlignedDetailFastPath,
} from "../../comment_detail_fastpath";
import { getDbAgentBlueprintEnv } from "../../db_agent_env";
import { inferExecutionShapeStructural } from "../../nlu/dbQueryExecutionShapeLlm";
import { resolveQueryTier } from "../../nlu/dbComplexityLlm";
import { resolveDbModelForStage } from "../../nlu/dbModelRouter";
import { parseQueryPlan } from "../../nlu";
import { formatManagerContextBlob, parseManagerDbTaskFromJson } from "../../manager_task_context";
import { personInfoStatsEligible, runPersonInfoStatsFastPath } from "../../person";
import { parsePlanCompletenessJson } from "../../nlu/dbPlanCompletenessLlm";
import { recordQueryMetric, setRunMeta } from "../../query_metrics";
import { shouldBypassFastPathsForQuestion } from "../../query_learning";
import type { SchemaGroundResult } from "../../schema_ground";
import { safeParseSqlPreflightJson } from "../../sql_preflight";
import {
  runDetailRecordFastPaths,
  runScalarLookupDirect,
  runSqlDirect,
} from "../../sql_direct";
import { tryFootPressureFastPath } from "../../foot_pressure_fastpath";
import { parseExecutionShapeFromState } from "../helpers";
import type { DbGraphState } from "../state";
import type { DbGraphDeps } from "../types";

export function createSqlDirectNode(deps: DbGraphDeps): GraphNode<typeof DbGraphState> {
  const { config, ds, embeddingConfig, largerModel, model, progress } = deps;
  return async (state) => {
    const blueprintEnv = getDbAgentBlueprintEnv();
    if (!blueprintEnv.enableSqlDirect) return {};
    if (state.route_skip_sql_direct) return {};
    const sq = String(state.standalone_question || state.question || "").trim();
    const plan = parseQueryPlan(state.query_plan_json);
    let executionShape = parseExecutionShapeFromState(String(state.execution_shape_json || ""));
    if (!executionShape) {
      const structural = inferExecutionShapeStructural(plan);
      if (structural?.shape === "scalar_lookup" && structural.confidence >= 0.65) {
        executionShape = "scalar_lookup";
      }
    }
    const pre = safeParseSqlPreflightJson(String(state.sql_preflight_json || ""), sq, plan);
    const q = (pre?.refined_question || "").trim() || sq;
    let schemaGround: SchemaGroundResult | null = null;
    try {
      const raw = String(state.schema_ground_json || "").trim();
      if (raw) schemaGround = JSON.parse(raw) as SchemaGroundResult;
    } catch {
      schemaGround = null;
    }
    if (!schemaGround?.candidate_tables?.length) return {};

    let routeHint = "";
    try {
      const rp = String(state.route_policy_json || "").trim();
      if (rp) routeHint = (JSON.parse(rp) as { hintBlock?: string })?.hintBlock || "";
    } catch {
      routeHint = "";
    }
    if (!routeHint && schemaGround?.table_judge_hint) routeHint = schemaGround.table_judge_hint;

    const mgr = parseManagerDbTaskFromJson(String(state.manager_task_json || ""));
    const managerContextBlob = formatManagerContextBlob(mgr);
    const completeness = parsePlanCompletenessJson(String(state.plan_completeness_json || ""));

    // 足底专名次数/明细优先于 person_info 性别分布，避免「做过几次足底」被抢答成男女人数
    if (!shouldBypassFastPathsForQuestion(q)) {
      const footFast = await tryFootPressureFastPath(ds, {
        question: q,
        plan,
        schemaGround,
        managerContextBlob,
        executionShape,
        wantsCount: executionShape === "scalar_lookup",
      });
      if (footFast) {
        recordQueryMetric({
          path: "sql_direct",
          ok: true,
          empty: footFast.rowCount <= 0,
          reason: "foot_pressure_fastpath",
          question: q,
          data_domain: plan.data_domain,
          tables: schemaGround?.candidate_tables,
        });
        setRunMeta({ path: "sql_direct", data_domain: plan.data_domain, intent: plan.intent });
        return { answer: footFast.answer, sql_direct_fail_reason: "" };
      }
    }

    if (personInfoStatsEligible(plan)) {
      progress?.("人员主表：按地区/年龄统计…");
      const personStats = await runPersonInfoStatsFastPath(ds, plan, executionShape, completeness);
      if (personStats) {
        recordQueryMetric({
          path: "sql_direct",
          ok: true,
          empty: false,
          reason: "person_info_filtered_stats",
          question: q,
          data_domain: plan.data_domain,
          tables: ["person_info"],
        });
        setRunMeta({ path: "sql_direct", data_domain: "person_basic", intent: plan.intent });
        return { answer: personStats, sql_direct_fail_reason: "" };
      }
    }

    if (
      shouldUseCommentAlignedDetailFastPath({ plan, schemaGround, question: q, executionShape }) &&
      !shouldBypassFastPathsForQuestion(q)
    ) {
      progress?.("表注释对齐：直接查询…");
      const commentFast = await runCommentAlignedDetailFastPath(ds, {
        question: q,
        queryPlan: plan,
        schemaGround,
      });
      if (commentFast) {
        recordQueryMetric({
          path: "sql_direct",
          ok: true,
          question: q,
          data_domain: plan.data_domain,
          tables: schemaGround?.candidate_tables,
        });
        setRunMeta({ path: "sql_direct", data_domain: plan.data_domain, intent: plan.intent });
        return { answer: commentFast.answer, sql_direct_fail_reason: "" };
      }
    }

    progress?.("结构化 SQL：尝试一次生成并执行…");
    const tierInfo = await resolveQueryTier(largerModel ?? model, q, plan);
    const sqlModel = resolveDbModelForStage(config, "sql_codegen", { plan, tier: tierInfo.tier });
    const formatModel = resolveDbModelForStage(config, "result_column", { plan, tier: tierInfo.tier });
    if (executionShape === "detail_rows" && !shouldBypassFastPathsForQuestion(q)) {
      const detailFast = await runDetailRecordFastPaths({
        ds,
        question: q,
        queryPlan: plan,
        schemaGround,
        executionShape,
        managerContextBlob,
      });
      if (detailFast?.ok) {
        recordQueryMetric({
          path: "sql_direct",
          ok: true,
          question: q,
          data_domain: plan.data_domain,
          tables: schemaGround?.candidate_tables,
        });
        setRunMeta({
          path: "sql_direct",
          data_domain: plan.data_domain,
          intent: plan.intent,
          execution_shape: executionShape,
        });
        return { answer: detailFast.answer, sql_direct_fail_reason: "" };
      }
    }
    if (executionShape === "scalar_lookup" || executionShape === "detail_rows") {
      progress?.(
        executionShape === "detail_rows" ? "明细枚举：Schema Linking → SQL…" : "属性查询：Schema Linking → SQL…",
      );
      const scalarFirst = await runScalarLookupDirect({
        model: sqlModel,
        formatModel,
        ds,
        question: q,
        queryPlan: plan,
        schemaGround,
        executionShape,
      });
      if (scalarFirst.ok) {
        recordQueryMetric({
          path: "sql_direct",
          ok: true,
          question: q,
          data_domain: plan.data_domain,
          tables: schemaGround?.candidate_tables,
        });
        setRunMeta({
          path: "sql_direct",
          data_domain: plan.data_domain,
          intent: plan.intent,
          execution_shape: executionShape,
        });
        return { answer: scalarFirst.answer, sql_direct_fail_reason: "" };
      }
    }
    let res = await runSqlDirect({
      model: sqlModel,
      formatModel,
      ds,
      question: q,
      queryPlan: plan,
      preflight: pre,
      schemaGround,
      routeHint,
      sessionKey: String(state.session_id || ""),
      embeddingConfig,
      managerContextBlob,
      executionShape,
      completeness,
    });
    if (!res.ok && res.reason === "needs_clarification") {
      return { sql_direct_fail_reason: res.reason };
    }
    if (!res.ok && res.reason === "empty_result") {
      progress?.("结构化 SQL：无结果，放宽条件重试…");
      res = await runSqlDirect({
        model: sqlModel,
        formatModel,
        ds,
        question: q,
        queryPlan: plan,
        preflight: pre,
        schemaGround,
        routeHint,
        relaxed: true,
        sessionKey: String(state.session_id || ""),
        embeddingConfig,
        managerContextBlob,
        executionShape,
        completeness,
      });
    }
    if (!res.ok && res.reason === "empty_result_named") {
      return { sql_direct_fail_reason: res.reason };
    }
    if (!res.ok && (res.reason === "empty_result" || res.reason === "no_schema_ground")) {
      return { sql_direct_fail_reason: res.reason };
    }
    if (res.ok) {
      recordQueryMetric({
        path: "sql_direct",
        ok: true,
        question: q,
        data_domain: plan.data_domain,
        tables: schemaGround?.candidate_tables,
      });
      setRunMeta({ path: "sql_direct", data_domain: plan.data_domain, intent: plan.intent });
      return { answer: res.answer, sql_direct_fail_reason: "" };
    }
    recordQueryMetric({
      path: "sql_direct",
      ok: false,
      reason: res.reason,
      question: q,
      data_domain: plan.data_domain,
      tables: schemaGround?.candidate_tables,
    });
    return { sql_direct_fail_reason: res.reason };
  };
}
