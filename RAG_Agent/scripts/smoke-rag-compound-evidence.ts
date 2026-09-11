/**
 * 复合问证据槽位契约：拆句 / 区分性覆盖 / 子问优选（零 LLM）。
 * 文案对齐验收语料 §2.2（补贴+夜班），并校验版本对照槽。
 */
import assert from "node:assert/strict";
import { splitCompoundQueries } from "../../shared/managerSubAgentProtocol.ts";
import {
  evidenceCoversSubQueries,
  distinctiveSubQueryTerms,
  prioritizeEvidenceBySubQueries,
  mergeVersionConflictEvidence,
} from "../server/utils/retrieval_shared.ts";

const q =
  "护理员岗位补贴是每人每月多少？夜班津贴怎么算、有没有月上限？";

const parts = splitCompoundQueries(q);
assert.ok(parts.length >= 2, `expected >=2 subqueries, got ${JSON.stringify(parts)}`);
assert.ok(
  parts.some((p) => p.includes("夜班")),
  `夜班 must be its own subquery: ${JSON.stringify(parts)}`,
);
assert.ok(
  parts.some((p) => p.includes("岗位补贴") || p.includes("补贴")),
  `补贴 must be a subquery: ${JSON.stringify(parts)}`,
);

const mdChunk = {
  source: "养老机构服务规范-验收用-v3.2.md",
  content:
    "### 2.2 护理员岗位补贴（现行 v3.2）\n- **护理员岗位补贴**：每人每月 **800 元**（税前，随工资发放）。\n- **夜班津贴**（与岗位补贴分列，不得互相冲抵）：每有效夜班 **60 元**；同一自然月累计夜班津贴上限 **1200 元**。",
};
const mdAppendix = {
  source: "养老机构服务规范-验收用-v3.2.md",
  content:
    "## 附录 A：已废止条款摘要（v2.0 / 2020，仅供对照，不得作为现行依据）\n> 警告：以下为历史版本摘要，**已于 2024-06-01 废止**。\n| 护理员岗位补贴 | 每人每月 **500 元** | 每人每月 **800 元** |",
};
const docxNoise = {
  source: "养老机构服务规范.docx",
  content: "第二十一条 高龄津贴：八十周岁以上老年人每月 100 元。第三十条 护理人员配比不得低于 1:3。",
};
const pool = [docxNoise, mdChunk, docxNoise, mdAppendix];

const coveredAll = evidenceCoversSubQueries([mdChunk], parts);
assert.equal(coveredAll, true, "md chunk covers both subsidy and night-shift subqueries");

const coveredOnlySubsidy = evidenceCoversSubQueries(
  [{ source: "x", content: "护理员岗位补贴每人每月 800 元，税前随工资发放。" }],
  parts,
);
assert.equal(
  coveredOnlySubsidy,
  false,
  "subsidy-only evidence must NOT pretend night-shift is covered",
);

const termsNight = distinctiveSubQueryTerms(
  parts.find((p) => p.includes("夜班")) || "夜班津贴怎么算",
  parts,
);
assert.ok(
  termsNight.some((t) => t.includes("夜班") || t.includes("津贴")),
  `night distinctive terms: ${JSON.stringify(termsNight)}`,
);

const slotted = prioritizeEvidenceBySubQueries(parts, pool, 4);
const focused = mergeVersionConflictEvidence(slotted, pool, 4);
assert.ok(
  focused.some((e) => String(e.source).includes("验收用-v3.2")),
  `focused must keep v3.2 md, got ${focused.map((e) => e.source).join(",")}`,
);
assert.ok(
  focused.some((e) => String(e.content).includes("夜班") && String(e.content).includes("1200")),
  "focused evidence must retain night-shift clause",
);
assert.ok(
  focused.some((e) => String(e.content).includes("500") && /废止|附录|v2/.test(e.content)),
  "focused must retain appendix version compare (500)",
);

console.log(
  `smoke-rag-compound-evidence OK: parts=${parts.length} focused=${focused.length}`,
);
