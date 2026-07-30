import { getVectorStore, getUploadedDocuments, searchKeywordCandidates, searchBm25Candidates } from "./vectorStore";
import { looksLikeManagerRetrievalTask, sanitizeIncomingQuestion, parseManagerRagTaskFromJson } from "./incoming_question";
import { buildCompoundSubQueries } from "./query_plan_builder";
import {
  getManagerRagTask,
  getRetrievalUserKey,
  getRetrievalCondenseContext,
  getRagMergedUnderstand,
  isOrchestratedByManager,
} from "./retrieval_context";
import { retrievalQueriesFromPlan, splitCompoundQueries, buildFastPathRetrievalQueries, planNeedsDeepRetrieval } from "./query_plan";
import type { RagQueryPlan } from "./query_plan";
import { understandRagQuery, buildRagDialogContext } from "./rag_nlu";
import { recordRagQueryMetric } from "./query_metrics";
import { getRagAgentEnv } from "./rag_agent_env";
import { createRagChatOpenAI } from "./rag_chat_openai";
import { readAgentLlmJsonMaxTokens } from "#agent-shared/agentLlmSpeed";
import { allowsOrchestratedDialogMerge } from "#agent-shared/turnScope";
import {
  rerankWithCrossEncoderOrLexical,
  shouldSkipLlmRerankAfterCrossEncoder,
} from "./cross_encoder_rerank";
import { getLearningHintsForQuestion } from "./rag_learning";
import { rewriteQueryForAgenticRetrieval, shouldAttemptAgenticRetry } from "./agentic_retrieval";
import { indexRagExperience, recallRagExperience } from "./experience_vectors";
import { getRagPromptPatchesForStage } from "./prompt_evolution";
import {
  formatUserPreferencesBlock,
  getUserPreferences,
  learnFromSuccessfulRetrieval,
} from "./user_preferences";
import { filterTopicsRelevantToQuery } from "./preference_context_gate";
import { extractTopicKeywords } from "./session_memory";
import { ensureQueriesEmbedded, getRagEmbeddings } from "./embedding_query_cache";
import { resolvePromptAbVariant, recordPromptAbObservation } from "./prompt_ab_router";
import {
  sampleRetrievalBanditArm,
  recordRetrievalBanditOutcome,
  localRerankBanditPlan,
  type RetrievalBanditArm,
} from "./retrieval_bandit";
import { resolveRagRetrievalMode, modeUsesTurboRetrieval } from "./rag_retrieval_mode";
import {
  retrieveParallelSubQueryLanes,
  fuseGlobalHybridWithLanes,
} from "./sub_query_retrieval";
import { judgeDocScope, getRagRequestIntent } from "./doc_scope_judge";
import { condenseRetrievalQuery } from "./query_condense";
import { expandDocsToParent } from "./parent_expand";
import { mmrSelect } from "./mmr_select";
import {
  buildClarifyMessage,
  buildExplicitDocNotFoundMessage,
  buildSourceLabel,
  clampText,
  formatClarifyEnvelope,
  normalizeMetadata,
  resolveSourceLabel,
  scoreDocByQueryTerms,
  selectCandidateSources,
  filterEvidenceByQueryFocus,
  tokenizeForKeywordSearch,
  uniqBy,
  planEntityKeywordTerms,
  resolveRetrievalLimits,
  mergeSubQueryCoverage,
  type EvidenceItem,
  type HybridDocRow,
} from "./retrieval_shared";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  buildEvidenceSelectHumanPrompt,
  buildRerankHumanPrompt,
  buildRerankSystemPrompt,
  getRetrievalEvidenceRules,
  getRetrievalExpansionRules,
} from "./rag_playbook_prompts";

