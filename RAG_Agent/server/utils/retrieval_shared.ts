import { getUploadedDocuments } from "./vectorStore";
import { getRagAgentEnv } from "./rag_agent_env";
import type { RagQueryPlan } from "./query_plan";
import { judgeDocScope, type RagIntentJudgment } from "./doc_scope_judge";
import { filterTextsRelevantToQuery } from "./preference_context_gate";

/** 问句是否要求列全/跨文档穷尽（模型判断） */
export async function looksLikeCompletenessQuery(query: string): Promise<boolean> {
  const docs = await getUploadedDocuments();
  return (await judgeDocScope(String(query ?? "").trim(), docs)).is_completeness_query;
}

/** 问句是否已含明确文档锚点（模型判断） */
export async function hasExplicitDocAnchor(
  query: string,
  intent?: Pick<RagIntentJudgment, "has_explicit_doc_anchor">
): Promise<boolean> {
  if (intent) return intent.has_explicit_doc_anchor;
  const docs = await getUploadedDocuments();
  return (await judgeDocScope(String(query ?? "").trim(), docs)).has_explicit_doc_anchor;
}

function docNameStem(name: string): string {
  const n = String(name ?? "").trim().toLowerCase();
  const dot = n.lastIndexOf(".");
  return dot > 0 ? n.slice(0, dot) : n;
}

/** 将模型识别的点名文档映射到已上传文件名 */
export function resolveSpecifiedToUploaded(
  specified: string[],
  docs: { name: string }[]
): Set<string> {
  const anchored = new Set<string>();
  for (const spec of specified) {
    const s = String(spec ?? "").trim().toLowerCase();
    if (!s) continue;
    const sStem = docNameStem(s);
    for (const d of docs) {
      const name = String(d.name ?? "").trim();
      const nLower = name.toLowerCase();
      const nStem = docNameStem(name);
      if (
        nLower === s ||
        nStem === sStem ||
        nLower.includes(s) ||
        s.includes(nStem) ||
        nStem.includes(sStem)
      ) {
        anchored.add(name);
      }
    }
  }
  return anchored;
}

/** 从 query plan 提取额外关键词（数字/时间/主题） */
export function planEntityKeywordTerms(plan: RagQueryPlan): string[] {
  const ents = plan.entities ?? { doc_names: [], topics: [], numbers: [], time_hints: [] };
  return [
    ...ents.topics,
    ...ents.numbers,
    ...ents.time_hints,
    ...plan.retrieval_keywords,
  ]
    .map((t) => String(t ?? "").trim().toLowerCase())
    .filter((t) => t.length >= 2);
}

export type RetrievalLimits = {
  maxResults: number;
  maxEvidence: number;
  keywordLimit: number;
  perSubQueryTopK: number;
  evidenceFilterOpts: { minKeep: number; minRelativeScore: number; maxKeep: number };
  widenDocRouting: boolean;
};

export function resolveRetrievalLimits(
  plan: RagQueryPlan,
  query: string,
  intent?: Pick<RagIntentJudgment, "is_completeness_query">,
  opts?: { docCount?: number },
): RetrievalLimits {
  const completeness = Boolean(intent?.is_completeness_query);
  const multiPart =
    plan.intent === "multi_part" ||
    plan.intent === "comparison" ||
    (plan.sub_queries?.length ?? 0) >= 2;

  let maxResults = 4;
  if (completeness) maxResults = 8;
  else if (multiPart) maxResults = 7;
  else if (plan.intent === "fact_lookup") maxResults = 5;

  // 多文档库：fact_lookup 略放宽，给 per-source coverage 留槽位
  if ((opts?.docCount ?? 0) >= 2 && plan.intent === "fact_lookup") {
    maxResults = Math.min(maxResults + 1, 8);
  }

  const maxEvidence = Math.min(maxResults + 2, 10);
  const keywordLimit = completeness || multiPart ? 52 : 40;

  return {
    maxResults,
    maxEvidence,
    keywordLimit,
    perSubQueryTopK: multiPart || completeness ? 2 : 1,
    evidenceFilterOpts: {
      minKeep: multiPart || completeness ? 2 : 1,
      minRelativeScore: completeness ? 0.28 : multiPart ? 0.32 : 0.38,
      maxKeep: maxEvidence,
    },
    widenDocRouting: completeness || multiPart,
  };
}

