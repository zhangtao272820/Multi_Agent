/**
 * 倒排 BM25 契约：upsert / 删源 / 专有名词命中；查询触及 postings 而非全库 N。
 * 不调 LLM、不连向量库。
 */
import assert from "node:assert/strict";
import { createBm25InvertedIndex } from "../server/utils/bm25_inverted_index";

function main() {
  const idx = createBm25InvertedIndex();
  const noise = Array.from({ length: 80 }, (_, i) => ({
    pageContent: `无关条款第${i}条：日常办公用品采购与报销流程说明。`,
    metadata: { source: `noise_${i}.md` },
  }));
  for (const d of noise) idx.upsertDoc(d);

  idx.upsertDoc({
    pageContent: "本公司独有编号 XYZ-998877 年假天数为十五天，须提前申请。",
    metadata: { source: "hr_policy.md" },
  });
  idx.upsertDoc({
    pageContent: "报销须提交发票原件，与年假无关。",
    metadata: { source: "finance.md" },
  });

  assert.equal(idx.size, 82);

  const hits = idx.search(["xyz-998877", "年假"], 5);
  assert.ok(hits.length >= 1, "expected proprietary id hit");
  assert.ok(
    String(hits[0]?.metadata?.source).includes("hr_policy"),
    `top hit should be hr_policy, got ${hits[0]?.metadata?.source}`
  );

  const stats = idx.getStats();
  assert.ok(
    stats.lastSearchPostingTouches < stats.docCount,
    `posting touches ${stats.lastSearchPostingTouches} should be < N=${stats.docCount}`
  );
  assert.ok(stats.lastSearchPostingTouches > 0, "should touch some postings");

  const removed = idx.removeBySource("hr_policy.md");
  assert.equal(removed, 1);
  const after = idx.search(["xyz-998877"], 5);
  assert.equal(after.length, 0, "removed source must not hit");

  const roundtrip = createBm25InvertedIndex();
  const n = roundtrip.loadFromJSON(idx.toJSON());
  assert.equal(n, idx.size);
  const financeHits = roundtrip.search(["报销", "发票"], 5);
  assert.ok(
    financeHits.some((h) => String(h.metadata?.source) === "finance.md"),
    "roundtrip should still find finance.md"
  );

  console.log(
    `smoke-rag-bm25-index OK: docs=${idx.size} postingTouches=${stats.lastSearchPostingTouches}`
  );
}

main();