const withRetry = async <T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> => {
  try {
    return await fn();
  } catch (error: any) {
    if (retries > 0 && (error?.status === 429 || error?.status >= 500)) {
      await new Promise((r) => setTimeout(r, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

export type DocumentRetrievalResult = {
  output: string;
  effectiveQuery: string;
  plan: RagQueryPlan;
  evidence: EvidenceItem[];
  needsClarify: boolean;
  ms: number;
  routingMode?: string;
  agenticRounds?: number;
  rerankMode?: string;
  clarifyReason?: string;
  /** H4：zero_hits | weak_evidence | ambiguous_low_confidence | … */
  retrievalFailureMode?: string;
  experienceHits?: number;
  abVariant?: string;
  banditArm?: string;
};

const coerceEvidenceJson = (modelTextRaw: string, maxEvidence = 6) => {
  const t = String(modelTextRaw ?? "").trim();
  if (!t) return null as null | { evidence: EvidenceItem[] };
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    const evidence = Array.isArray(parsed?.evidence) ? parsed.evidence : [];
    const cleaned = evidence
      .map((e: any) => ({
        content: String(e?.content ?? e?.quote ?? "").trim(),
        source: String(e?.source ?? "unknown").trim() || "unknown",
      }))
      .filter((e: any) => Boolean(e.content))
      .slice(0, maxEvidence);
    return { evidence: cleaned };
  } catch {
    return null;
  }
};

const buildEvidenceWindow = (textRaw: string, terms: string[]) => {
  const text = String(textRaw ?? "");
  if (!text) return "";
  const lc = text.toLowerCase();
  const uniqTerms = Array.from(new Set((terms ?? []).map((t) => String(t || "").trim()).filter(Boolean)));
  const longFirst = uniqTerms.sort((a, b) => b.length - a.length);
  const primary = longFirst.filter((t) => t.length >= 3);
  let bestIdx = -1;
  for (const t of (primary.length > 0 ? primary : longFirst)) {
    const idx = lc.indexOf(String(t).toLowerCase());
    if (idx >= 0) {
      bestIdx = idx;
      break;
    }
  }
  if (bestIdx < 0) return clampText(text, 900);
  const start = Math.max(0, bestIdx - 420);
  const end = Math.min(text.length, bestIdx + 700);
  return clampText(text.slice(start, end), 900);
};

const routingExplainBlock = (routingDecision: any, routedSources: Set<string>) => {
  const env = getRagAgentEnv();
  if (!env.enableRoutingExplain) return "";
  return [
    "[路由解释]",
    `mode: ${routingDecision.routingMode}`,
    `selected: ${Array.from(routedSources).join(", ") || "(none)"}`,
    `scores: ${routingDecision.debugScores
      .slice(0, 8)
      .map((s: any) => `${s.name}:${s.score.toFixed(2)}(${s.reason})`)
      .join(" | ")}`,
  ].join("\n") + "\n\n";
};

const formatRetrievalOutput = (params: {
  routingDecision: { routingMode?: string; debugScores?: unknown[] };
  routedSources: Set<string>;
  evidence: EvidenceItem[];
  contentFallback?: string;
}) => {
  const explain = routingExplainBlock(params.routingDecision, params.routedSources);
  if (params.evidence.length) {
    return `${explain}[evidence_json]\n${JSON.stringify({ evidence: params.evidence }, null, 2)}`;
  }
  return `${explain}${params.contentFallback || "未找到相关背景信息。"}`;
};

/** 核心文档检索：供 document_query 技能与 /api/retrieve 共用 */
export async function runDocumentRetrieval(input: {
  query: string;
  rawQuery?: string;
  skipLlmRerank?: boolean;
  skipEvidenceSelect?: boolean;
  /** 外部已 condense 时跳过检索内二次改写 */
  skipCondense?: boolean;
  /** 可选：显式传入 condense 上下文（优先于请求级上下文） */
  condenseSummary?: string;
  condenseMessages?: import("@langchain/core/messages").BaseMessage[];
  /** 总管 /api/probe：混合检索快路径，跳过 LLM 扩展与多跳 */
  probeMode?: boolean;
  /** UI retrieve-first：跳过扩展/证据精选/过滤/agentic 等慢路径 LLM（保留向量+词法重排） */
  fastPath?: boolean;
  /** 双事实复合问句：在 fastPath 基础上对子问句各检一次向量 */
  compoundFast?: boolean;
  /** RAGFlow 标准档：混合检索 + CE rerank，启发式 plan，不走 LangGraph */
  pipelineStandard?: boolean;
  /** retrieve-first 已算 plan，跳过检索内二次 catalog LLM */
  prefetchedPlan?: RagQueryPlan;
  prefetchedLeanQuery?: string;
  prefetchedPlanSource?: "catalog_llm" | "plan_llm" | "heuristic" | "probe";
  _agenticAttempt?: number;
  _originalQuery?: string;
  _priorQueries?: string[];
  userKey?: string;
}): Promise<DocumentRetrievalResult> {
  let params = { ...input };
  const probeMode = Boolean(params.probeMode);
  /** 总管 probe/预取/执行：默认快路径，避免与 UI 全链路叠加多 query embedding */
  if (isOrchestratedByManager() && !probeMode && params.fastPath !== false) {
    params = {
      ...params,
      fastPath: true,
      skipLlmRerank: params.skipLlmRerank !== false,
      skipEvidenceSelect: params.skipEvidenceSelect !== false,
    };
  }
  const fastPath = Boolean(params.fastPath);
  const compoundFast = Boolean(params.compoundFast);
  const pipelineStandard = Boolean(params.pipelineStandard);
  if (probeMode || fastPath) {
    params = { ...params, skipLlmRerank: true, skipEvidenceSelect: true };
  }
  // 总管编排预取/probe：默认跳过 LLM 重排（gte-rerank 等非 chat 模型会 400）
  if (isOrchestratedByManager() && params.skipLlmRerank !== false) {
    params = { ...params, skipLlmRerank: true };
  }
  const [vectorStore, uploadedDocs] = await Promise.all([getVectorStore(), getUploadedDocuments()]);
  const corpusSize = uploadedDocs.length;
  const env = getRagAgentEnv({ docCount: corpusSize });
  const retrievalStartedAt = Date.now();
  const agenticAttempt = params._agenticAttempt ?? 0;
  const originalQuery = params._originalQuery ?? String(params.rawQuery ?? params.query ?? "").trim();
  const userKey = params.userKey ?? getRetrievalUserKey();
  let rerankMode = "none";
  const rawIncoming = String(params.rawQuery ?? "").trim();
  const managerTask = getManagerRagTask();
  const sanitizedIncoming =
    sanitizeIncomingQuestion(rawIncoming || String(params.query || ""), managerTask) ||
    String(params.query || "").trim();
  let effectiveQuery = sanitizedIncoming || String(params.query || "").trim();
  const allowOrchestratedCondense =
    allowsOrchestratedDialogMerge(managerTask?.turn_scope ?? null) ||
    (Boolean(managerTask?.dialog_anchor) && !managerTask?.turn_scope?.suppress_history);
  const skipCondense =
    probeMode ||
    Boolean(params.skipCondense) ||
    getRagMergedUnderstand()?.source === "llm" ||
    Boolean(getRagMergedUnderstand()?.coalesced) ||
    (isOrchestratedByManager() && !allowOrchestratedCondense) ||
    looksLikeManagerRetrievalTask(rawIncoming) ||
    getRagRequestIntent()?.needs_condense === false;
  if (!skipCondense && env.enableQueryCondense && effectiveQuery.length >= env.queryPlanMinLen) {
    const ctx = getRetrievalCondenseContext();
    const condenseSummary = String(params.condenseSummary ?? ctx.summary ?? "").trim();
    const condenseMessages = params.condenseMessages ?? ctx.messages ?? [];
    const dialogAnchor = String(managerTask?.dialog_anchor ?? "").trim();
    const hasDialogContext =
      Boolean(condenseSummary) || condenseMessages.length > 0 || Boolean(dialogAnchor);
    const mustCondense = getRagRequestIntent()?.needs_condense === true;
    if (mustCondense || (hasDialogContext && effectiveQuery.length >= 28)) {
      try {
        effectiveQuery = await condenseRetrievalQuery({
          summary: condenseSummary || dialogAnchor.slice(0, 400),
          messages: condenseMessages,
          draftQuery: effectiveQuery,
        });
      } catch (e) {
        console.warn("[Condense@retrieval] failed, using sanitized query:", e);
      }
    }
  }
  const promptAbVariant = resolvePromptAbVariant(userKey, originalQuery || effectiveQuery);
  const cachedIntent = getRagRequestIntent();
  const retrievalMode = resolveRagRetrievalMode({
    intent: cachedIntent,
    corpusSize,
    isManagerOrchestrated: isOrchestratedByManager(),
    managerRagTask: managerTask,
    subQueryCount: managerTask?.sub_queries?.length ?? 0,
  });
  const turboRetrieval =
    !pipelineStandard &&
    (probeMode || fastPath || compoundFast || modeUsesTurboRetrieval(retrievalMode));
  const smallCorpusTurbo = corpusSize > 0 && corpusSize <= env.smallCorpusTurboMaxDocs && !pipelineStandard;
  const skipSlowAugments = turboRetrieval || smallCorpusTurbo;

  const condenseCtx = getRetrievalCondenseContext();
  const recentDialog = condenseCtx.messages
    .filter((m) => m._getType() === "human" || m._getType() === "ai")
    .slice(-6)
    .map((m) => `${m._getType() === "human" ? "用户" : "助手"}：${String(m.content ?? "").trim()}`)
    .join("\n");

  const understood = await understandRagQuery({
    query: effectiveQuery,
    rawMessage: originalQuery || rawIncoming,
    managerTask,
    merged: getRagMergedUnderstand(),
    dialogContext: buildRagDialogContext({
      merged: getRagMergedUnderstand(),
      sessionSummary: condenseCtx.summary,
      recentDialog,
    }),
    docCatalog: uploadedDocs,
    fast: probeMode || turboRetrieval || Boolean(params.prefetchedPlan),
    probeMode,
    prefetchedPlan: params.prefetchedPlan,
    prefetchedLeanQuery: params.prefetchedLeanQuery,
    prefetchedPlanSource: params.prefetchedPlanSource,
  });
  effectiveQuery = understood.effectiveQuery || effectiveQuery;
  const ragPlan = understood.plan;
  let runCompoundFast = compoundFast;
  if (fastPath && !runCompoundFast && !probeMode && understood.needsDeepRetrieval) {
    runCompoundFast = true;
  }
  const learning =
    !probeMode && !skipSlowAugments && env.enableLearningLoop
      ? getLearningHintsForQuestion(originalQuery || effectiveQuery)
      : null;
  if (effectiveQuery) {
    await ensureQueriesEmbedded(getRagEmbeddings(), [effectiveQuery, originalQuery].filter(Boolean));
  }
  const suppressExperience = Boolean(managerTask?.turn_scope?.suppress_experience_replay);
  const experienceRecalls =
    !suppressExperience &&
    !probeMode &&
    !skipSlowAugments &&
    env.enableVectorExperience &&
    understood.experienceHits === 0
      ? await recallRagExperience(originalQuery || effectiveQuery, 3)
      : [];
  const experienceHits = understood.experienceHits || experienceRecalls.length;
  const skipPreferenceInjection = isOrchestratedByManager() || skipSlowAugments;
  const userPrefsBlock = skipPreferenceInjection
    ? ""
    : await formatUserPreferencesBlock(userKey, effectiveQuery);
  const userPrefs = userKey && !skipPreferenceInjection ? getUserPreferences(userKey) : null;
  const queryIntent =
    cachedIntent ??
    (await judgeDocScope(
      [effectiveQuery, rawIncoming, originalQuery].filter(Boolean).pop() || effectiveQuery,
      uploadedDocs
    ));
  if (queryIntent.missing_documents.length > 0) {
    const message = buildExplicitDocNotFoundMessage(queryIntent.missing_documents, uploadedDocs);
    recordRagQueryMetric({
      path: "clarify",
      ok: false,
      weak_evidence: true,
      ms: Date.now() - retrievalStartedAt,
      question: effectiveQuery,
      intent: ragPlan.intent,
      reason: "explicit_doc_not_in_kb",
    });
    const output = formatClarifyEnvelope(effectiveQuery, message, "explicit_doc_not_in_kb");
    return {
      output,
      effectiveQuery,
      plan: ragPlan,
      evidence: [],
      needsClarify: true,
      ms: Date.now() - retrievalStartedAt,
      agenticRounds: agenticAttempt,
      clarifyReason: "explicit_doc_not_in_kb",
      experienceHits,
      abVariant: promptAbVariant,
    };
  }
  const retrievalLimits = resolveRetrievalLimits(ragPlan, effectiveQuery, queryIntent);
  const { maxResults, maxEvidence, keywordLimit, perSubQueryTopK, evidenceFilterOpts } = retrievalLimits;
  const banditContext = `${ragPlan.intent}:${promptAbVariant}`;
  const banditPlan =
    skipSlowAugments || smallCorpusTurbo
      ? localRerankBanditPlan()
      : sampleRetrievalBanditArm(banditContext, userKey);
  let banditArm: RetrievalBanditArm = banditPlan.arm;

  const skipPlanClarify =
    uploadedDocs.length > 0 &&
    uploadedDocs.length <= 8 &&
    ["fact_lookup", "multi_part", "unknown"].includes(ragPlan.intent) &&
    ragPlan.confidence < 0.55;
  if (
    ragPlan.needs_clarification &&
    ragPlan.clarification_questions.length > 0 &&
    ragPlan.confidence < 0.45 &&
    !skipPlanClarify
  ) {
    const clarify =
      ragPlan.clarification_questions.join("\n") || (await buildClarifyMessage(effectiveQuery));
    recordRagQueryMetric({
      path: "clarify",
      ok: false,
      weak_evidence: true,
      ms: Date.now() - retrievalStartedAt,
      question: effectiveQuery,
      intent: ragPlan.intent,
      reason: "plan_needs_clarification",
    });
    const output = formatClarifyEnvelope(
      effectiveQuery,
      clarify,
      "plan_needs_clarification",
      ragPlan.clarification_questions
    );
    return {
      output,
      effectiveQuery,
      plan: ragPlan,
      evidence: [],
      needsClarify: true,
      ms: Date.now() - retrievalStartedAt,
      agenticRounds: agenticAttempt,
      clarifyReason: "plan_needs_clarification",
      experienceHits,
      abVariant: promptAbVariant,
      banditArm,
    };
  }

  const expansionModel = createRagChatOpenAI({
    modelName: env.expansionModel,
    temperature: 0,
    jsonTask: true,
  });
  const rerankModel = createRagChatOpenAI({
    modelName: env.rerankModel,
    temperature: 0,
    jsonTask: true,
  });

  const planIntent = ["definition", "process", "comparison", "fact_lookup"].includes(ragPlan.intent)
    ? ragPlan.intent
    : "fact_lookup";
  const raw = effectiveQuery;
  const planQueries = retrievalQueriesFromPlan(ragPlan, effectiveQuery);
  let queries = uniqBy(
    [
      ...planQueries,
      String(params.query || "").trim(),
      rawIncoming,
    ].filter(Boolean),
    (q) => q.toLowerCase()
  );
  if (managerTask?.retrieval_keywords?.length) {
    queries = uniqBy(
      [...queries, ...managerTask.retrieval_keywords],
      (q) => q.toLowerCase()
    );
  }
  if (learning?.similarPositiveQueries?.length) {
    queries = uniqBy([...queries, ...learning.similarPositiveQueries], (q) => q.toLowerCase());
  }
  const relatedPrefTopics = skipPreferenceInjection
    ? []
    : await filterTopicsRelevantToQuery(effectiveQuery, userPrefs?.frequent_topics);
  if (relatedPrefTopics.length) {
    queries = uniqBy([...queries, ...relatedPrefTopics.slice(0, 3)], (q) => q.toLowerCase());
  }
  if (experienceRecalls.length) {
    const expHints = experienceRecalls.map((e) => e.hint).filter(Boolean);
    queries = uniqBy([...queries, ...expHints], (q) => q.toLowerCase());
  }
  const expansionSeed = raw || effectiveQuery;
  if (queries.length === 0) queries = [effectiveQuery];
  const compoundParts =
    ragPlan.sub_queries.length >= 2 ? ragPlan.sub_queries : splitCompoundQueries(expansionSeed);
  const evidenceFilterWithSubs =
    compoundParts.length >= 2
      ? { ...evidenceFilterOpts, subQueries: compoundParts }
      : evidenceFilterOpts;
  if (compoundParts.length > 0 && !turboRetrieval && !probeMode) {
    queries = uniqBy([...queries, ...compoundParts], (q) => q.toLowerCase()).slice(0, env.maxRetrievalQueries);
  }
  if (fastPath && !runCompoundFast) {
    queries = buildFastPathRetrievalQueries({
      effectiveQuery,
      plan: ragPlan,
      managerKeywords: managerTask?.retrieval_keywords,
      max: env.maxRetrievalQueries,
    });
  } else if (runCompoundFast) {
    let subParts =
      ragPlan.sub_queries.length >= 2
        ? ragPlan.sub_queries
        : compoundParts.length >= 2
          ? compoundParts
          : [];
    if (subParts.length < 2) {
      subParts = await buildCompoundSubQueries(effectiveQuery, env.retrieveFirstMaxSubQueries);
    }
    queries = uniqBy(
      [effectiveQuery, ...subParts.slice(0, env.retrieveFirstMaxSubQueries)],
      (q) => q.toLowerCase()
    ).slice(0, 1 + env.retrieveFirstMaxSubQueries);
  } else if (corpusSize <= 5) {
    queries = uniqBy([effectiveQuery, ...queries], (q) => q.toLowerCase()).slice(0, 2);
  } else {
    queries = queries.slice(0, env.maxRetrievalQueries);
  }
  const vectorTopK = turboRetrieval || probeMode ? env.fastPathVectorTopK : env.vectorSearchTopK;
  const skipMultiQueryExpansion = queryIntent.has_explicit_doc_anchor;
  const shouldUseMultiQuery =
    !probeMode && !turboRetrieval && env.enableMultiQuery && expansionSeed.length >= env.multiQueryMinLen;
  if (shouldUseMultiQuery && !skipMultiQueryExpansion) {
    const expansionPrompt = [
      userPrefsBlock,
      env.enablePromptEvolution ? getRagPromptPatchesForStage("expansion", 2, promptAbVariant) : "",
      env.enablePromptEvolution ? getRagPromptPatchesForStage("retrieval", 1, promptAbVariant) : "",
      getRetrievalExpansionRules(),
      `问题类型: ${planIntent}`,
      `原始问题: ${expansionSeed}`,
    ]
      .filter(Boolean)
      .join("\n");
    const expansionRes = await withRetry(() => expansionModel.invoke(expansionPrompt));
    queries = uniqBy(
      [...queries, ...String(expansionRes.content).split("\n").map((q) => q.trim()).filter(Boolean)],
      (q) => q.toLowerCase()
    ).slice(0, env.maxRetrievalQueries);
  }

  const routingDecision = await selectCandidateSources(effectiveQuery, queries, {
    widenRouting: retrievalLimits.widenDocRouting,
    subQueryCount: compoundParts.length,
    intent: queryIntent,
  });
  const routedSources = routingDecision.selectedSources;
  const shouldFilterBySource = [
    "explicit_doc_name_anchor",
    "top_n_scored_docs",
    "dominant_doc_name_match",
    "small_corpus_dominant_doc",
  ].includes(String(routingDecision.routingMode || ""));

  const embeddings = getRagEmbeddings();
  await ensureQueriesEmbedded(embeddings, [
    ...queries,
    effectiveQuery,
    ...(compoundParts.length >= 2 ? compoundParts : []),
  ]);

  const semanticMap = new Map<string, { doc: any; score: number }>();
  const tryVectorSearchWithScore = async (q: string) => {
    const storeAny = vectorStore as any;
    if (typeof storeAny.similaritySearchWithScore === "function") {
      const rows = await storeAny.similaritySearchWithScore(q, vectorTopK);
      for (const [doc, distance] of rows as [any, number][]) {
        const metadata = normalizeMetadata(doc?.metadata);
        const source = String(metadata?.source ?? "");
        if (shouldFilterBySource && routedSources.size > 0 && !routedSources.has(source)) continue;
        const sourceLabel = buildSourceLabel(metadata);
        const docKey = `${sourceLabel}:${String(doc?.pageContent ?? "").slice(0, 60)}`;
        const semanticScore = 1 / (1 + Math.max(distance ?? 0, 0));
        const prev = semanticMap.get(docKey);
        if (!prev || semanticScore > prev.score) {
          semanticMap.set(docKey, { doc: { ...doc, metadata }, score: semanticScore });
        }
      }
      return;
    }
    const docs = await vectorStore.similaritySearch(q, vectorTopK);
    for (const doc of docs) {
      const metadata = normalizeMetadata(doc?.metadata);
      const source = String(metadata?.source ?? "");
      if (shouldFilterBySource && routedSources.size > 0 && !routedSources.has(source)) continue;
      const sourceLabel = buildSourceLabel(metadata);
      const docKey = `${sourceLabel}:${String(doc?.pageContent ?? "").slice(0, 60)}`;
      const prev = semanticMap.get(docKey);
      const fallbackScore = 0.18;
      if (!prev || fallbackScore > prev.score) {
        semanticMap.set(docKey, { doc: { ...doc, metadata }, score: fallbackScore });
      }
    }
  };

  await Promise.all(queries.map((q) => tryVectorSearchWithScore(q)));

  const keywordTerms = Array.from(
    new Set([
      ...queries.flatMap((q) => tokenizeForKeywordSearch(q)),
      ...planEntityKeywordTerms(ragPlan),
    ])
  );
  const keywordMap = new Map<string, { doc: any; score: number }>();
  const keywordCandidates = await searchKeywordCandidates({
    terms: keywordTerms,
    sources: shouldFilterBySource ? Array.from(routedSources) : [],
    limit: keywordLimit,
  });
  for (const row of keywordCandidates) {
    const metadata = normalizeMetadata(row.metadata ?? {});
    const source = String(metadata?.source ?? "");
    if (shouldFilterBySource && routedSources.size > 0 && !routedSources.has(source)) continue;
    const keywordScore = Math.min(0.6, Number(row.matchedTerms ?? 0) / Math.max(1, keywordTerms.length));
    const sourceLabel = buildSourceLabel(metadata);
    const doc = { pageContent: row.pageContent ?? "", metadata };
    const docKey = `${sourceLabel}:${String(doc.pageContent).slice(0, 60)}`;
    const prev = keywordMap.get(docKey);
    if (!prev || keywordScore > prev.score) {
      keywordMap.set(docKey, { doc, score: keywordScore });
    }
  }

  const bm25Map = new Map<string, { doc: any; score: number }>();
  if (env.enableBm25Lexical) {
    const bm25Candidates = await searchBm25Candidates({
      terms: keywordTerms,
      sources: shouldFilterBySource ? Array.from(routedSources) : [],
      limit: keywordLimit,
    });
    const maxBm25 = Math.max(1e-6, ...bm25Candidates.map((r) => r.bm25Score));
    for (const row of bm25Candidates) {
      const metadata = normalizeMetadata(row.metadata ?? {});
      const source = String(metadata?.source ?? "");
      if (shouldFilterBySource && routedSources.size > 0 && !routedSources.has(source)) continue;
      const bm25Score = Math.min(1, row.bm25Score / maxBm25);
      const sourceLabel = buildSourceLabel(metadata);
      const doc = { pageContent: row.pageContent ?? "", metadata };
      const docKey = `${sourceLabel}:${String(doc.pageContent).slice(0, 60)}`;
      const prev = bm25Map.get(docKey);
      if (!prev || bm25Score > prev.score) {
        bm25Map.set(docKey, { doc, score: bm25Score });
      }
    }
  }

  // 路由过滤后三路检索均为空时，对原始问句做一次全库召回保底
  if (
    !probeMode &&
    semanticMap.size === 0 &&
    keywordMap.size === 0 &&
    bm25Map.size === 0
  ) {
    const storeAny = vectorStore as { similaritySearchWithScore?: (q: string, k: number) => Promise<[unknown, number][]> };
    const vectorRows =
      typeof storeAny.similaritySearchWithScore === "function"
        ? await storeAny.similaritySearchWithScore(effectiveQuery, vectorTopK)
        : (await vectorStore.similaritySearch(effectiveQuery, vectorTopK)).map(
            (doc) => [doc, 0.45] as [unknown, number]
          );
    for (const [doc, distance] of vectorRows) {
      const d = doc as { pageContent?: string; metadata?: Record<string, unknown> };
      const metadata = normalizeMetadata(d?.metadata);
      const sourceLabel = buildSourceLabel(metadata);
      const docKey = `${sourceLabel}:${String(d?.pageContent ?? "").slice(0, 60)}`;
      const semanticScore = 1 / (1 + Math.max(distance ?? 0, 0));
      const prev = semanticMap.get(docKey);
      if (!prev || semanticScore > prev.score) {
        semanticMap.set(docKey, { doc: { ...d, metadata }, score: semanticScore });
      }
    }
    if (keywordMap.size === 0) {
      const fallbackKw = await searchKeywordCandidates({
        terms: keywordTerms,
        sources: [],
        limit: keywordLimit,
      });
      for (const row of fallbackKw) {
        const metadata = normalizeMetadata(row.metadata ?? {});
        const keywordScore = Math.min(0.55, Number(row.matchedTerms ?? 0) / Math.max(1, keywordTerms.length));
        const sourceLabel = buildSourceLabel(metadata);
        const doc = { pageContent: row.pageContent ?? "", metadata };
        const docKey = `${sourceLabel}:${String(doc.pageContent).slice(0, 60)}`;
        const prev = keywordMap.get(docKey);
        if (!prev || keywordScore > prev.score) {
          keywordMap.set(docKey, { doc, score: keywordScore });
        }
      }
    }
  }

  if (env.enableGapFillVector && !turboRetrieval && !probeMode) {
    const pooled = [
      ...Array.from(semanticMap.values()).sort((a, b) => b.score - a.score).slice(0, 14),
      ...Array.from(keywordMap.values()).sort((a, b) => b.score - a.score).slice(0, 10),
    ]
      .map((v) => String(v.doc?.pageContent ?? ""))
      .join("\n")
      .toLowerCase();
    const focusQ = String(raw || params.query || "").trim();
    const focusTerms = tokenizeForKeywordSearch(focusQ);
    const stopGap = new Set(["什么", "怎么", "如何", "哪些", "是否", "多少", "几次", "几条"]);
    const missingTerms = focusTerms.filter(
      (t) => t.length >= 2 && !stopGap.has(t) && !pooled.includes(t.toLowerCase())
    );
    if (missingTerms.length > 0 && semanticMap.size + keywordMap.size > 0 && focusTerms.length >= 2) {
      const dedup = [...new Set(missingTerms)].sort((a, b) => b.length - a.length).slice(0, 5);
      const fb1 = `${dedup.join(" ")} ${focusQ.slice(0, 40)}`.trim();
      const longest = dedup[0];
      const gapQueries = [fb1, longest && longest.length >= 4 && longest !== fb1 ? longest : ""].filter(
        (q): q is string => Boolean(q && q.length >= 4)
      );
      if (gapQueries.length) await ensureQueriesEmbedded(embeddings, gapQueries);
      if (fb1.length >= 4) await tryVectorSearchWithScore(fb1);
      if (longest && longest.length >= 4 && longest !== fb1) {
        await tryVectorSearchWithScore(longest);
      }
    }
  }

  const semanticRank = new Map<string, number>();
  const keywordRank = new Map<string, number>();
  const bm25Rank = new Map<string, number>();
  Array.from(semanticMap.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .forEach(([k], i) => semanticRank.set(k, i + 1));
  Array.from(keywordMap.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .forEach(([k], i) => keywordRank.set(k, i + 1));
  Array.from(bm25Map.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .forEach(([k], i) => bm25Rank.set(k, i + 1));

  const allKeys = new Set<string>([...semanticMap.keys(), ...keywordMap.keys(), ...bm25Map.keys()]);
  const focusLexicalTerms = tokenizeForKeywordSearch(raw || effectiveQuery).slice(0, 16);
  const hybridDocs = Array.from(allKeys)
    .map((k) => {
      const sem = semanticMap.get(k);
      const kw = keywordMap.get(k);
      const bm = bm25Map.get(k);
      const rowDoc = sem?.doc ?? kw?.doc ?? bm?.doc;
      const baseScore = Math.max(sem?.score ?? 0, kw?.score ?? 0, bm?.score ?? 0);
      const semanticRrf = semanticRank.has(k)
        ? env.rrfSemanticWeight * (1 / (env.rrfK + (semanticRank.get(k) as number)))
        : 0;
      const keywordRrf = keywordRank.has(k)
        ? env.rrfKeywordWeight * (1 / (env.rrfK + (keywordRank.get(k) as number)))
        : 0;
      const bm25Rrf = bm25Rank.has(k)
        ? env.rrfBm25Weight * (1 / (env.rrfK + (bm25Rank.get(k) as number)))
        : 0;
      const fusionScore = env.enableRrfFusion ? baseScore + semanticRrf + keywordRrf + bm25Rrf : baseScore;
      const meta = sem?.doc?.metadata ?? kw?.doc?.metadata ?? {};
      const sourceLabel = resolveSourceLabel(meta, routedSources);
      const learnedBoost = learning?.sourceScoreAdjust(sourceLabel) ?? 0;
      let expBoost = 0;
      for (const exp of experienceRecalls) {
        for (const s of exp.sources ?? []) {
          if (sourceLabel.includes(s) || s.includes(sourceLabel)) expBoost += 0.06;
        }
      }
      if (!skipPreferenceInjection && userPrefs?.preferred_sources?.length) {
        for (const s of userPrefs.preferred_sources) {
          if (sourceLabel.includes(s) || s.includes(sourceLabel)) expBoost += 0.05;
        }
      }
      const focusBoost = scoreDocByQueryTerms(String(rowDoc?.pageContent ?? ""), focusLexicalTerms) * 0.12;
      const tableBoost =
        String(meta?.chunkType ?? "") === "table" && retrievalLimits.widenDocRouting ? 0.07 : 0;
      return {
        key: k,
        doc: rowDoc,
        score: fusionScore + learnedBoost + expBoost + focusBoost + tableBoost,
        keywordScore: kw?.score ?? 0,
      };
    })
    .filter((row) => Boolean(row.doc))
    .sort((a, b) => b.score - a.score);

  let laneFusedDocs: HybridDocRow[] = hybridDocs;
  const shouldRunSubQueryLanes =
    env.enableSubQueryParallelRetrieval &&
    compoundParts.length >= 2 &&
    (!turboRetrieval || runCompoundFast) &&
    !probeMode &&
    (ragPlan.intent === "multi_part" ||
      ragPlan.intent === "comparison" ||
      ragPlan.sub_queries.length >= 2 ||
      compoundParts.length >= 2);
  if (shouldRunSubQueryLanes) {
    try {
      const laneDocs = await retrieveParallelSubQueryLanes({
        subQueries: compoundParts,
        vectorStore,
        env,
        shouldFilterBySource,
        routedSources,
        laneTopK: env.subQueryLaneTopK,
        keywordLimitPerLane: env.subQueryKeywordLimitPerLane,
      });
      if (laneDocs.length) {
        laneFusedDocs = fuseGlobalHybridWithLanes(hybridDocs, laneDocs, perSubQueryTopK);
      }
    } catch (e) {
      console.warn("[SubQueryLanes] skipped:", e);
    }
  }

  const keywordPreferred = laneFusedDocs
    .filter((row) => (row.keywordScore ?? 0) > 0)
    .sort((a, b) => (b.keywordScore - a.keywordScore) || (b.score - a.score));
  const guardedHybridDocs =
    env.keywordTopGuard > 0
      ? uniqBy([...keywordPreferred.slice(0, env.keywordTopGuard), ...hybridDocs], (row) => row.key)
      : hybridDocs;

  const coverageMergedDocs =
    compoundParts.length >= 2
      ? mergeSubQueryCoverage(guardedHybridDocs, compoundParts, perSubQueryTopK)
      : guardedHybridDocs;

  const entityTermCount = planEntityKeywordTerms(ragPlan).length;
  const keywordCount = tokenizeForKeywordSearch(effectiveQuery).length;
  const tooVagueQuery = keywordCount < 2 && entityTermCount < 1;
  const topScore = coverageMergedDocs[0]?.score ?? 0;
  const secondScore = coverageMergedDocs[1]?.score ?? 0;
  const scoreGap = topScore - secondScore;
  /** H4：Top1 偏低且与 Top2 分差过小 → 证据ambiguous，走 Corrective */
  const ambiguousLowConfidence =
    !tooVagueQuery &&
    coverageMergedDocs.length >= 2 &&
    topScore > 0 &&
    topScore <= env.correctiveAmbiguousTopMax &&
    scoreGap < env.correctiveMinScoreGap;
  const zeroHits =
    semanticMap.size === 0 && keywordMap.size === 0 && bm25Map.size === 0 && coverageMergedDocs.length === 0;
  const weakEvidence =
    zeroHits || (coverageMergedDocs.length === 0 && tooVagueQuery) || ambiguousLowConfidence;
  const retrievalFailureMode = zeroHits
    ? "zero_hits"
    : ambiguousLowConfidence
      ? "ambiguous_low_confidence"
      : weakEvidence
        ? "weak_evidence"
        : undefined;

  const persistSuccessExperience = (items: EvidenceItem[]) => {
    if (!env.enableVectorExperience || items.length === 0 || skipSlowAugments) return;
    const sources = items.map((e) => e.source).filter(Boolean);
    const hint =
      experienceRecalls[0]?.hint ||
      (sources.length ? `优先来源=${sources.slice(0, 2).join("、")}` : "document_query");
    void indexRagExperience({
      question: originalQuery || effectiveQuery,
      hint,
      sources,
    }).catch(() => {});
    if (userKey) {
      learnFromSuccessfulRetrieval({
        userKey,
        question: originalQuery || effectiveQuery,
        intent: ragPlan.intent,
        sources,
        topics: extractTopicKeywords(originalQuery || effectiveQuery),
      });
    }
  };

  const finish = (extra?: { weak_evidence?: boolean; reason?: string }) => {
    const refused =
      Boolean(extra?.weak_evidence) ||
      extra?.reason === "needs_clarify" ||
      String(extra?.reason || "").includes("clarify");
    const empty_evidence =
      Boolean(extra?.weak_evidence) ||
      extra?.reason === "zero_hits" ||
      extra?.reason === "weak_evidence" ||
      extra?.reason === "empty_result";
    recordRagQueryMetric({
      path: "document_query",
      ok: !extra?.weak_evidence,
      weak_evidence: extra?.weak_evidence,
      ms: Date.now() - retrievalStartedAt,
      question: effectiveQuery,
      intent: ragPlan.intent,
      sub_query_count: queries.length,
      routing_mode: String(routingDecision.routingMode || ""),
      reason: extra?.reason,
      retrieval_failure_mode:
        extra?.reason ||
        (extra?.weak_evidence ? retrievalFailureMode || "weak_evidence" : undefined),
      agentic_rounds: agenticAttempt,
      rerank_mode: rerankMode,
      ab_variant: promptAbVariant,
      bandit_arm: banditArm,
      refused,
      empty_evidence,
      error_code: refused ? "needs_clarify" : empty_evidence ? "empty_result" : undefined,
    });
    recordPromptAbObservation(promptAbVariant, !extra?.weak_evidence);
    const elapsedMs = Date.now() - retrievalStartedAt;
    recordRetrievalBanditOutcome(banditArm, !extra?.weak_evidence, {
      ms: elapsedMs,
      targetMs: env.banditTargetLatencyMs,
    });
  };

  if (weakEvidence) {
    if (
      !probeMode &&
      shouldAttemptAgenticRetry({
        enabled: env.enableAgenticRetrieval,
        attempt: agenticAttempt,
        maxRounds: env.agenticMaxRounds,
        clarifyReason: zeroHits
          ? "zero_hits"
          : ambiguousLowConfidence
            ? "ambiguous_low_confidence"
            : "weak_evidence",
        turboRetrieval,
      })
    ) {
      const rewritten = await rewriteQueryForAgenticRetrieval({
        originalQuery: originalQuery || effectiveQuery,
        failedQuery: effectiveQuery,
        attempt: agenticAttempt + 1,
        priorQueries: [...(params._priorQueries ?? []), effectiveQuery],
        learningHints: learning?.similarPositiveQueries,
        retrievalFailureMode: retrievalFailureMode || (zeroHits ? "zero_hits" : "weak_evidence"),
        docCatalog: uploadedDocs,
      });
      return runDocumentRetrieval({
        ...params,
        query: rewritten.query,
        rawQuery: originalQuery || rawIncoming || effectiveQuery,
        _agenticAttempt: agenticAttempt + 1,
        _originalQuery: originalQuery || effectiveQuery,
        _priorQueries: [...(params._priorQueries ?? []), effectiveQuery],
      });
    }

    const clarify = await buildClarifyMessage(effectiveQuery);
    const clarifyTag = retrievalFailureMode || (zeroHits ? "zero_hits" : "weak_evidence");
    recordRagQueryMetric({
      path: "clarify",
      ok: false,
      weak_evidence: true,
      ms: Date.now() - retrievalStartedAt,
      question: effectiveQuery,
      intent: ragPlan.intent,
      routing_mode: String(routingDecision.routingMode || ""),
      reason: clarifyTag,
      retrieval_failure_mode: clarifyTag,
    });
    const output = `${routingExplainBlock(routingDecision, routedSources)}${formatClarifyEnvelope(effectiveQuery, clarify, clarifyTag)}`;
    return {
      output,
      effectiveQuery,
      plan: ragPlan,
      evidence: [],
      needsClarify: true,
      ms: Date.now() - retrievalStartedAt,
      routingMode: String(routingDecision.routingMode || ""),
      agenticRounds: agenticAttempt,
      clarifyReason: clarifyTag,
      retrievalFailureMode: clarifyTag,
      experienceHits,
      abVariant: promptAbVariant,
      banditArm,
    };
  }

  const rerankPoolSize = Math.max(maxResults + 2, turboRetrieval ? maxResults + 1 : env.maxRerankCandidates);
  const preCandidates = coverageMergedDocs.slice(0, rerankPoolSize).map((row) => row.doc);
  const lexicalTerms = tokenizeForKeywordSearch(raw || effectiveQuery).slice(0, 16);

  let uniqueDocs = preCandidates;
  const skipHeavyRerank = (turboRetrieval || probeMode || smallCorpusTurbo) && !pipelineStandard;
  if (env.enableLexicalRerank || env.enableCrossEncoderRerank || env.enableLocalRerank || env.enableEmbeddingRerank) {
    const ceModel =
      env.enableCrossEncoderRerank && env.crossEncoderModel ? env.crossEncoderModel : undefined;
    const ranked = await rerankWithCrossEncoderOrLexical(effectiveQuery, preCandidates, {
      crossEncoderModel: ceModel,
      lexicalThreshold: env.lexicalRerankSkipLlmThreshold,
      topN: rerankPoolSize,
      enableLocalRerank: env.enableLocalRerank,
      banditPlan,
      skipHeavyRerank,
    });
    uniqueDocs = ranked.docs;
    rerankMode = ranked.mode;
    if (banditPlan.forceLlmRerank) {
      params = { ...params, skipLlmRerank: false };
    } else if (
      !params.skipLlmRerank &&
      env.enableRerank &&
      shouldSkipLlmRerankAfterCrossEncoder(
        ranked.mode,
        ranked.topScore,
        env.crossEncoderSkipLlmThreshold,
        env.lexicalRerankSkipLlmThreshold,
        env.localRerankSkipLlmThreshold,
        env.embeddingRerankSkipLlmThreshold,
        banditPlan.forceLlmRerank
      )
    ) {
      params = { ...params, skipLlmRerank: true };
    }
  } else {
    const lexicalRanked = preCandidates
      .map((doc) => ({
        doc,
        lexicalScore: scoreDocByQueryTerms(String(doc?.pageContent ?? ""), lexicalTerms),
      }))
      .sort((a, b) => b.lexicalScore - a.lexicalScore);
    const hasPositiveLexical = lexicalRanked.some((r) => r.lexicalScore > 0);
    uniqueDocs = (hasPositiveLexical
      ? lexicalRanked.filter((r) => r.lexicalScore > 0).map((r) => r.doc)
      : lexicalRanked.map((r) => r.doc)
    ).slice(0, rerankPoolSize);
  }

  let results = uniqueDocs.slice(0, Math.max(maxResults * 2, maxResults));
  const rerankCandidates = uniqueDocs.slice(0, rerankPoolSize);
  if (
    !params.skipLlmRerank &&
    env.enableRerank &&
    rerankCandidates.length >= env.rerankMinCandidates
  ) {
    const candidatesBlock = rerankCandidates
      .map(
        (d, i) =>
          `[ID ${i}] [来源 ${resolveSourceLabel(d.metadata ?? {}, routedSources)}]: ${String(d.pageContent ?? "").substring(0, env.rerankDocPreviewChars)}...`,
      )
      .join("\n\n");
    const rerankRes = await withRetry(() =>
      rerankModel.invoke([
        new SystemMessage(buildRerankSystemPrompt(maxResults)),
        new HumanMessage(buildRerankHumanPrompt(effectiveQuery, candidatesBlock)),
      ]),
    );
    const topIds = String(rerankRes.content)
      .split(/[,，\s]+/)
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => Number.isInteger(id) && id >= 0 && id < rerankCandidates.length);
    const topDocs = topIds.map((id) => rerankCandidates[id]).filter(Boolean);
    if (topDocs.length >= Math.min(2, maxResults)) {
      results = topDocs.slice(0, Math.max(maxResults * 2, maxResults));
    } else {
      const baseDocs = uniqueDocs.slice(0, Math.min(Math.max(env.rerankKeepTopBase, maxResults - 1), uniqueDocs.length));
      const merged = uniqBy([...topDocs, ...baseDocs], (d) => {
        const label = resolveSourceLabel(d?.metadata ?? {}, routedSources);
        return `${label}:${String(d?.pageContent ?? "").slice(0, 120)}`;
      });
      results = (merged.length > 0 ? merged : rerankCandidates).slice(0, Math.max(maxResults * 2, maxResults));
    }
  }

  // H3：MMR 去冗余（在 parent expand 前，对子块候选打散）
  if (env.enableMmr && results.length > maxResults) {
    results = mmrSelect(
      results.map((doc, i) => ({
        item: doc,
        relevance: results.length - i,
        text: String(doc?.pageContent ?? ""),
      })),
      Math.max(maxResults + 2, maxResults),
      env.mmrLambda
    );
  }

  // H2：子块 → 父块文本扩展并去重
  results = expandDocsToParent(results, env.enableParentExpand).slice(0, maxResults);

  const content = results
    .map((r) => {
      const source = resolveSourceLabel(r.metadata ?? {}, routedSources);
      return `[内容]: ${r.pageContent}\n[来源]: ${source}`;
    })
    .join("\n\n");

  const buildEvidenceFromResults = () =>
    results.slice(0, maxEvidence).map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>
      const ingestAt = String(meta.ingest_at || meta.ingestAt || meta.uploaded_at || meta.created_at || '').trim()
      const sourceVersion = String(meta.source_version || meta.version || meta.doc_version || '').trim()
      return {
        content: String(r.pageContent ?? ''),
        source: resolveSourceLabel(meta, routedSources) || 'unknown',
        ...(ingestAt ? { ingest_at: ingestAt } : {}),
        ...(sourceVersion ? { source_version: sourceVersion } : {})
      }
    })

  let evidence: EvidenceItem[] = [];
  if (turboRetrieval) {
    evidence = buildEvidenceFromResults();
    if (evidence.length) {
      finish();
      persistSuccessExperience(evidence);
      return {
        output: formatRetrievalOutput({
          routingDecision,
          routedSources,
          evidence,
        }),
        effectiveQuery,
        plan: ragPlan,
        evidence,
        needsClarify: false,
        ms: Date.now() - retrievalStartedAt,
        routingMode: String(routingDecision.routingMode || ""),
        agenticRounds: agenticAttempt,
        rerankMode,
        experienceHits,
        abVariant: promptAbVariant,
        banditArm,
      };
    }
  }

  if (!params.skipEvidenceSelect) {
    try {
      const selectionText = results
        .map((r, i) => {
          const source = resolveSourceLabel(r.metadata ?? {}, routedSources);
          const window = buildEvidenceWindow(String(r.pageContent ?? ""), lexicalTerms);
          return `[ID ${i}] [来源 ${source}]\n${window}`;
        })
        .join("\n\n");
      const selector = createRagChatOpenAI({
        modelName: env.evidenceSelectModel,
        temperature: 0,
        maxTokens: Math.max(640, Math.min(readAgentLlmJsonMaxTokens() * 2, maxEvidence * 220)),
        jsonTask: true,
      });
      const selRes = await withRetry(() =>
        selector.invoke([
          new SystemMessage(getRetrievalEvidenceRules()),
          new HumanMessage(buildEvidenceSelectHumanPrompt(effectiveQuery, selectionText, maxEvidence)),
        ]),
      );
      const coerced = coerceEvidenceJson(String(selRes.content ?? ""), maxEvidence);
      if (coerced?.evidence?.length) {
        evidence = await filterEvidenceByQueryFocus(effectiveQuery, coerced.evidence, evidenceFilterWithSubs);
        if (evidence.length) {
          finish();
          persistSuccessExperience(evidence);
          return {
            output: formatRetrievalOutput({
              routingDecision,
              routedSources,
              evidence,
            }),
            effectiveQuery,
            plan: ragPlan,
            evidence,
            needsClarify: false,
            ms: Date.now() - retrievalStartedAt,
            routingMode: String(routingDecision.routingMode || ""),
            agenticRounds: agenticAttempt,
            rerankMode,
            experienceHits,
            abVariant: promptAbVariant,
            banditArm,
          };
        }
      }
    } catch (e) {
      console.warn("[EvidenceSelect] skipped:", e);
    }
  }

  evidence = skipSlowAugments
    ? buildEvidenceFromResults()
    : await filterEvidenceByQueryFocus(
        effectiveQuery,
        results.map((r) => ({
          content: String(r.pageContent ?? ""),
          source: resolveSourceLabel(r.metadata ?? {}, routedSources) || "unknown",
        })),
        evidenceFilterWithSubs
      );
  if (!evidence.length && results.length > 0) {
    if (
      !probeMode &&
      shouldAttemptAgenticRetry({
        enabled: env.enableAgenticRetrieval,
        attempt: agenticAttempt,
        maxRounds: env.agenticMaxRounds,
        clarifyReason: "evidence_filtered_off_topic",
        turboRetrieval,
      })
    ) {
      const rewritten = await rewriteQueryForAgenticRetrieval({
        originalQuery: originalQuery || effectiveQuery,
        failedQuery: effectiveQuery,
        attempt: agenticAttempt + 1,
        priorQueries: [...(params._priorQueries ?? []), effectiveQuery],
        learningHints: learning?.similarPositiveQueries,
        docCatalog: uploadedDocs,
      });
      return runDocumentRetrieval({
        ...params,
        query: rewritten.query,
        rawQuery: originalQuery || rawIncoming || effectiveQuery,
        _agenticAttempt: agenticAttempt + 1,
        _originalQuery: originalQuery || effectiveQuery,
        _priorQueries: [...(params._priorQueries ?? []), effectiveQuery],
      });
    }

    evidence = results.slice(0, maxEvidence).map((r) => ({
      content: String(r.pageContent ?? ""),
      source: resolveSourceLabel(r.metadata ?? {}, routedSources) || "unknown",
    }));
  }
  if (!evidence.length) {
    finish({ weak_evidence: true, reason: "evidence_filtered_off_topic" });
    const clarify = await buildClarifyMessage(effectiveQuery);
    const output = `${routingExplainBlock(routingDecision, routedSources)}${formatClarifyEnvelope(
      effectiveQuery,
      clarify,
      "evidence_filtered_off_topic"
    )}`;
    return {
      output,
      effectiveQuery,
      plan: ragPlan,
      evidence: [],
      needsClarify: true,
      ms: Date.now() - retrievalStartedAt,
      routingMode: String(routingDecision.routingMode || ""),
      agenticRounds: agenticAttempt,
      clarifyReason: "evidence_filtered_off_topic",
      experienceHits,
      abVariant: promptAbVariant,
      banditArm,
    };
  }
  finish();
  persistSuccessExperience(evidence);
  const output = formatRetrievalOutput({
    routingDecision,
    routedSources,
    evidence,
    contentFallback: content || "未找到相关背景信息。",
  });
  return {
    output,
    effectiveQuery,
    plan: ragPlan,
    evidence,
    needsClarify: false,
    ms: Date.now() - retrievalStartedAt,
    routingMode: String(routingDecision.routingMode || ""),
    agenticRounds: agenticAttempt,
    rerankMode,
    experienceHits,
    abVariant: promptAbVariant,
    banditArm,
  };
}