type HybridDocRow = { key: string; doc: any; score: number; keywordScore?: number; laneSubQuery?: string };

export type { HybridDocRow };

/** 复合问句：保证每个子问句至少有一定数量的候选进入重排池 */
export function mergeSubQueryCoverage(
  hybridDocs: HybridDocRow[],
  subQueries: string[],
  perSubQueryTopK: number
): HybridDocRow[] {
  const parts = subQueries.map((q) => String(q || "").trim()).filter((q) => q.length >= 5);
  if (parts.length < 2 || hybridDocs.length === 0) return hybridDocs;

  const picked: HybridDocRow[] = [];
  const seen = new Set<string>();
  for (const sq of parts) {
    const terms = tokenizeForKeywordSearch(sq);
    const ranked = [...hybridDocs]
      .map((row) => ({
        row,
        subScore: scoreDocByQueryTerms(String(row.doc?.pageContent ?? ""), terms),
      }))
      .sort((a, b) => b.subScore - a.subScore || b.row.score - a.row.score);
    let added = 0;
    for (const { row, subScore } of ranked) {
      if (subScore <= 0 && added > 0) continue;
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      picked.push(row);
      added += 1;
      if (added >= perSubQueryTopK) break;
    }
  }
  return uniqBy([...picked, ...hybridDocs], (row) => row.key);
}

/**
 * 多文档库：保证候选池中每个 source 至少保留 perSourceMin 条，再按原序填满 maxResults。
 * 避免近义高分块被单一文档占满 top-k（挤占其它文档的正确段落）。
 */
export function mergeSourceCoverage<T>(
  docs: T[],
  resolveSource: (doc: T) => string,
  opts: { perSourceMin?: number; maxResults: number },
): T[] {
  const maxResults = Math.max(1, Math.floor(opts.maxResults));
  const perSourceMin = Math.max(1, Math.floor(opts.perSourceMin ?? 1));
  if (!docs.length) return [];
  if (docs.length <= maxResults) return docs.slice(0, maxResults);

  const sourceOf = (doc: T) => String(resolveSource(doc) || "unknown").trim() || "unknown";
  const sources: string[] = [];
  const seenSrc = new Set<string>();
  for (const doc of docs) {
    const src = sourceOf(doc);
    if (seenSrc.has(src)) continue;
    seenSrc.add(src);
    sources.push(src);
  }
  if (sources.length < 2) return docs.slice(0, maxResults);

  const docKey = (doc: T, idx: number) =>
    `${sourceOf(doc)}:${idx}:${String((doc as { pageContent?: unknown })?.pageContent ?? "").slice(0, 48)}`;
  const seen = new Set<string>();
  const out: T[] = [];

  for (const src of sources) {
    let added = 0;
    for (let i = 0; i < docs.length && added < perSourceMin; i++) {
      const doc = docs[i];
      if (sourceOf(doc) !== src) continue;
      const key = docKey(doc, i);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(doc);
      added += 1;
    }
  }

  for (let i = 0; i < docs.length && out.length < maxResults; i++) {
    const doc = docs[i];
    const key = docKey(doc, i);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
  }

  return out.slice(0, maxResults);
}

/** 复合问句：证据是否覆盖各子问句（用于档位升级，避免「命中一条就停」） */
export function evidenceCoversSubQueries(
  evidence: EvidenceItem[],
  subQueries: string[],
  minCoveredRatio = 1,
): boolean {
  const parts = subQueries.map((q) => String(q || "").trim()).filter((q) => q.length >= 4);
  if (parts.length < 2 || !evidence.length) return parts.length < 2;
  let covered = 0;
  for (const sq of parts) {
    const terms = distinctiveSubQueryTerms(sq, parts);
    const hit = evidence.some((e) => scoreDocByQueryTerms(String(e.content ?? ""), terms) > 0);
    if (hit) covered += 1;
  }
  const need = Math.max(1, Math.ceil(parts.length * minCoveredRatio));
  return covered >= need;
}

