/**
 * M1：企业制度知识图存储（文件 JSON；可选 Postgres）。
 * 节点：OrgUnit / Role / Process / Clause；边：BELONGS_TO / OWNED_BY / STEP_OF / REFERS_TO / REQUIRES_ROLE
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PolicyNodeType = "OrgUnit" | "Role" | "Process" | "Clause";
export type PolicyRelType =
  | "BELONGS_TO"
  | "OWNED_BY"
  | "STEP_OF"
  | "REFERS_TO"
  | "REQUIRES_ROLE";

export type PolicyGraphNode = {
  id: string;
  type: PolicyNodeType;
  name: string;
  source: string;
  content_hash: string;
  chunk_id?: string;
  text?: string;
  meta?: Record<string, unknown>;
};

export type PolicyGraphEdge = {
  id: string;
  from_id: string;
  to_id: string;
  rel: PolicyRelType;
  source: string;
  content_hash: string;
  meta?: Record<string, unknown>;
};

export type PolicyGraphData = {
  nodes: PolicyGraphNode[];
  edges: PolicyGraphEdge[];
};

const NODE_TYPES = new Set<PolicyNodeType>(["OrgUnit", "Role", "Process", "Clause"]);
const REL_TYPES = new Set<PolicyRelType>([
  "BELONGS_TO",
  "OWNED_BY",
  "STEP_OF",
  "REFERS_TO",
  "REQUIRES_ROLE",
]);

function graphFilePath(): string {
  const custom = String(process.env.RAG_POLICY_GRAPH_PATH ?? "").trim();
  if (custom) return custom;
  return join(process.cwd(), ".data", "rag-policy-graph.json");
}

function emptyGraph(): PolicyGraphData {
  return { nodes: [], edges: [] };
}

export function loadPolicyGraph(): PolicyGraphData {
  const path = graphFilePath();
  if (!existsSync(path)) return emptyGraph();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      nodes: Array.isArray(raw?.nodes) ? raw.nodes : [],
      edges: Array.isArray(raw?.edges) ? raw.edges : [],
    };
  } catch {
    return emptyGraph();
  }
}

export function savePolicyGraph(data: PolicyGraphData): void {
  const path = graphFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

/** 按 source 删除子图（H1 对齐：内容变更先 purge） */
export function purgeGraphBySource(source: string): { nodes: number; edges: number } {
  const s = String(source || "").trim();
  if (!s) return { nodes: 0, edges: 0 };
  const g = loadPolicyGraph();
  const beforeN = g.nodes.length;
  const beforeE = g.edges.length;
  g.nodes = g.nodes.filter((n) => n.source !== s);
  g.edges = g.edges.filter((e) => e.source !== s);
  savePolicyGraph(g);
  void import("./policy_graph_pg")
    .then((m) => m.purgePolicyGraphPgBySource(s))
    .catch((e) => console.warn("[PolicyGraphPG] purge skipped:", e));
  return { nodes: beforeN - g.nodes.length, edges: beforeE - g.edges.length };
}

/** 该 source 无边/无节点，或节点名像样例说明 → 应重抽 */
export function policyGraphNeedsRefresh(source: string): boolean {
  const s = String(source || "").trim();
  if (!s) return false;
  const g = loadPolicyGraph();
  const nodes = g.nodes.filter((n) => n.source === s);
  if (!nodes.length) return true;
  const edges = g.edges.filter((e) => e.source === s);
  if (edges.length < 2) return true;
  return nodes.some((n) =>
    /设计意图|冒烟样例|用途：|便于验证|非生产/.test(`${n.name || ""}${n.text || ""}`)
  );
}

