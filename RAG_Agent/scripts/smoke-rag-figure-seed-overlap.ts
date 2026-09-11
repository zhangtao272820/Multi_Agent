/**
 * 图门控种子 overlap：长中文须 bigram 命中（X 波），不调 LLM。
 */
import assert from "node:assert/strict";
import { scoreTextOverlapLite } from "../server/utils/policy_graph_store";

const q = "入职时劳动合同由谁签署？门禁卡什么时候才能发？";
const name = "步骤：劳动合同签署";
const text =
  "材料审核通过后，由人力资源部指定经办人与员工签署劳动合同；行政办公室不得代签。";
const score = scoreTextOverlapLite(q, name) * 2 + scoreTextOverlapLite(q, text);
assert.ok(score > 0, `bigram seed must hit 劳动合同/门禁, score=${score}`);

const miss = scoreTextOverlapLite("天气预报气温", "劳动合同签署流程");
assert.ok(miss === 0 || miss < score, "unrelated query should score lower");

console.log(`smoke-rag-figure-seed-overlap OK score=${score}`);
