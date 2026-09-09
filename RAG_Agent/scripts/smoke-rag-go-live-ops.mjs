/**
 * W3 ops 捆绑：仅 MinerU health（可选；默认 go-live 不含，避免烧侧车）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

console.log("=== go-live:ops mineru-health ===");
const r = spawnSync("npm", ["run", "smoke:mineru-health"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: process.env,
});
if (r.status !== 0) process.exit(r.status || 1);
console.log("smoke-rag-go-live-ops OK");