export function upsertPolicyGraphFragment(params: {
  source: string;
  content_hash: string;
  nodes: Omit<PolicyGraphNode, "source" | "content_hash">[];
  edges: Omit<PolicyGraphEdge, "source" | "content_hash" | "id">[];
}): void {
  const source = String(params.source || "").trim();
  const content_hash = String(params.content_hash || "").trim();
  if (!source) return;
  purgeGraphBySource(source);
  const g = loadPolicyGraph();
  const writtenNodes: PolicyGraphNode[] = [];
  const writtenEdges: PolicyGraphEdge[] = [];
  for (const n of params.nodes) {
    if (!NODE_TYPES.has(n.type)) continue;
    const name = String(n.name || "").trim();
    if (!name) continue;
    const row: PolicyGraphNode = {
      id: String(n.id || `${n.type}:${name}`).slice(0, 200),
      type: n.type,
      name,
      source,
      content_hash,
      chunk_id: n.chunk_id,
      text: n.text,
      meta: n.meta,
    };
    g.nodes.push(row);
    writtenNodes.push(row);
  }
  let ei = 0;
  for (const e of params.edges) {
    if (!REL_TYPES.has(e.rel)) continue;
    const from_id = String(e.from_id || "").trim();
    const to_id = String(e.to_id || "").trim();
    if (!from_id || !to_id) continue;
    const row: PolicyGraphEdge = {
      id: `e:${source}:${ei++}`,
      from_id,
      to_id,
      rel: e.rel,
      source,
      content_hash,
      meta: e.meta,
    };
    g.edges.push(row);
    writtenEdges.push(row);
  }
  savePolicyGraph(g);
  void import("./policy_graph_pg")
    .then((m) =>
      m.mirrorPolicyGraphToPg({
        source,
        content_hash,
        nodes: writtenNodes,
        edges: writtenEdges,
      })
    )
    .catch((e) => console.warn("[PolicyGraphPG] mirror skipped:", e));
}

export function scoreTextOverlapLite(a: string, b: string): number {
  /** 长中文串整段作 token 会导致种子永不命中；拆成 bigram + 英文词 */
  const tokenSet = (s: string): Set<string> => {
    const out = new Set<string>();
    const runs =
      String(s || "")
        .toLowerCase()
        .match(/[\u4e00-\u9fff]{2,}|[a-z0-9_]{2,}/g) ?? [];
    for (const t of runs) {
      out.add(t);
      if (/[\u4e00-\u9fff]/.test(t)) {
        for (let i = 0; i <= t.length - 2; i += 1) {
          out.add(t.slice(i, i + 2));
        }
      }
    }
    return out;
  };
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit;
}

/** 1～2 跳遍历，收集 Clause（及带 text 的节点）作证据候选 */
export function traversePolicyGraph(params: {
  query: string;
  topics?: string[];
  maxHops?: number;
  limit?: number;
}): Array<{ key: string; pageContent: string; source: string; score: number; lane: "graph" }> {
  const g = loadPolicyGraph();
  if (!g.nodes.length) return [];
  const q = String(params.query || "").trim();
  const topics = (params.topics || []).map((t) => String(t).trim()).filter(Boolean);
  const seeds = g.nodes
    .map((n) => {
      const score =
        scoreTextOverlapLite(q, n.name) * 2 +
        scoreTextOverlapLite(q, n.text || "") +
        topics.reduce((s, t) => s + scoreTextOverlapLite(t, n.name) * 1.5, 0);
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (!seeds.length) return [];

  const maxHops = Math.max(1, Math.min(2, params.maxHops ?? 2));
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    if (!adj.has(e.from_id)) adj.set(e.from_id, []);
    if (!adj.has(e.to_id)) adj.set(e.to_id, []);
    adj.get(e.from_id)!.push(e.to_id);
    adj.get(e.to_id)!.push(e.from_id);
  }

  const visited = new Set<string>();
  const queue: Array<{ id: string; hop: number; seedScore: number }> = seeds.map((s) => ({
    id: s.n.id,
    hop: 0,
    seedScore: s.score,
  }));
  const hits: Array<{ key: string; pageContent: string; source: string; score: number; lane: "graph" }> =
    [];

  while (queue.length) {
    const cur = queue.shift()!;
    if (visited.has(cur.id)) continue;
    visited.add(cur.id);
    const node = byId.get(cur.id);
    if (!node) continue;
    const text = String(node.text || "").trim() || (node.type === "Clause" ? node.name : "");
    if (text.length >= 8) {
      hits.push({
        key: `graph:${node.source}:${node.id}`,
        pageContent: text,
        source: node.source,
        score: cur.seedScore / (1 + cur.hop),
        lane: "graph",
      });
    }
    if (cur.hop >= maxHops) continue;
    for (const nxt of adj.get(cur.id) || []) {
      if (!visited.has(nxt)) queue.push({ id: nxt, hop: cur.hop + 1, seedScore: cur.seedScore });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, params.limit ?? 12);
}

/** 测试/脚本：重置整图 */
export function resetPolicyGraphForTest(data?: PolicyGraphData): void {
  savePolicyGraph(data ?? emptyGraph());
}

export function isValidPolicyNodeType(t: string): t is PolicyNodeType {
  return NODE_TYPES.has(t as PolicyNodeType);
}

export function isValidPolicyRelType(t: string): t is PolicyRelType {
  return REL_TYPES.has(t as PolicyRelType);
}
