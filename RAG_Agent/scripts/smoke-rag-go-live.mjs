/**
 * Go-live 捆绑：纯契约 smoke，不调 LLM、不连外部专家 / MinerU 侧车。
 * 任一步失败即非 0 退出。
 * W6：捆绑侧建议 RAG_EVAL_MIN_PASS_RATE≥0.7（不覆盖本地已显式设置的值）。
 * MinerU 真连通：npm run smoke:go-live:ops
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const goLiveEnv = {
  ...process.env,
  RAG_EVAL_MIN_PASS_RATE: process.env.RAG_EVAL_MIN_PASS_RATE || "0.7",
};

const STEPS = [
  { name: "structure-corpus", args: ["run", "smoke:structure-corpus"] },
  { name: "chunk-article-list", args: ["run", "smoke:chunk-article-list"] },
  { name: "force-reembed", args: ["run", "smoke:force-reembed"] },
  { name: "bm25-index", args: ["run", "smoke:bm25-index"] },
  { name: "binary-ingest", args: ["run", "smoke:binary-ingest"] },
  { name: "tenant-isolation", args: ["run", "smoke:tenant-isolation"] },
  { name: "pgvector-ann", args: ["run", "smoke:pgvector-ann"] },
  { name: "enterprise-h", args: ["run", "smoke:enterprise-h"] },
  { name: "heavy-parse-strict", args: ["run", "smoke:heavy-parse-strict"] },
  { name: "gate:rag-eval", args: ["run", "gate:rag-eval"] },
];

console.log(
  `[go-live] RAG_EVAL_MIN_PASS_RATE=${goLiveEnv.RAG_EVAL_MIN_PASS_RATE} (eval:rag:ci 建议≥0.7；本捆绑 gate 为离线 schema)`
);

let failed = 0;
for (const step of STEPS) {
  console.log(`\n=== go-live: ${step.name} ===`);
  const r = spawnSync("npm", step.args, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: goLiveEnv,
  });
  if (r.status !== 0) {
    console.error(`go-live FAIL: ${step.name} exit=${r.status}`);
    failed += 1;
    break;
  }
}

if (failed) process.exit(1);
console.log("\nsmoke-rag-go-live OK");
