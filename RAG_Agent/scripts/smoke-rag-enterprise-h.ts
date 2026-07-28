/**
 * H 波离线 smoke：幂等 hash、parent expand、MMR、citation guard（不启服务、不调 embedding）。
 */
import { createHash } from "node:crypto";
import { hashCorpusText, resolveSourceVersion, buildIngestTimestamps } from "../server/utils/ingest_meta";
import { expandDocsToParent, createParentId } from "../server/utils/parent_expand";
import { mmrSelect } from "../server/utils/mmr_select";
import {
  checkAnswerGroundedInEvidence,
  buildEvidenceOnlyFallback,
  extractClaimTokens,
} from "../server/utils/citation_guard";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

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

// —— H5 citation ——
{
  const evidence = [{ content: "补贴标准为每人每月 200 元。", source: "规范.docx" }];
  assert(extractClaimTokens("补贴 200 元").includes("200"), "extract number");
  const ok = checkAnswerGroundedInEvidence("补贴标准为每人每月 200 元。", evidence);
  assert(ok.ok, "grounded answer ok");
  const bad = checkAnswerGroundedInEvidence("补贴标准为每人每月 999 元。", evidence);
  assert(!bad.ok && bad.missing.includes("999"), "ungrounded number fails");
  const fb = buildEvidenceOnlyFallback("补贴多少", evidence, ["999"]);
  assert(fb.includes("摘录") && fb.includes("规范.docx"), "fallback lists evidence");
}

// —— hash determinism helper used by upsert path ——
{
  const h = createHash("sha256").update("x", "utf8").digest("hex");
  assert(h.length === 64, "crypto ok");
}

console.log("smoke-rag-enterprise-h: ok");
