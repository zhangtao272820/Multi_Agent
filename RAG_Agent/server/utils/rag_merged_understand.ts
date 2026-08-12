/**
 * RAG Stage-4 合并理解：多轮合并 + 检索关键词抽取（一次 LLM，失败走结构拼接）。
 */
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { createRagChatOpenAI } from "./rag_chat_openai";
import { getRagAgentEnv } from "./rag_agent_env";
import { condenseRetrievalQuery } from "./query_condense";
import {
  allowRagMultiTurnMerge,
  buildRagMultiTurnQueryText,
  type RagSessionRetrievalAnchor,
} from "./rag_multi_turn";
import { extractTopicKeywords } from "./session_memory";
import { isRagNluFeatureEnabled } from "./rag_nlu_mode";
import { groundFollowupQuery, shouldGroundFollowupQuery } from "#agent-shared/followupQueryGrounding";

export type RagMergedUnderstandResult = {
  effectiveQuery: string;
  coalesced?: string;
  multiTurn: boolean;
  needsCondense: boolean;
  retrievalKeywords: string[];
  topics: string[];
  source: "llm" | "structural" | "passthrough";
};

function safeJsonParse(text: string): Record<string, unknown> | null {
  const s = String(text ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1));
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function isRagMergedUnderstandEnabled(): boolean {
  return isRagNluFeatureEnabled("merged");
}

