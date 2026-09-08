import { createRagChatOpenAI } from "./rag_chat_openai";
import { getRagAgentEnv } from "./rag_agent_env";
import { scoreTextOverlap } from "./retrieval_shared";
import {
  defaultRagQueryPlan,
  heuristicRagQueryPlan,
  mergeRagQueryPlans,
  parseRagQueryPlan,
  type RagQueryPlan,
  type RagQueryIntent,
} from "./query_plan";
import type { ManagerRagTaskPayload } from "#agent-shared/managerSubAgentProtocol";
import { isRagHeuristicAllowed, isRagNluFeatureEnabled } from "./rag_nlu_mode";

const ENABLE_RAG_QUERY_PLAN = () => getRagAgentEnv().enableQueryPlan;
const QUERY_PLAN_MIN_LEN = () => getRagAgentEnv().queryPlanMinLen;

export function isCatalogGroundedPlanEnabled(): boolean {
  return String(process.env.RAG_CATALOG_GROUNDED_PLAN ?? process.env.RAG_QUERY_REWRITE ?? "1").trim() !== "0";
}

const envBool = (v: unknown, defaultValue: boolean) => {
  if (v === undefined || v === null || v === "") return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
};

/**
 * 小库/高置信启发式时跳过目录锚定 flash LLM（RAGFlow/Dify 快路径惯例）。
 * 多轮且未做合并理解时仍可调 LLM 消解指代。
 */
export function shouldUseCatalogLlmPlan(opts: {
  docCount: number;
  hasDialogContext?: boolean;
  mergedSource?: string;
  heuristicConfidence?: number;
  subQueryCount?: number;
  intent?: string;
  /** 统一理解 / 上游已给出 plan 时不再打 catalog LLM */
  prefetched?: boolean;
}): boolean {
  if (opts.prefetched) return false;
  if (!isCatalogGroundedPlanEnabled()) return false;
  const env = getRagAgentEnv({ docCount: opts.docCount });
  const skipSmall = envBool(process.env.RAG_SKIP_CATALOG_LLM_SMALL_CORPUS, true);
  const multiPart =
    (opts.subQueryCount ?? 0) >= 2 ||
    opts.intent === "multi_part" ||
    opts.intent === "comparison";
  if (skipSmall && opts.docCount > 0 && opts.docCount <= env.smallCorpusTurboMaxDocs) {
    if (multiPart) return true;
    if (opts.hasDialogContext && opts.mergedSource !== "llm") return true;
    return false;
  }
  if ((opts.heuristicConfidence ?? 0) >= 0.58 && !opts.hasDialogContext) return false;
  return true;
}

/** 无 LLM：用目录文件名/摘要与问句重叠度增强启发式 plan */
export function enrichHeuristicPlanWithCatalog(
  plan: RagQueryPlan,
  query: string,
  docCatalog: { name: string; summary?: string }[],
): RagQueryPlan {
  if (!docCatalog.length) return plan;
  const q = String(query || "").trim();
  const matchedDocs: string[] = [];
  const extraKw: string[] = [];
  let bestScore = 0;
  for (const doc of docCatalog) {
    const name = String(doc.name ?? "").trim();
    const stem = name.replace(/\.[a-z0-9]+$/i, "");
    const summary = String(doc.summary ?? "").trim();
    const nameScore = Math.max(scoreTextOverlap(q, name), scoreTextOverlap(q, stem));
    const summaryScore = summary ? scoreTextOverlap(q, summary) * 0.85 : 0;
    const total = nameScore + summaryScore;
    if (total > bestScore) bestScore = total;
    if (nameScore >= 2 || summaryScore >= 1.5) {
      matchedDocs.push(name);
      if (summary) {
        for (const part of summary.split(/[，,；;、\s]+/).map((s) => s.trim()).filter((s) => s.length >= 2)) {
          if (scoreTextOverlap(q, part) >= 1) extraKw.push(part);
        }
      }
    }
  }
  const boosted = {
    ...plan,
    entities: {
      ...plan.entities,
      doc_names: Array.from(new Set([...plan.entities.doc_names, ...matchedDocs])).slice(0, 6),
    },
    retrieval_keywords: Array.from(new Set([...plan.retrieval_keywords, ...extraKw])).slice(0, 12),
    confidence: Math.max(plan.confidence, matchedDocs.length ? 0.65 : bestScore >= 2 ? 0.55 : plan.confidence),
  };
  return mergeRagQueryPlans(boosted, plan);
}

