/**
 * UI 检索路径（Dify 式按复杂度分 workflow）：
 * - fast：单向量+词法，最快
 * - compound_fast：多子问句并行，中等
 * - standard：RAGFlow 式混合检索 + CE rerank + 引用生成，不走 LangGraph
 */
import type { ManagerRagTaskPayload } from "#agent-shared/managerSubAgentProtocol";
import type { RagIntentJudgment } from "./doc_scope_judge";
import { getRagAgentEnv } from "./rag_agent_env";

export type RagRetrievalMode = "fast" | "compound_fast" | "standard";

/** @deprecated 仅兼容旧引用；document_query 不再走 LangGraph full */
export type RagRetrievalModeLegacy = RagRetrievalMode | "full";

export function resolveRagRetrievalMode(params: {
  intent: RagIntentJudgment | null | undefined;
  corpusSize: number;
  isManagerOrchestrated?: boolean;
  subQueryCount?: number;
  managerRagTask?: ManagerRagTaskPayload | null;
}): RagRetrievalMode {
  const env = getRagAgentEnv();
  const intent = params.intent;
  const task = params.managerRagTask;
  const mgrSubs = task?.sub_queries?.length ?? params.subQueryCount ?? 0;
  if (params.isManagerOrchestrated) {
    if (task?.force_deep_retrieval) return "standard";
    const scopeLen = String(task?.scope_hint ?? "").trim().length;
    if (scopeLen > 80) return "standard";
    if (mgrSubs >= 2) return env.enableRetrieveFirstCompound ? "compound_fast" : "standard";
    if (task?.query_intent === "multi_part") {
      return env.enableRetrieveFirstCompound ? "compound_fast" : "standard";
    }
    return "fast";
  }
  if (!intent || intent.is_chitchat || intent.route_action !== "document_query") return "standard";
  if (intent.missing_documents.length > 0) return "standard";
  if (intent.is_completeness_query) return "standard";
  if ((params.subQueryCount ?? 0) >= 2 || intent.retrieve_first_ok === false) {
    return env.enableRetrieveFirstCompound ? "compound_fast" : "standard";
  }
  return "fast";
}

/** Dify 式：初始档位失败时逐级加深，仍停留在 RAGFlow 管线内 */
export function buildModeEscalation(
  initial: RagRetrievalMode,
  opts?: { corpusSize?: number; smallCorpusTurboMaxDocs?: number; isMultiPart?: boolean },
): RagRetrievalMode[] {
  const small =
    typeof opts?.corpusSize === "number" &&
    opts.corpusSize > 0 &&
    opts.corpusSize <= (opts.smallCorpusTurboMaxDocs ?? 8);
  if (small) {
    if (opts?.isMultiPart) {
      if (initial === "compound_fast") return ["compound_fast"];
      return ["compound_fast"];
    }
    if (initial === "fast") return ["fast", "compound_fast"];
    if (initial === "compound_fast") return ["compound_fast"];
    return ["standard"];
  }
  if (opts?.isMultiPart && initial === "fast") {
    return ["compound_fast", "standard"];
  }
  if (initial === "fast") return ["fast", "compound_fast", "standard"];
  if (initial === "compound_fast") return ["compound_fast", "standard"];
  return ["standard"];
}

export type RetrievalRunParams = {
  fastPath: boolean;
  compoundFast: boolean;
  pipelineStandard: boolean;
  skipLlmRerank: boolean;
  skipEvidenceSelect: boolean;
};

/** 各档 runDocumentRetrieval 参数（RAGFlow：standard 开 CE rerank，跳过 LLM 重排/证据精选） */
export function resolveRetrievalRunParams(
  mode: RagRetrievalMode,
  opts?: { forceCompound?: boolean }
): RetrievalRunParams {
  switch (mode) {
    case "fast":
      return {
        fastPath: true,
        compoundFast: false,
        pipelineStandard: false,
        skipLlmRerank: true,
        skipEvidenceSelect: true,
      };
    case "compound_fast":
      return {
        fastPath: true,
        compoundFast: true,
        pipelineStandard: false,
        skipLlmRerank: true,
        skipEvidenceSelect: true,
      };
    case "standard":
      return {
        fastPath: false,
        compoundFast: Boolean(opts?.forceCompound),
        pipelineStandard: true,
        skipLlmRerank: true,
        skipEvidenceSelect: true,
      };
  }
}

export function modeUsesTurboRetrieval(mode: RagRetrievalMode): boolean {
  return mode === "fast" || mode === "compound_fast";
}

export function modeWorkflowLabel(mode: RagRetrievalMode): string {
  if (mode === "fast") return "简易检索";
  if (mode === "compound_fast") return "复合检索";
  return "深度检索+重排";
}

/** UI/standalone：理解置信度不足时自动加深初始档位（通用，非领域规则） */
export function resolveUiRetrievalModeFromPlan(params: {
  baseMode: RagRetrievalMode;
  plan: { sub_queries: string[]; retrieval_keywords: string[]; confidence: number };
  planSource?: string;
  corpusSize?: number;
  smallCorpusTurboMaxDocs?: number;
}): RagRetrievalMode {
  let mode = params.baseMode;
  const turboMax = params.smallCorpusTurboMaxDocs ?? 8;
  const smallCorpus =
    typeof params.corpusSize === "number" &&
    params.corpusSize > 0 &&
    params.corpusSize <= turboMax;
  if (smallCorpus && params.planSource === "heuristic") {
    const multi =
      params.plan.sub_queries.length >= 2 ||
      params.plan.intent === "multi_part" ||
      params.plan.intent === "comparison";
    if (multi) return "compound_fast";
    return mode;
  }
  const weak =
    params.planSource === "heuristic" ||
    (params.plan.confidence > 0 && params.plan.confidence < 0.52);
  const multi = params.plan.sub_queries.length >= 2;
  const richKw = params.plan.retrieval_keywords.length >= 2;
  if (multi && mode === "fast") return "compound_fast";
  if (weak && mode === "fast") return richKw ? "compound_fast" : "standard";
  if (weak && mode === "compound_fast" && params.plan.confidence < 0.42) return "standard";
  return mode;
}

/** document_query 默认走 RAGFlow 管线；agentic 模式改走 LangGraph 工具环 */
export function shouldUseDocumentRagPipeline(params: {
  intent: RagIntentJudgment | null | undefined;
  isManagerOrchestrated: boolean;
  enableRetrieveFirstChat: boolean;
  hasDocuments: boolean;
}): boolean {
  if (!params.enableRetrieveFirstChat || params.isManagerOrchestrated || !params.hasDocuments) return false;
  if (!params.intent) return false;
  if (params.intent.is_chitchat) return false;
  if (params.intent.route_action !== "document_query") return false;
  if (params.intent.retrieval_mode === "agentic" || params.intent.is_completeness_query) return false;
  if (params.intent.retrieve_first_ok === false) return false;
  return true;
}

/** @deprecated 使用 shouldUseDocumentRagPipeline */
export function shouldUseUiRetrieveFirstChat(params: {
  intent: RagIntentJudgment | null | undefined;
  isManagerOrchestrated: boolean;
  enableRetrieveFirstChat: boolean;
}): boolean {
  return shouldUseDocumentRagPipeline({ ...params, hasDocuments: true });
}
