/**
 * X 波验收闭环契约（零 LLM）：读 testdata 真文件。
 * - §2.2 岗位补贴+夜班同块
 * - 附录 A 新旧对照同块
 * - 复合槽 + 版本对照槽合并后 focused 同时含夜班与 500/800
 * - 制度图：graphrag-smoke 启发式抽图后 traverse 对入职问 hits>0
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document } from "@langchain/core/documents";
import { splitDocumentsStructured, splitProseByStructure } from "../server/utils/chunk_text";
import { splitCompoundQueries } from "../../shared/managerSubAgentProtocol.ts";
import {
  evidenceCoversSubQueries,
  mergeVersionConflictEvidence,
  prioritizeEvidenceBySubQueries,
  collectVersionBackfillTerms,
  filterStaleVersionBackfillHits,
} from "../server/utils/retrieval_shared";
import { ensureMultiSourceEvidenceSlots } from "../server/utils/multi_source_evidence";
import { rewriteContradictoryAbsentClaims } from "../server/utils/rag_evidence_answer";
import { heuristicExtractPolicyGraph } from "../server/utils/policy_graph_extract";
import {
  resetPolicyGraphForTest,
  traversePolicyGraph,
  upsertPolicyGraphFragment,
} from "../server/utils/policy_graph_store";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCEPT_MD = path.join(
  __dirname,
  "..",
  "data",
  "testdata",
  "养老机构服务规范-验收用-v3.2.md",
);
const GRAPH_MD = path.join(
  __dirname,
  "..",
  "data",
  "fixtures",
  "graphrag-smoke-入职与请假制度.md",
);

function findCoveringBlob(blobs: string[], needles: string[]): string | undefined {
  return blobs.find((b) => needles.every((n) => b.includes(n)));
}

async function assertColocate(text: string, label: string, needles: string[]) {
  const parts = splitProseByStructure(text);
  const structured = await splitDocumentsStructured([
    new Document({ pageContent: text, metadata: { source: label } }),
  ]);
  const parentBlobs = structured.map((d) => String(d.metadata?.parent_text ?? d.pageContent ?? ""));
  const hit =
    findCoveringBlob(parts, needles) ||
    findCoveringBlob(parentBlobs, needles) ||
    structured.find((d) => {
      const parent = String(d.metadata?.parent_text ?? "");
      const body = String(d.pageContent ?? "");
      return needles.every((n) => parent.includes(n) || body.includes(n));
    });
  assert.ok(hit, `[${label}] 未同块：${needles.join(" + ")}`);
}

async function main() {
  assert.ok(fs.existsSync(ACCEPT_MD), `missing ${ACCEPT_MD}`);
  const text = fs.readFileSync(ACCEPT_MD, "utf8");

  await assertColocate(text, "§2.2", ["护理员岗位补贴", "800", "夜班津贴", "60", "1200"]);
  await assertColocate(text, "附录A", ["护理员岗位补贴", "500", "800", "已废止"]);

  const q =
    "护理员岗位补贴是每人每月多少？夜班津贴怎么算、有没有月上限？";
  const parts = splitCompoundQueries(q);
  assert.ok(parts.length >= 2, `subqueries: ${JSON.stringify(parts)}`);
  assert.ok(parts.some((p) => p.includes("夜班")), "夜班子问");
  assert.ok(parts.some((p) => /补贴/.test(p)), "补贴子问");

  const i22 = text.indexOf("### 2.2");
  const i23 = text.indexOf("### 2.3");
  const i3 = text.indexOf("## 3.");
  const section22 = text.slice(i22, i23 > 0 ? i23 : i3);
  const appendix = text.slice(text.indexOf("## 附录 A"));
  assert.ok(section22.includes("800") && section22.includes("夜班"), "slice §2.2");
  assert.ok(appendix.includes("500") && appendix.includes("已废止"), "slice 附录");

  const mdCurrent = {
    source: "养老机构服务规范-验收用-v3.2.md",
    content: section22.slice(0, 900),
  };
  const mdStale = {
    source: "养老机构服务规范-验收用-v3.2.md",
    content: appendix.slice(0, 900),
  };
  const docxNoise = {
    source: "养老机构服务规范.docx",
    content: "第二十一条 高龄津贴：八十周岁以上老年人每月 100 元。配比不得低于 1:3。",
  };
  const pool = [docxNoise, mdCurrent, docxNoise, mdStale];

  assert.equal(
    evidenceCoversSubQueries([{ source: "x", content: "护理员岗位补贴每人每月 800 元" }], parts),
    false,
    "仅补贴不得假装覆盖夜班",
  );
  assert.equal(evidenceCoversSubQueries([mdCurrent], parts), true, "§2.2 覆盖补贴+夜班");

  const slotted = prioritizeEvidenceBySubQueries(parts, pool, 4);
  const focused = mergeVersionConflictEvidence(slotted, pool, 4);
  assert.ok(
    focused.some((e) => String(e.content).includes("夜班") && String(e.content).includes("1200")),
    "focused 须含夜班 1200",
  );
  assert.ok(
    focused.some((e) => String(e.content).includes("500") && /废止|附录|v2/.test(e.content)),
    `focused 须含新旧对照 500，got=${focused.map((e) => e.content.slice(0, 40)).join(" | ")}`,
  );

  // Y：pool 仅有现行 §2.2（无附录）时，模拟 keyword 回填后再 merge 必须含 500
  const poolNoAppendix = [docxNoise, mdCurrent, docxNoise];
  const slottedOnly = prioritizeEvidenceBySubQueries(parts, poolNoAppendix, 4);
  const alone = mergeVersionConflictEvidence(slottedOnly, poolNoAppendix, 4);
  assert.ok(
    !alone.some((e) => String(e.content).includes("500") && /废止|附录/.test(e.content)),
    "无回填时不应凭空出现附录",
  );
  const { sources, terms } = collectVersionBackfillTerms(slottedOnly);
  assert.ok(sources.some((s) => s.includes("验收用-v3.2")), `backfill sources: ${sources.join(",")}`);
  assert.ok(terms.some((t) => t.includes("废止") || t.includes("附录") || t.includes("v2")), `terms=${terms}`);
  const backfilled = filterStaleVersionBackfillHits(slottedOnly, [mdStale, docxNoise]);
  assert.ok(backfilled.length >= 1, "filter 须保留附录废止块");
  const focusedAfterBackfill = mergeVersionConflictEvidence(slottedOnly, [...poolNoAppendix, ...backfilled], 4);
  assert.ok(
    focusedAfterBackfill.some((e) => String(e.content).includes("500") && /废止|附录|v2/.test(e.content)),
    `回填后须含 500 对照，got=${focusedAfterBackfill.map((e) => e.content.slice(0, 40)).join(" | ")}`,
  );

  // 近义 md+docx：focused 仅 md 时，ensureMultiSource 须补进 docx 相关块
  const docxSubsidy = {
    source: "养老机构服务规范.docx",
    content: "护理型床位护理员与入住老年人配比不低于 1:4；岗位相关补贴见机构细则。",
  };
  const mdOnlyFocused = [mdCurrent, mdCurrent];
  const poolBoth = [mdCurrent, docxSubsidy, docxNoise];
  const multi = ensureMultiSourceEvidenceSlots(
    mdOnlyFocused,
    poolBoth,
    "护理员岗位补贴是每人每月多少？配比标准是多少？",
    parts,
    4,
  );
  assert.ok(
    multi.some((e) => String(e.source).includes(".docx")),
    `多源保槽须含 docx，got=${multi.map((e) => e.source).join(",")}`,
  );
  assert.ok(
    multi.some((e) => String(e.source).includes("验收用-v3.2")),
    `多源保槽须保留验收 md，got=${multi.map((e) => e.source).join(",")}`,
  );

  const fakeAbsent =
    "护理员岗位补贴现行 800 元/月。夜班津贴文档中未提及具体标准，也没有月上限规定。";
  const rewritten = rewriteContradictoryAbsentClaims(fakeAbsent, [mdCurrent], parts);
  assert.ok(
    !rewritten.includes("未提及") || !rewritten.includes("夜班"),
    `假未提及应被改写: ${rewritten}`,
  );

  assert.ok(fs.existsSync(GRAPH_MD), `missing ${GRAPH_MD}`);
  const graphText = fs.readFileSync(GRAPH_MD, "utf8");
  const extracted = heuristicExtractPolicyGraph(graphText, "graphrag-smoke-入职与请假制度.md");
  assert.ok(extracted.nodes.length >= 3, `nodes=${extracted.nodes.length}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-pg-"));
  const prev = process.env.RAG_POLICY_GRAPH_PATH;
  process.env.RAG_POLICY_GRAPH_PATH = path.join(tmp, "rag-policy-graph.json");
  try {
    resetPolicyGraphForTest();
    upsertPolicyGraphFragment({
      source: "graphrag-smoke-入职与请假制度.md",
      content_hash: "smoke-acceptance",
      nodes: extracted.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        text: n.text || n.name,
      })),
      edges: extracted.edges.map((e) => ({
        from_id: e.from_id,
        to_id: e.to_id,
        rel: e.rel,
      })),
    });
    const hits = traversePolicyGraph({
      query: "入职时劳动合同由谁签署？门禁卡什么时候才能发、有什么前置条件？",
      topics: ["劳动合同", "门禁卡", "入职"],
      maxHops: 2,
      limit: 12,
    });
    assert.ok(hits.length > 0, `图门控应对入职问有命中，hits=${hits.length}`);
    assert.ok(
      hits.some((h) => /劳动合同|门禁/.test(h.pageContent)),
      `图命中应含劳动合同/门禁: ${hits.map((h) => h.pageContent.slice(0, 40)).join(" | ")}`,
    );
  } finally {
    if (prev === undefined) delete process.env.RAG_POLICY_GRAPH_PATH;
    else process.env.RAG_POLICY_GRAPH_PATH = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(
    `smoke-rag-acceptance-v32 OK: parts=${parts.length} focused=${focused.length} graphHits ok`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
