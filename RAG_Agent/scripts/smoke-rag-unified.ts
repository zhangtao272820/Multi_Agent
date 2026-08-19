/**
 * RAG hop 折叠契约 smoke：统一理解 JSON / 档位别名 / catalog prefetch / 生成 cap。
 * 纯函数，不调 LLM。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleRagUnifiedBundle,
  parseRagUnifiedUnderstandJson,
} from "../server/utils/rag_unified_understand.ts";
import { parseRagCorpusTierEnv } from "../server/utils/rag_corpus_tier.ts";
import { shouldUseCatalogLlmPlan } from "../server/utils/query_plan_builder.ts";
import { shouldUseDocumentRagPipeline } from "../server/utils/rag_retrieval_mode.ts";
import { RAG_AGENT_DEFAULTS } from "../server/utils/rag_agent_env.ts";
import { classifyRagTurnScopeStructural } from "../server/utils/ragTurnScope.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(parseRagUnifiedUnderstandJson("not json") === null, "invalid json → null");
assert(parseRagUnifiedUnderstandJson({ route_action: "document_query", confidence: 0.2 }) === null, "low confidence → null");

const parsed = parseRagUnifiedUnderstandJson({
  mode: "continuation",
  turn_kind: "continuation",
  route_action: "document_query",
  needs_condense: true,
  lean_query: "2023年退货政策的主要内容是什么",
  sub_queries: ["2023年退货政策"],
  retrieval_keywords: ["退货", "政策"],
  confidence: 0.86,
});
assert(parsed?.lean_query?.includes("退货"), "parse lean_query");

const follow = assembleRagUnifiedBundle(parsed!, {
  lastUser: "那退货政策呢",
  hasHistory: true,
  docCount: 3,
});
assert(follow.turnScope.mode === "continuation", "continuation turn_scope");
assert(follow.intent.route_action === "document_query", "route document_query");
assert(follow.intent.retrieval_mode === "pipeline", "non-completeness stays pipeline");
assert(follow.leanQuery.includes("退货"), "lean query");
assert(follow.merged.source === "llm", "merged source llm");
assert(follow.plan.sub_queries.length >= 1, "plan sub_queries");

const isolated = assembleRagUnifiedBundle(
  parseRagUnifiedUnderstandJson({
    mode: "topic_shift",
    turn_kind: "new_task",
    route_action: "document_query",
    lean_query: "不能自理的老年人口腔护理频次是多少？",
    confidence: 0.9,
  })!,
  { lastUser: "不能自理的老年人口腔护理频次是多少？", hasHistory: true, docCount: 4 },
);
assert(isolated.turnScope.suppress_history === true, "new_task isolates history");
assert(!isolated.leanQuery.includes("配比"), "must not stick previous topic");

const complete = assembleRagUnifiedBundle(
  parseRagUnifiedUnderstandJson({
    route_action: "document_query",
    is_completeness_query: true,
    lean_query: "列出全部护理条目",
    confidence: 0.8,
  })!,
  { lastUser: "列出全部护理条目", hasHistory: false, docCount: 4 },
);
assert(complete.intent.is_completeness_query === true, "completeness flag");
assert(complete.intent.retrieval_mode === "agentic", "completeness → agentic");
assert(complete.intent.retrieve_first_ok === false, "completeness not retrieve-first");

const noHist = classifyRagTurnScopeStructural("口腔护理频次是多少", []);
assert(noHist.mode === "current_only", "empty history structural skip");

assert(parseRagCorpusTierEnv("standard") === "auto", "legacy standard maps to auto");
assert(parseRagCorpusTierEnv("auto") === "auto", "auto stays auto");
assert(parseRagCorpusTierEnv("s") === "s", "s tier");

assert(
  shouldUseCatalogLlmPlan({
    docCount: 20,
    prefetched: true,
    hasDialogContext: true,
    mergedSource: "structural",
  }) === false,
  "prefetched plan skips catalog LLM",
);

assert(
  shouldUseDocumentRagPipeline({
    intent: {
      specified_documents: [],
      missing_documents: [],
      is_chitchat: false,
      route_action: "document_query",
      is_completeness_query: false,
      has_explicit_doc_anchor: false,
      retrieve_first_ok: true,
      retrieval_mode: "agentic",
    },
    isManagerOrchestrated: false,
    enableRetrieveFirstChat: true,
    hasDocuments: true,
  }) === true,
  "retrieval_mode=agentic without completeness still retrieve-first",
);

assert(RAG_AGENT_DEFAULTS.maxContextChars === 4800, "generate context cap 4800");
assert(RAG_AGENT_DEFAULTS.maxContextSnippets === 4, "generate snippets 4");

const agentSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../server/utils/agent.ts"),
  "utf8",
);
assert(!agentSrc.includes("根据工具返回结果，用自然"), "list/upload must not rephrase via LLM");
assert(agentSrc.includes("return { messages: [new AIMessage({ content: raw })] }"), "present_tool passthrough");

const chatSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../server/api/chat.post.ts"),
  "utf8",
);
assert(chatSrc.includes("judgeRagUnifiedUnderstand"), "chat wires unified understand");
assert(chatSrc.includes("ragPreflight.is_completeness_query"), "agentic only completeness");

console.log("smoke-rag-unified: OK");
