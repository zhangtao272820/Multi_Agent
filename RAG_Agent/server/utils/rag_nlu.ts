/**
 * RAG NLU：目录锚定查询理解 + 侧车合并（通用，适用任意领域问法）。
 */
import type { ManagerRagTaskPayload } from "#agent-shared/managerSubAgentProtocol";
import { splitCompoundQueries } from "#agent-shared/managerSubAgentProtocol";
import type { RagQueryPlan, RagQueryIntent } from "./query_plan";
import {
  defaultRagQueryPlan,
  heuristicRagQueryPlan,
  planNeedsDeepRetrieval,
} from "./query_plan";
import {
  buildCatalogGroundedQueryPlan,
  buildDialogContextBlock,
  enrichHeuristicPlanWithCatalog,
  inferRagIntentLlm,
  inferRetrievalKeywordsLlm,
  isCatalogGroundedPlanEnabled,
  shouldUseCatalogLlmPlan,
  type RagDialogContext,
} from "./query_plan_builder";
import { RAG_INTENT_PLAYBOOK } from "./rag_intent_playbook";
import { recallRagExperience } from "./experience_vectors";
import { enrichRagQuerySensitivity } from "./rag_text_sensitivity";
import { getRagAgentEnv } from "./rag_agent_env";
import type { RagMergedUnderstandResult } from "./rag_merged_understand";
import {
  anchorBoostForRagRecall,
  type RagSessionRetrievalAnchor,
} from "./rag_multi_turn";
import { isRagNluFeatureEnabled, isRagHeuristicAllowed, resolveRagNluMode } from "./rag_nlu_mode";

export type { RagDialogContext };
export { buildDialogContextBlock, planNeedsDeepRetrieval };

export type RagIntentRecallHit = {
  id: string;
  score: number;
  intent: string;
  matched_text: string;
  retrieval_keywords: string[];
};

