import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { isUnsafeStreamToken } from "./answer_sanitize";
import { runDocumentRetrieval, type DocumentRetrievalResult } from "./document_retrieval";
import { getRagAgentEnv, chatModelName } from "./rag_agent_env";
import { createRagChatOpenAI } from "./rag_chat_openai";
import { buildGeneratePromptTemplate, wrapRagUntrustedContext } from "./rag_playbook_prompts";
import { getRagPromptPatchesForStage } from "./prompt_evolution";
import { resolvePromptAbVariant } from "./prompt_ab_router";
import type { EvidenceItem } from "./retrieval_shared";
import { parseClarifyMessageFromTool } from "./retrieval_shared";
import { getUploadedDocuments } from "./vectorStore";
import { getRagRequestIntent, type RagIntentJudgment } from "./doc_scope_judge";
import { getRagMergedUnderstand, getRagPrefetchedUnderstand } from "./retrieval_context";
import { heuristicRagQueryPlan, isMultiPartRagQuery, resolveCompoundSubQueries } from "./query_plan";
import { evidenceCoversSubQueries } from "./retrieval_shared";
import {
  buildModeEscalation,
  modeWorkflowLabel,
  resolveRagRetrievalMode,
  resolveRetrievalRunParams,
  resolveUiRetrievalModeFromPlan,
  shouldUseDocumentRagPipeline,
  modeUsesTurboRetrieval,
  type RagRetrievalMode,
} from "./rag_retrieval_mode";
import {
  buildCatalogGroundedQueryPlan,
  enrichHeuristicPlanWithCatalog,
  isCatalogGroundedPlanEnabled,
  shouldUseCatalogLlmPlan,
  type RagDialogContext,
} from "./query_plan_builder";
import {
  buildGenerateQuestionForRag,
  answerLooksLikeRetrievalMiss,
  finalizeRagAnswerWithEvidenceGuard,
  focusEvidenceForGeneration,
  prioritizeEvidenceForGeneration,
  prioritizeEvidenceBySubQueries,
} from "./rag_evidence_answer";
import { rewriteQueryForAgenticRetrieval } from "./agentic_retrieval";

const clampText = (text: string, max: number) => {
  const s = String(text ?? "").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

const pickStreamChunkText = (chunk: unknown): string => {
  if (typeof chunk === "string") return chunk;
  if (Array.isArray(chunk)) {
    return chunk
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return String((part as { text: string }).text);
        }
        return "";
      })
      .join("");
  }
  return chunk != null ? String(chunk) : "";
};

export function buildContextFromEvidenceItems(items: EvidenceItem[]): string {
  const env = getRagAgentEnv();
  const lines: string[] = [];
  for (const it of items.slice(0, env.maxContextSnippets)) {
    const content = String(it?.content ?? "").trim();
    const source = String(it?.source ?? "unknown").trim();
    if (!content) continue;
    lines.push(`[内容]: ${content}`);
    lines.push(`[来源]: ${source}`);
    lines.push("");
  }
  return clampText(lines.join("\n").trim(), env.maxContextChars);
}

export function buildRetrieveFirstToolOutput(result: DocumentRetrievalResult): string {
  const meta = {
    agenticRounds: result.agenticRounds ?? 0,
    rerankMode: result.rerankMode,
    evidenceCount: result.evidence.length,
    needsClarify: result.needsClarify,
    experienceHits: result.experienceHits ?? 0,
    abVariant: result.abVariant,
    banditArm: result.banditArm,
    retrievalLanes: result.retrievalLanes ?? ["hybrid"],
    needs_graph: Boolean(result.plan?.needs_graph),
    ms: result.ms,
  };
  let out = String(result.output ?? "").trim();
  if (!/\[evidence_json\]/.test(out) && result.evidence.length) {
    out = `${out}\n\n[evidence_json]\n${JSON.stringify({ evidence: result.evidence }, null, 2)}`;
  }
  return `${out}\n[retrieval_meta]\n${JSON.stringify(meta)}`;
}

