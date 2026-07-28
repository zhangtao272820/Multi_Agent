/**
 * Graph 执行后的后处理：metrics / learning / 友好兜底回复。
 */
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { getDbAgentBlueprintEnv, DB_AGENT_DEFAULTS } from "../db_agent_env";
import { clipText, parseQueryPlan } from "../nlu";
import { parseManagerDbTaskFromJson, shouldSuppressDbHistory } from "../manager_task_context";
import { sanitizeIncomingQuestion } from "../incoming_question";
import { trimChatHistoryForModel } from "../nlu";
import {
  consumeExplainPreflight,
  consumeQueryTier,
  getLastRunContext,
  getRunMeta,
  setRunMeta,
} from "../query_metrics";
import { recordLearningSignal, readLearningSignals } from "../query_learning";
import { buildClarificationSuggestions } from "../clarification_hints";
import { runLightweightCuratorOnQueryEnd } from "../learning_curator";
import { learnFromSuccessfulQuery } from "../user_preferences";
import { incrementLlmCallCount, getLlmCallCount, resetLlmCallCount } from "../llm_call_counter";
import { composeFriendlyAssistantReply, reflectOnQueryFailure } from "../query_reflect";
import {
  inferCausalFailureTag,
  recordRouteDecisionOutcome,
  refreshRoutePreferencesFromSignals,
  type RouteDecision,
} from "../route";

export type PostGraphDeps = {
  model: BaseLanguageModel;
  largerModel?: BaseLanguageModel;
  embeddingConfig: {
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    embeddingModel?: string;
    embeddingDimensions: number;
  };
};

export function createPrepareGraphInput() {
  return (input: any) => {
      let manager_task_json = "";
      if (typeof input?.manager_task_json === "string" && String(input.manager_task_json).trim()) {
        manager_task_json = String(input.manager_task_json).trim();
      } else if (input?.managerTask && typeof input.managerTask === "object") {
        try {
          manager_task_json = JSON.stringify(input.managerTask);
        } catch {
          manager_task_json = "";
        }
      }
      resetLlmCallCount();
      return {
        question: clipText(
          sanitizeIncomingQuestion(String(input?.question ?? "")),
          getDbAgentBlueprintEnv().maxModelInputChars,
        ),
        chat_history: (() => {
          const env = getDbAgentBlueprintEnv();
          const mgrTask = parseManagerDbTaskFromJson(String(input?.manager_task_json || ""));
          if (shouldSuppressDbHistory(mgrTask)) return [];
          return trimChatHistoryForModel(
            input?.chat_history ?? [],
            env.chatHistoryMaxMessages,
            env.chatHistoryMaxChars,
            env.chatHistoryMessageMaxChars,
          );
        })(),
        manager_task_json,
        session_id: String(input?.session_id ?? input?.sessionId ?? "").trim(),
        bypass_task_stack: Boolean(input?.bypass_task_stack),
      };
  };
}

