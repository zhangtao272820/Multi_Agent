import type { GraphNode } from "@langchain/langgraph";
import { sanitizeCondensedQuestion } from "../../nlu";
import { sanitizeIncomingQuestion } from "../../incoming_question";
import { incrementLlmCallCount } from "../../llm_call_counter";
import {
  parseManagerDbTaskFromJson,
  resolveManagerStandaloneQuestion,
  shouldSuppressDbHistory,
} from "../../manager_task_context";
import {
  isolateManagerDbQuestionByLlm,
  pickManagerDbStandaloneQuestion,
  shouldSkipManagerDbQuestionIsolate,
  stripManagerUpstreamContext,
} from "../../manager_question_isolate";
import {
  judgeManagerPrefetchTrustByLlm,
  sanitizeUntrustedManagerTask,
} from "../../manager_prefetch_trust";
import { resolveNeedsCondense } from "../../nlu/dbCondenseLlm";
import type { DbGraphState } from "../state";
import type { DbGraphEarlyDeps } from "../types";
import { groundFollowupQuery, shouldGroundFollowupQuery } from "#agent-shared/followupQueryGrounding";
import { parseTurnScopePayload } from "#agent-shared/turnScope";

function priorUserFromHistory(hist: any[], question: string): string {
  const q = String(question || "").trim();
  const humans = (hist || [])
    .filter((m: any) => {
      const r = String(m?.role || m?._getType?.() || "").toLowerCase();
      return r === "user" || r === "human";
    })
    .map((m: any) => String(m?.content ?? m?.kwargs?.content ?? "").trim())
    .filter(Boolean);
  if (!humans.length) return "";
  const last = humans[humans.length - 1];
  return last === q && humans.length >= 2 ? humans[humans.length - 2] : last === q ? "" : last;
}

export function createCondenseNode(deps: DbGraphEarlyDeps): GraphNode<typeof DbGraphState> {
  const { model, nluModel, progress, standaloneQuestionChain } = deps;
  const condenseModel = (nluModel ?? model) as import("@langchain/openai").ChatOpenAI;

  return async (state) => {
    if (state.answer) return {};
    let mgr = parseManagerDbTaskFromJson(String(state.manager_task_json || ""));
    const rawQ = sanitizeIncomingQuestion(String(state.question ?? "").trim());

    if (mgr?.source === "manager" && rawQ) {
      const skipIsolate = shouldSkipManagerDbQuestionIsolate(mgr, rawQ);
      const isolated = skipIsolate
        ? null
        : await isolateManagerDbQuestionByLlm(condenseModel, rawQ, mgr);
      const sq = pickManagerDbStandaloneQuestion(rawQ, mgr, isolated);
      const trust = await judgeManagerPrefetchTrustByLlm(condenseModel, sq, mgr);
      mgr = sanitizeUntrustedManagerTask(mgr, trust) ?? mgr;
      if (mgr.refined_question) {
        mgr = { ...mgr, refined_question: stripManagerUpstreamContext(mgr.refined_question) };
      }
      const standalone = sanitizeIncomingQuestion(sq);
      return {
        standalone_question: standalone,
        manager_task_json: JSON.stringify(mgr),
      };
    }

    if (mgr?.refined_question?.trim()) {
      const sq = resolveManagerStandaloneQuestion(rawQ, mgr);
      return { standalone_question: sanitizeIncomingQuestion(sq) };
    }
    const q = sanitizeIncomingQuestion(String(state.question ?? "").trim());
    if (shouldSuppressDbHistory(mgr)) return { standalone_question: q };

    const scope = parseTurnScopePayload(mgr?.turn_scope) || null;
    const hist = state.chat_history as any;
    const histArr = Array.isArray(hist) ? hist : [];
    const anchorTask = priorUserFromHistory(histArr, q);
    const turnKind = scope?.turn_kind || undefined;

    const shouldCondense = await resolveNeedsCondense(condenseModel, q);
    if (!shouldCondense) {
      if (shouldGroundFollowupQuery({ turnKind, lastUser: q, anchorTask })) {
        return {
          standalone_question: sanitizeIncomingQuestion(
            groundFollowupQuery({ lastUser: q, turnKind, anchorTask, candidate: q }),
          ),
        };
      }
      return { standalone_question: q };
    }
    if (histArr.length > 0) {
      const out = await standaloneQuestionChain.invoke({
        chat_history: hist,
        question: q,
      });
      incrementLlmCallCount(1);
      let sq = sanitizeCondensedQuestion(out) || q;
      if (shouldGroundFollowupQuery({ turnKind: turnKind || "continuation", lastUser: q, anchorTask })) {
        sq = groundFollowupQuery({
          lastUser: q,
          turnKind: turnKind || "continuation",
          anchorTask,
          candidate: sq,
        });
      }
      return { standalone_question: sanitizeIncomingQuestion(sq) };
    }
    return { standalone_question: q };
  };
}