function formatRetrievalLanesLabel(lanes: string[] | undefined): string {
  const xs = (lanes || []).map((x) => String(x || "").trim()).filter(Boolean);
  if (!xs.length) return "hybrid";
  return xs.join("+");
}

export type RetrieveFirstChatInput = {
  sanitizedMessage: string;
  rawMessage: string;
  historyMessages: BaseMessage[];
  summaryInjection: string;
  userKey?: string;
  isManagerOrchestrated: boolean;
  preflight?: RagIntentJudgment | null;
};

export type RetrieveFirstChatResult = {
  answer: string;
  evidence: { source?: string; content?: string }[];
  toolOutput: string;
  retrievalNeedsClarify: boolean;
  usage: unknown;
  effectiveQuery: string;
  workflowMode?: RagRetrievalMode;
  /** 无证据时的澄清答复（仍走 RAGFlow 管线，不回落 LangGraph） */
  clarifyOnly?: boolean;
  /** H4 / I2：检索失败可解释枚举 */
  retrievalFailureMode?: string;
  /** L/M：hybrid | hyde | graph */
  retrievalLanes?: string[];
};

function resolvePreflight(input: RetrieveFirstChatInput): RagIntentJudgment | null {
  return input.preflight ?? getRagRequestIntent();
}

export type RetrieveFirstSkipReason =
  | "disabled"
  | "manager_orchestrated"
  | "no_documents"
  | "chitchat"
  | "not_document_query"
  | "missing_documents"
  | "agentic_mode";

export function explainRetrieveFirstSkip(input: RetrieveFirstChatInput): RetrieveFirstSkipReason | null {
  const env = getRagAgentEnv();
  if (!env.enableRetrieveFirstChat) return "disabled";
  if (input.isManagerOrchestrated) return "manager_orchestrated";

  const intent = resolvePreflight(input);
  if (intent?.is_chitchat) return "chitchat";
  if (intent && intent.route_action !== "document_query") return "not_document_query";
  if (intent && intent.missing_documents.length > 0) return "missing_documents";
  if (env.enableAgenticToolLoop && intent?.is_completeness_query) {
    return "agentic_mode";
  }

  return null;
}

function buildDialogFromRetrieveInput(input: RetrieveFirstChatInput): RagDialogContext {
  const recentDialog = input.historyMessages
    .filter((m) => m._getType() === "human" || m._getType() === "ai")
    .slice(-6)
    .map((m) => `${m._getType() === "human" ? "用户" : "助手"}：${String(m.content ?? "").trim()}`)
    .join("\n");
  return {
    sessionSummary: String(input.summaryInjection || "").trim() || undefined,
    recentDialog: recentDialog || undefined,
  };
}

export async function shouldTryRetrieveFirstChat(input: RetrieveFirstChatInput): Promise<boolean> {
  if (explainRetrieveFirstSkip(input)) return false;
  const docs = await getUploadedDocuments();
  return shouldUseDocumentRagPipeline({
    intent: resolvePreflight(input),
    isManagerOrchestrated: input.isManagerOrchestrated,
    enableRetrieveFirstChat: getRagAgentEnv().enableRetrieveFirstChat,
    hasDocuments: docs.length > 0,
  });
}

const skipReasonLabel: Record<RetrieveFirstSkipReason, string> = {
  disabled: "RAG 管线已关闭",
  manager_orchestrated: "总管编排任务",
  no_documents: "知识库暂无文档",
  chitchat: "闲聊/非文档问句",
  not_document_query: "非文档检索意图",
  missing_documents: "指定文档不存在",
  agentic_mode: "Agentic 多跳检索",
};

