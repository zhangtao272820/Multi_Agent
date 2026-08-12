/**
 * 用模型统一判断：文档范围、路由动作、检索策略、回复质量（不用正则启发式）。
 */
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createRagChatOpenAI } from "./rag_chat_openai";
import { ragFastJudgeModelName } from "./rag_agent_env";

export type RouteAction = "document_list" | "document_upload" | "document_query" | "direct_answer";

export type RagRetrievalMode = "pipeline" | "agentic";

export type RagIntentJudgment = {
  specified_documents: string[];
  missing_documents: string[];
  is_chitchat: boolean;
  route_action: RouteAction;
  is_completeness_query: boolean;
  has_explicit_doc_anchor: boolean;
  /** 多轮场景下，问句是否需 condense 为自包含检索句 */
  needs_condense?: boolean;
  /** 是否可走 retrieve-first 快路径（简单单主题 document_query） */
  retrieve_first_ok?: boolean;
  /**
   * J 波：pipeline=固定 Hybrid 管线；agentic=专家内工具多跳。
   * 由模型判定，代码仅做安全校正。
   */
  retrieval_mode?: RagRetrievalMode;
};

/** @deprecated 别名，保持兼容 */
export type DocScopeJudgment = RagIntentJudgment;

export type RagPreflightInput = {
  query: string;
  uploadedDocs: { name: string }[];
  hasDialogContext?: boolean;
  dialogPreview?: string;
};

const INTENT_SYSTEM_BASE = [
  "你是文档知识库「意图与范围判断器」。",
  "给定用户问题与当前已上传文档文件名列表，输出结构化 JSON 判断。",
  "仅输出 JSON：",
  '{"specified_documents":[],"missing_documents":[],"is_chitchat":false,"route_action":"document_query","is_completeness_query":false,"has_explicit_doc_anchor":false,"needs_condense":false,"retrieve_first_ok":true,"retrieval_mode":"pipeline"}',
  "字段说明：",
  "- specified_documents：用户明确点名的文档/手册/文件名（含书名、扩展名文件、口语专名）；未点名则 []。",
  "- missing_documents：specified 中在已上传列表找不到合理对应的名称。",
  "- is_chitchat：问候、闲聊、感谢等，不涉及文档检索。",
  "- route_action：document_list=问有哪些文档/文件列表；document_upload=问如何上传/导入；",
  "  document_query=问文档内容/条款/流程/事实；direct_answer=与文档库无关或可直接简短回答。",
  "  含「从知识库/文档库检索」「在已上传文档中查找」等表述时，仍视为 document_query（按主题检索），不是 document_list。",
  "- is_completeness_query：用户要求**穷尽列全**全部条目、跨文档汇总、对比所有选项。仅问 2～3 个具体事实（如「A 和 B 分别是多少」）不算 completeness。",
  "- has_explicit_doc_anchor：问句已点名具体文档、章节、页码等锚点，无需再扩展检索问句。",
  "- missing_documents：仅当用户**明确点名**某文件名/手册名且已上传列表中找不到合理对应时才填入；",
  "  勿因问句未点名文件名、或问句较宽泛，就把库内已有文档判为缺失。",
  "- needs_condense：仅当提供了对话上下文时判断。true=问句含指代/省略/承接上文，需改写为自包含检索句；",
  "  false=问句已自包含（含用户重复同一完整问句）。",
  "- retrieve_first_ok：true 当 route 为 document_query、非闲聊、无 missing_documents、非 is_completeness_query，",
  "  且为单主题或不超过 2 个具体事实子问（如「压疮护理要求和行走训练时长分别是多少」仍可为 true）。",
  "- retrieval_mode：pipeline=简单单事实/明确锚文档，走固定检索管线；agentic=跨文档对比、多步调研、综合分析、需要先看目录再选源。",
  "不要输出其它文字。",
].join("\n");

const ANSWER_ADEQUACY_SYSTEM = [
  "你是文档问答质量判断器。",
  "给定用户问题、助手回复及检索证据条数，判断回复是否充分、可交付给用户。",
  "仅输出 JSON：{\"adequate\":true}",
  "adequate=false 当：几乎空回复、只写无效参考来源、来源为 unknown 且无实质内容、",
  "未解释找不到的原因、答非所问、把检索占位/失败说明当作最终答案。",
  "不要输出其它文字。",
].join("\n");

