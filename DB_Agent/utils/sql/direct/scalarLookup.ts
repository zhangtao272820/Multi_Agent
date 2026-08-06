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
import {
  isEnumerateRowsMode,
  dedupeEnumerateRows,
  enumerateRowLimit,
  detailEnumerateRowsLookIncomplete,
  shouldRejectIncompleteDetailLink,
} from "../../nlu/dbSchemaLinkResultMode";
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

import {
  buildSqlDirectAnswer,
  answerOpts,
  rowsLookEmpty,
} from "./answerFormat";
import type { SqlDirectResult } from "./types";

export async function runScalarLookupDirect(params: {
  model: BaseLanguageModel;
  formatModel?: BaseLanguageModel | null;
  ds: DataSource;
  question: string;
  queryPlan?: QueryPlan | null;
  schemaGround?: SchemaGroundResult | null;
  executionShape?: QueryExecutionShape | null;
}): Promise<SqlDirectResult> {
  const shape = params.executionShape ?? "scalar_lookup";

  const personAnswer = await runPersonInfoStatsFastPath(params.ds, params.queryPlan, shape);
  if (personAnswer) {
    recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: "person_info_filtered_stats" });
    return {
      ok: true,
      answer: sanitizeAssistantTextForPlan(personAnswer, params.queryPlan),
      sql: "(person_info filtered)",
      rowCount: 1,
    };
  }

  const linked = await tryScalarSchemaLinkedQuery({
    model: params.model,
    ds: params.ds,
    question: params.question,
    queryPlan: params.queryPlan,
    schemaGround: params.schemaGround,
    executionShape: shape,
  });
  if (linked.ok) {
    if (
      shouldRejectIncompleteDetailLink(shape, {
        mode: linked.mode,
        result_cardinality: linked.result_cardinality,
        use_distinct: linked.use_distinct,
      }) &&
      detailEnumerateRowsLookIncomplete(linked.rows)
    ) {
      return { ok: false, reason: "incomplete_detail_link" };
    }
    // JSON 关联 DISTINCT 集合：即使误判 detail_rows，仍按 scalar 出答（列注释标签）
    const answerShape =
      linked.mode === "json_array_join" ||
      linked.result_cardinality === "distinct_set" ||
      linked.use_distinct
        ? ("scalar_lookup" as const)
        : shape;
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

  if (shape === "detail_rows") {
    return { ok: false, reason: "schema_link_detail_failed" };
  }

  const ir = await linkColumnsToQueryIr(params.model, {
    question: params.question,
    queryPlan: params.queryPlan,
    schemaGround: params.schemaGround,
  });
  if (ir) {
    const irGuardCtx = {
      queryPlan: params.queryPlan,
      preflight: null as null,
      judge: params.schemaGround?.table_judge ?? null,
    };
    const compiled = compileQueryIrToSql(ir);
    if (compiled.ok) {
      const irValidated = validateGeneratedSelectSql(compiled.sql, irGuardCtx, { extract: false });
      if (irValidated.ok) {
        const withHint = prepareSelectForExecution(irValidated.sql, 10);
        try {
          const rows = (await params.ds.query(withHint)) as any[];
          if (!rowsLookEmpty(rows)) {
            const answer = await buildSqlDirectAnswer(
              params.ds,
              rows,
              answerOpts(params, withHint, { executionShape: "scalar_lookup" }),
            );
            recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: "query_ir_scalar" });
            return { ok: true, answer, sql: withHint, rowCount: rows.length };
          }
        } catch (e: any) {
          const repaired = await repairSqlWithLlm(params.model, {
            question: params.question,
            sql: withHint,
            error: String(e?.message ?? e),
            queryIr: ir,
            schemaSummary: params.schemaGround?.schema_summary,
          });
          if (repaired) {
            const fixValidated = validateGeneratedSelectSql(repaired, irGuardCtx, { extract: false });
            if (fixValidated.ok) {
              const withHintFix = prepareSelectForExecution(fixValidated.sql, 10);
              try {
                const rows = (await params.ds.query(withHintFix)) as any[];
                if (!rowsLookEmpty(rows)) {
                  const answer = await buildSqlDirectAnswer(
                    params.ds,
                    rows,
                    answerOpts(params, withHintFix, { executionShape: "scalar_lookup" }),
                  );
                  recordQueryMetric({ path: "sql_direct", ok: true, empty: false, reason: "query_ir_scalar_repair" });
                  return { ok: true, answer, sql: withHintFix, rowCount: rows.length };
                }
              } catch {
                /* fall through */
              }
            }
          }
        }
      }
    }
  }

  return { ok: false, reason: linked.reason };
}