/**
 * 子问句区分性词：去掉与其它子问句共享的泛化词（多少/什么等），
 * 避免「岗位补贴」命中就假装「夜班津贴」也已覆盖。
 */
export function distinctiveSubQueryTerms(subQuery: string, allSubQueries: string[]): string[] {
  const sq = String(subQuery || "").trim();
  const parts = (allSubQueries || []).map((q) => String(q || "").trim()).filter((q) => q.length >= 4);
  const own = tokenizeForKeywordSearch(sq);
  if (!own.length) return [];
  const shared = new Set<string>();
  for (const other of parts) {
    if (other === sq) continue;
    for (const t of tokenizeForKeywordSearch(other)) shared.add(t);
  }
  const distinctive = own.filter((t) => t.length >= 2 && !shared.has(t));
  if (distinctive.length >= 1) return distinctive;
  return own.filter((t) => t.length >= 3);
}

/** 复合问句：每个子问句至少保留 1 条证据，避免 dominant source 挤掉另一主题 */
export function prioritizeEvidenceBySubQueries(
  subQueries: string[],
  items: EvidenceItem[],
  max = 6,
): EvidenceItem[] {
  const list = (items || []).filter((e) => String(e.content ?? "").trim().length >= 4);
  if (!list.length) return [];
  const parts = subQueries.map((q) => String(q || "").trim()).filter((q) => q.length >= 4);
  if (parts.length < 2) {
    return list.slice(0, max);
  }
  const perSub = Math.max(1, Math.floor(max / parts.length));
  const picked: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const sq of parts) {
    const terms = distinctiveSubQueryTerms(sq, parts);
    const ranked = list
      .map((item) => ({
        item,
        score: scoreDocByQueryTerms(String(item.content ?? ""), terms),
      }))
      .sort((a, b) => b.score - a.score);
    let added = 0;
    for (const { item, score } of ranked) {
      if (score <= 0) continue;
      const key = `${item.source}:${String(item.content ?? "").slice(0, 48)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(item);
      added += 1;
      if (added >= perSub) break;
    }
  }
  if (!picked.length) return list.slice(0, max);
  for (const item of list) {
    if (picked.length >= max) break;
    const key = `${item.source}:${String(item.content ?? "").slice(0, 48)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(item);
  }
  return picked.slice(0, max);
}

export const tokenizeForKeywordSearch = (text: string): string[] => {
  const normalized = text.toLowerCase();
  const asciiTerms = normalized.match(/[a-z0-9_]+/g) ?? [];
  const cjkTerms = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const terms = new Set<string>();
  for (const t of asciiTerms) {
    if (t.length >= 2) terms.add(t);
  }
  for (const t of cjkTerms) {
    terms.add(t);
    if (t.length >= 4) {
      for (let i = 0; i <= t.length - 2; i += 1) {
        terms.add(t.slice(i, i + 2));
      }
    }
  }
  return Array.from(terms);
};

export const scoreDocByQueryTerms = (pageContent: string, terms: string[]) => {
  const text = String(pageContent ?? "").toLowerCase();
  if (!text || terms.length === 0) return 0;
  let score = 0;
  for (const t of terms) {
    if (!t) continue;
    if (text.includes(t)) score += t.length >= 3 ? 2 : 1;
  }
  return score;
};

export const uniqBy = <T>(items: T[], keyFn: (t: T) => string) => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
};

