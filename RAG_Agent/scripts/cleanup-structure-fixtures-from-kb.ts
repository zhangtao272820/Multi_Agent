/**
 * 运维：从 Docker 知识库剔除 structure fixture-*，保留原先业务文档。
 * 用法（宿主机，rag_pgvector / rag_agent 已起）：
 *   npx tsx scripts/cleanup-structure-fixtures-from-kb.ts
 * 或直接：docker exec + SQL（本脚本封装）。
 *
 * 不删命名卷；仅 DELETE 向量行并重写容器内 metadata / BM25。
 */
import { spawnSync } from "node:child_process";

const FIXTURE_PREFIX = "fixture-";

function run(cmd: string, args: string[], opts?: { allowFail?: boolean }) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false });
  if (r.status !== 0 && !opts?.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

function main() {
  const list = run("docker", [
    "exec",
    "rag_pgvector",
    "psql",
    "-U",
    "postgres",
    "-d",
    "rag_vector",
    "-t",
    "-A",
    "-c",
    `SELECT DISTINCT metadata->>'source' FROM rag_documents WHERE metadata->>'source' LIKE '${FIXTURE_PREFIX}%' ORDER BY 1;`,
  ]);
  const sources = String(list.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`fixture sources to delete: ${sources.length}`, sources);

  const del = run("docker", [
    "exec",
    "rag_pgvector",
    "psql",
    "-U",
    "postgres",
    "-d",
    "rag_vector",
    "-c",
    `DELETE FROM rag_documents WHERE COALESCE(metadata->>'source','') LIKE '${FIXTURE_PREFIX}%';`,
  ]);
  console.log(String(del.stdout || "").trim());

  // 容器内：过滤 docs_metadata + bm25（租户 default + 根目录镜像）
  const nodeCleanup = `
const fs = require('fs');
const paths = [
  '/app/.data/tenants/default/docs_metadata.json',
  '/app/.data/docs_metadata.json',
];
for (const p of paths) {
  if (!fs.existsSync(p)) continue;
  const raw = fs.readFileSync(p, 'utf8');
  const docs = JSON.parse(raw);
  if (!Array.isArray(docs)) continue;
  const next = docs.filter((d) => !String(d.name || '').startsWith('fixture-'));
  fs.writeFileSync(p, JSON.stringify(next));
  console.log('meta', p, docs.length, '->', next.length);
}
const bm25Paths = [
  '/app/.data/tenants/default/bm25_index.json',
  '/app/.data/bm25_index.json',
];
for (const p of bm25Paths) {
  if (!fs.existsSync(p)) continue;
  const idx = JSON.parse(fs.readFileSync(p, 'utf8'));
  const docs = Array.isArray(idx.docs) ? idx.docs : [];
  const next = docs.filter((d) => !String(d?.metadata?.source || '').startsWith('fixture-'));
  idx.docs = next;
  fs.writeFileSync(p, JSON.stringify(idx));
  console.log('bm25', p, docs.length, '->', next.length);
}
`;
  const clean = run("docker", ["exec", "rag_agent", "node", "-e", nodeCleanup]);
  console.log(String(clean.stdout || "").trim());

  // 进程内 metadata/BM25 以磁盘为准：重启加载过滤后的文件
  run("docker", ["restart", "rag_agent"]);
  console.log("restarted rag_agent; waiting ready…");

  for (let i = 0; i < 40; i++) {
    spawnSync("curl.exe", ["-s", "http://127.0.0.1:13102/api/ready"], {
      encoding: "utf8",
      shell: false,
    });
    const ready = spawnSync("curl.exe", ["-s", "http://127.0.0.1:13102/api/ready"], {
      encoding: "utf8",
      shell: false,
    });
    const body = String(ready.stdout || "");
    if (body.includes('"ready":true') && /"docCount":\s*4/.test(body)) break;
    spawnSync(process.platform === "win32" ? "timeout" : "sleep", process.platform === "win32" ? ["/t", "2", "/nobreak"] : ["2"], {
      shell: true,
      stdio: "ignore",
    });
  }

  const remain = run("docker", [
    "exec",
    "rag_pgvector",
    "psql",
    "-U",
    "postgres",
    "-d",
    "rag_vector",
    "-t",
    "-A",
    "-c",
    "SELECT DISTINCT metadata->>'source' FROM rag_documents ORDER BY 1;",
  ]);
  const left = String(remain.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const fixturesLeft = left.filter((s) => s.startsWith(FIXTURE_PREFIX));
  if (fixturesLeft.length) {
    throw new Error(`fixtures still in PG: ${fixturesLeft.join(", ")}`);
  }
  console.log("remaining sources:", left);
  console.log("cleanup-structure-fixtures-from-kb OK");
}

main();
