/**
 * 结构切分契约：条款下「1. 2. 3.」明细不得拆成孤儿块；reindex 重建须挂回条款。
 * 对照用户反馈：第十条只命中标题、明细在别处。不调 LLM、不连库。
 */
import assert from "node:assert/strict";
import {
  mergeOrphanNumberedListParts,
  reconstructSourceTextFromChunks,
  splitProseByStructure,
} from "../server/utils/chunk_text";

function main() {
  const article = [
    "### 第十条 失能老人护理",
    "养老机构应当为失能老人提供以下服务：",
    "1. 每日翻身护理不少于 6 次，预防压疮",
    "2. 每 2 小时检查一次尿不湿，保持清洁干燥",
    "3. 每日进行肢体被动活动不少于 30 分钟",
    "4. 提供个性化营养餐，根据医嘱调整饮食",
    "",
    "### 第十一条 半失能老人护理",
    "半失能老人护理标准：",
    "1. 每日协助洗漱",
  ].join("\n");

  const parts = splitProseByStructure(article);
  assert.ok(parts.length >= 2, `expected >=2 sections, got ${parts.length}`);
  const art10 = parts.find((p) => p.includes("第十条") && p.includes("失能老人护理"));
  assert.ok(art10, "missing 第十条 section");
  assert.ok(art10!.includes("翻身护理"), "第十条 must keep 翻身明细");
  assert.ok(art10!.includes("尿不湿"), "第十条 must keep 尿不湿明细");
  assert.ok(art10!.includes("营养餐"), "第十条 must keep 营养餐明细");
  assert.ok(!art10!.includes("第十一条"), "第十条 section must not swallow 第十一条");

  const art11 = parts.find((p) => p.includes("第十一条"));
  assert.ok(art11?.includes("协助洗漱"), "第十一条 keeps its own list");

  // 模拟旧切分产物：标题与 1. 拆开；两组列表（第十条 / 第十一条）
  const broken = [
    "### 第十一条 半失能老人护理\n半失能老人护理标准：",
    "### 第十条 失能老人护理\n养老机构应当为失能老人提供以下服务：",
    "1. 每日翻身护理不少于 6 次，预防压疮",
    "2. 每 2 小时检查一次尿不湿，保持清洁干燥",
    "3. 每日进行肢体被动活动不少于 30 分钟",
    "4. 提供个性化营养餐，根据医嘱调整饮食",
    "1. 设置记忆训练活动，每日不少于 1 小时",
    "2. 每日协助行走训练不少于 20 分钟",
  ];
  const rebuilt = reconstructSourceTextFromChunks(broken);
  assert.ok(rebuilt.includes("翻身护理"), "reconstruct keeps 翻身");
  const rebuiltParts = splitProseByStructure(rebuilt);
  const rebuilt10 = rebuiltParts.find((p) => /第十条/.test(p) && /失能老人护理/.test(p) && !/半失能/.test(p.split("\n")[0] ?? ""));
  assert.ok(rebuilt10, "reconstruct yields 第十条");
  assert.ok(
    rebuilt10!.includes("翻身护理") && rebuilt10!.includes("尿不湿"),
    "明细必须挂在第十条而非第十一条"
  );
  assert.ok(!rebuilt10!.includes("记忆训练"), "半失能明细不得误挂第十条");
  const rebuilt11 = rebuiltParts.find((p) => /第十一条/.test(p));
  assert.ok(rebuilt11?.includes("记忆训练"), "第十一条应拿到第二组列表");

  const merged = mergeOrphanNumberedListParts([
    "### 第十条 失能老人护理\n养老机构应当为失能老人提供以下服务：",
    "1. 每日翻身护理不少于 6 次，预防压疮",
    "2. 每 2 小时检查一次尿不湿，保持清洁干燥",
  ]);
  assert.equal(merged.length, 1);
  assert.ok(merged[0]!.includes("翻身") && merged[0]!.includes("尿不湿"));

  console.log("smoke-rag-chunk-article-list OK: structure keeps 第十条+明细 together");
}

main();
