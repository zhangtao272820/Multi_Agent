/**
 * 多文档 source coverage + 近义多源保槽 离线 smoke（纯函数，不启服务、不调 LLM）。
 * 故意不 import rag_evidence_answer（会牵出 chat OpenAI）。
 */
import assert from "node:assert/strict";
import { getRagAgentEnv } from "../server/utils/rag_agent_env";
import { ensureMultiSourceEvidenceSlots } from "../server/utils/multi_source_evidence";
import {
  areNearDuplicatePolicyDocNames,
  mergeSourceCoverage,
} from "../server/utils/retrieval_shared";

function shouldAttemptAgenticRetry(params: {
  enabled: boolean;
  attempt: number;
  maxRounds: number;
  clarifyReason?: string;
  turboRetrieval?: boolean;
}): boolean {
  if (!params.enabled) return false;
  if (params.attempt >= params.maxRounds) return false;
  if (params.turboRetrieval && params.clarifyReason !== "zero_hits") return false;
  return (
    params.clarifyReason === "zero_hits" ||
    params.clarifyReason === "weak_evidence" ||
    params.clarifyReason === "ambiguous_low_confidence" ||
    params.clarifyReason === "evidence_filtered_off_topic" ||
    params.clarifyReason === "false_negative_miss"
  );
}

function main() {
  const env = getRagAgentEnv({ docCount: 2 });
  assert.equal(env.enableSourceCoverage, true);
  assert.ok(env.sourceCoveragePerSourceMin >= 1);

  assert.ok(
    areNearDuplicatePolicyDocNames("养老机构服务规范.docx", "养老机构服务规范-验收用-v3.2.md"),
    "验收 md 与规范 docx 须判为近义政策对",
  );
  assert.ok(
    !areNearDuplicatePolicyDocNames("个人月收入.txt", "养老机构服务规范.docx"),
    "财务 txt 与规范不得近义",
  );

  const pool = [
    { pageContent: "失能老人每月补贴 800 元", metadata: { source: "养老机构服务规范.docx" } },
    { pageContent: "专业人员要求：…", metadata: { source: "养老机构服务规范.docx" } },
    { pageContent: "半失能老人护理标准", metadata: { source: "养老机构服务规范.docx" } },
    { pageContent: "护理员岗位补贴：每人每月 800 元", metadata: { source: "养老机构服务规范-验收用-v3.2.md" } },
    { pageContent: "声明：虚构语料", metadata: { source: "养老机构服务规范-验收用-v3.2.md" } },
  ];
  const covered = mergeSourceCoverage(
    pool,
    (d) => String(d.metadata?.source || "unknown"),
    { perSourceMin: 1, maxResults: 4 },
  );
  const sources = new Set(covered.map((d) => d.metadata.source));
  assert.equal(sources.size, 2, `expected 2 sources in top-k, got ${[...sources]}`);
  assert.ok(
    covered.some((d) => String(d.pageContent).includes("护理员岗位补贴")),
    "acceptance md caregiver subsidy chunk should survive coverage",
  );

  const maxResultsSingle = 5;
  const maxResultsMulti = Math.min(maxResultsSingle + 1, 8);
  assert.equal(maxResultsMulti, 6);

  const mdOnly = [
    {
      source: "养老机构服务规范-验收用-v3.2.md",
      content: "护理员岗位补贴：每人每月 800 元。夜班津贴 60 元/次，月上限 1200 元。",
    },
    {
      source: "养老机构服务规范-验收用-v3.2.md",
      content: "附录对照：v2.0 岗位补贴 500 元已废止。",
    },
  ];
  const multiPool = [
    ...mdOnly,
    {
      source: "养老机构服务规范.docx",
      content: "第十条 失能老人护理：每日翻身不少于 6 次；护理型床位配比不低于 1:4。",
    },
  ];
  const slotted = ensureMultiSourceEvidenceSlots(
    mdOnly,
    multiPool,
    "护理员岗位补贴是多少？失能护理翻身要求是什么？",
    ["护理员岗位补贴是多少", "失能护理翻身要求是什么"],
    4,
  );
  assert.ok(
    slotted.some((e) => String(e.source).includes(".docx")),
    `ensureMultiSource must add docx when pool has readable text, got ${slotted.map((e) => e.source).join(",")}`,
  );
  assert.ok(
    slotted.some((e) => String(e.source).includes("验收用")),
    "须保留验收 md",
  );

  assert.equal(
    shouldAttemptAgenticRetry({
      enabled: true,
      attempt: 0,
      maxRounds: 1,
      clarifyReason: "false_negative_miss",
    }),
    true,
  );

  console.log("smoke-rag-source-coverage: OK");
}

main();
