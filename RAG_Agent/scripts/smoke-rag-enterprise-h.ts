/**
 * H/I 波离线 smoke：幂等 hash/purge、parent expand、MMR、citation/faithfulness、
 * retrievalFailureMode 契约（不启服务、不调 embedding）。
 */
import { createHash } from "node:crypto";
import {
  hashCorpusText,
  resolveSourceVersion,
  buildIngestTimestamps,
  shouldSkipReembed,
  filterMemoryVectorsBySource,
} from "../server/utils/ingest_meta";
import { expandDocsToParent, createParentId } from "../server/utils/parent_expand";
import { mmrSelect } from "../server/utils/mmr_select";
import {
  checkAnswerGroundedInEvidence,
  buildEvidenceOnlyFallback,
  extractClaimTokens,
} from "../server/utils/citation_guard";
import { buildRagAgentResult } from "../server/utils/agent_result";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const ALLOWED_FAILURE_MODES = new Set([
  "zero_hits",
  "weak_evidence",
  "ambiguous_low_confidence",
]);

// —— H1 ingest_meta ——
{
  const a = hashCorpusText("hello\n\nworld");
  const b = hashCorpusText("hello\n\n\nworld");
  assert(a === b, "normalize should stabilize hash");
  assert(a.length === 64, "sha256 hex length");
  assert(resolveSourceVersion({ contentHash: a }) === a.slice(0, 12), "default version from hash");
  assert(resolveSourceVersion({ explicit: "v2", contentHash: a }) === "v2", "explicit version wins");
  const ts = buildIngestTimestamps(new Date("2026-07-27T00:00:00.000Z"));
  assert(ts.ingest_at === "2026-07-27T00:00:00.000Z", "ingest_at iso");
  assert(ts.processedAt === ts.ingest_at, "processedAt aligned");
  assert(shouldSkipReembed(a, a), "same hash skips re-embed");
  assert(!shouldSkipReembed(a, hashCorpusText("other")), "different hash re-embeds");
  assert(!shouldSkipReembed(undefined, a), "missing existing hash does not skip");
}

// —— H1 purge by source（与 vectorStore memory 分支同核）——
{
  const vectors = [
    { id: "1", metadata: { source: "规范.docx" } },
    { id: "2", metadata: { source: "规范.docx" } },
    { id: "3", metadata: { source: "其它.txt" } },
  ];
  const { kept, removed } = filterMemoryVectorsBySource(vectors, "规范.docx");
  assert(removed === 2, `purge should remove 2, got ${removed}`);
  assert(kept.length === 1 && kept[0]!.id === "3", "other source retained");
  const again = filterMemoryVectorsBySource(kept, "规范.docx");
  assert(again.removed === 0 && again.kept.length === 1, "second purge is no-op");
}

// —— H2 parent expand ——
{
  const parentText = "第一条 护理人员配比不得低于 1:10。细则说明若干字。".repeat(3);
  const pid = createParentId({ source: "规范.docx", sectionIndex: 0, sectionHeading: "第一条", parentText });
  assert(pid.length === 16, "parent id length");
  const kids = [
    { pageContent: "配比不得低于 1:10", metadata: { parent_id: pid, parent_text: parentText, source: "规范.docx" } },
    { pageContent: "细则说明若干字", metadata: { parent_id: pid, parent_text: parentText, source: "规范.docx" } },
    { pageContent: "无关短句", metadata: { source: "其它.txt" } },
  ];
  const expanded = expandDocsToParent(kids, true);
  assert(expanded.length === 2, `dedupe parent+flat, got ${expanded.length}`);
  assert(expanded[0]!.pageContent === parentText, "first becomes parent text");
  assert(String(expanded[0]!.metadata?.chunk_level) === "parent_expanded", "chunk_level flag");
}