function tokenBag(text: string): Set<string> {
  const norm = String(text || "").toLowerCase();
  const parts = norm.match(/[\u4e00-\u9fff]+|[a-z]+|\d+/g) || [];
  return new Set(parts.slice(0, 160));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

export function isRagIntentRecallEnabled(): boolean {
  return isRagNluFeatureEnabled("intent_rag");
}

export function recallRagIntentPlaybook(
  query: string,
  sessionAnchor?: RagSessionRetrievalAnchor | null,
): RagIntentRecallHit | null {
  const q = String(query || "").trim();
  if (!q || q.length < 4 || !isRagIntentRecallEnabled()) return null;
  const bag = tokenBag(q);
  let best: RagIntentRecallHit | null = null;
  for (const entry of RAG_INTENT_PLAYBOOK) {
    for (const p of entry.paraphrases) {
      let score = jaccard(bag, tokenBag(p));
      score += anchorBoostForRagRecall({ intent: entry.intent }, sessionAnchor);
      if (!best || score > best.score) {
        best = {
          id: entry.id,
          score,
          intent: entry.intent,
          matched_text: p,
          retrieval_keywords: entry.retrieval_keywords,
        };
      }
    }
  }
  return best && best.score >= 0.22 ? best : null;
}

function intentFromManagerTask(task: ManagerRagTaskPayload | null | undefined): RagQueryIntent | null {
  const raw = String(task?.query_intent || "").trim() as RagQueryIntent;
  const valid = new Set([
    "definition",
    "process",
    "comparison",
    "fact_lookup",
    "multi_part",
    "quote",
    "doc_list",
    "out_of_scope",
    "unknown",
  ]);
  return valid.has(raw) ? raw : null;
}

/** Call-Fusion：总管侧车已含 lean_query / intent / keywords 时跳过 catalog LLM */
export function buildOrchestratedRagQueryPlanFromManagerTask(
  task: ManagerRagTaskPayload,
): RagQueryPlan | null {
  const lean = String(task.lean_query ?? "").trim();
  if (!lean || lean.length < 4) return null;
  const subs = task.sub_queries?.length ? task.sub_queries.slice(0, 6) : [lean];
  const mgrIntent = intentFromManagerTask(task);
  let intent: RagQueryIntent = mgrIntent ?? "fact_lookup";
  if (subs.length >= 2) intent = "multi_part";
  return {
    ...defaultRagQueryPlan(),
    intent,
    sub_queries: subs,
    retrieval_keywords: task.retrieval_keywords?.length ? [...task.retrieval_keywords].slice(0, 12) : [],
    confidence: 0.82,
  };
}

export function shouldUseOrchestratedRagPlanFusion(
  task: ManagerRagTaskPayload | null | undefined,
): boolean {
  return task?.source === "manager" && String(task?.lean_query ?? "").trim().length >= 4;
}

/** 将总管侧车 + 意图 RAG 召回合并进 QueryPlan */
export function mergeManagerTaskIntoPlan(
  plan: RagQueryPlan,
  task: ManagerRagTaskPayload | null | undefined,
  recall?: RagIntentRecallHit | null,
): RagQueryPlan {
  if (!task && !recall) return plan;
  const out = { ...plan, entities: { ...plan.entities } };
  if (task?.sub_queries?.length) {
    out.sub_queries = task.sub_queries.slice(0, 6);
    out.intent = out.intent === "unknown" ? "multi_part" : out.intent;
    out.confidence = Math.max(out.confidence, 0.72);
  }
  if (task?.retrieval_keywords?.length) {
    out.retrieval_keywords = Array.from(
      new Set([...out.retrieval_keywords, ...task.retrieval_keywords]),
    ).slice(0, 12);
  }
  if (recall?.retrieval_keywords?.length) {
    out.retrieval_keywords = Array.from(
      new Set([...out.retrieval_keywords, ...recall.retrieval_keywords]),
    ).slice(0, 12);
  }
  const mgrIntent = intentFromManagerTask(task);
  if (mgrIntent && out.intent === "unknown") out.intent = mgrIntent;
  // playbook 仅 hint 关键词，不单独改 intent（LLM-First §6 RG-P1-5）
  if (task?.scope_hint) {
    const topics = task.scope_hint
      .split(/[，,；;、\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2)
      .slice(0, 6);
    out.entities.topics = Array.from(new Set([...out.entities.topics, ...topics])).slice(0, 8);
  }
  return out;
}

export function buildRagDialogContext(input: {
  merged?: RagMergedUnderstandResult | null;
  sessionAnchor?: RagSessionRetrievalAnchor | null;
  sessionSummary?: string;
  recentDialog?: string;
}): RagDialogContext {
  return {
    sessionSummary: String(input.sessionSummary || "").trim() || undefined,
    recentDialog: String(input.recentDialog || "").trim() || undefined,
    mergedQuery: input.merged?.effectiveQuery,
    mergedKeywords: input.merged?.retrievalKeywords,
    sessionAnchor: input.sessionAnchor?.coalescedTask,
  };
}

export type RagUnderstandResult = {
  plan: RagQueryPlan;
  effectiveQuery: string;
  intentRecall: RagIntentRecallHit | null;
  experienceHits: number;
  multiTurn?: boolean;
  mergeSource?: string;
  planSource?: "catalog_llm" | "plan_llm" | "heuristic" | "probe";
  needsDeepRetrieval?: boolean;
};

/**
 * RAG 主理解入口：对话上下文 + 目录锚定 plan → 侧车合并。
 */
export async function understandRagQuery(input: {
  query: string;
  rawMessage?: string;
  managerTask?: ManagerRagTaskPayload | null;
  merged?: RagMergedUnderstandResult | null;
  sessionAnchor?: RagSessionRetrievalAnchor | null;
  dialogContext?: RagDialogContext | null;
  docCatalog?: { name: string; summary?: string }[];
  fast?: boolean;
  probeMode?: boolean;
  /** retrieve-first 已算好的 plan，避免二次 catalog LLM */
  prefetchedPlan?: RagQueryPlan;
  prefetchedLeanQuery?: string;
  prefetchedPlanSource?: RagUnderstandResult["planSource"];
}): Promise<RagUnderstandResult> {
  const env = getRagAgentEnv({ docCount: input.docCatalog?.length });
  const task = input.managerTask;
  const merged = input.merged;
  const raw = String(input.rawMessage || input.query || "").trim();
  const baseQuery =
    merged?.effectiveQuery ||
    task?.lean_query ||
    String(input.query || "").trim();
  let effectiveQuery = enrichRagQuerySensitivity(baseQuery, raw);
  if (!effectiveQuery) effectiveQuery = raw;

  const dialogContext =
    input.dialogContext ??
    buildRagDialogContext({
      merged,
      sessionAnchor: input.sessionAnchor,
    });

  const structuralSubs = task?.sub_queries?.length
    ? task.sub_queries
    : splitCompoundQueries(effectiveQuery);

  let plan: RagQueryPlan;
  let planSource: RagUnderstandResult["planSource"] = "heuristic";
  let intentRecall: RagIntentRecallHit | null = null;

  const hasDialogContext = Boolean(
    dialogContext?.recentDialog || dialogContext?.sessionSummary || dialogContext?.mergedQuery,
  );

  const orchestratedFused =
    !input.prefetchedPlan && task && shouldUseOrchestratedRagPlanFusion(task)
      ? buildOrchestratedRagQueryPlanFromManagerTask(task)
      : null;

  if (input.prefetchedPlan) {
    plan = input.prefetchedPlan;
    planSource = input.prefetchedPlanSource ?? "heuristic";
    if (String(input.prefetchedLeanQuery || "").trim().length >= 4) {
      effectiveQuery = enrichRagQuerySensitivity(String(input.prefetchedLeanQuery).trim(), raw);
    }
    if (structuralSubs.length >= 2 && plan.sub_queries.length < 2) {
      plan.sub_queries = structuralSubs.slice(0, env.retrieveFirstMaxSubQueries || 4);
      plan.intent = "multi_part";
    }
  } else if (orchestratedFused && task) {
    const recall = recallRagIntentPlaybook(effectiveQuery, input.sessionAnchor);
    plan = mergeManagerTaskIntoPlan(orchestratedFused, task, recall);
    planSource = "plan_llm";
    effectiveQuery = enrichRagQuerySensitivity(String(task.lean_query).trim(), raw);
  } else if (input.probeMode || (input.fast && isRagHeuristicAllowed())) {
    plan = enrichHeuristicPlanWithCatalog(
      heuristicRagQueryPlan(effectiveQuery),
      effectiveQuery,
      input.docCatalog ?? [],
    );
    planSource = input.probeMode ? "probe" : "heuristic";
    intentRecall = recallRagIntentPlaybook(effectiveQuery, input.sessionAnchor);
    if (structuralSubs.length >= 2) {
      plan.sub_queries = structuralSubs.slice(0, env.retrieveFirstMaxSubQueries || 4);
      plan.intent = "multi_part";
    }
  } else if (
    isCatalogGroundedPlanEnabled() &&
    shouldUseCatalogLlmPlan({
      docCount: input.docCatalog?.length ?? 0,
      hasDialogContext,
      mergedSource: merged?.source,
      heuristicConfidence: heuristicRagQueryPlan(effectiveQuery).confidence,
      subQueryCount: structuralSubs.length,
      intent: heuristicRagQueryPlan(effectiveQuery).intent,
      prefetched: Boolean(input.prefetchedPlan),
    })
  ) {
    const grounded = await buildCatalogGroundedQueryPlan(effectiveQuery, {
      rawMessage: raw,
      docCatalog: input.docCatalog,
      managerTask: task,
      dialogContext,
    });
    plan = grounded.plan;
    planSource = grounded.source === "llm" ? "catalog_llm" : "heuristic";
    if (grounded.leanQuery.length >= 4) {
      effectiveQuery = enrichRagQuerySensitivity(grounded.leanQuery, raw);
    }
    if (structuralSubs.length >= 2 && plan.sub_queries.length < 2) {
      plan.sub_queries = structuralSubs.slice(0, env.retrieveFirstMaxSubQueries || 4);
      plan.intent = "multi_part";
    }
    if (planSource !== "catalog_llm" || plan.confidence < 0.55) {
      intentRecall = recallRagIntentPlaybook(effectiveQuery, input.sessionAnchor);
    }
    if (
      plan.intent === "unknown" ||
      (planSource === "catalog_llm" && plan.confidence < 0.55)
    ) {
      const intentOnly = await inferRagIntentLlm(effectiveQuery, { dialogContext }).catch(() => null);
      if (intentOnly && intentOnly.confidence >= 0.52) {
        plan = {
          ...plan,
          intent: intentOnly.intent,
          confidence: Math.max(plan.confidence, intentOnly.confidence),
        };
      }
    }
  } else if (isRagHeuristicAllowed()) {
    plan = enrichHeuristicPlanWithCatalog(
      heuristicRagQueryPlan(effectiveQuery),
      effectiveQuery,
      input.docCatalog ?? [],
    );
    planSource = "heuristic";
    intentRecall = recallRagIntentPlaybook(effectiveQuery, input.sessionAnchor);
    if (structuralSubs.length >= 2) {
      plan.sub_queries = structuralSubs.slice(0, env.retrieveFirstMaxSubQueries || 4);
      plan.intent = "multi_part";
    }
  } else {
    plan = { ...defaultRagQueryPlan(), sub_queries: structuralSubs.length >= 2 ? structuralSubs.slice(0, 4) : [] };
    planSource = "catalog_llm";
    if (structuralSubs.length >= 2) plan.intent = "multi_part";
  }

  plan = mergeManagerTaskIntoPlan(plan, task, intentRecall);
  if (merged?.retrievalKeywords?.length) {
    plan.retrieval_keywords = Array.from(
      new Set([...plan.retrieval_keywords, ...merged.retrievalKeywords]),
    ).slice(0, 12);
  }
  if (merged?.topics?.length) {
    plan.entities.topics = Array.from(
      new Set([...plan.entities.topics, ...merged.topics]),
    ).slice(0, 8);
  }

  let experienceHits = 0;
  if (!input.probeMode && env.enableVectorExperience && !input.fast) {
    const recalls = await recallRagExperience(effectiveQuery, 2).catch(() => []);
    experienceHits = recalls.length;
    for (const r of recalls) {
      if (r.hint) {
        plan.retrieval_keywords = Array.from(new Set([...plan.retrieval_keywords, r.hint])).slice(0, 12);
      }
    }
  }

  if (!plan.sub_queries.length && plan.intent === "multi_part") {
    const subs = splitCompoundQueries(effectiveQuery);
    if (subs.length >= 2) plan.sub_queries = subs.slice(0, 4);
  }

  if (!plan.sub_queries.length && effectiveQuery) {
    plan.sub_queries = [effectiveQuery];
  }

  if (
    resolveRagNluMode() === "full" &&
    !input.probeMode &&
    !input.prefetchedPlan &&
    plan.retrieval_keywords.length < 2 &&
    effectiveQuery.length >= 4 &&
    planSource !== "heuristic" &&
    planSource !== "probe"
  ) {
    const kw = await inferRetrievalKeywordsLlm(effectiveQuery, {
      intent: plan.intent,
      dialogContext: buildDialogContextBlock(dialogContext),
    }).catch(() => null);
    if (kw?.retrieval_keywords?.length) {
      plan.retrieval_keywords = Array.from(
        new Set([...plan.retrieval_keywords, ...kw.retrieval_keywords]),
      ).slice(0, 12);
    }
    if (kw?.topics?.length) {
      plan.entities.topics = Array.from(new Set([...plan.entities.topics, ...kw.topics])).slice(0, 8);
    }
  }

  return {
    plan,
    effectiveQuery,
    intentRecall,
    experienceHits,
    multiTurn: merged?.multiTurn,
    mergeSource: merged?.source,
    planSource,
    needsDeepRetrieval: planNeedsDeepRetrieval(plan, planSource),
  };
}

export function defaultUnderstandFallback(query: string): RagUnderstandResult {
  const q = String(query || "").trim();
  const plan = q
    ? isRagHeuristicAllowed()
      ? heuristicRagQueryPlan(q)
      : { ...defaultRagQueryPlan(), sub_queries: q ? [q] : [] }
    : defaultRagQueryPlan();
  return {
    plan,
    effectiveQuery: q,
    intentRecall: null,
    experienceHits: 0,
    planSource: isRagHeuristicAllowed() ? "heuristic" : "catalog_llm",
    needsDeepRetrieval: planNeedsDeepRetrieval(plan, isRagHeuristicAllowed() ? "heuristic" : "catalog_llm"),
  };
}
