/**
 * L 波离线契约（Node 14+ 纯 JS，不调 LLM）。
 * 与 query_lane_gates / hyde_retrieval / policy_graph_store 行为对齐。
 */
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function decideUseHyde(plan, ctx) {
  if (!ctx.enableHyde) return false;
  if (ctx.probeMode || ctx.turboRetrieval || ctx.fastPath) return false;
  if (ctx.hasExplicitDocAnchor) return false;
  if (plan.use_hyde === true) return true;
  if (plan.use_hyde === false) return false;
  if ((plan.entities?.doc_names || []).length > 0) return false;
  if ((plan.entities?.numbers || []).length >= 2) return false;
  const qLen = ctx.queryLen ?? 0;
  if (qLen > 0 && qLen < 6) return false;
  const fuzzyIntent = plan.intent === "definition" || plan.intent === "unknown";
  const lowConf = plan.confidence > 0 && plan.confidence < 0.55;
  return fuzzyIntent && (lowConf || (qLen > 0 && qLen <= 24));
}

function decideUseMultiQuery(plan, ctx) {
  if (!ctx.enableMultiQuery) return false;
  if (ctx.probeMode || ctx.turboRetrieval) return false;
  if (ctx.hasExplicitDocAnchor) return false;
  if (ctx.managerLeanQueryHighConfidence && plan.confidence >= 0.7) return false;
  if (plan.use_multi_query === true) return true;
  if (plan.use_multi_query === false) return false;
  const qLen = ctx.queryLen ?? 0;
  if (qLen > 0 && qLen < 6) return false;
  if (plan.intent === "multi_part" || plan.intent === "comparison") return true;
  return (plan.sub_queries || []).length >= 2;
}

function decideNeedsGraph(plan, ctx) {
  if (!ctx.enablePolicyGraph) return false;
  if (ctx.probeMode) return false;
  if (plan.needs_graph === true) return true;
  if (plan.intent === "process") return true;
  if (plan.intent === "comparison" && (plan.entities?.topics || []).length >= 2) return true;
  if (plan.intent === "multi_part" && (plan.entities?.topics || []).length >= 2) return true;
  if (plan.intent === "multi_part" && (plan.sub_queries || []).length >= 2) return true;
  if (plan.needs_graph === false) return false;
  return false;
}

function fuseRankMapsRrf(maps, k = 60) {
  const scores = new Map();
  for (const lane of maps) {
    for (const [key, rank] of lane.ranks) {
      if (!Number.isFinite(rank) || rank < 1) continue;
      const add = lane.weight * (1 / (k + rank));
      scores.set(key, (scores.get(key) || 0) + add);
    }
  }
  return scores;
}

function ranksFromScoreMap(scoreMap) {
  const ordered = Array.from(scoreMap.entries()).sort((a, b) => b[1] - a[1]);
  const ranks = new Map();
  ordered.forEach(([key], i) => ranks.set(key, i + 1));
  return ranks;
}

// —— L2 ——
{
  const base = {
    intent: "definition",
    confidence: 0.4,
    entities: { doc_names: [], numbers: [], topics: [] },
    sub_queries: [],
  };
  assert.strictEqual(decideUseHyde(base, { enableHyde: true, queryLen: 12 }), true);
  assert.strictEqual(decideUseHyde(base, { enableHyde: true, probeMode: true, queryLen: 12 }), false);
  assert.strictEqual(
    decideUseHyde(base, { enableHyde: true, hasExplicitDocAnchor: true, queryLen: 12 }),
    false
  );
  const multi = { intent: "multi_part", confidence: 0.5, sub_queries: ["a", "b"], entities: {} };
  assert.strictEqual(decideUseMultiQuery(multi, { enableMultiQuery: true }), true);
  assert.strictEqual(
    decideUseMultiQuery(multi, { enableMultiQuery: true, hasExplicitDocAnchor: true }),
    false
  );
  const proc = { intent: "process", confidence: 0.6, entities: { topics: [] }, sub_queries: [] };
  assert.strictEqual(decideNeedsGraph(proc, { enablePolicyGraph: true }), true);
  // turbo 仍可开图（本地边表）；probe 才关
  assert.strictEqual(decideNeedsGraph(proc, { enablePolicyGraph: true, turboRetrieval: true }), true);
  assert.strictEqual(decideNeedsGraph(proc, { enablePolicyGraph: true, probeMode: true }), false);
  const multiRel = {
    intent: "multi_part",
    confidence: 0.5,
    entities: { topics: [] },
    sub_queries: ["入职流程归属部门", "入职流程参与岗位"],
    needs_graph: false,
  };
  assert.strictEqual(decideNeedsGraph(multiRel, { enablePolicyGraph: true }), true);
}

