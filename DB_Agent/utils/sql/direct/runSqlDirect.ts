/**
 * 结构化 SQL 快路径：Preflight + Schema 接地后，强模型一次生成 SELECT，失败则交 ReAct Agent。
 */
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { EmbeddingClientConfig } from "../../agent";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import type { DataSource } from "typeorm";
import { clipText } from "../../nlu/text";
import type { QueryPlan } from "../../nlu/query_plan";
import { formatQueryPlanForSqlAgent } from "../../nlu/query_plan";
import type { SqlPreflightResult } from "../../sql_preflight";
import { formatSqlPreflightForSqlAgent } from "../../sql_preflight";
import { formatSchemaGroundForAgent, type SchemaGroundResult } from "../../schema_ground";
import { formatExperienceBlockForAgentAsync } from "../../query_learning";
import { formatSqlTemplateBlockForAgent, recordSqlTemplate, trySqlTemplateDirect } from "../../query_sql_templates";
import { buildJoinContextBlock } from "../../join_path";
import { formatUserPreferencesBlock } from "../../user_preferences";
import { getPromptPatchesForStage } from "../../prompt_evolution";
import { getDbAgentBlueprintEnv } from "../../db_agent_env";
import {
  extractSqlFromLlmOutput,
  isReadOnlySelectSql,
  prepareSelectForExecution,
  sqlDirectSystemPrompt,
  SQL_DIRECT_HUMAN_TEMPLATE,
  validateGeneratedSelectSql,
  formatSqlValidationFailure,
} from "../../sql";
import { sanitizeAssistantText, sanitizeAssistantTextForPlan } from "../../text";
import { runExplainPreflight } from "../../sql_explain_util";
import { getRunMeta, recordQueryMetric, setRunMeta, stashExplainPreflight, stashQueryTier } from "../../query_metrics";
import { formatFieldValueForUser } from "../../display_values";
import { resolvePersonNameFromPlanOrQuestion, isPersonEntityPlan } from "../../query_route_policy";
import {
  guessTablesFromSql,
} from "../../sql_plan_guard";
import { linkColumnsToQueryIr } from "../../nlu/dbColumnLinkLlm";
import {
  formatExecutionShapeForSqlAgent,
  type QueryExecutionShape,
} from "../../nlu/dbQueryExecutionShapeLlm";
import { isEnumerateRowsMode, dedupeEnumerateRows, enumerateRowLimit, detailEnumerateRowsLookIncomplete } from "../../nlu/dbSchemaLinkResultMode";
import { hasNegativeFeedbackForQuestion, shouldBypassFastPathsForQuestion } from "../../query_learning";
import { pickDisplayColumnsByLlm } from "../../nlu/dbResultColumnLlm";
import { pickColumnsByPlanMetrics, formatSingleScalarValue } from "../../nlu/dbAnswerFormat";
import { shouldRunResultColumnLlm } from "../../nlu/dbModelRouter";
import { compileSchemaLinkToSql, tryScalarSchemaLinkedQuery } from "../../scalar_sql_builder";
import { resolveQueryTier, shouldUseQueryIrPath } from "../../nlu/dbComplexityLlm";
import { compileQueryIrToSql } from "../../query_ir";
import { repairSqlWithLlm } from "../../sql_repair";
import { incrementLlmCallCount } from "../../llm_call_counter";
import { trySqlPlanDirect } from "../../sql_plan_direct";
import {
  loadTablesMeta,
  queryPlanWantsFootAreaDetail,
  discoverSchemaRelations,
  tableNameLooksLikeFootPressure,
  tableNameLooksLikeNursingChronic,
  tableNameLooksLikePersonHealthRecords,
  tryPersonHealthJoinQuery,
  tryPrimaryTableDetailByName,
} from "../../schema_relations";
import { getMustTablesForDataDomain, getHealthLinkTables } from "../../domain_patch";
import {
  collectDetailFastPathIntentTokens,
  rankDetailTablesByIntent,
} from "../../detail_fastpath_align";
import {
  planMentionsFootPressure,
  questionMentionsFootPressure,
  tryFootPressureFastPath,
} from "../../foot_pressure_fastpath";
import { tryMetricsDirect } from "../../metrics_compiler";
import { tryGenericStatistics } from "../../generic_statistics";
import { runPersonInfoStatsFastPath } from "../../person";
import type { PlanCompletenessResult } from "../../nlu/dbPlanCompletenessLlm";

