/**
 * 轻量检索评测：对 data/rag-eval-questions.json 调用 /api/retrieve
 * 用法：先 npm run dev，再 npm run eval:rag
 * CI：npm run eval:rag:ci（未达 RAG_EVAL_MIN_PASS_RATE 时 exit 1）
 * 说明：非完整 RAGAS；含 precision@k / context overlap / refuse。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  precisionAtK,
  contextOverlapRelevance,
  isRefusalPass,
  evidenceKeywordsPass,
  rankedSourcesFromEvidence,
} from "../server/utils/rag_eval_metrics.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const base = process.env.RAG_EVAL_URL || "http://localhost:13102";
const minPassRate = Number(process.env.RAG_EVAL_MIN_PASS_RATE ?? "0.5");
const minAvgPrecision = Number(process.env.RAG_EVAL_MIN_AVG_PRECISION ?? "0");
const ciMode = process.argv.includes("--ci") || process.env.RAG_EVAL_CI === "1";

const cases = JSON.parse(
  fs.readFileSync(path.join(root, "data/rag-eval-questions.json"), "utf8")
);

function isDocumentListHit(data: any) {
  const intent = String(data?.intent || data?.route_intent || data?.nlu?.intent || "").toLowerCase();
  if (intent.includes("document_list") || intent.includes("list") || intent === "doc_list") return true;
  if (Array.isArray(data?.documents) && data.documents.length > 0) return true;
  if (Array.isArray(data?.doc_list) && data.doc_list.length > 0) return true;
  if (Array.isArray(data?.evidence) && data.evidence.length > 0) {
    const joined = JSON.stringify(data.evidence).toLowerCase();
    if (joined.includes("document") || joined.includes("文档") || joined.includes(".pdf") || joined.includes(".docx")) {
      return true;
    }
  }
  const answer = String(data?.answer || data?.summary || "").toLowerCase();
  return answer.includes("文档") || answer.includes("共有") || answer.includes("如下");
}

function hasStaleHintSignal(data: any) {
  const blob = JSON.stringify(data ?? {});
  return /过期|最新制度|stale|freshness/i.test(blob);
}

function hasFreshnessMeta(data: any) {
  const ev = Array.isArray(data?.evidence) ? data.evidence : [];
  return ev.some((e: any) => Boolean(e?.ingest_at || e?.source_version || e?.ingestAt || e?.sourceVersion));
}

function hasClarifyOrCiteSignal(c: any, data: any) {
  const blob = JSON.stringify(data ?? {});
  if (
    /澄清|不一致|以.*为准|source_version|版本|冲突/.test(blob) ||
    /clarify|conflict/i.test(blob)
  ) {
    return true;
  }
  const sources = (data.evidence || []).map((e: any) => String(e.source || "")).join(" ");
  return (c.expect_sources || []).some((s: string) => sources.includes(s) || blob.includes(s));
}

function checkAnswerGroundedInEvidence(answer: string, evidence: any[]) {
  const corpus = (evidence || []).map((e) => String(e?.content ?? "")).join("\n");
  const s = String(answer ?? "");
  const claims: string[] = [];
  for (const m of s.match(/\d+(?:\.\d+)?%|\d+(?:\.\d+)?/g) ?? []) claims.push(m);
  for (const m of s.match(/第[一二三四五六七八九十百千\d]+[条款章节项]/g) ?? []) claims.push(m);
  if (claims.length < 1) return { ok: true, reason: "no_numeric_claims" };
  if (!corpus.trim()) return { ok: false, reason: "empty_evidence" };
  const missing = claims.filter((c) => !corpus.includes(c));
  if (missing.length / claims.length > 0.5) return { ok: false, missing };
  return { ok: true };
}

function hasSourceHit(c: any, data: any) {
  const sources = (data.evidence || []).map((e: any) => String(e.source || "")).join(" ");
  const blob = JSON.stringify(data ?? {});
  return (c.expect_sources || []).some((s: string) => sources.includes(s) || blob.includes(s));
}

function casePass(c: any, data: any) {
  if (c.expect_refuse === true) {
    return isRefusalPass(c, data);
  }
  if (!data?.ok) return false;
  if (c.expect_intent === "document_list") {
    return isDocumentListHit(data);
  }
  if (c.expect_stale_hint === true) {
    const hit = hasSourceHit(c, data);
    const hasEvidence = Boolean(data.evidence?.length > 0 || hit);
    return hasEvidence && (hasFreshnessMeta(data) || hasStaleHintSignal(data));
  }
  if (c.expect_clarify_or_cite === true && !c.tags?.includes("faithfulness")) {
    return hasClarifyOrCiteSignal(c, data);
  }
  if (Array.isArray(c.expect_evidence_keywords) && c.expect_evidence_keywords.length) {
    const texts = (data.evidence || []).map((e: any) => String(e.content || ""));
    if (!evidenceKeywordsPass(texts, c.expect_evidence_keywords)) return false;
  }
  if (Array.isArray(c.tags) && c.tags.includes("faithfulness")) {
    const hit = hasSourceHit(c, data) || Boolean(data.evidence?.length > 0);
    if (!hit) return false;
    const answer = String(data.answer || data.agentResult?.answer || "").trim();
    if (answer && data.evidence?.length) {
      const grounded = checkAnswerGroundedInEvidence(answer, data.evidence);
      if (grounded.ok) return true;
      if (data.needsClarify || data.agentResult?.needs_clarify) return true;
      return false;
    }
    return (
      data.evidence.some((e: any) => String(e.content || "").trim().length >= 20) &&
      (hasClarifyOrCiteSignal(c, data) || hasSourceHit(c, data))
    );
  }
  const hit = hasSourceHit(c, data);
  return Boolean(data.evidence?.length > 0 || hit);
}

const results: any[] = [];
let ok = 0;
let precisionSum = 0;
let precisionN = 0;
let relevanceSum = 0;
let relevanceN = 0;

for (const c of cases) {
  const t0 = Date.now();
  let data: any = {};
  try {
    const res = await fetch(`${base}/api/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: c.question, skipLlmRerank: true, skipEvidenceSelect: true }),
    });
    data = await res.json().catch(() => ({}));
  } catch (e: any) {
    console.error(`ERR [${c.id}]`, e?.message || e);
  }
  const pass = casePass(c, data);
  if (pass) ok += 1;

  const ranked = rankedSourcesFromEvidence(data.evidence);
  const pAt5 =
    c.expect_refuse || !c.expect_sources?.length
      ? null
      : precisionAtK(ranked, c.expect_sources, 5);
  if (typeof pAt5 === "number") {
    precisionSum += pAt5;
    precisionN += 1;
  }
  const texts = (data.evidence || []).map((e: any) => String(e.content || ""));
  const ctxRel = texts.length ? contextOverlapRelevance(c.question, texts) : 0;
  if (texts.length) {
    relevanceSum += ctxRel;
    relevanceN += 1;
  }

  const row = {
    id: c.id,
    pass,
    hits: data.evidence?.length ?? 0,
    ms: data.ms ?? Date.now() - t0,
    precision_at_5: pAt5,
    context_relevance: texts.length ? ctxRel : null,
    agentic_rounds: data.agentic_rounds ?? 0,
    experience_hits: data.experience_hits ?? 0,
    rerank_mode: data.rerank_mode,
  };
  results.push(row);
  console.log(
    `${pass ? "PASS" : "FAIL"} [${c.id}] ${c.question.slice(0, 40)}… hits=${row.hits} p@5=${pAt5 ?? "-"} ctx=${row.context_relevance?.toFixed?.(3) ?? "-"}`
  );
}

const avgPrecision = precisionN ? precisionSum / precisionN : 0;
const avgContextRelevance = relevanceN ? relevanceSum / relevanceN : 0;

const report = {
  at: new Date().toISOString(),
  base,
  total: cases.length,
  passed: ok,
  passRate: cases.length ? ok / cases.length : 0,
  avg_precision_at_5: avgPrecision,
  avg_context_relevance: avgContextRelevance,
  minPassRate,
  minAvgPrecision,
  ciMode,
  results,
};

const outDir = path.join(root, ".data");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "rag-eval-baseline.json");
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

console.log(
  `\n${ok}/${cases.length} passed (${Math.round(report.passRate * 100)}%) avg_p@5=${avgPrecision.toFixed(3)} avg_ctx=${avgContextRelevance.toFixed(3)}`
);
console.log(`baseline -> ${outFile}`);

if (ciMode && report.passRate < minPassRate) {
  console.error(`CI gate failed: passRate ${report.passRate} < ${minPassRate}`);
  process.exit(1);
}
if (ciMode && minAvgPrecision > 0 && avgPrecision < minAvgPrecision) {
  console.error(`CI gate failed: avg_precision_at_5 ${avgPrecision} < ${minAvgPrecision}`);
  process.exit(1);
}
