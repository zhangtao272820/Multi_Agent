/**
 * 轻量 RAG 评测指标（无 LLM）：precision@k、上下文 overlap、拒答判定。
 */

export type EvalCaseLike = {
  expect_refuse?: boolean;
  expect_sources?: string[];
  expect_evidence_keywords?: string[];
  tags?: string[];
};

export type EvalRetrieveLike = {
  ok?: boolean;
  evidence?: Array<{ source?: string; content?: string }>;
  needsClarify?: boolean;
  needs_clarify?: boolean;
  agentResult?: { needs_clarify?: boolean; answer?: string };
  answer?: string;
  clarify?: boolean;
  retrieval_failure_mode?: string;
};

/** Top-K 来源命中期望 source 的 precision（命中期望数 / min(k, ranked)） */
export function precisionAtK(
  rankedSources: string[],
  expectSources: string[],
  k = 5
): number {
  const expects = (expectSources ?? []).map((s) => String(s || "").trim()).filter(Boolean);
  if (!expects.length) return 1;
  const top = (rankedSources ?? [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, Math.max(1, k));
  if (!top.length) return 0;
  let hits = 0;
  for (const src of top) {
    if (expects.some((e) => src.includes(e) || e.includes(src))) hits += 1;
  }
  return hits / top.length;
}

function tokenizeOverlap(text: string): Set<string> {
  const raw = String(text ?? "").toLowerCase();
  const out = new Set<string>();
  const cjk = raw.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const w of cjk) {
    out.add(w);
    if (w.length >= 4) {
      for (let i = 0; i + 2 <= w.length; i += 2) out.add(w.slice(i, i + 2));
    }
  }
  const latin = raw.match(/[a-z0-9_]{2,}/g) ?? [];
  for (const w of latin) out.add(w);
  return out;
}

/** 问句与证据文本的 Jaccard overlap（CJK bigram / latin token） */
export function contextOverlapRelevance(query: string, evidenceTexts: string[]): number {
  const q = tokenizeOverlap(query);
  if (!q.size) return 0;
  const corpus = tokenizeOverlap((evidenceTexts ?? []).join("\n"));
  if (!corpus.size) return 0;
  let inter = 0;
  for (const t of q) if (corpus.has(t)) inter += 1;
  const union = q.size + corpus.size - inter;
  return union > 0 ? inter / union : 0;
}

function hasRefuseSignal(data: EvalRetrieveLike): boolean {
  if (data.needsClarify || data.needs_clarify || data.clarify) return true;
  if (data.agentResult?.needs_clarify) return true;
  const mode = String(data.retrieval_failure_mode || "").toLowerCase();
  if (mode.includes("refuse") || mode.includes("clarify") || mode.includes("empty") || mode.includes("weak")) {
    return true;
  }
  const answer = String(data.answer || data.agentResult?.answer || "");
  if (/无法回答|没有相关|未找到|知识库中没有|不足以回答|请补充|澄清/.test(answer)) return true;
  const ev = Array.isArray(data.evidence) ? data.evidence : [];
  if (ev.length === 0) return true;
  return false;
}

function hasFabricatedNumericClaims(data: EvalRetrieveLike): boolean {
  const answer = String(data.answer || data.agentResult?.answer || "").trim();
  if (!answer) return false;
  const corpus = (data.evidence || []).map((e) => String(e?.content ?? "")).join("\n");
  const claims: string[] = [];
  for (const m of answer.match(/\d+(?:\.\d+)?%|\d+(?:\.\d+)?/g) ?? []) claims.push(m);
  for (const m of answer.match(/第[一二三四五六七八九十百千\d]+[条款章节项]/g) ?? []) claims.push(m);
  if (!claims.length) return false;
  if (!corpus.trim()) return true;
  const missing = claims.filter((c) => !corpus.includes(c));
  return missing.length / claims.length > 0.5;
}

/**
 * expect_refuse：须澄清/空证据/拒答信号，且不得编造数字条款。
 * retrieve 无答案时：空证据或 clarify 即通过。
 */
export function isRefusalPass(c: EvalCaseLike, data: EvalRetrieveLike): boolean {
  if (!c.expect_refuse) return false;
  if (data?.ok === false) return true;
  if (hasFabricatedNumericClaims(data)) return false;
  return hasRefuseSignal(data);
}

/** 证据正文是否覆盖期望关键词 */
export function evidenceKeywordsPass(
  evidenceTexts: string[],
  keywords: string[]
): boolean {
  const joined = (evidenceTexts ?? []).join("\n");
  const kws = (keywords ?? []).map((k) => String(k || "").trim()).filter(Boolean);
  if (!kws.length) return true;
  if (!joined.trim()) return false;
  return kws.every((k) => joined.includes(k));
}

export function rankedSourcesFromEvidence(
  evidence: Array<{ source?: string }> | undefined
): string[] {
  return (evidence || []).map((e) => String(e?.source || "")).filter(Boolean);
}
