/**
 * 多文档 source coverage + 证据优选 round-robin 离线 smoke（纯函数镜像，不启服务、不调 LLM）。
 * 逻辑须与 retrieval_shared.mergeSourceCoverage / rag_evidence_answer.prioritizeEvidenceForGeneration 保持一致。
 */
import assert from "node:assert/strict";
import { getRagAgentEnv } from "../server/utils/rag_agent_env";

function mergeSourceCoverage<T>(
  docs: T[],
  resolveSource: (doc: T) => string,
  opts: { perSourceMin?: number; maxResults: number },
): T[] {
  const maxResults = Math.max(1, Math.floor(opts.maxResults));
  const perSourceMin = Math.max(1, Math.floor(opts.perSourceMin ?? 1));
  if (!docs.length) return [];
  if (docs.length <= maxResults) return docs.slice(0, maxResults);

  const sourceOf = (doc: T) => String(resolveSource(doc) || "unknown").trim() || "unknown";
  const sources: string[] = [];
  const seenSrc = new Set<string>();
  for (const doc of docs) {
    const src = sourceOf(doc);
    if (seenSrc.has(src)) continue;
    seenSrc.add(src);
    sources.push(src);
  }
  if (sources.length < 2) return docs.slice(0, maxResults);

  const docKey = (doc: T, idx: number) =>
    `${sourceOf(doc)}:${idx}:${String((doc as { pageContent?: unknown })?.pageContent ?? "").slice(0, 48)}`;
  const seen = new Set<string>();
  const out: T[] = [];

  for (const src of sources) {
    let added = 0;
    for (let i = 0; i < docs.length && added < perSourceMin; i++) {
      const doc = docs[i];
      if (sourceOf(doc) !== src) continue;
      const key = docKey(doc, i);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(doc);
      added += 1;
    }
  }

  for (let i = 0; i < docs.length && out.length < maxResults; i++) {
    const doc = docs[i];
    const key = docKey(doc, i);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
  }

  return out.slice(0, maxResults);
}

function tokenize(text: string): string[] {
  const normalized = String(text || "").toLowerCase();
  const cjk = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const terms = new Set<string>();
  for (const t of cjk) {
    terms.add(t);
    if (t.length >= 4) {
      for (let i = 0; i <= t.length - 2; i++) terms.add(t.slice(i, i + 2));
    }
  }
  return [...terms];
}

function overlapScore(query: string, text: string): number {
  const hay = String(text || "").toLowerCase();
  let s = 0;
  for (const t of tokenize(query)) {
    if (hay.includes(t)) s += t.length >= 3 ? 2 : 1;
  }
  return s;
}

