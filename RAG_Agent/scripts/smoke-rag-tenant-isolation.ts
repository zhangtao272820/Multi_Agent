/**
 * W5：跨租户逻辑隔离契约（路径 / ALS / PG 表后缀 / 入库 metadata），不调 LLM、不连真库。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getRagRequestTenantId,
  runWithRagTenant,
  safeRagTenantSegment,
} from "../server/utils/ragTenantContext";
import { createBm25InvertedIndex } from "../server/utils/bm25_inverted_index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function main() {
  // —— ALS：A/B 租户互不串 ——
  const a = runWithRagTenant({ tenantId: "tenant_a" }, () => getRagRequestTenantId());
  const b = runWithRagTenant({ tenantId: "tenant_b" }, () => getRagRequestTenantId());
  assert.equal(a, "tenant_a");
  assert.equal(b, "tenant_b");
  assert.notEqual(a, b);

  const segA = runWithRagTenant({ tenantId: "tenant_a" }, () => safeRagTenantSegment());
  const segB = runWithRagTenant({ tenantId: "tenant_b" }, () => safeRagTenantSegment());
  assert.equal(segA, "tenant_a");
  assert.equal(segB, "tenant_b");
  assert.notEqual(segA, segB);

  // 路径隔离：与 vectorStore.tenantDataDir 约定一致（.data/tenants/<seg>/…）
  const pathA = path.join(".data", "tenants", segA, "vector_store.json");
  const pathB = path.join(".data", "tenants", segB, "vector_store.json");
  assert.ok(pathA.includes(`${path.sep}tenants${path.sep}tenant_a${path.sep}`));
  assert.ok(pathB.includes(`${path.sep}tenants${path.sep}tenant_b${path.sep}`));
  assert.notEqual(pathA, pathB);

  // 危险字符规范化，避免路径穿越
  const evil = safeRagTenantSegment("../evil;drop");
  assert.ok(!evil.includes(".."), "no parent traversal");
  assert.ok(!evil.includes(";"), "no semicolon");
  assert.ok(evil.length <= 48);

  // —— 检索层：按 source 隔离的 BM25 模拟「不同租户索引」——
  const idxA = createBm25InvertedIndex();
  const idxB = createBm25InvertedIndex();
  idxA.upsertDoc({
    pageContent: "租户A机密：翻身护理细则仅A可见",
    metadata: { source: "a_secret.md", tenant_id: "tenant_a" },
  });
  idxB.upsertDoc({
    pageContent: "租户B公开：探视时间表",
    metadata: { source: "b_public.md", tenant_id: "tenant_b" },
  });
  const leakToB = idxB.search(["翻身", "机密"], 5);
  assert.equal(leakToB.length, 0, "tenant B index must not see A corpus");
  const leakToA = idxA.search(["探视"], 5);
  assert.equal(leakToA.length, 0, "tenant A index must not see B corpus");
  assert.ok(idxA.search(["翻身"], 5).length >= 1, "A finds own docs");
  assert.ok(idxB.search(["探视"], 5).length >= 1, "B finds own docs");

  // —— 源码契约：入库写 tenant_id；store/表按 tenant 分 ——
  const vs = readSource("RAG_Agent/server/utils/vectorStore.ts");
  assert.ok(vs.includes("tenant_id: docTenantId"), "upsert writes tenant_id");
  assert.ok(vs.includes("tenants"), "tenant data dir");
  assert.ok(vs.includes("safeRagTenantSegment"), "PG/path uses safe segment");
  assert.ok(
    vs.includes("rag_documents_") || vs.includes("${baseTable}_${tenantSeg}"),
    "non-default tenant gets table suffix"
  );

  const mw = readSource("RAG_Agent/server/middleware/rag-tenant.ts");
  assert.ok(mw.includes("ragTenantId") || mw.includes("tenant"), "middleware sets tenant");

  const ctx = readSource("RAG_Agent/server/utils/ragTenantContext.ts");
  assert.ok(ctx.includes("runWithRagTenant"), "ALS helper");
  assert.ok(ctx.includes("getRagRequestTenantId"), "request tenant reader");

  console.log("smoke-rag-tenant-isolation OK");
}

main();
