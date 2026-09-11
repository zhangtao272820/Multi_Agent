/**
 * RAG 多格式入库契约（不调 LLM / 不写向量库）：
 * OOXML docx、WPS OLE 名 docx、xlsx、路由矩阵、质检闸、未知二进制拒收。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import { Document } from "@langchain/core/documents";
import {
  isIngestTextReliable,
  looksLikeBinaryOfficeOrPdf,
  KNOWN_INGEST_EXTS,
} from "../server/utils/ingest_text_quality";
import { resolveWordParseStrategy, wordMagicHex } from "../server/utils/word_parse_strategy";
import { parseSpreadsheetBuffer } from "../server/utils/spreadsheet_parse";
import { splitDocumentsStructured } from "../server/utils/chunk_text";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "binary");
const testdataDir = path.join(__dirname, "..", "data", "testdata");

function buildMinimalDocx(text: string): Buffer {
  const zip = new AdmZip();
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body>
</w:document>`,
      "utf8",
    ),
  );
  zip.addFile(
    "[Content_Types].xml",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`),
  );
  zip.addFile(
    "_rels/.rels",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
  );
  return zip.toBuffer();
}

async function main() {
  process.env.RAG_HEAVY_PARSE = "1";
  process.env.MINERU_API_URL = "http://127.0.0.1:8798";
  process.env.RAG_HEAVY_PARSE_STRICT = "1";

  const {
    shouldAttemptHeavyParse,
    isLocalOfficeParseExtension,
  } = await import("../server/utils/heavy_parse_client");

  // —— 路由矩阵：Office 本地，PDF 可走 MinerU ——
  assert.equal(shouldAttemptHeavyParse("a.pdf"), true);
  assert.equal(shouldAttemptHeavyParse("a.docx"), false);
  assert.equal(shouldAttemptHeavyParse("a.pptx"), false);
  assert.equal(shouldAttemptHeavyParse("a.xlsx"), false);
  assert.equal(isLocalOfficeParseExtension("a.docx"), true);
  assert.equal(isLocalOfficeParseExtension("a.pptx"), true);

  // —— OOXML docx → mammoth ——
  const MARKER = "翻身护理800元";
  const ooxml = buildMinimalDocx(`第十条 ${MARKER}`);
  assert.equal(wordMagicHex(ooxml), "504b0304");
  assert.equal(resolveWordParseStrategy({ magicHex: "504b0304", fileExt: "docx" }).kind, "ooxml_mammoth");
  const mammoth = await import("mammoth");
  const ooxmlText = String((await mammoth.extractRawText({ buffer: ooxml })).value || "");
  assert.ok(ooxmlText.includes(MARKER), "ooxml mammoth extract");
  assert.equal(isIngestTextReliable(ooxmlText + "条款".repeat(20), "规范.docx"), true);

  // —— WPS OLE 名 docx → word-extractor（真实用户文件或 fixture） ——
  const oleCandidates = [
    path.join("f:/下载", "养老机构服务规范.docx"),
    path.join(fixtureDir, "wps-ole-养老机构服务规范.docx"),
    path.join(testdataDir, "养老机构服务规范.docx"),
  ];
  let olePath = "";
  for (const p of oleCandidates) {
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    if (wordMagicHex(buf) === "d0cf11e0") {
      olePath = p;
      break;
    }
  }
  assert.ok(olePath, "need at least one OLE-named docx fixture (WPS)");
  const oleBuf = fs.readFileSync(olePath);
  const oleStrategy = resolveWordParseStrategy({ magicHex: wordMagicHex(oleBuf), fileExt: "docx" });
  assert.equal(oleStrategy.kind, "ole_word_extractor");
  if (oleStrategy.kind === "ole_word_extractor") {
    assert.equal(oleStrategy.extMismatchOleAsDocx, true);
  }
  const WordExtractor = (await import("word-extractor")).default;
  const oleBody = String((await new WordExtractor().extract(oleBuf)).getBody() || "");
  assert.ok(oleBody.length >= 80, `ole body too short: ${oleBody.length}`);
  assert.ok(/[\u4e00-\u9fff]/.test(oleBody), "ole body must contain CJK");
  assert.equal(isIngestTextReliable(oleBody, "养老机构服务规范.docx"), true);
  // 固化到 fixtures，便于无下载目录的 CI
  fs.mkdirSync(fixtureDir, { recursive: true });
  const oleFixture = path.join(fixtureDir, "wps-ole-养老机构服务规范.docx");
  if (!fs.existsSync(oleFixture) || fs.statSync(oleFixture).size !== oleBuf.length) {
    fs.writeFileSync(oleFixture, oleBuf);
  }

  // —— xlsx ——
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["条款", "正文"],
      ["第1条", "人力资源部归口入职"],
      ["第12条", "事假审批流程由行政办公室归口"],
    ]),
    "人事",
  );
  const xbuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  assert.equal(looksLikeBinaryOfficeOrPdf(xbuf), true);
  const xtext = parseSpreadsheetBuffer(xbuf, "hr.xlsx");
  assert.ok(xtext.includes("人力资源部"), "xlsx cells");
  assert.ok(xtext.includes("事假审批"), "xlsx leave flow");
  const xchunks = await splitDocumentsStructured([
    new Document({ pageContent: xtext, metadata: { source: "hr.xlsx", fileType: "xlsx" } }),
  ]);
  assert.ok(xchunks.length >= 1, "xlsx chunks");

  // —— 质检拒收乱码 / 二进制当文本 ——
  assert.equal(
    isIngestTextReliable("PK\x03\x04" + "x".repeat(100), "a.pdf"),
    false,
  );
  assert.equal(
    isIngestTextReliable("0SvsQĉ[".repeat(30), "养老机构服务规范.docx"),
    false,
  );
  assert.equal(KNOWN_INGEST_EXTS.has("xlsx"), true);
  assert.equal(KNOWN_INGEST_EXTS.has("bin"), false);
  assert.equal(looksLikeBinaryOfficeOrPdf(Buffer.from("%PDF-1.4")), true);

  // —— testdata 三种真实格式存在 ——
  const need = [
    "养老机构服务规范.docx",
    "养老机构服务规范-验收用-v3.2.pdf",
    "graphrag-smoke-入职与请假制度.xlsx",
  ];
  for (const name of need) {
    const p = path.join(testdataDir, name);
    assert.ok(fs.existsSync(p), `missing testdata ${name}`);
    assert.ok(fs.statSync(p).size > 100, `empty ${name}`);
  }

  console.log(
    `smoke-rag-ingest-formats OK ole=${path.basename(olePath)} ooxml_marker=${MARKER} xlsxChunks=${xchunks.length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
