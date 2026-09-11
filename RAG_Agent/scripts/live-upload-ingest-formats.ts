/**
 * Docker 实传三种格式并抽查 PG 正文（会走嵌入，仅本地验收用，不进 ci:gate）。
 * 用法：npx tsx scripts/live-upload-ingest-formats.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testdata = path.join(__dirname, "..", "data", "testdata");
const base = process.env.RAG_UPLOAD_URL || "http://127.0.0.1:13102";
const token =
  process.env.CLAWHIVE_INTERNAL_TOKEN ||
  process.env.AGENT_SERVICE_TOKEN ||
  "95064263-25c0-459f-808a-c280a6772512";

const FILES = [
  {
    name: "养老机构服务规范.docx",
    // 优先用户旧 OLE 文件
    paths: [
      "f:/下载/养老机构服务规范.docx",
      path.join(testdata, "养老机构服务规范.docx"),
    ],
    expectCjk: ["养老", "护理"],
  },
  {
    name: "养老机构服务规范-验收用-v3.2.pdf",
    paths: [path.join(testdata, "养老机构服务规范-验收用-v3.2.pdf")],
    expectCjk: ["800", "护理"],
  },
  {
    name: "graphrag-smoke-入职与请假制度.xlsx",
    paths: [path.join(testdata, "graphrag-smoke-入职与请假制度.xlsx")],
    expectCjk: ["入职", "人力资源"],
  },
];

function resolvePath(paths: string[]): string {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`missing file among ${paths.join(" | ")}`);
}

async function upload(filePath: string, fileName: string): Promise<{ chunks: number }> {
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  form.append("file", new Blob([bytes]), fileName);
  form.append("force_reembed", "1");
  const res = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: {
      "x-internal-token": token,
      "x-agent-service-token": token,
    },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`upload ${fileName} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text) as { chunks?: number };
  return { chunks: Number(json.chunks || 0) };
}

function pgCheck(source: string, tips: string[]): { n: number; parsers: string; hitTips: string[] } {
  const src = source.replace(/'/g, "''");
  const tipClauses = tips
    .map((t, i) => `MAX(CASE WHEN content LIKE '%${t.replace(/'/g, "''")}%' THEN 1 ELSE 0 END) AS t${i}`)
    .join(", ");
  const sql = `SELECT COUNT(*)::int AS n,
    COALESCE(string_agg(DISTINCT COALESCE(metadata->>'parser','?'), ','), '') AS parsers,
    ${tipClauses}
    FROM rag_documents WHERE metadata->>'source' = '${src}'`;
  const out = execFileSync(
    "docker",
    ["exec", "rag_pgvector", "psql", "-U", "postgres", "-d", "rag_vector", "-t", "-A", "-F", "|", "-c", sql],
    { encoding: "utf8" },
  ).trim();
  const parts = out.split("|");
  const n = Number(parts[0] || 0);
  const parsers = parts[1] || "";
  const hitTips = tips.filter((_, i) => Number(parts[2 + i] || 0) === 1);
  return { n, parsers, hitTips };
}

async function main() {
  const ready = await fetch(`${base}/api/ready`).then((r) => r.json()).catch(() => null);
  assert.ok(ready && (ready as any).ready === true, "rag /api/ready not ready");

  for (const f of FILES) {
    const fp = resolvePath(f.paths);
    console.log(`upload ${f.name} from ${fp} ...`);
    const { chunks } = await upload(fp, f.name);
    assert.ok(chunks >= 1, `${f.name} chunks=${chunks}`);
    await new Promise((r) => setTimeout(r, 1200));
    const row = pgCheck(f.name, f.expectCjk);
    assert.ok(row.n >= 1, `${f.name} pg rows=${row.n}`);
    for (const tip of f.expectCjk) {
      assert.ok(row.hitTips.includes(tip), `${f.name} missing tip「${tip}」parsers=${row.parsers}`);
    }
    console.log(`OK ${f.name} chunks=${chunks} pg=${row.n} parser=${row.parsers} tips=${row.hitTips.join(",")}`);
  }
  console.log("live-upload-ingest-formats OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
