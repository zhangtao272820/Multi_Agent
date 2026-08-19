/**
 * 独立端检索前一次 JSON：turn_kind + route + lean_query + sub_queries。
 * 失败返回 null（不 silent 正则路由）；调用方回退既有 turn_scope / merge / preflight。
 */
import { z } from "zod";
import {
  buildTurnScopePayload,
  parseTurnKind,
  parseTurnScopeMode,
  type TurnScopePayload,
} from "#agent-shared/turnScope";
import type { RagIntentJudgment, RouteAction } from "./doc_scope_judge";
import {
  defaultRagQueryPlan,
  type RagQueryIntent,
  type RagQueryPlan,
} from "./query_plan";
import type { RagMergedUnderstandResult } from "./rag_merged_understand";

export const RagUnifiedUnderstandSchema = z.object({
  mode: z.enum(["current_only", "continuation", "topic_shift", "chitchat"]).optional(),
  turn_kind: z.enum(["new_task", "continuation", "output_followup", "slot_answer", "chitchat"]).optional(),
  route_action: z.enum(["document_list", "document_upload", "document_query", "direct_answer"]),
  is_chitchat: z.boolean().optional(),
  is_completeness_query: z.boolean().optional(),
  retrieve_first_ok: z.boolean().optional(),
  retrieval_mode: z.enum(["pipeline", "agentic"]).optional(),
  specified_documents: z.array(z.string()).optional(),
  missing_documents: z.array(z.string()).optional(),
  has_explicit_doc_anchor: z.boolean().optional(),
  needs_condense: z.boolean().optional(),
  lean_query: z.string().optional(),
  sub_queries: z.array(z.string()).optional(),
  retrieval_keywords: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type RagUnifiedUnderstand = z.infer<typeof RagUnifiedUnderstandSchema>;

export type RagUnifiedUnderstandBundle = {
  parsed: RagUnifiedUnderstand;
  turnScope: TurnScopePayload;
  intent: RagIntentJudgment;
  merged: RagMergedUnderstandResult;
  plan: RagQueryPlan;
  leanQuery: string;
};

const QUERY_INTENTS = new Set<RagQueryIntent>([
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

function safeJsonParse(text: string): unknown {
  const s = String(text ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanStrings(v: unknown, max = 8): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = String(x ?? "").trim();
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function isRagUnifiedUnderstandEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.RAG_UNIFIED_UNDERSTAND ?? "1").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/** 纯函数：解析一次 JSON；缺 route 或低置信返回 null */
export function parseRagUnifiedUnderstandJson(raw: unknown): RagUnifiedUnderstand | null {
  const obj = typeof raw === "string" ? safeJsonParse(raw) : raw;
  const parsed = RagUnifiedUnderstandSchema.safeParse(obj);
  if (!parsed.success) return null;
  const confidence = Number(parsed.data.confidence ?? 1);
  if (Number.isFinite(confidence) && confidence < 0.48) return null;
  return parsed.data;
}

export function unifiedToTurnScope(
  parsed: RagUnifiedUnderstand,
  hasHistory: boolean,
): TurnScopePayload {
  if (!hasHistory) return buildTurnScopePayload("current_only", "new_task");
  const kind = parseTurnKind(parsed.turn_kind);
  const mode =
    parseTurnScopeMode(parsed.mode) ||
    (kind === "continuation" || kind === "output_followup" || kind === "slot_answer"
      ? "continuation"
      : kind === "chitchat"
        ? "chitchat"
        : "topic_shift");
  return buildTurnScopePayload(mode, kind || "new_task");
}

export function unifiedToIntent(
  parsed: RagUnifiedUnderstand,
  docCount: number,
): RagIntentJudgment {
  const route = parsed.route_action as RouteAction;
  const isChitchat = parsed.is_chitchat === true || route === "direct_answer" || parsed.turn_kind === "chitchat";
  const completeness = parsed.is_completeness_query === true;
  const specified = cleanStrings(parsed.specified_documents, 6);
  const missing = cleanStrings(parsed.missing_documents, 6);
  const intent: RagIntentJudgment = {
    specified_documents: specified,
    missing_documents: missing,
    is_chitchat: isChitchat,
    route_action: isChitchat && route === "document_query" ? "direct_answer" : route,
    is_completeness_query: completeness,
    has_explicit_doc_anchor: parsed.has_explicit_doc_anchor === true,
    needs_condense: parsed.needs_condense === true,
    retrieve_first_ok: parsed.retrieve_first_ok !== false,
    retrieval_mode: completeness ? "agentic" : "pipeline",
  };
  if (docCount <= 0) {
    return { ...intent, retrieve_first_ok: false, retrieval_mode: "pipeline" };
  }
  if (intent.is_chitchat || intent.route_action !== "document_query") {
    return { ...intent, retrieve_first_ok: false, retrieval_mode: "pipeline" };
  }
  if (intent.missing_documents.length > 0) {
    return { ...intent, retrieve_first_ok: false, retrieval_mode: "pipeline" };
  }
  if (completeness) {
    return { ...intent, retrieve_first_ok: false, retrieval_mode: "agentic" };
  }
  return {
    ...intent,
    retrieve_first_ok: true,
    retrieval_mode: "pipeline",
  };
}

export function unifiedToMerged(
  parsed: RagUnifiedUnderstand,
  lastUser: string,
  leanQuery: string,
): RagMergedUnderstandResult {
  const last = String(lastUser || "").trim();
  const lean = String(leanQuery || last).trim() || last;
  const continuation =
    parsed.turn_kind === "continuation" ||
    parsed.turn_kind === "output_followup" ||
    parsed.turn_kind === "slot_answer" ||
    parsed.needs_condense === true;
  return {
    effectiveQuery: lean,
    coalesced: lean !== last ? lean : undefined,
    multiTurn: continuation,
    needsCondense: parsed.needs_condense === true || continuation,
    retrievalKeywords: cleanStrings(parsed.retrieval_keywords, 10),
    topics: cleanStrings(parsed.retrieval_keywords, 8),
    source: "llm",
  };
}

function inferPlanIntent(parsed: RagUnifiedUnderstand, lastUser: string): RagQueryIntent {
  if (parsed.route_action === "document_list") return "doc_list";
  const subs = cleanStrings(parsed.sub_queries, 4);
  if (subs.length >= 2) return "multi_part";
  const q = String(parsed.lean_query || lastUser || "").trim();
  if (QUERY_INTENTS.has(q as RagQueryIntent)) return q as RagQueryIntent;
  return "unknown";
}

export function unifiedToQueryPlan(
  parsed: RagUnifiedUnderstand,
  lastUser: string,
  leanQuery: string,
): RagQueryPlan {
  const lean = String(leanQuery || lastUser || "").trim();
  const subs = cleanStrings(parsed.sub_queries, 4);
  const keywords = cleanStrings(parsed.retrieval_keywords, 12);
  const base = defaultRagQueryPlan();
  return {
    ...base,
    intent: inferPlanIntent(parsed, lastUser),
    sub_queries: subs.length ? subs : lean ? [lean] : [],
    retrieval_keywords: keywords,
    entities: {
      ...base.entities,
      doc_names: cleanStrings(parsed.specified_documents, 6),
      topics: keywords.slice(0, 8),
    },
    confidence: Math.max(Number(parsed.confidence ?? 0.72), 0.55),
  };
}

export function assembleRagUnifiedBundle(
  parsed: RagUnifiedUnderstand,
  opts: { lastUser: string; hasHistory: boolean; docCount: number },
): RagUnifiedUnderstandBundle {
  const lastUser = String(opts.lastUser || "").trim();
  const leanQuery = String(parsed.lean_query || "").trim() || lastUser;
  const turnScope = unifiedToTurnScope(parsed, opts.hasHistory);
  const intent = unifiedToIntent(parsed, opts.docCount);
  const merged = unifiedToMerged(parsed, lastUser, leanQuery);
  const plan = unifiedToQueryPlan(parsed, lastUser, leanQuery);
  return { parsed, turnScope, intent, merged, plan, leanQuery };
}

function formatCatalog(docs: { name: string; summary?: string }[]): string {
  if (!docs.length) return "（当前无已索引文档）";
  return docs
    .slice(0, 16)
    .map((d, i) => {
      const summary = String(d.summary ?? "").trim().slice(0, 160);
      return `${i + 1}. ${d.name}${summary ? `：${summary}` : ""}`;
    })
    .join("\n");
}

const UNIFIED_SYSTEM = [
  "你是文档知识库的「一轮理解器」。一次输出路由、轮次范围与可检索问句。",
  "只输出 JSON，不要其它文字。",
  '{"mode":"current_only|continuation|topic_shift|chitchat","turn_kind":"new_task|continuation|output_followup|chitchat","route_action":"document_query|document_list|document_upload|direct_answer","is_chitchat":false,"is_completeness_query":false,"retrieve_first_ok":true,"retrieval_mode":"pipeline","specified_documents":[],"missing_documents":[],"has_explicit_doc_anchor":false,"needs_condense":false,"lean_query":"...","sub_queries":[],"retrieval_keywords":[],"confidence":0.8}',
  "规则：",
  "- 自包含新问题 → mode=topic_shift 或 current_only，turn_kind=new_task，lean_query 只保留本轮。",
  "- 短句指代承接上文 → continuation；输出加工（翻译/总结/精简）→ output_followup。",
  "- route_action：问有哪些文档=document_list；如何上传=document_upload；问条款/事实=document_query；闲聊=direct_answer。",
  "- is_completeness_query 仅当要求穷尽列全/跨文档汇总全部选项；2～3 个具体事实不算。",
  "- retrieval_mode 仅 completeness 时用 agentic，其余 pipeline。",
  "- lean_query：可独立向量检索的中文完整问句；消除指代，勿编造目录外专有名词。",
  "- 复合问题才拆 sub_queries（1～4 条）；单主题则 sub_queries 可为空或一条。",
].join("\n");

export async function judgeRagUnifiedUnderstand(input: {
  question: string;
  historyPreview?: string;
  sessionSummary?: string;
  sessionAnchor?: string;
  uploadedDocs: { name: string; summary?: string }[];
}): Promise<RagUnifiedUnderstandBundle | null> {
  if (!isRagUnifiedUnderstandEnabled()) return null;
  const question = String(input.question || "").trim();
  if (!question) return null;
  const hasHistory = Boolean(String(input.historyPreview || "").trim() || String(input.sessionAnchor || "").trim());
  try {
    const { createRagChatOpenAI } = await import("./rag_chat_openai");
    const { ragFastJudgeModelName } = await import("./rag_agent_env");
    const model = createRagChatOpenAI({
      modelName: process.env.CONDENSE_MODEL ?? ragFastJudgeModelName(),
      maxTokens: 480,
      jsonTask: true,
    });
    const human = [
      `用户问题：${question.slice(0, 700)}`,
      `已上传文档：\n${formatCatalog(input.uploadedDocs)}`,
      input.sessionAnchor ? `任务锚点：${String(input.sessionAnchor).slice(0, 400)}` : "",
      input.sessionSummary ? `会话摘要：${String(input.sessionSummary).slice(0, 500)}` : "",
      hasHistory ? `最近对话：\n${String(input.historyPreview || "").slice(0, 1400)}` : "最近对话：（无）",
    ]
      .filter(Boolean)
      .join("\n\n");
    const res = await model.invoke([
      ["system", UNIFIED_SYSTEM],
      ["human", human],
    ]);
    const text = String((res as { content?: unknown })?.content ?? "");
    const parsed = parseRagUnifiedUnderstandJson(text);
    if (!parsed) return null;
    return assembleRagUnifiedBundle(parsed, {
      lastUser: question,
      hasHistory,
      docCount: input.uploadedDocs.length,
    });
  } catch (e) {
    console.warn("[RagUnifiedUnderstand] failed:", e);
    return null;
  }
}