/** 镜像 prioritizeEvidenceForGeneration：去掉 top.score>=0.08；近分 round-robin */
function prioritizeEvidence(
  query: string,
  effectiveQuery: string,
  items: { source?: string; content?: string }[],
  max = 6,
  catalog?: { name: string; summary?: string }[],
  forceMultiSource = false,
) {
  const queries = [effectiveQuery, query];
  const summaryBoost = new Map<string, number>();
  for (const doc of catalog ?? []) {
    let boost = 0;
    for (const q of queries) {
      boost += overlapScore(q, doc.summary ?? "") * 5;
      boost += overlapScore(q, doc.name) * 4;
    }
    summaryBoost.set(doc.name, boost);
  }
  const scored = items.map((item) => {
    let score = 0;
    for (const q of queries) {
      score += overlapScore(q, String(item.content ?? "")) * 2;
      score += overlapScore(q, String(item.source ?? "")) * 3;
    }
    for (const [name, boost] of summaryBoost) {
      if (String(item.source).includes(name)) score += boost;
    }
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const bySource = new Map<string, { total: number; rows: typeof items }>();
  for (const row of scored) {
    const src = String(row.item.source ?? "unknown");
    const prev = bySource.get(src) ?? { total: 0, rows: [] };
    prev.total += row.score;
    prev.rows.push(row.item);
    bySource.set(src, prev);
  }
  const sourceRank = [...bySource.entries()].sort((a, b) => b[1].total - a[1].total);
  const dominant = sourceRank[0];
  const runner = sourceRank[1];
  const dominantWins =
    !forceMultiSource &&
    Boolean(dominant) &&
    dominant![1].total > 0 &&
    (!runner || dominant![1].total >= runner[1].total * 1.35);

  const seen = new Set<string>();
  const out: typeof items = [];
  const pushItem = (item: (typeof items)[number]) => {
    const key = `${item.source}:${String(item.content ?? "").slice(0, 48)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push(item);
    return true;
  };

  if (dominantWins) {
    for (const item of dominant![1].rows) {
      pushItem(item);
      if (out.length >= max) break;
    }
  } else if (sourceRank.length >= 2 || forceMultiSource) {
    const queues = sourceRank.map(([, v]) => [...v.rows]);
    let guard = 0;
    while (out.length < max && queues.some((q) => q.length) && guard < max * 8) {
      guard += 1;
      for (const q of queues) {
        if (out.length >= max) break;
        while (q.length) {
          const item = q.shift()!;
          if (pushItem(item)) break;
        }
      }
    }
  } else {
    for (const row of scored) {
      pushItem(row.item);
      if (out.length >= max) break;
    }
  }
  return out;
}

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

  // fact_lookup 多文档放宽：镜像 resolveRetrievalLimits 规则
  const maxResultsSingle = 5;
  const maxResultsMulti = Math.min(maxResultsSingle + 1, 8);
  assert.equal(maxResultsMulti, 6);

  const nearTie = prioritizeEvidence(
    "养老机构护理员补贴标准是多少？",
    "护理员岗位补贴 标准",
    [
      { source: "养老机构服务规范.docx", content: "第二十条 失能老人补贴标准：完全失能老人每月补贴 800 元" },
      { source: "养老机构服务规范-验收用-v3.2.md", content: "护理员岗位补贴：每人每月 800 元（税前）" },
      { source: "养老机构服务规范.docx", content: "第三十一条 专业人员要求" },
    ],
    4,
  );
  const nearSources = new Set(nearTie.map((e) => e.source));
  assert.ok(
    nearSources.size >= 2,
    `near-tie should keep both sources, got ${JSON.stringify(nearTie.map((e) => e.source))}`,
  );

  const financeCatalog = [
    { name: "个人月收入.txt", summary: "该文档展示了个人的月度财务状况：月收入6000，月支出5000" },
    { name: "养老机构服务规范.docx", summary: "养老机构服务规范，护理标准与补贴政策" },
  ];
  const financePick = prioritizeEvidence(
    "在知识库中检索个人的财务情况",
    "个人月度收入与支出",
    [
      { source: "养老机构服务规范.docx", content: "第二十一条 高龄老人补贴" },
      { source: "个人月收入.txt", content: "月收入6000元，月支出5000元" },
    ],
    4,
    financeCatalog,
  );
  assert.ok(
    financePick.every((e) => String(e.source).includes("个人月收入")),
    `dominant finance should collapse, got ${JSON.stringify(financePick.map((e) => e.source))}`,
  );

  // forceMultiSource：即使 docx 分更高也不塌缩
  const forced = prioritizeEvidence(
    "养老机构护理员补贴标准是多少？",
    "护理员岗位补贴",
    [
      { source: "养老机构服务规范.docx", content: "第二十条 失能老人补贴标准：完全失能老人每月补贴 800 元" },
      { source: "养老机构服务规范.docx", content: "失能老人补贴政策说明" },
      { source: "养老机构服务规范-验收用-v3.2.md", content: "护理员岗位补贴：每人每月 800 元（税前）" },
    ],
    4,
    undefined,
    true,
  );
  assert.ok(
    forced.some((e) => String(e.source).includes("验收用")),
    `forceMultiSource must keep acceptance md, got ${JSON.stringify(forced.map((e) => e.source))}`,
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
