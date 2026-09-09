/**
 * W4：二进制入库→检索契约（本地解析 + 切分 + BM25），不调 LLM / MinerU / 外网。
 * 覆盖：DOCX（mammoth）/ 最小 PDF（pdf-parse）/ ZIP 多成员解压 source 集合。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { Document } from "@langchain/core/documents";
import { createBm25InvertedIndex } from "../server/utils/bm25_inverted_index";
import { hashCorpusText } from "../server/utils/ingest_meta";
import { splitDocumentsStructured } from "../server/utils/chunk_text";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MARKER = "翻身护理";
const MARKER2 = "尿不湿";
const CORPUS = `### 第十条 服务内容\n1. ${MARKER}\n2. ${MARKER2}\n3. 协助进食`;

function buildMinimalDocx(text: string): Buffer {
  const zip = new AdmZip();
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body>
</w:document>`;
  zip.addFile("word/document.xml", Buffer.from(docXml, "utf8"));
  zip.addFile(
    "[Content_Types].xml",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  );
  zip.addFile(
    "_rels/.rels",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  );
  zip.addFile(
    "word/_rels/document.xml.rels",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`)
  );
  return zip.toBuffer();
}

/** 最小可解析 PDF（Latin 可抽到；中文用旁路 md 成员覆盖语义） */
function buildMinimalPdf(asciiMarker: string): Buffer {
  const stream = `BT /F1 12 Tf 50 700 Td (${asciiMarker}) Tj ET`;
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n",
    `4 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body, "utf8");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

async function parsePdfLocal(buffer: Buffer, fileName: string): Promise<Document[]> {
  const pdfParseModule: any = await import("pdf-parse");
  const PDFParseCtor =
    pdfParseModule?.PDFParse ?? pdfParseModule?.default?.PDFParse ?? null;
  let text = "";
  if (typeof PDFParseCtor === "function") {
    const parser = new PDFParseCtor({ data: buffer });
    try {
      const textResult = await parser.getText();
      text = String(textResult?.text ?? "");
    } finally {
      if (typeof parser.destroy === "function") await parser.destroy();
    }
  } else {
    const pdfParseFn = pdfParseModule?.default ?? pdfParseModule;
    assert.equal(typeof pdfParseFn, "function", "pdf-parse callable");
    const parsed = await pdfParseFn(buffer);
    text = String(parsed?.text ?? "");
  }
  return [new Document({ pageContent: text, metadata: { source: fileName, fileType: "pdf" } })];
}

async function parseDocxLocal(buffer: Buffer, fileName: string): Promise<Document[]> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return [
    new Document({
      pageContent: String(result.value || ""),
      metadata: { source: fileName, fileType: "docx" },
    }),
  ];
}

/** 与 processDocument ZIP 白名单对齐的扩展探测 */
function zipWhitelistEntries(zipBuf: Buffer): string[] {
  assert.equal(zipBuf.slice(0, 4).toString("hex"), "504b0304", "zip magic");
  const zip = new AdmZip(zipBuf);
  const allow = new Set([
    ".txt",
    ".pdf",
    ".docx",
    ".md",
    ".csv",
    ".xlsx",
    ".xls",
    ".json",
    ".html",
    ".htm",
    ".pptx",
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".tiff",
  ]);
  return zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => e.name.replace(/\\/g, "/"))
    .filter((name) => allow.has(path.extname(name).toLowerCase()));
}

async function main() {
  process.env.RAG_HEAVY_PARSE = "0";
  process.env.RAG_HEAVY_PARSE_STRICT = "0";

  const fixtureDir = path.join(__dirname, "fixtures", "binary");
  fs.mkdirSync(fixtureDir, { recursive: true });

  // —— DOCX ——
  const docxName = "policy-article.docx";
  const docxBuf = buildMinimalDocx(CORPUS);
  fs.writeFileSync(path.join(fixtureDir, docxName), docxBuf);
  const docxDocs = await parseDocxLocal(docxBuf, docxName);
  assert.ok(docxDocs[0]!.pageContent.includes(MARKER), "docx must extract 翻身护理");
  assert.ok(docxDocs[0]!.pageContent.includes(MARKER2), "docx must extract 尿不湿");
  const docxChunks = await splitDocumentsStructured(docxDocs);
  assert.ok(docxChunks.length >= 1, "docx chunks >= 1");
  const docxHash = hashCorpusText(docxDocs.map((d) => d.pageContent).join("\n"));
  assert.equal(docxHash.length, 64, "content_hash sha256");

  const bm25 = createBm25InvertedIndex();
  for (const c of docxChunks) {
    bm25.upsertDoc({
      pageContent: c.pageContent,
      metadata: { ...c.metadata, source: docxName },
    });
  }
  const docxHits = bm25.search([MARKER, "第十条"], 5);
  assert.ok(docxHits.length >= 1, "BM25 retrieve after docx ingest");
  assert.ok(
    String(docxHits[0]?.metadata?.source).includes(docxName),
    `top hit source ${docxHits[0]?.metadata?.source}`
  );

  // —— PDF ——
  const pdfName = "policy-ascii.pdf";
  const pdfMarker = "RAG_SMOKE_TURNING_CARE";
  const pdfBuf = buildMinimalPdf(pdfMarker);
  fs.writeFileSync(path.join(fixtureDir, pdfName), pdfBuf);
  const pdfDocs = await parsePdfLocal(pdfBuf, pdfName);
  assert.ok(
    pdfDocs[0]!.pageContent.includes(pdfMarker),
    `pdf extract must contain ${pdfMarker}, got=${JSON.stringify(pdfDocs[0]!.pageContent.slice(0, 120))}`
  );
  const pdfChunks = await splitDocumentsStructured(pdfDocs);
  assert.ok(pdfChunks.length >= 1, "pdf chunks >= 1");
  for (const c of pdfChunks) {
    bm25.upsertDoc({
      pageContent: c.pageContent,
      metadata: { ...c.metadata, source: pdfName },
    });
  }
  const pdfHits = bm25.search([pdfMarker.toLowerCase()], 5);
  assert.ok(pdfHits.some((h) => String(h.metadata?.source) === pdfName), "BM25 find pdf source");

  // —— ZIP：多成员 source 集合 ——
  const zip = new AdmZip();
  zip.addFile("a/clause.md", Buffer.from(CORPUS, "utf8"));
  zip.addFile("b/note.txt", Buffer.from("探视时间 14:00-16:00", "utf8"));
  zip.addFile("ignore.bin", Buffer.from([0, 1, 2, 3]));
  const zipBuf = zip.toBuffer();
  const zipPath = path.join(os.tmpdir(), `rag-binary-smoke-${Date.now()}.zip`);
  fs.writeFileSync(zipPath, zipBuf);
  const entries = zipWhitelistEntries(zipBuf);
  const entryBases = [...new Set(entries.map((n) => path.basename(n)))].sort();
  assert.deepEqual(entryBases, ["clause.md", "note.txt"], `zip whitelist bases, got ${JSON.stringify(entries)}`);
  assert.ok(!entries.some((n) => n.endsWith(".bin") || n.includes("ignore")), "bin not whitelisted");
  // 模拟 processDocument 对白名单成员递归：txt/md 直接入库切分
  const zipInner = new AdmZip(zipBuf);
  for (const name of entries) {
    const entry =
      zipInner.getEntry(name) ||
      zipInner.getEntries().find((e) => path.basename(e.name) === path.basename(name));
    assert.ok(entry, `entry ${name}`);
    const text = entry!.getData().toString("utf8");
    const docs = [new Document({ pageContent: text, metadata: { source: path.basename(name) } })];
    const chunks = await splitDocumentsStructured(docs);
    for (const c of chunks) {
      bm25.upsertDoc({
        pageContent: c.pageContent,
        metadata: { source: path.basename(name) },
      });
    }
  }
  const zipHits = bm25.search(["探视时间"], 5);
  assert.ok(
    zipHits.some((h) => String(h.metadata?.source) === "note.txt"),
    "zip member note.txt retrievable"
  );

  fs.unlinkSync(zipPath);
  console.log(
    `smoke-rag-binary-ingest OK: docxChunks=${docxChunks.length} pdfChunks=${pdfChunks.length} zipEntries=${entries.length} hash=${docxHash.slice(0, 12)}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