async function streamGenerateAnswer(
  input: RetrieveFirstChatInput,
  contextText: string,
  questionForGenerate: string,
  onEvent: (ev: Record<string, unknown>) => void,
  streamTokens = true,
): Promise<{ answer: string; usage: unknown }> {
  const env = getRagAgentEnv();
  const chain = ChatPromptTemplate.fromTemplate(
    buildGeneratePromptTemplate(
      false,
      env.enablePromptEvolution
        ? getRagPromptPatchesForStage(
            "generate",
            2,
            env.enablePromptAbTest ? resolvePromptAbVariant(input.userKey, input.sanitizedMessage) : "control"
          )
        : ""
    )
  ).pipe(
    createRagChatOpenAI({
      modelName: chatModelName(),
      streaming: true,
    })
  );

  let answer = "";
  let usage: unknown = null;
  const stream = await chain.stream({
    context: wrapRagUntrustedContext("rag_evidence", contextText, env.maxContextChars + 400),
    question: questionForGenerate,
  });
  for await (const chunk of stream) {
    const content = (chunk as { content?: unknown })?.content;
    const tokenText = pickStreamChunkText(content);
    if (tokenText && !isUnsafeStreamToken(tokenText)) {
      answer += tokenText;
      if (streamTokens) onEvent({ type: "token", content: tokenText });
    }
    const chunkUsage =
      (chunk as { usage_metadata?: unknown })?.usage_metadata ??
      (chunk as { response_metadata?: { tokenUsage?: unknown } })?.response_metadata?.tokenUsage ??
      null;
    if (chunkUsage) usage = chunkUsage;
  }
  return { answer, usage };
}

/**
 * Dify 分档 + RAGFlow 检索→rerank→引用生成。
 * document_query 不再回落 LangGraph；档位失败时逐级加深，仍无证据则返回澄清话术。
 */
