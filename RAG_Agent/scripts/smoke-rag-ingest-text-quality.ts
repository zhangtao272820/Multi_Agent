/**
 * 入库正文统一质检 + 二进制拒收契约：不调 LLM / MinerU / 外网。
 */
import assert from "node:assert/strict";
import {
  isIngestTextReliable,
  looksLikeBinaryOfficeOrPdf,
  KNOWN_INGEST_EXTS,
  IngestTextUnreliableError,
} from "../server/utils/ingest_text_quality";

const goodZh =
  "正常中文制度条款内容重复填充足够长度用于质检门槛一二三四五六七八九十甲乙丙丁戊己庚辛";

assert.equal(isIngestTextReliable(goodZh, "手册.md"), true);
assert.equal(
  isIngestTextReliable(
    "0SvsQĉ[\n6R[,gĉ0\n### ,{Nag\n,gĉ(uN(W-NNSNlqQTVXQOl{vvT{|{Q:gg0\n## ,{Nz\ngRhQ\n### ,{ASag 1YNbt ".repeat(
      3,
    ),
    "养老机构服务规范.docx",
  ),
  false,
  "中文文件名+乱码正文须拒收",
);
assert.equal(isIngestTextReliable("PK\x03\x04binaryzip", "a.pdf"), false);
assert.equal(isIngestTextReliable("bad\uFFFDbad\uFFFDbad\uFFFD", "a.pdf"), false);
assert.equal(isIngestTextReliable("", "a.md"), false);

assert.equal(looksLikeBinaryOfficeOrPdf(Buffer.from([0x50, 0x4b, 0x03, 0x04])), true);
assert.equal(looksLikeBinaryOfficeOrPdf(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])), true);
assert.equal(looksLikeBinaryOfficeOrPdf(Buffer.from("%PDF-1.4")), true);
assert.equal(looksLikeBinaryOfficeOrPdf(Buffer.from("hello world text")), false);

assert.equal(KNOWN_INGEST_EXTS.has("docx"), true);
assert.equal(KNOWN_INGEST_EXTS.has("pptx"), true);
assert.equal(KNOWN_INGEST_EXTS.has("bin"), false);

const err = new IngestTextUnreliableError("test");
assert.equal(err.code, "ingest_text_unreliable");

console.log("smoke-rag-ingest-text-quality OK");