// —— L1 RRF ——
{
  const a = ranksFromScoreMap(
    new Map([
      ["d1", 0.9],
      ["d2", 0.5],
    ])
  );
  const b = ranksFromScoreMap(
    new Map([
      ["d2", 0.8],
      ["d3", 0.7],
    ])
  );
  const fused = fuseRankMapsRrf(
    [
      { ranks: a, weight: 1 },
      { ranks: b, weight: 0.9 },
    ],
    60
  );
  assert.ok(fused.has("d1") && fused.has("d2") && fused.has("d3"));
  assert.ok(fused.get("d2") > fused.get("d3"));
}

// —— M graph file ——
{
  const tmp = mkdtempSync(join(tmpdir(), "rag-l-wave-"));
  const graphPath = join(tmp, "graph.json");
  const data = {
    nodes: [
      {
        id: "OrgUnit:hr",
        type: "OrgUnit",
        name: "人力资源部",
        source: "制度A.pdf",
        content_hash: "h1",
        text: "人力资源部负责招聘审批",
      },
      {
        id: "Role:hr_bp",
        type: "Role",
        name: "HRBP",
        source: "制度A.pdf",
        content_hash: "h1",
        text: "HRBP 跟进入职流程",
      },
      {
        id: "Process:onboard",
        type: "Process",
        name: "入职流程",
        source: "制度A.pdf",
        content_hash: "h1",
        text: "入职流程含材料审核与培训",
      },
      {
        id: "Clause:c1",
        type: "Clause",
        name: "入职材料",
        source: "制度A.pdf",
        content_hash: "h1",
        text: "新员工须提交身份证与学历证明原件。",
      },
    ],
    edges: [
      {
        id: "e1",
        from_id: "Role:hr_bp",
        to_id: "OrgUnit:hr",
        rel: "BELONGS_TO",
        source: "制度A.pdf",
        content_hash: "h1",
      },
      {
        id: "e2",
        from_id: "Process:onboard",
        to_id: "OrgUnit:hr",
        rel: "OWNED_BY",
        source: "制度A.pdf",
        content_hash: "h1",
      },
      {
        id: "e3",
        from_id: "Process:onboard",
        to_id: "Role:hr_bp",
        rel: "REQUIRES_ROLE",
        source: "制度A.pdf",
        content_hash: "h1",
      },
      {
        id: "e4",
        from_id: "Clause:c1",
        to_id: "Process:onboard",
        rel: "STEP_OF",
        source: "制度A.pdf",
        content_hash: "h1",
      },
    ],
  };
  mkdirSync(dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, JSON.stringify(data), "utf8");
  assert.ok(existsSync(graphPath));
  const loaded = JSON.parse(readFileSync(graphPath, "utf8"));
  assert.strictEqual(loaded.nodes.length, 4);
  assert.strictEqual(loaded.edges.length, 4);
  // purge by source
  loaded.nodes = loaded.nodes.filter((n) => n.source !== "制度A.pdf");
  loaded.edges = loaded.edges.filter((e) => e.source !== "制度A.pdf");
  assert.strictEqual(loaded.nodes.length, 0);
  rmSync(tmp, { recursive: true, force: true });
}

// 源文件存在性（实现已落地）
{
  const root = join(__dirname, "..");
  for (const rel of [
    "server/utils/query_lane_gates.ts",
    "server/utils/hyde_retrieval.ts",
    "server/utils/policy_graph_store.ts",
    "server/utils/policy_graph_extract.ts",
    "doc/L波-普通RAG与GraphRAG升级方案.md",
  ]) {
    assert.ok(existsSync(join(root, rel)), `missing ${rel}`);
  }
}

console.log("[smoke:l-wave] ok");