export const clampText = (text: string, maxChars: number) => {
  const s = String(text ?? "");
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 16))}\n...(已截断)...`;
};

const normalizeDocNameToken = (text: string) =>
  String(text || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[\s_\-()（）【】\[\]{}《》"“”'‘’、，。,.;；:：!?？]/g, "")
    .trim();

export const buildExplicitDocNotFoundMessage = (
  missing: string[],
  docs: { name: string }[]
): string => {
  const docList = docs.length
    ? docs.map((d) => `- ${d.name}`).join("\n")
    : "- （暂无已上传文档）";
  return [
    `知识库中没有您指定的文档「${missing.join("、")}」，无法查询其章节或条款。`,
    "",
    "当前已上传的文档：",
    docList,
    "",
    "请确认文档名称是否正确，或先在左侧上传该文档后再提问。",
  ].join("\n");
};

export const parseRetrievalMetaFromTool = (toolText: string): Record<string, unknown> | null => {
  const idx = String(toolText ?? "").indexOf("[retrieval_meta]");
  if (idx < 0) return null;
  try {
    return JSON.parse(String(toolText).slice(idx + "[retrieval_meta]".length).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const parseClarifyMessageFromTool = (toolText: string): string => {
  const m = String(toolText ?? "").match(/\[clarify_json\]\s*([\s\S]*?)$/);
  if (m) {
    try {
      const parsed = JSON.parse(String(m[1] ?? "").trim()) as { message?: string };
      if (parsed?.message) return String(parsed.message).trim();
    } catch {
      /* ignore */
    }
  }
  const block = String(toolText ?? "").match(/【需要补充信息】\s*\n?([\s\S]*?)(?:\n\n<|\n\[clarify_json\]|$)/);
  if (block?.[1]) return block[1].trim();
  return "";
};

const extractAnchoredSources = (queries: string[], docs: { name: string }[]): Set<string> => {
  const qTokens = queries.map((q) => normalizeDocNameToken(q)).filter(Boolean);
  if (!qTokens.length) return new Set<string>();
  const anchored = new Set<string>();
  for (const d of docs) {
    const rawName = String(d.name || "").trim();
    if (!rawName) continue;
    const normalizedName = normalizeDocNameToken(rawName);
    if (!normalizedName) continue;
    const matched = qTokens.some((q) => q.includes(normalizedName) || normalizedName.includes(q));
    if (matched) anchored.add(rawName);
  }
  return anchored;
};

export const buildSourceLabel = (metadata: Record<string, any>) => {
  const source = String(metadata?.source ?? "unknown");
  const page = metadata?.page;
  return page ? `${source}#p${page}` : source;
};

export const normalizeMetadata = (metadata: any): Record<string, any> => {
  if (!metadata) return {};
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof metadata === "object") {
    const m = metadata as Record<string, any>;
    if (m.metadata && typeof m.metadata === "object") return m.metadata as Record<string, any>;
    return m;
  }
  return {};
};

export const resolveSourceLabel = (metadata: Record<string, any>, routedSources: Set<string>) => {
  const normalized = normalizeMetadata(metadata);
  const source = String(normalized?.source ?? "").trim();
  const page = normalized?.page;
  if (source) return page ? `${source}#p${page}` : source;
  if (routedSources.size === 1) {
    const [onlySource] = Array.from(routedSources);
    return page ? `${onlySource}#p${page}` : onlySource;
  }
  return "unknown";
};

export const buildClarifyMessage = async (query: string) => {
  const docs = await getUploadedDocuments();
  const docHints = docs.slice(0, 5).map((d) => `- ${d.name}`).join("\n");
  const hintBlock = docHints ? `你当前已上传文档（节选）:\n${docHints}\n\n` : "";
  return [
    "检索到的证据不足，暂时无法给出可靠答案。",
    `${hintBlock}请补充 1-2 个关键信息后我再查：`,
    "1) 直接回复上面列表中的“文档名”（任选一个）或你关心的主题",
    "2) 时间范围/对象（例如某月份、某类人群）",
    "3) 更具体的指标/关键词或文档文件名；",
    `你也可以直接改问：关于“${query}”，请先在指定文档里定位相关段落。`,
  ].join("\n");
};

export const formatClarifyEnvelope = (
  query: string,
  message: string,
  reason: string,
  extraQuestions?: string[]
) => {
  const questions =
    extraQuestions && extraQuestions.length > 0
      ? extraQuestions.slice(0, 3)
      : ["请指定文档名或主题范围", "请补充时间范围或对象范围", "请补充更具体的指标关键词"];
  const managerPayload = { needsClarify: true, questions, query, reason };
  const legacyPayload = { status: "needs_clarification", query, reason, questions, message };
  return [
    "【需要补充信息】",
    message,
    "",
    `<RAG_NEEDS_CLARIFY>${JSON.stringify(managerPayload)}</RAG_NEEDS_CLARIFY>`,
    "",
    "[clarify_json]",
    JSON.stringify(legacyPayload, null, 2),
  ].join("\n");
};

