/**
 * PG jsonb 消毒契约：\u0000 会导致 Postgres「unsupported Unicode escape sequence」。
 */
import assert from "node:assert/strict";
import {
  sanitizeDocumentForPgJson,
  sanitizeMetadataForPgJson,
  sanitizeTextForPgJson,
} from "../server/utils/pg_json_sanitize";

const dirty = "护理员补贴\u0000每人每月\u0001800\u0007元";
const clean = sanitizeTextForPgJson(dirty);
assert.equal(clean.includes("\u0000"), false);
assert.equal(clean.includes("\u0001"), false);
assert.ok(clean.includes("800"));
assert.ok(clean.includes("护理员"));

const meta = sanitizeMetadataForPgJson({
  source: "规范.docx\u0000",
  parent_text: "附录\u0000A",
  nested: { note: "ok\u0000" },
  tags: ["a\u0000", "b"],
});
assert.equal(String(meta.source).includes("\u0000"), false);
assert.equal(String((meta.nested as any).note).includes("\u0000"), false);
assert.equal((meta.tags as string[])[0], "a");

const doc = sanitizeDocumentForPgJson({
  pageContent: "正文\u0000夹杂",
  metadata: { source: "x\u0000.docx", chunk: 1 },
});
assert.equal(doc.pageContent.includes("\u0000"), false);
assert.equal(String(doc.metadata.source).includes("\u0000"), false);

// 模拟 LangChain → JSON → PG：消毒后不应再出现 \u0000 escape
const encoded = JSON.stringify({ content: doc.pageContent, metadata: doc.metadata });
assert.equal(encoded.includes("\\u0000"), false);

// Y：WPS OLE 名 docx → 应解析而非拒收（与 vectorStore 一致）
function shouldParseOleNamedDocx(fileName: string, magicHex: string): boolean {
  const ext = String(fileName || "").split(".").pop()?.toLowerCase() || "";
  return (ext === "docx" || ext === "doc") && magicHex === "d0cf11e0";
}
assert.equal(shouldParseOleNamedDocx("规范.docx", "d0cf11e0"), true);
assert.equal(shouldParseOleNamedDocx("规范.doc", "d0cf11e0"), true);
assert.equal(shouldParseOleNamedDocx("规范.docx", "504b0304"), false);

console.log("smoke-rag-pg-json-sanitize OK");