// —— H3 MMR ——
{
  const docs = [
    { id: "a", text: "养老机构护理人员配比要求不得低于一比十" },
    { id: "b", text: "养老机构护理人员配比要求不得低于一比十细则" },
    { id: "c", text: "膳食服务应保证营养均衡与食品安全" },
  ];
  const picked = mmrSelect(
    docs.map((d, i) => ({ item: d, relevance: 10 - i, text: d.text })),
    2,
    0.35
  );
  assert(picked.length === 2, "mmr top2");
  const ids = new Set(picked.map((p) => p.id));
  assert(ids.has("a"), "mmr keeps top relevance");
  assert(ids.has("c"), `mmr should diversify near-duplicates, got ${[...ids]}`);
  assert(!ids.has("b"), "near-duplicate b should lose to diverse c");
}

// —— H4 / I2 retrievalFailureMode → agent_result.structured ——
{
  for (const mode of ALLOWED_FAILURE_MODES) {
    const ar = buildRagAgentResult({
      query: "test",
      needsClarify: true,
      evidence: [],
      retrievalFailureMode: mode,
    });
    assert(ar.structured?.retrieval_failure_mode === mode, `structured mode ${mode}`);
    assert(ALLOWED_FAILURE_MODES.has(String(ar.structured?.retrieval_failure_mode)), "enum ok");
  }
  const ok = buildRagAgentResult({
    query: "test",
    evidence: [{ source: "规范.docx", content: "配比 1:10", ingest_at: "2026-07-01T00:00:00.000Z" }],
  });
  assert(!ok.structured?.retrieval_failure_mode, "success path has no failure mode");
  assert(String(ok.answer || "").includes("1:10"), "answer must be evidence body not query");
  assert(ok.answer !== "test", "answer must not equal query");
  assert(String(ok.structured?.query || "") === "test", "query stays in structured");
}

// —— H5 / I1 citation + faithfulness fixtures ——
{
  const evidence = [{ content: "补贴标准为每人每月 200 元。", source: "规范.docx" }];
  assert(extractClaimTokens("补贴 200 元").includes("200"), "extract number");
  const ok = checkAnswerGroundedInEvidence("补贴标准为每人每月 200 元。", evidence);
  assert(ok.ok, "grounded answer ok");
  const bad = checkAnswerGroundedInEvidence("补贴标准为每人每月 999 元。", evidence);
  assert(!bad.ok && bad.missing.includes("999"), "ungrounded number fails");
  const fb = buildEvidenceOnlyFallback("补贴多少", evidence, ["999"]);
  assert(fb.includes("摘录") && fb.includes("规范.docx"), "fallback lists evidence");

  const fixtures: Array<{
    q: string;
    contexts: typeof evidence;
    answer: string;
    expectOk: boolean;
  }> = [
    {
      q: "补贴多少",
      contexts: evidence,
      answer: "补贴标准为每人每月 200 元。",
      expectOk: true,
    },
    {
      q: "补贴多少",
      contexts: evidence,
      answer: "补贴标准为每人每月 500 元。",
      expectOk: false,
    },
    {
      q: "配比",
      contexts: [{ content: "护理人员配比不得低于 1:10。", source: "规范.docx" }],
      answer: "配比不得低于 1:10。",
      expectOk: true,
    },
    {
      q: "条款",
      contexts: [{ content: "第一条 入住评估应全面。", source: "规范.docx" }],
      answer: "根据第三条，入住评估应全面。",
      expectOk: false,
    },
  ];
  for (const fx of fixtures) {
    const r = checkAnswerGroundedInEvidence(fx.answer, fx.contexts);
    assert(r.ok === fx.expectOk, `faithfulness fixture «${fx.q}» expect ${fx.expectOk} got ${r.ok}`);
  }
}

// —— hash determinism helper used by upsert path ——
{
  const h = createHash("sha256").update("x", "utf8").digest("hex");
  assert(h.length === 64, "crypto ok");
}

console.log("smoke-rag-enterprise-h: ok");