export function formatRagDocCatalog(docs: { name: string; summary?: string }[]): string {
  if (!docs.length) return "（当前无已索引文档；仅做问句清洗与子句拆分，勿编造专有名词）";
  return docs
    .slice(0, 16)
    .map((d, i) => {
      const summary = String(d.summary ?? "").trim().slice(0, 160);
      return `${i + 1}. ${d.name}${summary ? `：${summary}` : ""}`;
    })
    .join("\n");
}

export type CatalogGroundedPlanResult = {
  plan: RagQueryPlan;
  leanQuery: string;
  source: "llm" | "heuristic";
};

function parseLeanQueryFromJson(raw: string): string {
  const s = String(raw ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  try {
    const o = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    return String(o?.lean_query ?? "").trim();
  } catch {
    return "";
  }
}

/** 供 smoke：解析目录锚定计划 JSON */
export function parseCatalogGroundedPlanForTest(raw: {
  lean_query?: string;
  retrieval_keywords?: string[];
  sub_queries?: string[];
  intent?: string;
}) {
  const leanQuery = String(raw.lean_query ?? raw.sub_queries?.[0] ?? "").trim();
  const retrievalKeywords = (raw.retrieval_keywords || []).map((x) => String(x ?? "").trim()).filter(Boolean);
  const subQueries = (raw.sub_queries || []).map((x) => String(x ?? "").trim()).filter(Boolean);
  return { leanQuery, retrievalKeywords, subQueries };
}

const CATALOG_GROUNDED_PLAN_PROMPT = `你是「文档检索查询理解器」。用户问题可能千奇百怪、口语化、含指代或元指令；你的任务是根据【知识库目录】与【对话上下文】产出 JSON 查询计划，使向量/关键词检索能命中正确文档。

只输出 JSON，不要 Markdown 或解释。

## 任务字典（intent）
definition | process | comparison | fact_lookup | multi_part | quote | doc_list | out_of_scope | unknown

## 输出字段
- lean_query：一条可独立做向量检索的中文问句（去掉「从知识库检索/帮我查」等元指令，补全指代）
- intent / sub_queries / entities.doc_names / entities.topics / entities.numbers / entities.time_hints
- retrieval_keywords：2～8 个，优先来自目录文件名/摘要中的术语、同义表述、上下位词
- needs_graph：boolean — 涉及部门归属、岗位职责、流程步骤、条款互引、多跳关系时为 true；纯单点事实/定义为 false
- needs_clarification / clarification_questions / confidence(0～1)

## 通用规则（适用任意领域）
1) 【知识库目录】是检索范围与扩词的唯一依据；用户抽象问法须对齐到目录中出现的具体主题/字段/文件名；
2) 禁止编造目录中未出现的专有名词、机构名、产品名；
3) 复合/对比/多字段问题必须拆 sub_queries（1～4 条）；单问句则 sub_queries 含 lean_query 即可；
4) 多轮对话：结合上下文消解「他/这个/刚才/上面」等指代，写入 lean_query；
5) 用户口语与文档术语不一致时，retrieval_keywords 应覆盖目录摘要中的实际表述；
6) entities.doc_names：若目录中某文件名与问句明显相关，写入（不含扩展名亦可）；
7) 目录为空时仅清洗问句；needs_clarification 仅在完全无法推断主题时为 true；
8) 保留用户原话中的数字、时间、否定与关键实体；
9) 问「归哪个部门 / 哪些岗位 / 审批链 / 前置条件」等关系时 needs_graph=true（即使 intent=multi_part）。

输出示例结构（勿照抄内容）：
{"lean_query":"…","intent":"fact_lookup","sub_queries":["…"],"entities":{"doc_names":[],"topics":[],"numbers":[],"time_hints":[]},"retrieval_keywords":["…"],"needs_graph":false,"needs_clarification":false,"clarification_questions":[],"confidence":0.82}`;

const QUERY_PLAN_PROMPT = `你是「文档检索意图拆解器」。把用户问题拆成 JSON 查询计划，帮助 RAG 检索更准确。

只输出 JSON，不要 Markdown 或解释。

## 任务字典（intent）
- definition：问概念/定义/含义
- process：问流程/步骤/如何办理
- comparison：对比/区别/哪个更…
- fact_lookup：查具体事实/数字/时间/是否存在
- multi_part：一次问多个独立子问题
- quote：要求原文/摘录/引用
- doc_list：问有哪些文档（非内容检索）
- out_of_scope：与文档无关
- unknown：无法判断

## 输出字段
- intent: 上表之一
- sub_queries: 1～4 条可独立检索的子问句（复合问题必须拆分）
- entities.doc_names / entities.topics / entities.numbers / entities.time_hints
- retrieval_keywords: 同义词、上位词、相关术语（2～8 个）
- needs_graph: 部门归属/岗位职责/流程步骤/条款互引/多跳关系 → true；单点事实 → false
- needs_clarification / clarification_questions / confidence(0～1)

## 推理步骤（CoT，体现在 JSON 质量上，不要输出推理过程）
1) 先判断 intent；2) 再拆 sub_queries 覆盖各字段；3) 补 entities 与 retrieval_keywords；4) 标 needs_graph；5) 信息严重不足才 needs_clarification=true。

## 示例
用户：2023年销售提成和退货政策分别是什么？
{"intent":"multi_part","sub_queries":["2023年销售提成政策","2023年退货政策"],"entities":{"doc_names":[],"topics":["销售提成","退货政策"],"numbers":["2023"],"time_hints":["2023年"]},"retrieval_keywords":["提成比例","退货规则"],"needs_graph":false,"needs_clarification":false,"clarification_questions":[],"confidence":0.85}

用户：入职流程归哪个部门？需要哪些岗位？
{"intent":"multi_part","sub_queries":["入职流程归属部门","入职流程参与岗位"],"entities":{"doc_names":[],"topics":["入职流程","人力资源部","HRBP"],"numbers":[],"time_hints":[]},"retrieval_keywords":["入职","部门","岗位"],"needs_graph":true,"needs_clarification":false,"clarification_questions":[],"confidence":0.86}

规则：
1) 保留用户原意，不编造文档里不存在的专有名词。
2) 对比类、多字段类必须拆 sub_queries；元指令（「从知识库检索」等）不要进 sub_queries。
3) 已有明确主题时 needs_clarification=false。
4) 关系/流程归属类务必 needs_graph=true，以便制度图辅佐 Hybrid。`;

function buildManagerHintsBlock(task?: ManagerRagTaskPayload | null): string {
  if (!task) return "";
  const lines: string[] = [];
  if (task.scope_hint) lines.push(`检索范围说明：${String(task.scope_hint).slice(0, 400)}`);
  if (task.image_caption) lines.push(`画面摘要（图意接地）：${String(task.image_caption).slice(0, 80)}`);
  if (task.retrieval_keywords?.length) lines.push(`已有扩展词：${task.retrieval_keywords.join("、")}`);
  if (task.sub_queries?.length) lines.push(`已有子问句：${task.sub_queries.join("；")}`);
  return lines.length ? `\n\n【编排侧车（可合并，勿重复）】\n${lines.join("\n")}` : "";
}

/** 多轮/会话上下文（供目录锚定理解，通用，非领域词表） */
export type RagDialogContext = {
  sessionSummary?: string;
  recentDialog?: string;
  mergedQuery?: string;
  mergedKeywords?: string[];
  sessionAnchor?: string;
};

export function buildDialogContextBlock(ctx?: RagDialogContext | null): string {
  if (!ctx) return "";
  const parts: string[] = [];
  if (ctx.sessionAnchor) parts.push(`任务锚点：${ctx.sessionAnchor.slice(0, 400)}`);
  if (ctx.sessionSummary) parts.push(`会话摘要：${ctx.sessionSummary.slice(0, 500)}`);
  if (ctx.recentDialog) parts.push(`最近对话：\n${ctx.recentDialog.slice(0, 1400)}`);
  if (ctx.mergedQuery && ctx.mergedQuery.length > 4) {
    parts.push(`多轮合并问句：${ctx.mergedQuery.slice(0, 450)}`);
  }
  if (ctx.mergedKeywords?.length) parts.push(`合并扩展词：${ctx.mergedKeywords.slice(0, 8).join("、")}`);
  return parts.length
    ? `\n\n【对话上下文（解析指代、补全省略；勿编造目录外专有名词）】\n${parts.join("\n\n")}`
    : "";
}

/**
 * 目录锚定查询理解：fast / 总管 / 无完整 plan 时的统一 flash 入口。
 * 不依赖领域词表，扩词完全由知识库目录驱动。
 */
export async function buildCatalogGroundedQueryPlan(
  question: string,
  opts?: {
    rawMessage?: string;
    docCatalog?: { name: string; summary?: string }[];
    managerTask?: ManagerRagTaskPayload | null;
    dialogContext?: RagDialogContext | null;
  },
): Promise<CatalogGroundedPlanResult> {
  const q = String(question ?? "").trim();
  const heuristic = heuristicRagQueryPlan(q);
  const fallbackLean = q;
  if (!q || q.length < 4 || !isCatalogGroundedPlanEnabled()) {
    if (isRagHeuristicAllowed()) {
      return { plan: heuristic, leanQuery: fallbackLean, source: "heuristic" };
    }
    return { plan: defaultRagQueryPlan(), leanQuery: fallbackLean, source: "catalog_llm" };
  }

  try {
    const env = getRagAgentEnv({ docCount: opts?.docCatalog?.length });
    const model = createRagChatOpenAI({
      modelName: env.queryPlanModel,
      maxTokens: 640,
    });
    const human = [
      `【知识库目录】\n${formatRagDocCatalog(opts?.docCatalog ?? [])}`,
      `【用户原话】\n${String(opts?.rawMessage || q).trim().slice(0, 700)}`,
      `【当前检索句】\n${q.slice(0, 450)}`,
      buildDialogContextBlock(opts?.dialogContext),
      buildManagerHintsBlock(opts?.managerTask),
    ]
      .filter(Boolean)
      .join("\n\n");
    const res = await withRetry(() => model.invoke(`${CATALOG_GROUNDED_PLAN_PROMPT}\n\n${human}`));
    const rawText = String(res.content ?? "");
    const parsed = parseRagQueryPlan(rawText);
    const leanQuery = parseLeanQueryFromJson(rawText) || parsed.sub_queries[0] || q;
    if (leanQuery.length < 4 && parsed.confidence <= 0 && !parsed.retrieval_keywords.length) {
      if (isRagHeuristicAllowed()) {
        return { plan: heuristic, leanQuery: fallbackLean, source: "heuristic" };
      }
      return { plan: defaultRagQueryPlan(), leanQuery: fallbackLean, source: "catalog_llm" };
    }
    const llmPlan = {
      ...parsed,
      sub_queries: parsed.sub_queries.length ? parsed.sub_queries : [leanQuery],
      confidence: isRagHeuristicAllowed()
        ? Math.max(parsed.confidence, heuristic.confidence, 0.55)
        : Math.max(parsed.confidence, 0.55),
    };
    const merged = isRagHeuristicAllowed() ? mergeRagQueryPlans(llmPlan, heuristic) : llmPlan;
    return { plan: merged, leanQuery, source: "llm" };
  } catch (e) {
    console.warn("[CatalogGroundedPlan] LLM failed, using heuristic:", e);
    if (isRagHeuristicAllowed()) {
      return { plan: heuristic, leanQuery: fallbackLean, source: "heuristic" };
    }
    return { plan: defaultRagQueryPlan(), leanQuery: fallbackLean, source: "catalog_llm" };
  }
}

const withRetry = async <T>(fn: () => Promise<T>, retries = 2, delay = 800): Promise<T> => {
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

/**
 * 构建 RAG 查询计划。
 * 默认走 catalog-grounded（与主路径一致）；仅 RAG_LEGACY_QUERY_PLAN=1 时用旧 QUERY_PLAN_PROMPT。
 */
export async function buildRagQueryPlan(
  question: string,
  opts?: { fast?: boolean; docCatalog?: { name: string; summary?: string }[] },
): Promise<RagQueryPlan> {
  const q = String(question ?? "").trim();
  if (!q) return defaultRagQueryPlan();

  const heuristic = heuristicRagQueryPlan(q);
  if (opts?.fast && isRagHeuristicAllowed()) return heuristic;

  const useLegacy =
    String(process.env.RAG_LEGACY_QUERY_PLAN ?? "").trim() === "1" ||
    String(process.env.RAG_LEGACY_QUERY_PLAN ?? "").trim().toLowerCase() === "true";

  if (!useLegacy) {
    const grounded = await buildCatalogGroundedQueryPlan(q, {
      docCatalog: opts?.docCatalog,
      rawMessage: q,
    });
    return grounded.plan;
  }

  const shouldUseLlm = ENABLE_RAG_QUERY_PLAN() && q.length >= QUERY_PLAN_MIN_LEN();

  if (!shouldUseLlm) {
    return isRagHeuristicAllowed() ? heuristic : defaultRagQueryPlan();
  }

  try {
    const model = createRagChatOpenAI({
      modelName: getRagAgentEnv().queryPlanModel,
      maxTokens: 600,
    });
    const catalogBlock = opts?.docCatalog?.length
      ? `\n\n【知识库目录（扩词须优先依据此列表，勿编造未出现的专有名词）】\n${formatRagDocCatalog(opts.docCatalog)}`
      : "";
    const res = await withRetry(() =>
      model.invoke(`${QUERY_PLAN_PROMPT}${catalogBlock}\n\n用户问题：\n${q}`),
    );
    const parsed = parseRagQueryPlan(res.content);
    if (parsed.confidence > 0 || parsed.sub_queries.length > 0) {
      const llmPlan = {
        ...parsed,
        sub_queries: parsed.sub_queries.length > 0 ? parsed.sub_queries : heuristic.sub_queries,
        confidence: isRagHeuristicAllowed()
          ? Math.max(parsed.confidence, heuristic.confidence)
          : parsed.confidence,
      };
      return isRagHeuristicAllowed() ? mergeRagQueryPlans(llmPlan, heuristic) : llmPlan;
    }
  } catch (e) {
    console.warn("[RagQueryPlan] LLM failed, using heuristic:", e);
  }
  return isRagHeuristicAllowed() ? heuristic : defaultRagQueryPlan();
}

const COMPOUND_SUB_QUERY_PROMPT = `你是「检索子问句拆分器」。用户一次问了多个独立事实，请拆成 1～2 条可独立做向量检索的中文完整问句。
只输出 JSON：{"sub_queries":["子问句1","子问句2"]}
不要 Markdown、不要解释、不要编造专有名词。`;

/** compound_fast：用 flash 模型拆子问句（仅 1 次短调用，替代全量 query plan） */
export async function buildCompoundSubQueries(question: string, max = 2): Promise<string[]> {
  const q = String(question ?? "").trim();
  if (!q) return [];
  try {
    const model = createRagChatOpenAI({
      modelName: getRagAgentEnv().queryPlanModel,
      maxTokens: 200,
    });
    const res = await withRetry(() =>
      model.invoke(`${COMPOUND_SUB_QUERY_PROMPT}\n\n用户问题：\n${q}`)
    );
    return parseRagQueryPlan(res.content)
      .sub_queries.slice(0, max)
      .map((s) => String(s ?? "").trim())
      .filter(Boolean);
  } catch (e) {
    console.warn("[CompoundSubQueries] LLM failed:", e);
    return [];
  }
}

const RAG_INTENT_ONLY_PROMPT = `你是「文档检索意图分类器」。只根据用户问句判断检索意图 intent，不拆子句、不扩检索词。
只输出 JSON：{"intent":"definition|process|comparison|fact_lookup|multi_part|quote|doc_list|out_of_scope|unknown","confidence":0~1,"rationale":"..."}
规则：对比/差异/不同→comparison；定义/是什么/含义→definition；步骤/流程/如何→process；多独立子问题→multi_part；与文档无关→out_of_scope；不确定→unknown。`;

export type RagIntentOnlyResult = {
  intent: RagQueryIntent;
  confidence: number;
  rationale?: string;
};

function parseIntentOnlyJson(text: string): RagIntentOnlyResult | null {
  const s = String(text ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const intent = String(o.intent ?? "unknown").trim() as RagQueryIntent;
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
    if (!valid.has(intent)) return null;
    const confidence = Number(o.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < 0.52) return null;
    return {
      intent,
      confidence: Math.min(1, confidence),
      rationale: String(o.rationale ?? "").slice(0, 240) || undefined,
    };
  } catch {
    return null;
  }
}

/** catalog 低置信时补一次 T0 意图 LLM（RG-P1-3） */
export async function inferRagIntentLlm(
  question: string,
  opts?: { dialogContext?: string },
): Promise<RagIntentOnlyResult | null> {
  const q = String(question ?? "").trim();
  if (!q || q.length < 4) return null;
  if (!isRagNluFeatureEnabled("intent_rag")) return null;
  try {
    const model = createRagChatOpenAI({
      modelName: getRagAgentEnv().queryPlanModel,
      maxTokens: 160,
    });
    const ctx = String(opts?.dialogContext ?? "").trim().slice(0, 600);
    const res = await withRetry(() =>
      model.invoke(
        [
          RAG_INTENT_ONLY_PROMPT,
          ctx ? `【对话上下文】\n${ctx}` : "",
          `【用户问句】\n${q.slice(0, 900)}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    );
    return parseIntentOnlyJson(String((res as { content?: string })?.content ?? res ?? ""));
  } catch (e) {
    console.warn("[RagIntentLlm] failed:", e);
    return null;
  }
}

const RETRIEVAL_KEYWORDS_PROMPT = `你是 RAG 检索扩展词生成器。根据用户问句与意图，产出 2～8 个用于向量/词法检索的中文关键词或短语。
只输出 JSON：{"retrieval_keywords":["…"],"topics":["…"]}
规则：优先文档术语/同义表述/上下位词；勿编造专有名词；勿用 regex 硬匹配问句。`;

function parseRetrievalKeywordsJson(text: string): { retrieval_keywords: string[]; topics: string[] } | null {
  const s = String(text ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const retrieval_keywords = Array.isArray(o.retrieval_keywords)
      ? o.retrieval_keywords.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 10)
      : [];
    const topics = Array.isArray(o.topics)
      ? o.topics.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 8)
      : [];
    if (!retrieval_keywords.length && !topics.length) return null;
    return { retrieval_keywords, topics };
  } catch {
    return null;
  }
}

/** full 模式 catalog 缺检索词时补 T0 LLM（RG-P1-4） */
export async function inferRetrievalKeywordsLlm(
  question: string,
  opts?: { intent?: string; dialogContext?: string },
): Promise<{ retrieval_keywords: string[]; topics: string[] } | null> {
  const q = String(question ?? "").trim();
  if (!q || q.length < 4) return null;
  if (!isRagNluFeatureEnabled("merged")) return null;
  try {
    const model = createRagChatOpenAI({
      modelName: getRagAgentEnv().queryPlanModel,
      maxTokens: 220,
    });
    const ctx = String(opts?.dialogContext ?? "").trim().slice(0, 500);
    const res = await withRetry(() =>
      model.invoke(
        [
          RETRIEVAL_KEYWORDS_PROMPT,
          opts?.intent ? `intent=${opts.intent}` : "",
          ctx ? `【对话上下文】\n${ctx}` : "",
          `【用户问句】\n${q.slice(0, 900)}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    );
    return parseRetrievalKeywordsJson(String((res as { content?: string })?.content ?? res ?? ""));
  } catch (e) {
    console.warn("[RagRetrievalKeywordsLlm] failed:", e);
    return null;
  }
}
