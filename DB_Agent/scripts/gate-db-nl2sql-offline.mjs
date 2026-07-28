/**
 * D3 离线门禁：NL2SQL 黄金集 schema / 题量（不依赖 MySQL）。
 * 故意删减题量或破坏 schema → exit 1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const minCases = Number(process.env.DB_NL2SQL_MIN_CASES ?? "20");
const file = path.join(root, "eval/golden-person-basic-stats.json");

function assert(cond, msg) {
  if (!cond) {
    console.error(msg);
    process.exit(1);
  }
}

const raw = fs.readFileSync(file, "utf8");
let doc;
try {
  doc = JSON.parse(raw);
} catch (e) {
  assert(false, `invalid JSON: ${e?.message || e}`);
}

const cases = doc?.cases;
assert(Array.isArray(cases), "golden-person-basic-stats.json.cases must be array");
assert(cases.length >= minCases, `need >=${minCases} cases, got ${cases.length}`);

const ids = new Set();
let withPath = 0;
let withPrimary = 0;
for (const c of cases) {
  assert(c && typeof c === "object", "case must be object");
  assert(String(c.id || "").trim(), "case.id required");
  assert(!ids.has(c.id), `duplicate id: ${c.id}`);
  ids.add(c.id);
  assert(String(c.user || "").trim(), `case.user required for ${c.id}`);
  assert(c.expect && typeof c.expect === "object", `${c.id}: expect required`);
  if (Array.isArray(c.expect.path_any) && c.expect.path_any.length >= 1) withPath += 1;
  if (String(c.expect.primaryTable || "").trim()) withPrimary += 1;
}
assert(withPath >= Math.min(minCases, cases.length), `need path_any on all cases, got ${withPath}`);
assert(withPrimary >= Math.min(10, cases.length), `need >=10 primaryTable cases, got ${withPrimary}`);

console.log(`gate-db-nl2sql-offline OK: ${cases.length} cases (path=${withPath}, primary=${withPrimary})`);