export function createPostGraphStep(deps: PostGraphDeps) {
  const { model, largerModel, embeddingConfig } = deps;
  return async (state: any) => {
      const ans = String(state?.answer ?? "").trim();
      const question = String(state.standalone_question || state.question || "").trim();
      const plan = parseQueryPlan(state.query_plan_json);
      const empty =
        !ans ||
        /没有查到|未查询到|未找到|无记录|暂无数据|查询结果为空|暂未找到|没有数据/.test(ans) ||
        ans.length < 8;
      const ctx = getLastRunContext();
      const path = ctx?.path || "other";
      const tables = (() => {
        try {
          const g = JSON.parse(String(state.schema_ground_json || "{}"));
          return Array.isArray(g?.candidate_tables) ? g.candidate_tables : [];
        } catch {
          return [];
        }
      })();
      let routeReason = "";
      let primaryTables: string[] = [];
      try {
        const g = JSON.parse(String(state.schema_ground_json || "{}"));
        primaryTables = Array.isArray(g?.table_judge?.primary_tables) ? g.table_judge.primary_tables : [];
        const rp = JSON.parse(String(state.route_policy_json || "{}"));
        routeReason = String(rp?.reasons?.[0] || "");
      } catch {
        routeReason = "";
      }
      const blueprintEnv = getDbAgentBlueprintEnv();
      const failReason = String(state.sql_direct_fail_reason || ctx?.reason || "").trim();
      const errorCode = (() => {
        if (!empty) return undefined;
        if (failReason === "no_schema_ground" || (!tables.length && !primaryTables.length && !ans)) {
          return "schema_miss";
        }
        if (failReason.includes("timeout")) return "timeout";
        if (failReason.includes("empty") || empty) return "empty_result";
        return "business";
      })();
      setRunMeta({
        path,
        data_domain: plan.data_domain,
        intent: plan.intent,
        candidate_tables: tables.length ? tables : ctx?.tables,
        primary_tables: primaryTables,
        route_reason: routeReason,
        explore_skipped: blueprintEnv.enableExplore === false || primaryTables.length > 0,
        sql_direct_tried:
          path === "sql_direct" ||
          Boolean(String(state.sql_preflight_json || "").trim()) ||
          blueprintEnv.enableSqlDirect,
        needs_clarification: false,
        explain_preflight: consumeExplainPreflight(),
        domain: blueprintEnv.domain,
        profile: blueprintEnv.profile,
        agent_fallback: path === "sql_agent",
        query_ir_used: /query_ir/.test(String(ctx?.reason ?? "")),
        turn_scope_mode: (() => {
          try {
            const mgr = parseManagerDbTaskFromJson(String(state.manager_task_json || ""));
            return mgr?.turn_scope?.mode;
          } catch {
            return undefined;
          }
        })(),
        context_history_turns: Array.isArray(state.chat_history) ? (state.chat_history as unknown[]).length : 0,
        ...((): { query_tier?: string; query_tier_source?: string } => {
          const qt = consumeQueryTier();
          return qt ? { query_tier: qt.tier, query_tier_source: qt.source } : {};
        })(),
        sql_template_direct: /sql_template_direct/.test(String(ctx?.reason ?? "")),
        sql_plan_direct: /sql_plan_direct/.test(String(ctx?.reason ?? "")),
        structural_plan_used: Boolean(state.structural_plan_used),
        manager_plan_used: Boolean(state.manager_plan_used),
        llm_calls: getLlmCallCount(),
        // D1：空结果/失败码写入 meta；后续友好话术不得冲掉
        empty,
        error_code: errorCode,
        fail_reason: empty ? failReason || "empty_or_weak_answer" : undefined,
      });

      const clarified = String(state.clarification_question || "").trim();
      if (clarified && ans === clarified) {
        const suggestions = buildClarificationSuggestions({
          clarificationQuestion: clarified,
          missingSlots: plan.missing_slots,
          lastUserQuestion: question,
        });
        setRunMeta({
          path: "clarify",
          needs_clarification: true,
          clarification_question: clarified,
          missing_slots: plan.missing_slots,
          clarification_suggestions: suggestions,
          data_domain: plan.data_domain,
          intent: plan.intent,
          empty: false,
          error_code: "needs_clarify",
          fail_reason: "needs_clarification",
        });
      }

      if (!empty && blueprintEnv.enableUserPreferences && question) {
        try {
          learnFromSuccessfulQuery({
            sessionKey: String(state.session_id || ""),
            question,
            plan,
          });
        } catch {
          /* ignore */
        }
      }

      const causalTag =
        empty && blueprintEnv.enableRoutePolicy
          ? inferCausalFailureTag({
              path,
              data_domain: plan.data_domain,
              tables: tables.length ? tables : ctx?.tables,
              empty,
              reason: empty ? "empty_or_weak_answer" : undefined,
            })
          : null;

      if (blueprintEnv.enableQueryLearning && question) {
        recordLearningSignal(
          {
            question,
            path,
            ok: !empty,
            empty,
            data_domain: plan.data_domain,
            intent: plan.intent,
            tables: tables.length ? tables : ctx?.tables,
            reason: causalTag || (empty ? "empty_or_weak_answer" : "ok"),
          },
          { embeddingConfig },
        );
        if (DB_AGENT_DEFAULTS.enableRoutePolicy) {
          try {
            refreshRoutePreferencesFromSignals(readLearningSignals(600));
          } catch {
            /* ignore */
          }
        }
        runLightweightCuratorOnQueryEnd();
      }

      if (DB_AGENT_DEFAULTS.enableRoutePolicy && question) {
        try {
          const rp = String(state.route_policy_json || "").trim();
          if (rp) {
            const stored = JSON.parse(rp) as {
              contextKey?: string;
              executionPath?: string;
              alignment?: RouteDecision["alignment"];
            };
            if (stored.contextKey && stored.executionPath) {
              recordRouteDecisionOutcome({
                question,
                decision: {
                  intent: String(state.intent || ""),
                  executionPath: stored.executionPath as RouteDecision["executionPath"],
                  refinedPlan: plan,
                  hintBlock: "",
                  reasons: [],
                  alignment: stored.alignment ?? {
                    hasHealthTable: false,
                    hasPersonMaster: false,
                    hasHealthJoin: false,
                    hasPersonHealthRecords: false,
                    hasFootPressureTable: false,
                    domainMismatch: false,
                    causalTags: [],
                    schemaConfidence: 0,
                  },
                  skipSqlDirect: Boolean(state.route_skip_sql_direct),
                  contextKey: stored.contextKey,
                  pathScores: {},
                },
                ok: !empty,
                empty,
              });
            }
          }
        } catch {
          /* ignore */
        }
      }

      if (
        empty &&
        getDbAgentBlueprintEnv().enablePromptEvolution &&
        getDbAgentBlueprintEnv().enableFailureReflect &&
        question.length >= getDbAgentBlueprintEnv().failureReflectMinQuestionChars &&
        largerModel
      ) {
        try {
          const hint = await reflectOnQueryFailure(largerModel ?? model, {
            question,
            path,
            data_domain: plan.data_domain,
            reason: "empty_or_wrong",
            tables: tables.length ? tables : ctx?.tables,
          });
          if (hint && !ans) {
            incrementLlmCallCount(1);
            const friendly = await composeFriendlyAssistantReply(largerModel ?? model, {
              kind: "query_failed",
              question,
              path,
              data_domain: plan.data_domain,
              reason: causalTag || "empty_or_wrong",
              tables: tables.length ? tables : ctx?.tables,
              internal_hint: hint,
            });
            if (friendly) return friendly;
          }
        } catch {
          /* ignore */
        }
      }

      if (!ans) {
        incrementLlmCallCount(1);
        const failReason = String(state.sql_direct_fail_reason || "").trim();
        const kind =
          plan.intent === "out_of_scope"
            ? "out_of_scope"
            : failReason === "no_schema_ground" || (!tables.length && !primaryTables.length)
              ? "no_schema"
              : "empty_query";
        const friendly = await composeFriendlyAssistantReply(largerModel ?? model, {
          kind,
          question,
          path,
          data_domain: plan.data_domain,
          reason: failReason || causalTag || "empty_or_weak_answer",
          tables: tables.length ? tables : primaryTables,
        });
        if (friendly) return friendly;
      }

      return ans;
  };
}