/** 单轮问句：flash 轻量 prompt，少 token、快响应，专判快路径资格 */
const INTENT_FAST_SYSTEM = [
  "你是文档知识库「快路径意图判定器」。给定用户问题与已上传文档文件名，仅输出 JSON，不要其它文字。",
  '{"route_action":"document_query","is_chitchat":false,"is_completeness_query":false,"retrieve_first_ok":true,',
  '"specified_documents":[],"missing_documents":[],"has_explicit_doc_anchor":false,"needs_condense":false,"retrieval_mode":"pipeline"}',
  "route_action：document_list=问有哪些文档；document_upload=问如何上传；document_query=问文档内容/事实；direct_answer=闲聊或与文档无关。",
  "is_completeness_query：仅当用户要求穷尽列全**全部**条目、跨文档汇总**所有**选项时为 true；",
  "  问 2～4 个具体事实（如「A 和 B 分别是多少、某类标准、某字段取值」）为 false。",
  "retrieve_first_ok：document_query 且非闲聊、missing_documents 为空时为 true（含多事实问句，由 compound 快路径处理）。",
  "retrieval_mode：跨文档对比/综合调研/多步分析用 agentic；其余用 pipeline。",
  "specified_documents/missing_documents：仅用户明确点名文件名时使用；未点名时 missing_documents 必须为 []。",
].join("\n");

const intentCache = new Map<string, { at: number; value: RagIntentJudgment }>();
const INTENT_CACHE_TTL_MS = 300_000;

function intentCacheKey(query: string, docNames: string[], dialogKey: string): string {
  return `${query.trim().toLowerCase()}@@${docNames.slice().sort().join("\x1f")}@@${dialogKey}`;
}

const ROUTE_ACTIONS: RouteAction[] = [
  "document_list",
  "document_upload",
  "document_query",
  "direct_answer",
];

