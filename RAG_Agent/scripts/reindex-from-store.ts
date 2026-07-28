/**
 * H6：从已存向量重建切分（best-effort）。
 *   npx tsx scripts/reindex-from-store.ts
 * 可选：--dir <path> 从目录重新上传文本/md/json/csv（优先于 from-store）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function parseArgs(argv: string[]) {
  const dirIdx = argv.indexOf("--dir");
  const dir = dirIdx >= 0 ? argv[dirIdx + 1] : "";
  return { dir: dir ? path.resolve(dir) : "" };
}

async function reindexFromDir(dir: string) {
  const { upsertTextDocument } = await import("../server/utils/vectorStore");
  const exts = new Set([".txt", ".md", ".csv", ".json", ".html", ".htm"]);
  const files = fs.readdirSync(dir).filter((f) => exts.has(path.extname(f).toLowerCase()));
  let chunks = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    const text = fs.readFileSync(full, "utf8");
    const n = await upsertTextDocument(f, text);
    console.log(`[reindex:dir] ${f} -> ${n} chunks`);
    chunks += n;
  }
  return { sources: files.length, chunks };
}

async function main() {
  process.chdir(root);
  const { dir } = parseArgs(process.argv.slice(2));
  if (dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      console.error(`--dir not a directory: ${dir}`);
      process.exit(1);
    }
    const r = await reindexFromDir(dir);
    console.log(`reindex-from-dir OK: sources=${r.sources} chunks=${r.chunks}`);
    return;
  }
  const { reindexAllFromStore, auditVectorStoreHealth } = await import("../server/utils/vectorStore");
  const before = await auditVectorStoreHealth({ reconcile: false });
  console.log(
    `[health:before] backend=${before.backend} docs=${before.metadataDocCount} vectors=${before.vectorRowCount} missing_ingest=${before.missingIngestAtRatio}`
  );
  const r = await reindexAllFromStore();
  const after = await auditVectorStoreHealth({ reconcile: false });
  console.log(
    `[health:after] docs=${after.metadataDocCount} vectors=${after.vectorRowCount} missing_ingest=${after.missingIngestAtRatio} warnings=${after.warnings.join(",") || "none"}`
  );
  console.log(`reindex-from-store OK: sources=${r.sources} chunks=${r.chunks}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
