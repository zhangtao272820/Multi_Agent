/**
 * MinerU 严格模式契约：不调真 MinerU / LLM。
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
    HeavyParseStrictError,
  } = await import("../server/utils/heavy_parse_client");

  assert.equal(isHeavyParseExtension("手册.pdf"), true);
  assert.equal(isHeavyParseExtension("notes.txt"), false);
  assert.equal(shouldAttemptHeavyParse("手册.pdf"), true);
  assert.equal(shouldRejectOnHeavyFailure({ fileName: "手册.pdf" }), true);
  assert.equal(shouldRejectOnHeavyFailure({ fileName: "notes.txt" }), false);
  assert.equal(isHeavyParseTooShort(10), true);
  assert.equal(isHeavyParseTooShort(200), false);

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
