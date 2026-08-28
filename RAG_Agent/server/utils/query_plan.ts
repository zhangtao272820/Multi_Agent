
import { splitCompoundQueries } from "#agent-shared/managerSubAgentProtocol";

export type RagQueryIntent =
  | "definition"
  | "process"
  | "comparison"
  | "fact_lookup"
  | "multi_part"
  | "quote"
  | "doc_list"
  | "out_of_scope"
  | "unknown";

export type RagQueryPlan = {
  intent: RagQueryIntent;
  sub_queries: string[];
  entities: {
    doc_names: string[];
    topics: string[];
    numbers: string[];
    time_hints: string[];
  };
  retrieval_keywords: string[];
  needs_clarification: boolean;
  clarification_questions: string[];
  confidence: number;
  /** L 波：门控提示（可选；最终以 query_lane_gates 为准） */
  use_hyde?: boolean;
  use_multi_query?: boolean;
  needs_graph?: boolean;
};

export function defaultRagQueryPlan(): RagQueryPlan {
  return {
    intent: "unknown",
    sub_queries: [],
    entities: { doc_names: [], topics: [], numbers: [], time_hints: [] },
    retrieval_keywords: [],
    needs_clarification: false,
    clarification_questions: [],
    confidence: 0,
  };
}

function optionalBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

