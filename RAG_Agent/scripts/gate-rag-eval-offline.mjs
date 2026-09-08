/**
 * N4 离线门禁：校验 rag-eval 题集 schema / 题量（不依赖 RAG 进程）。
 * 故意删减题量或破坏 schema → exit 1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const minQuestions = Number(process.env.RAG_EVAL_MIN_QUESTIONS ?? "45");
const file = path.join(root, "data/rag-eval-questions.json");

function assert(cond, msg) {
  if (!cond) {
    console.error(msg);
    process.exit(1);
  }
}

const raw = fs.readFileSync(file, "utf8");
let cases;
try {
  cases = JSON.parse(raw);
} catch (e) {
  assert(false, `invalid JSON: ${e?.message || e}`);
}
assert(Array.isArray(cases), "rag-eval-questions.json must be array");
assert(cases.length >= minQuestions, `need >=${minQuestions} questions, got ${cases.length}`);

const ids = new Set();
let policyCount = 0;
let staleHintCount = 0;
let clarifyOrCiteCount = 0;
let faithfulnessCount = 0;
let refuseCount = 0;
let evidenceKwCount = 0;
for (const c of cases) {
  assert(c && typeof c === "object", "case must be object");
  assert(String(c.id || "").trim(), "case.id required");
  assert(!ids.has(c.id), `duplicate id: ${c.id}`);
  ids.add(c.id);
  assert(String(c.question || "").trim(), `case.question required for ${c.id}`);
  assert(Array.isArray(c.tags) && c.tags.length >= 1, `case.tags required for ${c.id}`);
  if (c.expect_refuse === true) {
    refuseCount += 1;
  } else if (c.expect_intent) {
    assert(typeof c.expect_intent === "string", `${c.id}: expect_intent must be string`);
  } else {
    assert(Array.isArray(c.expect_sources) && c.expect_sources.length >= 1, `${c.id}: expect_sources required`);
  }
  if (c.expect_stale_hint != null) {
    assert(c.expect_stale_hint === true, `${c.id}: expect_stale_hint must be true when set`);
  }
  if (c.expect_clarify_or_cite != null) {
    assert(c.expect_clarify_or_cite === true, `${c.id}: expect_clarify_or_cite must be true when set`);
  }
  if (c.expect_evidence_keywords != null) {
    assert(
      Array.isArray(c.expect_evidence_keywords) && c.expect_evidence_keywords.length >= 1,
      `${c.id}: expect_evidence_keywords must be non-empty array`
    );
    evidenceKwCount += 1;
  }
  if (c.tags.includes("policy")) policyCount += 1;
  if (c.tags.includes("faithfulness")) faithfulnessCount += 1;
  if (c.expect_stale_hint === true) staleHintCount += 1;
  if (c.expect_clarify_or_cite === true) clarifyOrCiteCount += 1;
}
assert(policyCount >= 10, `need >=10 policy-tagged questions, got ${policyCount}`);
assert(faithfulnessCount >= 3, `H5/I1: need >=3 faithfulness-tagged questions, got ${faithfulnessCount}`);
assert(staleHintCount >= 1, `G5: need >=1 expect_stale_hint case, got ${staleHintCount}`);
assert(clarifyOrCiteCount >= 1, `G5: need >=1 expect_clarify_or_cite case, got ${clarifyOrCiteCount}`);
assert(refuseCount >= 3, `need >=3 expect_refuse cases, got ${refuseCount}`);
assert(evidenceKwCount >= 3, `need >=3 expect_evidence_keywords cases, got ${evidenceKwCount}`);

console.log(
  `gate-rag-eval-offline OK: ${cases.length} questions (${policyCount} policy, ${faithfulnessCount} faithfulness, ${staleHintCount} stale_hint, ${clarifyOrCiteCount} clarify_or_cite, ${refuseCount} refuse, ${evidenceKwCount} evidence_kw)`
);