export const selectCandidateSources = async (
  query: string,
  expandedQueries: string[],
  opts?: {
    widenRouting?: boolean;
    subQueryCount?: number;
    intent?: RagIntentJudgment;
  }
) => {
  const env = getRagAgentEnv();
  const docs = await getUploadedDocuments();
  const allQueries = uniqBy(
    [query, ...expandedQueries].map((q) => String(q || "").trim()).filter(Boolean),
    (q) => q.toLowerCase()
  );
  const widenRouting =
    Boolean(opts?.widenRouting) ||
    Boolean(opts?.intent?.is_completeness_query) ||
    (opts?.subQueryCount ?? 0) >= 2;

  if (widenRouting && docs.length > 0) {
    return {
      selectedSources: new Set(docs.map((d) => d.name)),
      debugScores: docs.map((d) => ({ name: d.name, score: 1, reason: "completeness_or_multipart_all_docs" })),
      routingMode: "completeness_or_multipart_all_docs",
    };
  }

  if (env.enableExplicitDocAnchor && opts?.intent?.specified_documents?.length) {
    const anchored = resolveSpecifiedToUploaded(opts.intent.specified_documents, docs);
    if (anchored.size > 0) {
      return {
        selectedSources: anchored,
        debugScores: docs.map((d) => ({
          name: d.name,
          score: anchored.has(d.name) ? 10 : 0,
          reason: anchored.has(d.name) ? "explicit_doc_name_anchor" : "not_anchored",
        })),
        routingMode: "explicit_doc_name_anchor",
      };
    }
  }

  const allTerms = new Set<string>();
  for (const q of allQueries) {
    for (const term of tokenizeForKeywordSearch(q)) allTerms.add(term);
  }
  const scored = docs.map((doc) => {
    const name = String(doc.name ?? "").toLowerCase();
    const summary = String(doc.summary ?? "").toLowerCase();
    let score = 0;
    for (const term of allTerms) {
      if (name.includes(term)) score += term.length >= 3 ? 2.8 : 1.6;
      if (summary.includes(term)) score += term.length >= 3 ? 2.2 : 1.2;
    }
    score += scoreDocNameForQuery(doc.name, allQueries);
    score += scoreTextOverlap(query, summary) * 0.35;
    return { name: doc.name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const bestScore = scored[0]?.score ?? 0;
  const secondScore = scored[1]?.score ?? 0;
  const smallCorpus = docs.length <= env.docRoutingTopN;

  const tryDominant = (minScore: number, ratio: number) => {
    if (!widenRouting && bestScore >= minScore && bestScore >= secondScore * ratio && scored[0]?.name) {
      return {
        selectedSources: new Set([scored[0].name]),
        debugScores: scored.map((row) => ({
          ...row,
          reason: row.name === scored[0]!.name ? "dominant_doc_match" : "excluded_by_dominant_doc",
        })),
        routingMode: smallCorpus ? "small_corpus_dominant_doc" : "dominant_doc_name_match",
      };
    }
    return null;
  };

  const dominant =
    tryDominant(4, 1.75) ??
  (smallCorpus ? tryDominant(3, 1.45) : null);
  if (dominant) return dominant;

  if (bestScore <= 0) {
    return {
      selectedSources: new Set(docs.map((d) => d.name)),
      debugScores: scored.map((row) => ({ ...row, reason: "no_positive_signal_fallback_all" })),
      routingMode: "fallback_all_docs",
    };
  }
  if (bestScore < env.docRoutingMinConfidence) {
    return {
      selectedSources: new Set(docs.map((d) => d.name)),
      debugScores: scored.map((row) => ({ ...row, reason: "low_confidence_fallback_all" })),
      routingMode: "low_confidence_fallback_all_docs",
    };
  }

  if (smallCorpus) {
    return {
      selectedSources: new Set(docs.map((d) => d.name)),
      debugScores: scored.map((row) => ({ ...row, reason: "all_docs_small_corpus_scored" })),
      routingMode: "all_docs_small_corpus",
    };
  }

  const positives = scored.filter((row) => row.score > 0);
  const relaxed = positives.filter((row) => row.score >= bestScore * env.docRoutingRelaxRatio);
  const candidateRows = relaxed.length > 0 ? relaxed : positives.length > 0 ? positives : scored;
  const selected = candidateRows.slice(0, env.docRoutingTopN).map((row) => row.name);
  return {
    selectedSources: new Set(selected),
    debugScores: scored.map((row) => ({
      ...row,
      reason: selected.includes(row.name) ? "selected_top_n" : "not_selected",
    })),
    routingMode: "top_n_scored_docs",
  };
};

export type EvidenceItem = {
  content: string
  source: string
  /** G5：入库时间 ISO；供新鲜度告警 */
  ingest_at?: string
  /** G5：文档版本 / 修订标识 */
  source_version?: string
}

/** 文件名与问句词面重合（通用，用于文档路由） */
export function scoreDocNameForQuery(docName: string, queries: string[]): number {
  const name = String(docName || "").toLowerCase();
  const normName = normalizeDocNameToken(docName);
  let score = 0;
  for (const q of queries) {
    const terms = tokenizeForKeywordSearch(q);
    for (const t of terms) {
      if (t.length >= 2 && name.includes(t)) score += t.length >= 3 ? 3.2 : 1.4;
    }
    const normQ = normalizeDocNameToken(q);
    if (normQ.length >= 3 && normName.includes(normQ)) score += 6;
    else if (normQ.length >= 2 && normName.includes(normQ)) score += 4;
  }
  return score;
}

export function scoreTextOverlap(query: string, text: string): number {
  const terms = tokenizeForKeywordSearch(query);
  if (!terms.length) return 0;
  return scoreDocByQueryTerms(text, terms) * 1.2 + scoreDocByQueryTerms(text, terms.filter((t) => t.length >= 3));
}

/** 用模型筛掉与问句无关的证据块（避免向量误召回其它主题文档） */
export async function filterEvidenceByQueryFocus(
  query: string,
  items: EvidenceItem[],
  opts?: { minKeep?: number; maxKeep?: number; subQueries?: string[] }
): Promise<EvidenceItem[]> {
  if (!items.length) return items;
  const minKeep = opts?.minKeep ?? 1;
  const maxKeep = opts?.maxKeep ?? 4;
  if (items.length <= maxKeep) return items.slice(0, maxKeep);
  const subParts = (opts?.subQueries ?? [])
    .map((q) => String(q || "").trim())
    .filter((q) => q.length >= 4)
    .slice(0, 4);
  const focusQuery =
    subParts.length >= 2 ? [query, ...subParts].join("\n子问句：") : String(query || "").trim();

  const labeled = items.map((e, i) => ({
    item: e,
    text: `[${i}] [来源:${String(e.source ?? "unknown")}] ${String(e.content ?? "").slice(0, 900)}`,
  }));
  try {
    const keptTexts = await filterTextsRelevantToQuery(
      focusQuery,
      labeled.map((row) => row.text)
    );
    const keptSet = new Set(keptTexts);
    const filtered = labeled.filter((row) => keptSet.has(row.text)).map((row) => row.item);
    if (filtered.length) return filtered.slice(0, maxKeep);
  } catch (e) {
    console.warn("[EvidenceFocusFilter] model judge failed:", e);
  }
  return items.slice(0, Math.max(minKeep, Math.min(maxKeep, items.length)));
}

export const parseEvidenceJsonFromTool = (toolText: string): EvidenceItem[] => {
  const raw = String(toolText ?? "").trim();
  if (!raw) return [];
  const marker = "[evidence_json]";
  const idx = raw.indexOf(marker);
  if (idx < 0) return [];
  const after = raw.slice(idx + marker.length).trim();
  const braceStart = after.indexOf("{");
  const braceEnd = after.lastIndexOf("}");
  if (braceStart < 0 || braceEnd <= braceStart) return [];
  try {
    const parsed = JSON.parse(after.slice(braceStart, braceEnd + 1));
    const evidence = Array.isArray(parsed?.evidence) ? parsed.evidence : [];
    return evidence
      .map((e: { content?: string; quote?: string; source?: string }) => ({
        content: String(e?.content ?? e?.quote ?? "").trim(),
        source: String(e?.source ?? "unknown").trim() || "unknown",
      }))
      .filter((e) => Boolean(e.content));
  } catch {
    return [];
  }
};