const intentSet = new Set<RagQueryIntent>([
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

const STOP_TOPICS = new Set([
  "什么",
  "怎么",
  "如何",
  "哪些",
  "是否",
  "请问",
  "文档",
  "查询",
  "检索",
  "知识库",
  "告诉我",
  "帮忙",
  "一下",
]);

/** 启发式兜底：仅从问句抽主题词，不做领域同义词表（扩词由目录锚定 LLM 负责） */
export function expandHeuristicRetrievalKeywords(q: string): string[] {
  return extractHeuristicTopics(q, 6);
}

/** 从问句提取主题词（启发式兜底用） */
export function extractHeuristicTopics(text: string, max = 6): string[] {
  const s = String(text ?? "").trim();
  if (!s) return [];
  const cjk = s.match(/[\u4e00-\u9fff]{2,10}/g) ?? [];
  const ascii = s.match(/[a-zA-Z][a-zA-Z0-9_\-]{1,}/g) ?? [];
  const out: string[] = [];
  for (const t of [...cjk, ...ascii.map((x) => x.toLowerCase())]) {
    if (STOP_TOPICS.has(t) || t.length < 2) continue;
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function extractHeuristicNumbers(text: string): string[] {
  const s = String(text ?? "");
  const nums = s.match(/\d+(?:\.\d+)?%?/g) ?? [];
  return Array.from(new Set(nums)).slice(0, 6);
}

function extractHeuristicTimeHints(text: string): string[] {
  const s = String(text ?? "");
  const hints: string[] = [];
  const patterns = [
    /\d{4}年/g,
    /\d{1,2}月/g,
    /Q[1-4]/gi,
    /(今年|去年|本月|上月|上周|近期|最近)/g,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) hints.push(...m);
  }
  return Array.from(new Set(hints.map((x) => x.trim()))).slice(0, 4);
}

/** 结构性意图推断（无 LLM 兜底，仅看问句形态） */
function inferHeuristicIntent(q: string): RagQueryIntent {
  const s = String(q ?? "").trim();
  if (!s) return "unknown";
  if (/有哪些文档|文档列表|上传了哪些|什么文件/.test(s)) return "doc_list";
  if (/(原文|逐字|引用|摘录|照抄)/.test(s)) return "quote";
  if (/(对比|比较|区别|差异|哪个更|孰高孰低|vs|VS)/.test(s)) return "comparison";
  if (/(什么是|何谓|定义|含义|指的是什么|什么叫)/.test(s)) return "definition";
  if (/(如何|怎么|怎样|步骤|流程|方法|办理)/.test(s)) return "process";
  if (/(多少|几个|是否|有没有|哪一年|何时|什么时候)/.test(s)) return "fact_lookup";
  const compounds = splitCompoundQueries(s);
  if (compounds.length >= 2) return "multi_part";
  return "fact_lookup";
}

export { splitCompoundQueries } from "#agent-shared/managerSubAgentProtocol";

export function parseRagQueryPlan(raw: unknown): RagQueryPlan {
  const d = defaultRagQueryPlan();
  const text = String(raw ?? "").trim();
  if (!text) return d;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return d;
  let obj: any = null;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return d;
  }
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
  const intentRaw = String(obj?.intent ?? "").trim() as RagQueryIntent;
  const intent = intentSet.has(intentRaw) ? intentRaw : d.intent;
  const confidence = Number(obj?.confidence);
  const entities = obj?.entities ?? {};
  return {
    intent,
    sub_queries: arr(obj?.sub_queries).slice(0, 6),
    entities: {
      doc_names: arr(entities?.doc_names),
      topics: arr(entities?.topics),
      numbers: arr(entities?.numbers),
      time_hints: arr(entities?.time_hints),
    },
    retrieval_keywords: arr(obj?.retrieval_keywords).slice(0, 12),
    needs_clarification: Boolean(obj?.needs_clarification),
    clarification_questions: arr(obj?.clarification_questions).slice(0, 3),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    use_hyde: optionalBool(obj?.use_hyde),
    use_multi_query: optionalBool(obj?.use_multi_query),
    needs_graph: optionalBool(obj?.needs_graph),
  };
}

/** 合并 LLM 计划与启发式兜底，取并集保召回 */
export function mergeRagQueryPlans(primary: RagQueryPlan, fallback: RagQueryPlan): RagQueryPlan {
  const uniq = (xs: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of xs) {
      const k = x.toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  };
  return {
    intent: primary.intent !== "unknown" ? primary.intent : fallback.intent,
    sub_queries: uniq([...primary.sub_queries, ...fallback.sub_queries]).slice(0, 6),
    entities: {
      doc_names: uniq([...primary.entities.doc_names, ...fallback.entities.doc_names]),
      topics: uniq([...primary.entities.topics, ...fallback.entities.topics]).slice(0, 8),
      numbers: uniq([...primary.entities.numbers, ...fallback.entities.numbers]),
      time_hints: uniq([...primary.entities.time_hints, ...fallback.entities.time_hints]),
    },
    retrieval_keywords: uniq([...primary.retrieval_keywords, ...fallback.retrieval_keywords]).slice(0, 12),
    needs_clarification: primary.needs_clarification && fallback.needs_clarification,
    clarification_questions: primary.clarification_questions.length
      ? primary.clarification_questions
      : fallback.clarification_questions,
    confidence: Math.max(primary.confidence, fallback.confidence),
    use_hyde: primary.use_hyde ?? fallback.use_hyde,
    use_multi_query: primary.use_multi_query ?? fallback.use_multi_query,
    needs_graph: primary.needs_graph ?? fallback.needs_graph,
  };
}

/**
 * 无 LLM 时的增强兜底：结构性拆句 + 主题/数字/时间抽取 + 形态意图推断。
 */
export function heuristicRagQueryPlan(question: string): RagQueryPlan {
  const q = String(question ?? "").trim();
  const plan = defaultRagQueryPlan();
  if (!q) return plan;

  const compounds = splitCompoundQueries(q);
  const intent = inferHeuristicIntent(q);
  plan.intent = intent;

  if (compounds.length >= 2) {
    plan.sub_queries = compounds;
    plan.confidence = 0.48;
  } else if (intent === "comparison" && q.length >= 16) {
    const anchor = q.replace(/[？?].*$/, "").trim();
    plan.sub_queries = [q, `${anchor} 要点`, `${anchor} 差异`].filter((x, i, a) => a.indexOf(x) === i).slice(0, 3);
    plan.confidence = 0.42;
  } else {
    plan.sub_queries = [q];
    plan.confidence = q.length >= 8 ? 0.38 : 0.22;
  }

  const docLike = q.match(/[\w\u4e00-\u9fff\-_.]+\.(pdf|docx?|txt|md|xlsx?)/gi) ?? [];
  plan.entities.doc_names = docLike.map((x) => x.trim());
  plan.entities.topics = extractHeuristicTopics(q);
  plan.entities.numbers = extractHeuristicNumbers(q);
  plan.entities.time_hints = extractHeuristicTimeHints(q);

  const kw: string[] = [...expandHeuristicRetrievalKeywords(q)];
  for (const t of plan.entities.topics.slice(0, 4)) {
    if (intent === "definition") kw.push(`${t} 定义`, `${t} 含义`);
    else if (intent === "process") kw.push(`${t} 流程`, `${t} 步骤`);
    else kw.push(t);
  }
  plan.retrieval_keywords = Array.from(new Set(kw)).slice(0, 10);

  if (q.length < 4 && plan.entities.topics.length === 0) {
    plan.needs_clarification = true;
    plan.clarification_questions = ["请补充要查询的文档主题或关键词。"];
  }

  if (intent === "process") plan.needs_graph = true;
  else if (intent === "multi_part" && plan.sub_queries.length >= 2) plan.needs_graph = true;
  else if (
    (intent === "multi_part" || intent === "comparison") &&
    plan.entities.topics.length >= 2
  ) {
    plan.needs_graph = true;
  }

  return plan;
}

/** 理解置信度不足或仅启发式兜底时，应加深检索档位 */
export function planNeedsDeepRetrieval(plan: RagQueryPlan, planSource?: string): boolean {
  if (planSource === "heuristic") return true;
  if (plan.confidence > 0 && plan.confidence < 0.52) return true;
  if (plan.retrieval_keywords.length >= 2 && plan.confidence < 0.62) return true;
  return false;
}

/** fast 路径仍保留改写/侧车扩展词，避免只检一条 effectiveQuery 导致召回失败 */
export function buildFastPathRetrievalQueries(input: {
  effectiveQuery: string;
  plan: RagQueryPlan;
  managerKeywords?: string[];
  max?: number;
}): string[] {
  return buildRetrievalQuerySet(input.plan, input.effectiveQuery, {
    managerKeywords: input.managerKeywords,
    max: input.max,
  });
}

/** 从查询计划组装向量/词法检索 query 集合（通用，关键词亦作独立检索句） */
export function buildRetrievalQuerySet(
  plan: RagQueryPlan,
  effectiveQuery: string,
  opts?: { managerKeywords?: string[]; max?: number },
): string[] {
  const max = Math.max(2, opts?.max ?? 6);
  const base = String(effectiveQuery || "").trim();
  const fromPlan = retrievalQueriesFromPlan(plan, base);
  const keywordQueries = plan.retrieval_keywords
    .map((k) => String(k || "").trim())
    .filter((k) => k.length >= 2);
  const parts = [
    base,
    ...fromPlan,
    ...plan.sub_queries,
    ...keywordQueries,
    ...(opts?.managerKeywords ?? []),
    ...plan.entities.topics.slice(0, 4),
  ]
    .map((q) => String(q || "").trim())
    .filter((q) => q.length >= 2);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= max) break;
  }
  return out.length ? out : base ? [base] : [];
}

