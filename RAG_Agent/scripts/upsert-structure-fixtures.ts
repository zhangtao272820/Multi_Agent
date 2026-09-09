/**
 * 将 structure fixtures 入库（pgvector），便于 UI 用测试问题验收。
 *   npx tsx --tsconfig tsconfig.smoke.json scripts/upsert-structure-fixtures.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(__dirname, "fixtures", "structure");

async function main() {
  process.chdir(root);
  const { upsertTextDocument } = await import("../server/utils/vectorStore");
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => /\.(md|txt)$/i.test(f));
  let chunks = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, f), "utf8");
    const n = await upsertTextDocument(`fixture-${f}`, text, {
      fileType: path.extname(f).slice(1) || "txt",
      forceReembed: true,
    });
    console.log(`[fixture] ${f} -> ${n} chunks`);
    chunks += n;
  }
  console.log(`upsert-structure-fixtures OK: files=${files.length} chunks=${chunks}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