async function mergeByLlm(input: {
  messages: BaseMessage[];
  lastUser: string;
  summary?: string;
  sessionAnchor?: RagSessionRetrievalAnchor | null;
}): Promise<{ coalesced: string; retrieval_keywords: string[] } | null> {
  const env = getRagAgentEnv();
  const model = createRagChatOpenAI({
    modelName: process.env.CONDENSE_MODEL ?? env.condenseModel,
    maxTokens: 360,
  });
  const dialog = input.messages
    .filter((m) => m._getType() === "human" || m._getType() === "ai")
    .slice(-8)
    .map((m) => `${m._getType() === "human" ? "用户" : "助手"}：${String(m.content ?? "").trim()}`)
    .join("\n")
    .slice(0, 2200);
  const anchorBlock = input.sessionAnchor?.coalescedTask
    ? `【上轮任务锚点】\n${input.sessionAnchor.coalescedTask.slice(0, 400)}`
    : "";
  const sys = new SystemMessage(
    [
      "你是 RAG 文档检索的「Stage-4 合并理解节点」：把多轮对话压成一条可独立向量检索的中文问句。",
      "规则：",
      "1) 消除指代，补全省略的主语/文档主题/指标名；",
      "2) 保留时间、数字、否定与全部字段关键词；",
      "3) 去掉「从知识库检索」等元指令；",
      "4) 不编造文档里未出现的专有名词；",
      "5) 仅当末轮是指代承接（缺主语、这个/那个/呢 等）时，才用对话与锚点消指代补全；",
      "6) 若末轮已是自洽完整新问题（含新指标/新主题），coalesced 必须只保留末轮语义，禁止并入上轮主题或锚点；",
      '只输出 JSON：{"coalesced":"...","retrieval_keywords":["..."]}',
    ].join("\n"),
  );
  const human = new HumanMessage(
    [
      anchorBlock,
      `对话摘要：\n${String(input.summary || "（无）").trim().slice(0, 800)}`,
      `最近对话：\n${dialog || "（无）"}`,
      `末轮用户句：\n${input.lastUser.trim()}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  try {
    const res = await model.invoke([sys, human]);
    const obj = safeJsonParse(String(res.content ?? ""));
    const coalesced = String(obj?.coalesced ?? "").trim();
    if (coalesced.length < 6) return null;
    const keywords = Array.isArray(obj?.retrieval_keywords)
      ? obj!.retrieval_keywords!.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 10)
      : [];
    return { coalesced: coalesced.slice(0, 900), retrieval_keywords: keywords };
  } catch {
    return null;
  }
}

/**
 * RAG Stage-4 主入口：多轮合并 → 有效检索问句。
 * 编排模式有 dialog_anchor 时优先侧车，跳过本地合并。
 */
export async function mergeRagMultiTurnUnderstand(input: {
  messages: BaseMessage[];
  lastUser: string;
  summary?: string;
  sessionAnchor?: RagSessionRetrievalAnchor | null;
  skipMerge?: boolean;
  suppressAnchor?: boolean;
  /** 独立 turnScope turn_kind，用于短承接强制锚定 */
  turnKind?: string | null;
}): Promise<RagMergedUnderstandResult> {
  const last = String(input.lastUser || "").trim();
  if (!last || input.skipMerge) {
    return {
      effectiveQuery: last,
      multiTurn: false,
      needsCondense: false,
      retrievalKeywords: [],
      topics: extractTopicKeywords(last),
      source: "passthrough",
    };
  }

  const multiTurn = allowRagMultiTurnMerge({
    messages: input.messages,
    lastUser: last,
    turnKind: input.turnKind,
    suppressAnchor: input.suppressAnchor,
  });

  // 仅会话锚点存在不得强行进入合并；自洽新问直接透传末轮
  if (!multiTurn) {
    return {
      effectiveQuery: last,
      multiTurn: false,
      needsCondense: false,
      retrievalKeywords: [],
      topics: extractTopicKeywords(last),
      source: "passthrough",
    };
  }

  // 短承接锚定：只用会话锚点，禁止用 priorHuman 把新主题拉回旧题
  const anchorTask =
    !input.suppressAnchor && input.sessionAnchor?.coalescedTask
      ? String(input.sessionAnchor.coalescedTask).trim()
      : "";

  let coalesced: string | undefined;
  let retrievalKeywords: string[] = [];
  let source: RagMergedUnderstandResult["source"] = "structural";

  if (isRagMergedUnderstandEnabled()) {
    const llm = await mergeByLlm({
      messages: input.messages,
      lastUser: last,
      summary: input.summary,
      sessionAnchor: input.suppressAnchor ? null : input.sessionAnchor,
    });
    if (llm) {
      coalesced = llm.coalesced;
      retrievalKeywords = llm.retrieval_keywords;
      source = "llm";
    }
  }

  const structural = buildRagMultiTurnQueryText({
    messages: input.messages,
    lastUser: last,
    coalesced,
    sessionAnchor: input.suppressAnchor ? null : input.sessionAnchor,
    suppressAnchor: input.suppressAnchor,
    turnKind: input.turnKind,
  });

  let effectiveQuery = coalesced || structural.query || last;
  const needsCondense = multiTurn || structural.multiTurn;

  if (needsCondense && isRagMergedUnderstandEnabled() && !coalesced) {
    try {
      effectiveQuery = await condenseRetrievalQuery({
        summary: [String(input.summary || ""), input.sessionAnchor?.coalescedTask || ""]
          .filter(Boolean)
          .join("\n")
          .slice(0, 1200),
        messages: input.messages,
        draftQuery: effectiveQuery,
      });
      if (source === "structural") source = "llm";
    } catch {
      /* keep structural */
    }
  }

  // 仅明确 turnKind 承接时 ground；禁止用 multiTurn 启发式伪造 continuation
  if (
    shouldGroundFollowupQuery({
      turnKind: input.turnKind,
      lastUser: last,
      anchorTask,
    })
  ) {
    effectiveQuery = groundFollowupQuery({
      lastUser: last,
      turnKind: input.turnKind,
      anchorTask,
      candidate: effectiveQuery,
    });
  }

  const topics = extractTopicKeywords(effectiveQuery);
  if (
    !input.suppressAnchor &&
    input.sessionAnchor?.topics?.length &&
    (input.turnKind === "continuation" || input.turnKind === "output_followup")
  ) {
    retrievalKeywords = Array.from(
      new Set([...retrievalKeywords, ...input.sessionAnchor.topics]),
    ).slice(0, 12);
  }

  return {
    effectiveQuery: effectiveQuery.trim() || last,
    coalesced: coalesced || (structural.multiTurn ? effectiveQuery : undefined),
    multiTurn: structural.multiTurn || multiTurn,
    needsCondense,
    retrievalKeywords,
    topics,
    source,
  };
}

/** 供 smoke 测试：解析 LLM JSON 形态 */
export function parseMergedUnderstandForTest(raw: {
  coalesced?: string;
  retrieval_keywords?: string[];
}): Pick<RagMergedUnderstandResult, "coalesced" | "retrievalKeywords"> {
  return {
    coalesced: String(raw.coalesced ?? "").trim() || undefined,
    retrievalKeywords: (raw.retrieval_keywords || []).map(String).filter(Boolean),
  };
}