export async function runRetrieveFirstChatStream(
  input: RetrieveFirstChatInput,
  onEvent: (ev: Record<string, unknown>) => void
): Promise<RetrieveFirstChatResult | null> {
  const skipReason = explainRetrieveFirstSkip(input);
  const docs = await getUploadedDocuments();
  if (skipReason) {
    onEvent({
      type: "phase",
      phase: "retrieve_first_skip",
      content: `未走文档 RAG 管线：${skipReasonLabel[skipReason]}`,
      detail: { reason: skipReason },
    });
    return null;
  }
  if (!docs.length) {
    onEvent({
      type: "phase",
      phase: "retrieve_first_skip",
      content: "未走文档 RAG 管线：知识库暂无文档",
      detail: { reason: "no_documents" },
    });
    return null;
  }

  const env = getRagAgentEnv({ docCount: docs.length });
  const queryForRetrieval = input.sanitizedMessage.trim();
  const intent = resolvePreflight(input);
  const dialogContext = buildDialogFromRetrieveInput(input);
  const mergedUnderstand = getRagMergedUnderstand();
  const prefetched = getRagPrefetchedUnderstand();
  const hasDialogContext = Boolean(dialogContext.recentDialog || dialogContext.sessionSummary);
  let catalogPlan = enrichHeuristicPlanWithCatalog(
    prefetched?.plan ?? heuristicRagQueryPlan(queryForRetrieval),
    prefetched?.leanQuery || queryForRetrieval,
    docs,
  );
  let catalogSource: "llm" | "heuristic" = prefetched ? "llm" : "heuristic";
  let catalogLean = (prefetched?.leanQuery || queryForRetrieval).trim() || queryForRetrieval;
  const compoundSubs = resolveCompoundSubQueries(catalogPlan, catalogLean);
  if (
    !prefetched &&
    isCatalogGroundedPlanEnabled() &&
    shouldUseCatalogLlmPlan({
      docCount: docs.length,
      hasDialogContext,
      mergedSource: mergedUnderstand?.source,
      heuristicConfidence: catalogPlan.confidence,
      subQueryCount: compoundSubs.length,
      intent: catalogPlan.intent,
      prefetched: false,
    })
  ) {
    const grounded = await buildCatalogGroundedQueryPlan(queryForRetrieval, {
      rawMessage: input.rawMessage,
      docCatalog: docs,
      dialogContext,
    });
    catalogPlan = grounded.plan;
    catalogSource = grounded.source;
    if (grounded.leanQuery.length >= 4) catalogLean = grounded.leanQuery;
  }
  const isMultiPartFinal = isMultiPartRagQuery(catalogPlan, queryForRetrieval);
  const subQueriesFinal = resolveCompoundSubQueries(catalogPlan, queryForRetrieval);
  let initialMode: RagRetrievalMode = resolveUiRetrievalModeFromPlan({
    baseMode: resolveRagRetrievalMode({
      intent,
      corpusSize: docs.length,
      isManagerOrchestrated: input.isManagerOrchestrated,
      subQueryCount: catalogPlan.sub_queries.length,
    }),
    plan: catalogPlan,
    planSource: catalogSource === "llm" ? "catalog_llm" : "heuristic",
    corpusSize: docs.length,
    smallCorpusTurboMaxDocs: env.smallCorpusTurboMaxDocs,
  });
  const skipCondense =
    !env.enableQueryCondense ||
    intent?.needs_condense === false ||
    mergedUnderstand?.source === "llm" ||
    Boolean(mergedUnderstand?.coalesced) ||
    Boolean(prefetched);
  const modesToTry = buildModeEscalation(initialMode, {
    corpusSize: docs.length,
    smallCorpusTurboMaxDocs: env.smallCorpusTurboMaxDocs,
    isMultiPart: isMultiPartFinal,
  });

  onEvent({
    type: "phase",
    phase: "workflow_route",
    content: `工作流：${modeWorkflowLabel(initialMode)}（${docs.length} 份文档，Hybrid 主路径；制度图按问句门控辅佐）`,
    detail: { initialMode, modesToTry, corpusSize: docs.length },
  });

  const pipelineStartedAt = Date.now();
  let retrieval: DocumentRetrievalResult | null = null;
  let usedMode: RagRetrievalMode = initialMode;

  for (const mode of modesToTry) {
    const runParams = resolveRetrievalRunParams(mode, {
      forceCompound: catalogPlan.sub_queries.length >= 2,
    });
    onEvent({
      type: "phase",
      phase: "retrieval_start",
      content: `${modeWorkflowLabel(mode)}：向量+词法融合${mode === "standard" ? "+ CE 重排" : ""}（图车道门控中）`,
      detail: { mode, ...runParams },
    });

    const attemptStartedAt = Date.now();
    const result = await runDocumentRetrieval({
      query: catalogLean || queryForRetrieval,
      rawQuery: input.rawMessage,
      ...runParams,
      skipCondense,
      condenseSummary: input.summaryInjection,
      condenseMessages: [...input.historyMessages, new HumanMessage({ content: input.sanitizedMessage })],
      userKey: input.userKey,
      prefetchedPlan: catalogPlan,
      prefetchedLeanQuery: catalogLean,
      prefetchedPlanSource: catalogSource === "llm" ? "catalog_llm" : "heuristic",
    });

    if (result.evidence.length > 0) {
      const partialMulti =
        isMultiPartFinal &&
        subQueriesFinal.length >= 2 &&
        !evidenceCoversSubQueries(result.evidence, subQueriesFinal);
      if (partialMulti && modesToTry.indexOf(mode) < modesToTry.length - 1) {
        onEvent({
          type: "phase",
          phase: "retrieval_partial",
          content: `${modeWorkflowLabel(mode)} 仅覆盖部分子问句，尝试加深档位`,
          ms: result.ms ?? Date.now() - attemptStartedAt,
          detail: {
            mode,
            evidenceCount: result.evidence.length,
            subQueries: subQueriesFinal.length,
            retrievalLanes: result.retrievalLanes,
          },
        });
        retrieval = result;
        usedMode = mode;
        continue;
      }
      retrieval = result;
      usedMode = mode;
      const lanes = formatRetrievalLanesLabel(result.retrievalLanes);
      const graphAssist =
        (result.retrievalLanes || []).includes("graph")
          ? "；制度图已并入 RRF"
          : result.plan?.needs_graph
            ? "；已开图门控但无图命中"
            : "；未开图门控";
      onEvent({
        type: "phase",
        phase: "retrieval_done",
        content: `${modeWorkflowLabel(mode)} 命中 ${result.evidence.length} 条 · 车道 ${lanes}${graphAssist} · 重排 ${result.rerankMode || "lexical"}`,
        ms: result.ms ?? Date.now() - attemptStartedAt,
        detail: {
          mode,
          evidenceCount: result.evidence.length,
          rerankMode: result.rerankMode,
          routingMode: result.routingMode,
          retrievalLanes: result.retrievalLanes,
          needs_graph: result.plan?.needs_graph,
        },
      });
      break;
    }

    onEvent({
      type: "phase",
      phase: "retrieval_miss",
      content: `${modeWorkflowLabel(mode)} 未命中${modesToTry.indexOf(mode) < modesToTry.length - 1 ? "，尝试加深档位" : ""}`,
      ms: result.ms ?? Date.now() - attemptStartedAt,
      detail: { mode, needsClarify: result.needsClarify, clarifyReason: result.clarifyReason },
    });
    retrieval = result;
    usedMode = mode;
  }

  if (!retrieval) return null;

  const toolOutput = buildRetrieveFirstToolOutput(retrieval);

  if (!retrieval.evidence.length) {
    const clarify =
      parseClarifyMessageFromTool(toolOutput) ||
      "知识库中暂未找到与问题直接相关的文档内容，请补充文档、指定文件名或调整问法。";
    onEvent({
      type: "phase",
      phase: "clarify",
      content: "检索未命中，返回澄清指引",
      ms: Date.now() - pipelineStartedAt,
      detail: { mode: usedMode },
    });
    onEvent({ type: "token", content: clarify });
    return {
      answer: clarify,
      evidence: [],
      toolOutput,
      retrievalNeedsClarify: true,
      usage: null,
      effectiveQuery: retrieval.effectiveQuery,
      workflowMode: usedMode,
      clarifyOnly: true,
      retrievalFailureMode: retrieval.retrievalFailureMode || retrieval.clarifyReason || "weak_evidence",
      retrievalLanes: retrieval.retrievalLanes ?? ["hybrid"],
    };
  }

  const skipEvidenceFocus =
    !isMultiPartFinal &&
    (env.retrieveFirstSkipEvidenceSelect || modeUsesTurboRetrieval(usedMode));

  const focusEvidence = async (
    ev: EvidenceItem[],
    effectiveQuery: string,
    opts?: { forceMultiSource?: boolean },
  ) => {
    if (skipEvidenceFocus) {
      return isMultiPartFinal
        ? prioritizeEvidenceBySubQueries(subQueriesFinal, ev, env.maxContextSnippets)
        : prioritizeEvidenceForGeneration(
            input.sanitizedMessage,
            effectiveQuery || input.sanitizedMessage,
            ev,
            env.maxContextSnippets,
            docs,
            opts,
          );
    }
    if (opts?.forceMultiSource) {
      // LLM 精选易再塌缩到近义高分文档；假阴性再检强制 round-robin
      return prioritizeEvidenceForGeneration(
        input.sanitizedMessage,
        effectiveQuery || input.sanitizedMessage,
        ev,
        env.maxContextSnippets,
        docs,
        { forceMultiSource: true },
      );
    }
    return focusEvidenceForGeneration(
      input.sanitizedMessage,
      effectiveQuery || input.sanitizedMessage,
      ev,
      env.maxContextSnippets,
      docs,
    );
  };

  /** 首轮生成只用到的来源；假阴性再检时改扫其它文档 */
  const resolveAlternateSources = (used: EvidenceItem[]): string[] => {
    const usedNames = new Set(
      used.map((e) => String(e.source || "").trim()).filter(Boolean),
    );
    const matchesUsed = (name: string) =>
      [...usedNames].some((u) => u === name || u.includes(name) || name.includes(u));
    const alternates = docs
      .map((d) => String(d.name || "").trim())
      .filter((n) => n && !matchesUsed(n));
    if (alternates.length) return alternates;
    // 首轮已覆盖全部来源时，仍强制扫「非唯一主导源」
    if (usedNames.size === 1) {
      const sole = [...usedNames][0];
      return docs
        .map((d) => String(d.name || "").trim())
        .filter((n) => n && n !== sole && !sole.includes(n) && !n.includes(sole));
    }
    return docs.map((d) => String(d.name || "").trim()).filter(Boolean);
  };

  let focusedEvidence = await focusEvidence(
    retrieval.evidence,
    retrieval.effectiveQuery || input.sanitizedMessage,
  );
  let contextText = buildContextFromEvidenceItems(focusedEvidence);
  if (!contextText.trim()) {
    const clarify = "检索到片段但无法组装上下文，请换一种问法或指定文档名称。";
    onEvent({ type: "token", content: clarify });
    return {
      answer: clarify,
      evidence: [],
      toolOutput,
      retrievalNeedsClarify: true,
      usage: null,
      effectiveQuery: retrieval.effectiveQuery,
      workflowMode: usedMode,
      clarifyOnly: true,
      retrievalFailureMode: "weak_evidence",
    };
  }

  const emitGeneratePhase = (items: EvidenceItem[]) => {
    const sourceNames = Array.from(
      new Set(items.map((e) => String(e.source || "").trim()).filter(Boolean)),
    ).slice(0, 4);
    onEvent({
      type: "phase",
      phase: "generate",
      content: `基于 ${items.length} 条引用生成回答${sourceNames.length ? `（${sourceNames.join("、")}）` : ""}`,
      ms: Date.now() - pipelineStartedAt,
    });
  };

  emitGeneratePhase(focusedEvidence);
  onEvent({ type: "tool_output", name: "document_query", output: toolOutput });

  const questionForGenerate = buildGenerateQuestionForRag({
    rawQuestion: input.sanitizedMessage,
    effectiveQuery: retrieval.effectiveQuery || input.sanitizedMessage,
  });
  let { answer: draftAnswer, usage } = await streamGenerateAnswer(
    input,
    contextText,
    questionForGenerate,
    onEvent,
    true,
  );
  let answer = draftAnswer.trim();
  let streamedFinal = true;

  let falseNegativeRetried = false;
  if (
    answerLooksLikeRetrievalMiss(answer) &&
    docs.length >= 2 &&
    env.enableAgenticRetrieval
  ) {
    falseNegativeRetried = true;
    const priorFocused = focusedEvidence;
    const alternateSources = resolveAlternateSources(priorFocused);
    onEvent({
      type: "phase",
      phase: "false_negative_retry",
      content: alternateSources.length
        ? `回答似未命中文档事实，改扫未用文档再检索一次（${alternateSources.slice(0, 3).join("、")}${alternateSources.length > 3 ? "…" : ""}）`
        : "回答似未命中文档事实，改写问句后按多文档覆盖再检索一次",
      ms: Date.now() - pipelineStartedAt,
      detail: {
        docCount: docs.length,
        priorEffectiveQuery: retrieval.effectiveQuery,
        priorSources: [...new Set(priorFocused.map((e) => e.source))],
        alternateSources,
      },
    });
    const rewritten = await rewriteQueryForAgenticRetrieval({
      originalQuery: input.sanitizedMessage,
      failedQuery: retrieval.effectiveQuery || input.sanitizedMessage,
      attempt: 1,
      priorQueries: [retrieval.effectiveQuery || input.sanitizedMessage],
      retrievalFailureMode: "false_negative_miss",
      docCatalog: docs,
    });
    // 保留原问实体词，避免改写漂到「失能老人补贴」；与改写句拼成再检问句
    const retryQuery = [input.sanitizedMessage.trim(), rewritten.query.trim()]
      .filter(Boolean)
      .filter((q, i, arr) => arr.indexOf(q) === i)
      .join(" ")
      .slice(0, 300);
    const runParams = resolveRetrievalRunParams(usedMode, {
      forceCompound: catalogPlan.sub_queries.length >= 2,
    });
    const retryResult = await runDocumentRetrieval({
      query: retryQuery,
      rawQuery: input.rawMessage,
      ...runParams,
      skipCondense: true,
      condenseSummary: input.summaryInjection,
      condenseMessages: [...input.historyMessages, new HumanMessage({ content: input.sanitizedMessage })],
      userKey: input.userKey,
      prefetchedPlan: catalogPlan,
      prefetchedLeanQuery: retryQuery,
      prefetchedPlanSource: catalogSource === "llm" ? "catalog_llm" : "heuristic",
      forceSources: alternateSources.length ? alternateSources : undefined,
      _agenticAttempt: 1,
      _originalQuery: input.sanitizedMessage,
      _priorQueries: [retrieval.effectiveQuery || input.sanitizedMessage],
    });
    if (retryResult.evidence.length > 0) {
      // 交替文档证据优先，再并入首轮（避免 docx 近义块再次占满）
      const mergedEvidence = [...retryResult.evidence, ...priorFocused];
      retrieval = {
        ...retryResult,
        evidence: mergedEvidence,
        effectiveQuery: retryResult.effectiveQuery || retryQuery,
      };
      focusedEvidence = await focusEvidence(
        mergedEvidence,
        retrieval.effectiveQuery || retryQuery,
        { forceMultiSource: true },
      );
      contextText = buildContextFromEvidenceItems(focusedEvidence);
      if (contextText.trim()) {
        emitGeneratePhase(focusedEvidence);
        onEvent({
          type: "tool_output",
          name: "document_query",
          output: buildRetrieveFirstToolOutput(retrieval),
        });
        const retryQuestion = buildGenerateQuestionForRag({
          rawQuestion: input.sanitizedMessage,
          effectiveQuery: retrieval.effectiveQuery || retryQuery,
        });
        const retryGen = await streamGenerateAnswer(
          input,
          contextText,
          retryQuestion,
          onEvent,
          true,
        );
        streamedFinal = true;
        draftAnswer = retryGen.answer;
        usage = retryGen.usage;
        answer = draftAnswer.trim();
      }
    }
  }

  if (!skipEvidenceFocus || isMultiPartFinal || answerLooksLikeRetrievalMiss(answer)) {
    answer = await finalizeRagAnswerWithEvidenceGuard({
      question: input.sanitizedMessage,
      effectiveQuery: retrieval.effectiveQuery || input.sanitizedMessage,
      evidence: focusedEvidence,
      draftAnswer: answer,
    });
  }

  if (!streamedFinal && answer.trim()) {
    onEvent({ type: "token", content: answer });
    streamedFinal = true;
  } else if (
    !skipEvidenceFocus &&
    !isMultiPartFinal &&
    streamedFinal &&
    answer.trim() &&
    answer.trim() !== draftAnswer.trim()
  ) {
    onEvent({ type: "token", content: answer });
  }

  const evidence = focusedEvidence.map((e) => ({
    source: e.source,
    content: e.content,
  }));

  return {
    answer,
    evidence,
    toolOutput: buildRetrieveFirstToolOutput(retrieval),
    retrievalNeedsClarify: false,
    usage,
    effectiveQuery: retrieval.effectiveQuery,
    workflowMode: usedMode,
    retrievalFailureMode:
      falseNegativeRetried && answerLooksLikeRetrievalMiss(answer)
        ? "false_negative_miss"
        : retrieval.retrievalFailureMode || retrieval.clarifyReason,
    retrievalLanes: retrieval.retrievalLanes ?? ["hybrid"],
  };
}
