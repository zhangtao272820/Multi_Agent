/**
 * 已迁移：请使用 `npm run eval:rag`（scripts/rag-eval.ts）。
 * 本文件仅作兼容入口，转发到 ts 实现。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, "rag-eval.ts");
const r = spawnSync("npx", ["--yes", "tsx", target, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});
process.exit(r.status ?? 1);