/** 合并计划子问句与基础问句，供 Multi-Query / 向量检索去重使用 */
export function retrievalQueriesFromPlan(plan: RagQueryPlan, baseQuery: string): string[] {
  const base = String(baseQuery || "").trim();
  const topicBoost = plan.entities.topics.slice(0, 3);
  const parts = [
    base,
    ...plan.sub_queries,
    ...plan.retrieval_keywords.map((k) => `${base.split(/[，,？?]/)[0] ?? base} ${k}`.trim()),
    ...topicBoost.map((t) => `${t} ${base.slice(0, 24)}`.trim()),
  ]
    .map((x) => String(x || "").trim())
    .filter((x) => x.length >= 4);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function formatRagQueryPlanHint(plan: RagQueryPlan): string {
  const lines: string[] = [];
  if (plan.intent !== "unknown") lines.push(`intent=${plan.intent}`);
  if (plan.entities.doc_names.length) lines.push(`docs=${plan.entities.doc_names.join(",")}`);
  if (plan.sub_queries.length > 1) lines.push(`sub_queries=${plan.sub_queries.length}`);
  return lines.join("; ");
}

export function isComplexQueryPlan(plan: RagQueryPlan, maxSubQueries = 2): boolean {
  if (plan.intent === "multi_part" && plan.sub_queries.length > maxSubQueries) return true;
  if (plan.intent === "comparison" && plan.sub_queries.length > maxSubQueries) return true;
  return false;
}

/** 复合问句子问句列表：plan 子句优先，否则结构拆分 */
export function resolveCompoundSubQueries(plan: RagQueryPlan, query: string): string[] {
  const fromPlan = plan.sub_queries.map((s) => String(s).trim()).filter((s) => s.length >= 4);
  if (fromPlan.length >= 2) return fromPlan.slice(0, 6);
  const split = splitCompoundQueries(query);
  if (split.length >= 2) return split;
  return fromPlan.length ? fromPlan : [String(query || "").trim()].filter((s) => s.length >= 4);
}

/** 是否复合/对比类问句（需 compound 检索保各子主题召回） */
export function isMultiPartRagQuery(plan: RagQueryPlan, query: string): boolean {
  if (plan.intent === "multi_part" || plan.intent === "comparison") return true;
  return resolveCompoundSubQueries(plan, query).length >= 2;
}
