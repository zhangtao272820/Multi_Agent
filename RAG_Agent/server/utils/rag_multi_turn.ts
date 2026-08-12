/**
 * RAG Stage-4 多轮：结构性判定 + 会话检索锚点（对齐总管 multiTurnIntent）。
 * 契约：messages = 不含本轮的历史；lastUser = 本轮原话。
 */
import { type BaseMessage } from "@langchain/core/messages";

export type RagSessionRetrievalAnchor = {
  coalescedTask?: string;
  lastIntent?: string;
  topics: string[];
  updatedAt: string;
};

const REFER_MARKERS = [
  "这个",
  "那个",
  "上述",
  "同上",
  "上面",
  "前面",
  "刚才",
  "上次",
  "继续",
  "它",
  "他们",
  "前文",
  "这点",
  "呢",
] as const;

function humanTexts(messages: BaseMessage[]): string[] {
  return messages
    .filter((m) => m._getType() === "human")
    .map((m) => String(m.content ?? "").trim())
    .filter(Boolean);
}

/** 上一用户句：生产入参 messages 不含本轮；兼容 smoke 把本轮也塞进 messages */
export function previousHumanForMerge(messages: BaseMessage[], lastUser: string): string {
  const texts = humanTexts(messages);
  const last = String(lastUser || "").trim();
  if (!texts.length) return "";
  const lastH = texts[texts.length - 1]!;
  if (lastH === last) return texts.length >= 2 ? texts[texts.length - 2]! : "";
  return lastH;
}

function isExplicitReferentialFollowup(lastUser: string): boolean {
  const compact = String(lastUser || "").replace(/\s+/g, "");
  if (!compact || compact.length > 12) return false;
  return REFER_MARKERS.some((w) => compact.includes(w));
}

/**
 * 结构性多轮：仅明确指代承接才触发（禁止长度比误判自洽新问）。
 * messages 契约与生产一致：不含本轮；若含本轮则自动对齐 prev。
 */
export function shouldRunRagMultiTurnMerge(messages: BaseMessage[], lastUser: string): boolean {
  if (String(process.env.RAG_DISABLE_MULTI_TURN ?? "").trim() === "1") return false;
  const last = String(lastUser || "").trim();
  if (!last || last.length > 220) return false;
  const prev = previousHumanForMerge(messages, last);
  if (!prev) return false;
  return isExplicitReferentialFollowup(last);
}

/** 是否允许本轮走多轮合并（turnKind 优先；否则结构指代） */
export function allowRagMultiTurnMerge(input: {
  messages: BaseMessage[];
  lastUser: string;
  turnKind?: string | null;
  suppressAnchor?: boolean;
}): boolean {
  if (input.suppressAnchor) return false;
  const kind = String(input.turnKind || "").trim();
  if (kind === "new_task" || kind === "chitchat") return false;
  if (kind === "continuation" || kind === "output_followup" || kind === "slot_answer") return true;
  return shouldRunRagMultiTurnMerge(input.messages, input.lastUser);
}

/** 多轮场景下用于检索/意图 RAG 的扩展问句（结构拼接，LLM 失败时回退） */
export function buildRagMultiTurnQueryText(input: {
  messages: BaseMessage[];
  lastUser: string;
  coalesced?: string;
  sessionAnchor?: RagSessionRetrievalAnchor | null;
  suppressAnchor?: boolean;
  turnKind?: string | null;
}): { query: string; multiTurn: boolean } {
  const last = String(input.lastUser || "").trim();
  const coalesced = String(input.coalesced || "").trim();
  const multiTurn = allowRagMultiTurnMerge({
    messages: input.messages,
    lastUser: last,
    turnKind: input.turnKind,
    suppressAnchor: input.suppressAnchor,
  });

  if (!multiTurn) {
    return { query: last, multiTurn: false };
  }

  if (coalesced.length >= 6) {
    return { query: coalesced.slice(0, 1200), multiTurn: true };
  }

  // 结构回退：禁止把完整上轮 Q&A 灌进向量句；仅指代时用锚点/上一用户句消指代
  if (isExplicitReferentialFollowup(last)) {
    const anchor = input.suppressAnchor
      ? ""
      : String(input.sessionAnchor?.coalescedTask || "").trim();
    const prev = previousHumanForMerge(input.messages, last);
    const parts = [anchor || prev, last].map((s) => String(s || "").trim()).filter(Boolean);
    return { query: parts.join("\n").slice(0, 1400), multiTurn: true };
  }

  // continuation 但无明确指代：保守只用末轮（依赖 LLM coalesced）
  return { query: last, multiTurn: true };
}

export function anchorBoostForRagRecall(
  hit: { intent: string },
  anchor: RagSessionRetrievalAnchor | null | undefined,
): number {
  if (!anchor?.lastIntent) return 0;
  let boost = 0;
  if (hit.intent === anchor.lastIntent) boost += 0.05;
  if (anchor.topics.length && hit.intent === "fact_lookup") boost += 0.02;
  return boost;
}

export function buildRagSessionRetrievalAnchor(input: {
  coalescedTask?: string;
  lastIntent?: string;
  topics?: string[];
}): RagSessionRetrievalAnchor {
  return {
    coalescedTask: input.coalescedTask ? String(input.coalescedTask).trim().slice(0, 880) : undefined,
    lastIntent: input.lastIntent ? String(input.lastIntent).trim().slice(0, 64) : undefined,
    topics: (input.topics || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8),
    updatedAt: new Date().toISOString(),
  };
}

export function formatSessionRetrievalAnchorBlock(anchor: RagSessionRetrievalAnchor | null | undefined): string {
  if (!anchor?.coalescedTask) return "";
  return [
    "【上轮检索任务锚点（多轮承接参考，勿硬套若本轮已切换主题）】",
    anchor.lastIntent ? `intent=${anchor.lastIntent}` : "",
    anchor.coalescedTask ? `task=${anchor.coalescedTask.slice(0, 240)}` : "",
    anchor.topics.length ? `topics=${anchor.topics.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 从 condense 上下文消息提取末轮用户句（供测试） */
export function lastHumanFromMessages(messages: BaseMessage[]): string {
  const texts = humanTexts(messages);
  return texts[texts.length - 1] || "";
}