function parseIntentJson(text: string): RagIntentJudgment {
  const fallback: RagIntentJudgment = {
    specified_documents: [],
    missing_documents: [],
    is_chitchat: false,
    route_action: "document_query",
    is_completeness_query: false,
    has_explicit_doc_anchor: false,
    needs_condense: false,
    retrieve_first_ok: true,
    retrieval_mode: "pipeline",
  };
  const t = String(text ?? "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return fallback;
  try {
    const parsed = JSON.parse(t.slice(start, end + 1)) as {
      specified_documents?: unknown;
      missing_documents?: unknown;
      is_chitchat?: boolean;
      route_action?: string;
      is_completeness_query?: boolean;
      has_explicit_doc_anchor?: boolean;
      needs_condense?: boolean;
      retrieve_first_ok?: boolean;
      retrieval_mode?: string;
    };
    const arr = (v: unknown) =>
      Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
    const route = String(parsed.route_action ?? "").trim() as RouteAction;
    const modeRaw = String(parsed.retrieval_mode ?? "").trim().toLowerCase();
    const retrieval_mode: RagRetrievalMode = modeRaw === "agentic" ? "agentic" : "pipeline";
    return {
      specified_documents: arr(parsed.specified_documents),
      missing_documents: arr(parsed.missing_documents),
      is_chitchat: Boolean(parsed.is_chitchat),
      route_action: ROUTE_ACTIONS.includes(route) ? route : "document_query",
      is_completeness_query: Boolean(parsed.is_completeness_query),
      has_explicit_doc_anchor: Boolean(parsed.has_explicit_doc_anchor),
      needs_condense: Boolean(parsed.needs_condense),
      retrieve_first_ok: parsed.retrieve_first_ok !== false,
      retrieval_mode,
    };
  } catch {
    return fallback;
  }
}

function parseAdequacyJson(text: string): boolean {
  const t = String(text ?? "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return true;
  try {
    const parsed = JSON.parse(t.slice(start, end + 1)) as { adequate?: boolean };
    return parsed.adequate !== false;
  } catch {
    return true;
  }
}

function createJudgeModel(maxTokens: number) {
  return createRagChatOpenAI({
    modelName: ragFastJudgeModelName(),
    maxTokens,
  });
}

/** 依据模型结构化输出校正快路径资格，避免 LLM 误把简单 document_query 判成不可快路径 */
function normalizeRetrieveFirstOk(j: RagIntentJudgment, docCount: number): RagIntentJudgment {
  if (docCount <= 0) return { ...j, retrieve_first_ok: false, retrieval_mode: j.retrieval_mode || "pipeline" };
  if (j.is_chitchat || j.route_action !== "document_query") {
    return { ...j, retrieve_first_ok: false, retrieval_mode: j.retrieval_mode || "pipeline" };
  }
  if (j.missing_documents.length > 0) {
    return { ...j, retrieve_first_ok: false, retrieval_mode: j.retrieval_mode || "pipeline" };
  }
  // 穷尽/跨文档综合 → agentic，且不走 retrieve-first
  if (j.is_completeness_query || j.retrieval_mode === "agentic") {
    return {
      ...j,
      retrieve_first_ok: false,
      retrieval_mode: "agentic",
    };
  }
  return {
    ...j,
    retrieve_first_ok: true,
    retrieval_mode: j.retrieval_mode === "agentic" ? "agentic" : "pipeline",
  };
}

/** 请求级复用：chat 入口已判定时跳过后续重复 judge */
let requestIntent: RagIntentJudgment | null = null;

export function setRagRequestIntent(intent: RagIntentJudgment | null) {
  requestIntent = intent;
}

export function getRagRequestIntent(): RagIntentJudgment | null {
  return requestIntent;
}

export function formatDialogPreview(messages: BaseMessage[], limit = 6): string {
  return messages
    .filter((m) => m._getType() === "human" || m._getType() === "ai")
    .slice(-limit)
    .map((m) => {
      const role = m._getType() === "human" ? "用户" : "助手";
      const text = String(m.content ?? "").trim();
      return `${role}：${text.length > 240 ? `${text.slice(0, 240)}…` : text}`;
    })
    .filter((line) => line.length > 3)
    .join("\n");
}

/**
 * 单次模型调用完成：路由/范围/快路径资格/是否需 condense。
 * 单轮用 flash 紧凑 prompt；多轮用完整 prompt 含 needs_condense。
 * chat 入口调用一次，全链路复用缓存，避免串行多次 judge。
 */
export async function judgeRagPreflight(input: RagPreflightInput): Promise<RagIntentJudgment> {
  const q = String(input.query || "").trim();
  const docNames = input.uploadedDocs.map((d) => String(d.name ?? "").trim()).filter(Boolean);
  const dialogKey = input.hasDialogContext ? String(input.dialogPreview ?? "").slice(0, 400) : "";
  const key = intentCacheKey(q, docNames, dialogKey);
  const hit = intentCache.get(key);
  if (hit && Date.now() - hit.at < INTENT_CACHE_TTL_MS) return hit.value;

  if (!q) {
    const empty: RagIntentJudgment = {
      specified_documents: [],
      missing_documents: [],
      is_chitchat: true,
      route_action: "direct_answer",
      is_completeness_query: false,
      has_explicit_doc_anchor: false,
      needs_condense: false,
      retrieve_first_ok: false,
      retrieval_mode: "pipeline",
    };
    intentCache.set(key, { at: Date.now(), value: empty });
    return empty;
  }

  try {
    const hasDialog = Boolean(input.hasDialogContext);
    const model = createJudgeModel(hasDialog ? 280 : 160);
    const docBlock = docNames.length
      ? docNames.map((n, i) => `[${i}] ${n}`).join("\n")
      : "（知识库暂无已上传文档）";
    const dialogBlock =
      hasDialog && String(input.dialogPreview || "").trim()
        ? `\n\n最近对话（供 needs_condense 判断）：\n${String(input.dialogPreview).trim()}`
        : "";
    const res = await model.invoke([
      new SystemMessage(hasDialog ? INTENT_SYSTEM_BASE : INTENT_FAST_SYSTEM),
      new HumanMessage(`用户问题：${q}\n\n已上传文档：\n${docBlock}${dialogBlock}`),
    ]);
    const parsed = normalizeRetrieveFirstOk(parseIntentJson(String(res.content ?? "")), docNames.length);
    intentCache.set(key, { at: Date.now(), value: parsed });
    return parsed;
  } catch (e) {
    console.warn("[RagPreflight] failed:", e);
    return {
      specified_documents: [],
      missing_documents: [],
      is_chitchat: false,
      route_action: "document_query",
      is_completeness_query: false,
      has_explicit_doc_anchor: false,
      needs_condense: Boolean(input.hasDialogContext),
      retrieve_first_ok: true,
      retrieval_mode: "pipeline",
    };
  }
}

export async function judgeDocScope(
  query: string,
  uploadedDocs: { name: string }[]
): Promise<RagIntentJudgment> {
  const cached = getRagRequestIntent();
  if (cached) return cached;
  return judgeRagPreflight({ query, uploadedDocs });
}

/** 问句中点名了但知识库不存在的文档（模型判断） */
export async function findExplicitMissingDocs(
  queries: string[],
  docs: { name: string }[]
): Promise<string[]> {
  const cached = getRagRequestIntent();
  if (cached) return cached.missing_documents;
  const q =
    queries
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .pop() || "";
  return (await judgeRagPreflight({ query: q, uploadedDocs: docs })).missing_documents;
}

export async function isInadequateRagAnswer(
  question: string,
  answer: string,
  hints?: { needsClarify?: boolean; evidenceCount?: number }
): Promise<boolean> {
  const a = String(answer || "").trim();
  if (!a) return true;
  if (hints?.needsClarify) return true;
  if ((hints?.evidenceCount ?? 0) > 0) return false;
  try {
    const model = createJudgeModel(96);
    const res = await model.invoke([
      new SystemMessage(ANSWER_ADEQUACY_SYSTEM),
      new HumanMessage(
        [
          `用户问题：${String(question || "").trim()}`,
          `检索证据条数：${hints?.evidenceCount ?? "未知"}`,
          `助手回复：${a.slice(0, 800)}`,
        ].join("\n")
      ),
    ]);
    return !parseAdequacyJson(String(res.content ?? ""));
  } catch (e) {
    console.warn("[AnswerAdequacyJudge] failed:", e);
    return false;
  }
}