import {
  buildSqlDirectAnswer,
  answerOpts,
  selectRowLimit,
  rowsLookEmpty,
  loadTableComments,
} from "./answerFormat";
import { runSqlDirectDetailFastPath, planWantsFullRecordFields, sqlLooksLikePartialDetailSelect } from "./detailFastPath";
import type { SqlDirectResult } from "./types";

const DIRECT_SYSTEM = sqlDirectSystemPrompt();
const DIRECT_HUMAN = SQL_DIRECT_HUMAN_TEMPLATE;

export async function runSqlDirect(params: {
  model: BaseLanguageModel;
  formatModel?: BaseLanguageModel | null;
  ds: DataSource;
  question: string;
  queryPlan?: QueryPlan | null;
  preflight?: SqlPreflightResult | null;
  schemaGround?: SchemaGroundResult | null;
  routeHint?: string;
  relaxed?: boolean;
  guardRetry?: boolean;
  sessionKey?: string;
  embeddingConfig?: EmbeddingClientConfig;
  managerContextBlob?: string;
  executionShape?: QueryExecutionShape | null;
  completeness?: PlanCompletenessResult | null;
}): Promise<SqlDirectResult> {
  const q = String(params.question ?? "").trim();
  if (!q) return { ok: false, reason: "empty_question" };

  const bypassFast = shouldBypassFastPathsForQuestion(q);
  // 须在 !bypassFast 块外定义：空结果重试路径仍会读取
  const scalarShape =
    params.executionShape === "scalar_lookup" ||
    params.executionShape === "detail_rows" ||
    (params.queryPlan?.intent === "aggregation" &&
      !(params.queryPlan?.dimensions?.length) &&
      (params.queryPlan?.metrics?.length ?? 0) > 0);

  if (!bypassFast) {
  const tplHit = await trySqlTemplateDirect(params.ds, q);
  if (tplHit?.rows?.length && !hasNegativeFeedbackForQuestion(q)) {
    let tplRows = tplHit.rows;
    if (isEnumerateRowsMode(params.executionShape)) {
      tplRows = dedupeEnumerateRows(tplRows);
    }
    const answer = await buildSqlDirectAnswer(params.ds, tplRows, answerOpts(params, tplHit.sql));
    recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: "sql_template_direct" });
    return {
      ok: true,
      answer,
      sql: tplHit.sql,
      rowCount: tplHit.rows.length,
    };
  }

  const footFast = await tryFootPressureFastPath(params.ds, {
    question: q,
    plan: params.queryPlan,
    schemaGround: params.schemaGround,
    managerContextBlob: params.managerContextBlob,
    executionShape: params.executionShape,
    wantsCount: params.executionShape === "scalar_lookup",
  });
  if (footFast) {
    return {
      ok: true,
      answer: sanitizeAssistantText(footFast.answer),
      sql: footFast.sql,
      rowCount: footFast.rowCount,
    };
  }

  const personFiltered = await runPersonInfoStatsFastPath(
    params.ds,
    params.queryPlan,
    params.executionShape,
    params.completeness,
  );
  if (personFiltered) {
    recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: "person_info_filtered_stats" });
    return {
      ok: true,
      answer: sanitizeAssistantTextForPlan(personFiltered, params.queryPlan),
      sql: "(person_info filtered)",
      rowCount: 1,
    };
  }

  const fast = await runSqlDirectDetailFastPath({
    ds: params.ds,
    question: q,
    queryPlan: params.queryPlan,
    schemaGround: params.schemaGround,
    executionShape: params.executionShape,
  });
  if (fast?.ok) return fast;

  if (scalarShape) {
    const linked = await tryScalarSchemaLinkedQuery({
      model: params.model,
      ds: params.ds,
      question: q,
      queryPlan: params.queryPlan,
      schemaGround: params.schemaGround,
      executionShape: params.executionShape,
    });
    if (linked.ok) {
      const answerShape =
        linked.mode === "json_array_join" ||
        linked.result_cardinality === "distinct_set" ||
        linked.use_distinct
          ? ("scalar_lookup" as const)
          : (params.executionShape ?? "scalar_lookup");
      if (linked.mode === "json_array_join") {
        stashQueryTier("L3", "schema_link_json_array_join");
      }
      const answer = await buildSqlDirectAnswer(
        params.ds,
        linked.rows,
        answerOpts(params, linked.sql, { executionShape: answerShape }),
      );
      recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: "schema_link_scalar" });
      return { ok: true, answer, sql: linked.sql, rowCount: linked.rows.length };
    }
  }
  }

  const personName = resolvePersonNameFromPlanOrQuestion(params.queryPlan ?? ({} as QueryPlan), q);
  const relations = params.schemaGround?.relations ?? [];
  const candidateTables = params.schemaGround?.candidate_tables ?? [];
  const primary = params.schemaGround?.table_judge?.primary_tables ?? [];
  const judgeWantsHealthJoin =
    primary.some((t) => tableNameLooksLikePersonHealthRecords(t)) &&
    !primary.some((t) => tableNameLooksLikeNursingChronic(t) || tableNameLooksLikeFootPressure(t));
  const hasHealthCandidate = candidateTables.some((t) => tableNameLooksLikePersonHealthRecords(t));
  if (
    personName &&
    (judgeWantsHealthJoin || params.queryPlan?.data_domain === "person_health" || hasHealthCandidate)
  ) {
    try {
      const healthMust = getHealthLinkTables();
      const expanded = Array.from(new Set([...candidateTables, ...healthMust]));
      const rels =
        relations.length > 0 ? relations : await discoverSchemaRelations(params.ds, expanded);
      const metas = await loadTablesMeta(params.ds, expanded);
      const joined = await tryPersonHealthJoinQuery(params.ds, {
        personName,
        relations: rels,
        tableMetas: metas,
      });
      if (joined) {
        recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: "schema_health_join" });
        return { ok: true, answer: sanitizeAssistantText(joined), sql: "(schema join)", rowCount: 1 };
      }
    } catch {
      /* fall through */
    }
  }

  const blueprint = getDbAgentBlueprintEnv();
  const aggIntent =
    params.queryPlan?.intent === "aggregation" ||
    params.queryPlan?.intent === "trend" ||
    params.queryPlan?.intent === "comparison";
  if (
    aggIntent &&
    candidateTables.length &&
    params.executionShape !== "scalar_lookup" &&
    params.executionShape !== "detail_rows"
  ) {
    const generic = await tryGenericStatistics(params.ds, {
      question: q,
      queryPlan: params.queryPlan,
      candidateTables,
      primaryTables: primary,
      rankedTables: params.schemaGround?.table_judge?.ranked_tables,
      nluModel: params.model as import("@langchain/openai").ChatOpenAI,
    });
    if (generic) {
      recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: "generic_stats" });
      return { ok: true, answer: sanitizeAssistantText(generic), sql: "(generic stats)", rowCount: 1 };
    }
  }

  if (blueprint.enableMetricsDirect && aggIntent && params.executionShape !== "scalar_lookup") {
    const metricHit = await tryMetricsDirect(params.ds, q, params.queryPlan);
    if (metricHit?.answer) {
      return {
        ok: true,
        answer: sanitizeAssistantText(metricHit.answer),
        sql: metricHit.sql,
        rowCount: metricHit.rows.length,
      };
    }
  }

  const tierInfo = await resolveQueryTier(params.model, q, params.queryPlan);
  stashQueryTier(tierInfo.tier, tierInfo.source);
  const useQueryIr =
    blueprint.enableQueryIr &&
    shouldUseQueryIrPath(tierInfo.tier, params.queryPlan, params.executionShape) &&
    !params.guardRetry &&
    !params.relaxed;
  const rowLimit = selectRowLimit(params.executionShape);
  if (useQueryIr) {
    const irGuardCtx = {
      queryPlan: params.queryPlan,
      preflight: params.preflight,
      judge: params.schemaGround?.table_judge ?? null,
    };
    const ir = await linkColumnsToQueryIr(params.model, {
      question: q,
      queryPlan: params.queryPlan,
      schemaGround: params.schemaGround,
    });
    if (ir) {
      const compiled = compileQueryIrToSql(ir);
      if (compiled.ok) {
        // Plan 已声明 region/姓名等过滤时，QueryIR 必须通过 plan guard，禁止漏条件落库
        const irValidated = validateGeneratedSelectSql(compiled.sql, irGuardCtx, { extract: false });
        if (irValidated.ok) {
          const withHintIr = prepareSelectForExecution(irValidated.sql, rowLimit);
          try {
            const rows = (await params.ds.query(withHintIr)) as any[];
            if (!rowsLookEmpty(rows)) {
              const answer = await buildSqlDirectAnswer(params.ds, rows, answerOpts(params, withHintIr));
              recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: `query_ir:${tierInfo.tier}` });
              return { ok: true, answer, sql: withHintIr, rowCount: rows.length };
            }
          } catch (e: any) {
            const repaired = await repairSqlWithLlm(params.model, {
              question: q,
              sql: withHintIr,
              error: String(e?.message ?? e),
              queryIr: ir,
              schemaSummary: params.schemaGround?.schema_summary,
            });
            if (repaired) {
              const fixValidated = validateGeneratedSelectSql(repaired, irGuardCtx, { extract: false });
              if (fixValidated.ok) {
                const withHintFix = prepareSelectForExecution(fixValidated.sql, rowLimit);
                try {
                  const rows = (await params.ds.query(withHintFix)) as any[];
                  if (!rowsLookEmpty(rows)) {
                    const answer = await buildSqlDirectAnswer(params.ds, rows, answerOpts(params, withHintFix));
                    recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: `query_ir_repair:${tierInfo.tier}` });
                    return {
                      ok: true,
                      answer,
                      sql: withHintFix,
                      rowCount: rows.length,
                    };
                  }
                } catch {
                  /* fall through to standard sql_direct */
                }
              }
            }
          }
        }
      }
    }
  }

  const planBlock = formatQueryPlanForSqlAgent(params.queryPlan);
  const preBlock = formatSqlPreflightForSqlAgent(params.preflight);
  const schemaBlock = formatSchemaGroundForAgent(params.schemaGround);
  const experienceBlock = getDbAgentBlueprintEnv().enableQueryLearning
    ? await formatExperienceBlockForAgentAsync(params.question, params.embeddingConfig)
    : "";
  const templateBlock = blueprint.enableSqlTemplateLearning
    ? formatSqlTemplateBlockForAgent(params.question)
    : "";
  const prefBlock = blueprint.enableUserPreferences
    ? formatUserPreferencesBlock(params.sessionKey)
    : "";
  const evolveBlock = blueprint.enablePromptEvolution ? getPromptPatchesForStage("sql") : "";
  const routeBlock = String(params.routeHint ?? "").trim();
  const joinBlock = buildJoinContextBlock({
    tables: params.schemaGround?.candidate_tables ?? [],
    relations: params.schemaGround?.relations,
    queryPlan: params.queryPlan,
  });
  const relaxNote = params.relaxed
    ? "\n[重试提示] 上次无结果：必须保留姓名/专有名词过滤，禁止去掉 WHERE 中的姓名条件。可尝试 LIKE '%名%' 或适当放宽时间范围。"
    : "";
  const guardNote = params.guardRetry
    ? "\n[纠正] 上次 SQL 未落实查询计划中的姓名/地区过滤，或误用扩展从表；请只查主记录表并加上姓名与地区 WHERE（禁止只按年龄统计全市）。"
    : "";

  const shapeBlock = formatExecutionShapeForSqlAgent(params.executionShape);
  const context = [planBlock, shapeBlock, preBlock, schemaBlock, joinBlock, routeBlock, prefBlock, experienceBlock, templateBlock, evolveBlock, relaxNote, guardNote]
    .filter(Boolean)
    .join("\n\n");
  if (!schemaBlock.trim()) return { ok: false, reason: "no_schema_ground" };

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", DIRECT_SYSTEM],
    ["human", DIRECT_HUMAN],
  ]);

  let extracted = "";
  let effectivePreflight = params.preflight;
  let usedPlanDirect = false;

  if (blueprint.enableSqlPlanDirect && !params.guardRetry && !params.relaxed) {
    const merged = await trySqlPlanDirect({
      model: params.model,
      question: q,
      queryPlan: params.queryPlan,
      preflight: params.preflight,
      schemaGround: params.schemaGround,
      routeHint: params.routeHint,
      executionShape: params.executionShape,
    });
    if (merged && "clarify" in merged) {
      return { ok: false, reason: "needs_clarification" };
    }
    if (merged?.sql) {
      extracted = extractSqlFromLlmOutput(merged.sql);
      effectivePreflight = merged.preflight;
      usedPlanDirect = Boolean(extracted);
    }
  }

  if (!extracted) {
    let rawSql = "";
    try {
      rawSql = await RunnableSequence.from([prompt, params.model, new StringOutputParser()]).invoke({
        context: clipText(context, getDbAgentBlueprintEnv().sqlDirectMaxContextChars),
        question: q,
      });
      incrementLlmCallCount(1);
    } catch (e: any) {
      return { ok: false, reason: `llm_error:${String(e?.message ?? e)}` };
    }
    extracted = extractSqlFromLlmOutput(rawSql);
  }

  const judge = params.schemaGround?.table_judge;
  const judgeTables = [...(judge?.primary_tables ?? []), ...(judge?.auxiliary_tables ?? [])];
  const tableComments = judgeTables.length ? await loadTableComments(params.ds, judgeTables) : {};
  const validated = validateGeneratedSelectSql(extracted, {
    queryPlan: params.queryPlan,
    preflight: effectivePreflight,
    judge,
    tableComments,
  }, { extract: false });
  if (!validated.ok) {
    if (validated.stage === "plan_guard" || validated.stage === "schema_guard") {
      if (!params.guardRetry && validated.hint) {
        return runSqlDirect({
          ...params,
          routeHint: `${params.routeHint ?? ""}\n${validated.hint}`.trim(),
          guardRetry: true,
        });
      }
      return { ok: false, reason: formatSqlValidationFailure(validated.stage, validated.reason) };
    }
    return { ok: false, reason: formatSqlValidationFailure(validated.stage, validated.reason) };
  }

  if (
    planWantsFullRecordFields(params.queryPlan, q, params.executionShape) &&
    sqlLooksLikePartialDetailSelect(validated.sql) &&
    !params.guardRetry
  ) {
    return runSqlDirect({
      ...params,
      routeHint: `${params.routeHint ?? ""}\n明细/记录类问题须 SELECT * 或等价全列，禁止只选少数指标列。`.trim(),
      guardRetry: true,
    });
  }

  const withHint = prepareSelectForExecution(validated.sql, rowLimit);

  let explainInsights: string[] = [];
  if (getDbAgentBlueprintEnv().enableExplainPreflight) {
    explainInsights = await runExplainPreflight(params.ds, withHint);
  }

  let rows: any[] = [];
  try {
    rows = (await params.ds.query(withHint)) as any[];
  } catch (e: any) {
    return { ok: false, reason: `exec_error:${String(e?.message ?? e).slice(0, 120)}` };
  }

  if (rowsLookEmpty(rows)) {
    if (scalarShape) {
      const linkedRetry = await tryScalarSchemaLinkedQuery({
        model: params.model,
        ds: params.ds,
        question: q,
        queryPlan: params.queryPlan,
        schemaGround: params.schemaGround,
        executionShape: "scalar_lookup",
      });
      if (linkedRetry.ok) {
        const answer = await buildSqlDirectAnswer(
          params.ds,
          linkedRetry.rows,
          answerOpts(params, linkedRetry.sql, { executionShape: "scalar_lookup" }),
        );
        recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: "schema_link_scalar_retry" });
        return { ok: true, answer, sql: linkedRetry.sql, rowCount: linkedRetry.rows.length };
      }
    }
    recordQueryMetric({ path: "sql_direct", ok: false, empty: true, reason: "empty_result" });
    const personName = resolvePersonNameFromPlanOrQuestion(params.queryPlan ?? ({} as QueryPlan), q);
    if (personName && isPersonEntityPlan(params.queryPlan)) {
      return { ok: false, reason: "empty_result_named" };
    }
    return { ok: false, reason: "empty_result" };
  }

  const answer = await buildSqlDirectAnswer(params.ds, rows, answerOpts(params, withHint));
  recordQueryMetric({
    path: "sql_direct",
    ok: true,
    empty: false,
    reason: usedPlanDirect ? "sql_plan_direct" : undefined,
  });
  if (explainInsights.length) stashExplainPreflight(explainInsights);
  if (blueprint.enableSqlTemplateLearning) {
    recordSqlTemplate({
      question: q,
      sql: withHint,
      data_domain: params.queryPlan?.data_domain,
      tables: params.schemaGround?.table_judge?.primary_tables?.length
        ? params.schemaGround.table_judge.primary_tables
        : params.schemaGround?.candidate_tables,
    });
    setRunMeta({
      ...(getRunMeta() ?? { path: "sql_direct" }),
      executed_sql: withHint,
    });
  }
  return { ok: true, answer, sql: withHint, rowCount: rows.length, explain_insights: explainInsights };
}
