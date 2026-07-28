/**
 * 轻量检索评测：对 data/rag-eval-questions.json 调用 /api/retrieve
 * 用法：先 npm run dev，再 npm run eval:rag
 * CI：npm run eval:rag:ci（未达 RAG_EVAL_MIN_PASS_RATE 时 exit 1）
 * 说明：非完整 RAGAS；为可重复离线/在线集。
 */
import fs from "node:fs";
import path from "node:path";

const base = process.env.RAG_EVAL_URL || "http://localhost:13102";
const minPassRate = Number(process.env.RAG_EVAL_MIN_PASS_RATE ?? "0.5");
const ciMode = process.argv.includes("--ci") || process.env.RAG_EVAL_CI === "1";

const cases = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "data/rag-eval-questions.json"), "utf8")
);

function isDocumentListHit(data) {
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

/** G5：与 Manager buildStaleEvidenceHint 口径对齐的过期提示 */
function hasStaleHintSignal(data) {
  const blob = JSON.stringify(data ?? {});
  return /过期|最新制度|stale|freshness/i.test(blob);
}

/** G5：证据是否携带新鲜度元数据（检索层可证明） */
function hasFreshnessMeta(data) {
  const ev = Array.isArray(data?.evidence) ? data.evidence : [];
  return ev.some((e) => Boolean(e?.ingest_at || e?.source_version || e?.ingestAt || e?.sourceVersion));
}

/** G5：澄清 / 引用版本 / 命中 sources */
function hasClarifyOrCiteSignal(c, data) {
  const blob = JSON.stringify(data ?? {});
  if (
    /澄清|不一致|以.*为准|source_version|版本|冲突/.test(blob) ||
    /clarify|conflict/i.test(blob)
  ) {
    return true;
  }
  const sources = (data.evidence || []).map((e) => String(e.source || "")).join(" ");
  return (c.expect_sources || []).some((s) => sources.includes(s) || blob.includes(s));
}

function casePass(c, data) {
  if (!data?.ok) return false;
  if (c.expect_intent === "document_list") {
    return isDocumentListHit(data);
  }
  if (c.expect_stale_hint === true) {
    const sources = (data.evidence || []).map((e) => String(e.source || "")).join(" ");
    const hit = (c.expect_sources || []).some(
      (s) => sources.includes(s) || JSON.stringify(data).includes(s)
    );
    const hasEvidence = Boolean(data.evidence?.length > 0 || hit);
    // 检索层：命中证据 +（新鲜度元数据或过期提示）；Manager synth 的「过期」文案由 smoke:evidence-freshness 覆盖
    return hasEvidence && (hasFreshnessMeta(data) || hasStaleHintSignal(data));
  }
  if (c.expect_clarify_or_cite === true) {
    return hasClarifyOrCiteSignal(c, data);
  }
  const sources = (data.evidence || []).map((e) => String(e.source || "")).join(" ");
  const hit = (c.expect_sources || []).some(
    (s) => sources.includes(s) || JSON.stringify(data).includes(s)
  );
  return Boolean(data.evidence?.length > 0 || hit);
}

const results = [];
let ok = 0;

for (const c of cases) {
  const t0 = Date.now();
  let data = {};
  try {
    const res = await fetch(`${base}/api/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: c.question, skipLlmRerank: true, skipEvidenceSelect: true }),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`ERR [${c.id}]`, e?.message || e);
  }
  const pass = casePass(c, data);
  if (pass) ok += 1;
  const row = {
    id: c.id,
    pass,
    hits: data.evidence?.length ?? 0,
    ms: data.ms ?? Date.now() - t0,
    agentic_rounds: data.agentic_rounds ?? 0,
    experience_hits: data.experience_hits ?? 0,
    rerank_mode: data.rerank_mode,
  };
  results.push(row);
  console.log(
    `${pass ? "PASS" : "FAIL"} [${c.id}] ${c.question.slice(0, 40)}… hits=${row.hits} exp=${row.experience_hits}`
  );
}

const report = {
  at: new Date().toISOString(),
  base,
  total: cases.length,
  passed: ok,
  passRate: cases.length ? ok / cases.length : 0,
  minPassRate,
  ciMode,
  results,
};

const outDir = path.join(process.cwd(), ".data");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "rag-eval-baseline.json");
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

console.log(`\n${ok}/${cases.length} passed (${Math.round(report.passRate * 100)}%)`);
console.log(`baseline -> ${outFile}`);

if (ciMode && report.passRate < minPassRate) {
  console.error(`CI gate failed: passRate ${report.passRate} < ${minPassRate}`);
  process.exit(1);
}
