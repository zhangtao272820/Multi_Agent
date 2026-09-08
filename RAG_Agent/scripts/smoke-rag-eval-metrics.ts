/**
 * 评测指标契约：零网络、零 LLM。
 */
import assert from "node:assert/strict";
import {
  precisionAtK,
  contextOverlapRelevance,
  isRefusalPass,
  evidenceKeywordsPass,
} from "../server/utils/rag_eval_metrics";

function main() {
  assert.equal(precisionAtK(["养老机构服务规范.pdf", "其他.md"], ["养老机构服务规范"], 5), 0.5);
  assert.equal(precisionAtK(["养老机构服务规范"], ["养老机构服务规范"], 5), 1);
  assert.equal(precisionAtK([], ["养老机构服务规范"], 5), 0);

  const rel = contextOverlapRelevance("护理员补贴标准", [
    "养老机构护理员补贴标准为每人每月若干元。",
  ]);
  assert.ok(rel > 0.05, `expected overlap > 0.05, got ${rel}`);

  assert.equal(
    isRefusalPass(
      { expect_refuse: true },
      { ok: true, evidence: [], needsClarify: true }
    ),
    true
  );
  assert.equal(
    isRefusalPass(
      { expect_refuse: true },
      {
        ok: true,
        evidence: [{ content: "无关", source: "x" }],
        answer: "木星有79颗卫星",
      }
    ),
    false
  );
  assert.equal(
    isRefusalPass(
      { expect_refuse: true },
      { ok: true, evidence: [], answer: "知识库中没有相关内容" }
    ),
    true
  );

  assert.equal(
    evidenceKeywordsPass(["人员配比不得低于1:10"], ["人员配比", "1:10"]),
    true
  );
  assert.equal(evidenceKeywordsPass(["无关文本"], ["人员配比"]), false);

  console.log("smoke-rag-eval-metrics OK");
}

main();
