/**
 * MinerU 严格模式 + Office 本地权威 + 伪成功质检契约：不调真 MinerU / LLM。
 */
import assert from "node:assert/strict";

async function main() {
  delete process.env.RAG_HEAVY_PARSE_STRICT;
  process.env.RAG_HEAVY_PARSE = "1";
  process.env.MINERU_API_URL = "http://127.0.0.1:8798";
  process.env.RAG_HEAVY_PARSE_MIN_CHARS = "80";

  const { getRagAgentEnv } = await import("../server/utils/rag_agent_env");
  let env = getRagAgentEnv();
  assert.equal(env.heavyParseStrict, false, "dev default strict=off");

  process.env.RAG_HEAVY_PARSE_STRICT = "1";
  env = getRagAgentEnv();
  assert.equal(env.heavyParseStrict, true);
  assert.ok(env.heavyParseMinChars >= 80);

  const {
    shouldAttemptHeavyParse,
    shouldRejectOnHeavyFailure,
    isHeavyParseTooShort,
    isHeavyParseExtension,
    isLocalWordParseExtension,
    isLocalOfficeParseExtension,
    isHeavyParseTextReliable,
    HeavyParseStrictError,
  } = await import("../server/utils/heavy_parse_client");

  assert.equal(isHeavyParseExtension("手册.pdf"), true);
  assert.equal(isHeavyParseExtension("notes.txt"), false);
  assert.equal(isHeavyParseExtension("规范.docx"), false, "docx 不走 MinerU 扩展集");
  assert.equal(isHeavyParseExtension("汇报.pptx"), false, "pptx 不走 MinerU 扩展集");
  assert.equal(isLocalWordParseExtension("养老机构服务规范.docx"), true);
  assert.equal(isLocalOfficeParseExtension("汇报.pptx"), true);
  assert.equal(shouldAttemptHeavyParse("手册.pdf"), true);
  assert.equal(shouldAttemptHeavyParse("养老机构服务规范.docx"), false, "docx 必须本地 mammoth");
  assert.equal(shouldAttemptHeavyParse("汇报.pptx"), false, "pptx 必须本地 extractPptxText");
  assert.equal(shouldRejectOnHeavyFailure({ fileName: "手册.pdf" }), true);
  assert.equal(shouldRejectOnHeavyFailure({ fileName: "notes.txt" }), false);
  assert.equal(
    shouldRejectOnHeavyFailure({ fileName: "养老机构服务规范.docx" }),
    false,
    "Word 不因 MinerU 严格模式拒收",
  );
  assert.equal(
    shouldRejectOnHeavyFailure({ fileName: "汇报.pptx" }),
    false,
    "PPTX 不因 MinerU 严格模式拒收",
  );
  assert.equal(isHeavyParseTooShort(10), true);
  assert.equal(isHeavyParseTooShort(200), false);

  assert.equal(
    isHeavyParseTextReliable(
      "正常中文制度条款内容重复填充足够长度用于质检门槛一二三四五六七八九十",
      "手册.md",
    ),
    true,
  );
  assert.equal(
    isHeavyParseTextReliable(
      "0SvsQĉ[\n6R[,gĉ0\n### ,{Nag\n,gĉ(uN(W-NNSNlqQTVXQOl{vvT{|{Q:gg0\n## ,{Nz\ngRhQ\n### ,{ASag 1YNbt ".repeat(
        3,
      ),
      "养老机构服务规范.docx",
    ),
    false,
    "中文文件名+乱码正文须拒收",
  );
  assert.equal(isHeavyParseTextReliable("PK\x03\x04binaryzip", "a.pdf"), false);
  assert.equal(isHeavyParseTextReliable("bad\uFFFDbad\uFFFDbad\uFFFD", "a.pdf"), false);

  // Y：OLE 名 docx 应解析（word-extractor），不拒收
  const shouldParseOleNamedDocx = (name: string, magicHex: string) => {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    return (ext === "docx" || ext === "doc") && magicHex === "d0cf11e0";
  };
  assert.equal(shouldParseOleNamedDocx("规范.docx", "d0cf11e0"), true);
  assert.equal(shouldParseOleNamedDocx("规范.docx", "504b0304"), false);

  const err = new HeavyParseStrictError("test");
  assert.equal(err.code, "heavy_parse_strict_failed");
  assert.equal(err.name, "HeavyParseStrictError");

  process.env.RAG_HEAVY_PARSE_STRICT = "0";
  env = getRagAgentEnv();
  assert.equal(env.heavyParseStrict, false);
  assert.equal(shouldRejectOnHeavyFailure({ fileName: "手册.pdf" }), false);

  console.log("smoke-rag-heavy-parse-strict OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
