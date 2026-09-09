/**
 * 契约：同 content_hash 默认跳过重嵌；forceReembed 必须绕过。
 * 不调 LLM、不连库。
 */
import assert from "node:assert/strict";
import { hashCorpusText, shouldSkipReembed } from "../server/utils/ingest_meta";

/** 与 processDocument 闸门一致：!force && shouldSkipReembed */
function willSkipReembed(
  existingHash: string | undefined | null,
  nextHash: string,
  forceReembed?: boolean
): boolean {
  return !forceReembed && shouldSkipReembed(existingHash, nextHash);
}

function main() {
  const h = hashCorpusText("### 第十条\n1. 翻身护理\n2. 尿不湿");
  assert.equal(willSkipReembed(h, h, false), true, "same hash without force → skip");
  assert.equal(willSkipReembed(h, h, undefined), true, "same hash default → skip");
  assert.equal(willSkipReembed(h, h, true), false, "same hash + forceReembed → must re-embed");
  assert.equal(willSkipReembed(h, hashCorpusText("other"), false), false, "hash change → re-embed");
  assert.equal(willSkipReembed(undefined, h, false), false, "missing existing → re-embed");

  // Upload 表单真值解析（与 upload.post.ts 对齐）
  const parseForce = (raw: string) => /^(1|true|yes|on)$/i.test(String(raw || "").trim());
  assert.equal(parseForce("1"), true);
  assert.equal(parseForce("true"), true);
  assert.equal(parseForce("YES"), true);
  assert.equal(parseForce("0"), false);
  assert.equal(parseForce(""), false);

  console.log("smoke-rag-force-reembed OK");
}

main();
