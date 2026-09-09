/**
 * 多结构语料切分评测（契约）：条款/大纲/表+文/FAQ。
 * 断言「测试问题」所需关键证据同处一节或同 parent_text。
 * 不调 LLM、不连向量库。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document } from "@langchain/core/documents";
import {
  reconstructSourceTextFromChunks,
  splitDocumentsStructured,
  splitProseByStructure,
} from "../server/utils/chunk_text";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "structure");

type Case = {
  file: string;
  question: string;
  /** 这些短语必须出现在同一 section 或同一 parent_text */
  mustColocate: string[];
  /** 禁止与 mustColocate 同段的污染词（可选） */
  mustNotWith?: string[];
};

const CASES: Case[] = [
  {
    file: "01-md-articles-lists.md",
    question: "失能老人护理第十条要求提供哪些服务？",
    mustColocate: ["第十条", "翻身护理", "尿不湿", "营养餐"],
    mustNotWith: ["记忆训练", "第十一条"],
  },
  {
    file: "01-md-articles-lists.md",
    question: "半失能老人怎么训练？",
    mustColocate: ["第十一条", "记忆训练", "行走训练"],
    mustNotWith: ["翻身护理"],
  },
  {
    file: "02-plain-articles.txt",
    question: "发生火情怎么办？",
    mustColocate: ["第十条", "119", "切断电源"],
  },
  {
    file: "03-prose-plus-table.md",
    question: "完全失能老人每月补贴多少？",
    mustColocate: ["第二十条", "800"],
  },
  {
    file: "03-prose-plus-table.md",
    question: "护理员岗位补贴现行多少？",
    mustColocate: ["800 元", "护理员岗位补贴"],
  },
  {
    file: "04-cn-outline.txt",
    question: "新人入职要办哪些手续？",
    mustColocate: ["入职手续", "劳动合同", "门禁卡"],
  },
  {
    file: "05-faq.txt",
    question: "检索失败会怎样？",
    mustColocate: ["检索失败", "澄清"],
  },
  {
    file: "06-long-article.md",
    question: "超长第九十条失能明细有哪些？",
    mustColocate: ["第九十条", "翻身护理", "尿不湿", "营养餐", "心理支持"],
  },
];

function findCoveringBlob(blobs: string[], needles: string[]): string | undefined {
  return blobs.find((b) => needles.every((n) => b.includes(n)));
}

async function main() {
  assert.ok(fs.existsSync(FIXTURE_DIR), `missing fixtures: ${FIXTURE_DIR}`);

  for (const c of CASES) {
    const full = path.join(FIXTURE_DIR, c.file);
    const text = fs.readFileSync(full, "utf8");
    const parts = splitProseByStructure(text);
    const structured = await splitDocumentsStructured([
      new Document({ pageContent: text, metadata: { source: c.file } }),
    ]);

    const sectionHit = findCoveringBlob(parts, c.mustColocate);
    const parentBlobs = structured.map((d) => String(d.metadata?.parent_text ?? d.pageContent ?? ""));
    const parentHit = findCoveringBlob(parentBlobs, c.mustColocate);
    const childWithParent = structured.find((d) => {
      const parent = String(d.metadata?.parent_text ?? "");
      const body = String(d.pageContent ?? "");
      return c.mustColocate.every((n) => parent.includes(n) || body.includes(n));
    });

    assert.ok(
      sectionHit || parentHit || childWithParent,
      `[${c.file}] Q「${c.question}」证据未同块：need ${c.mustColocate.join(" + ")}；sections=${parts.length} children=${structured.length}`
    );

    const cover = sectionHit || parentHit || String(childWithParent?.metadata?.parent_text ?? childWithParent?.pageContent ?? "");
    if (c.mustNotWith?.length) {
      for (const bad of c.mustNotWith) {
        // 允许文档其它节出现；禁止与 mustColocate 同盖住的块内污染
        assert.ok(!cover.includes(bad), `[${c.file}] Q「${c.question}」同块污染「${bad}」`);
      }
    }

    // parent_text 应覆盖短条款全文（避免只有标题）
    const detailNeedle = c.mustColocate.find((n) => !/第.+条|入职手续|澄清/.test(n));
    if (detailNeedle) {
      const kids = structured.filter((d) => String(d.pageContent ?? "").includes(detailNeedle));
      for (const k of kids) {
        const parent = String(k.metadata?.parent_text ?? "");
        if (parent) {
          assert.ok(
            parent.includes(detailNeedle),
            `[${c.file}] child 命中「${detailNeedle}」但 parent_text 缺失该明细`
          );
        }
      }
    }
  }

  // 破碎 chunk 重建 + demix（模拟旧 bug 数据）
  const broken = [
    "### 第十条 失能老人护理\n养老机构应当为失能老人提供以下服务：\n1. 每日翻身护理不少于 6 次，预防压疮\n1. 设置记忆训练活动，每日不少于 1 小时\n2. 每 2 小时检查一次尿不湿，保持清洁干燥\n2. 每日协助行走训练不少于 20 分钟\n3. 每日进行肢体被动活动不少于 30 分钟\n4. 提供个性化营养餐，根据医嘱调整饮食",
    "### 第十一条 半失能老人护理\n半失能老人护理标准：",
  ];
  const rebuilt = reconstructSourceTextFromChunks(broken);
  const rebuiltParts = splitProseByStructure(rebuilt);
  const a10 = rebuiltParts.find((p) => p.includes("第十条") && p.includes("失能老人护理"));
  const a11 = rebuiltParts.find((p) => p.includes("第十一条"));
  assert.ok(a10?.includes("翻身护理") && a10.includes("尿不湿"), "demix 后第十条保留失能明细");
  assert.ok(a10 && !a10.includes("记忆训练"), "demix 后第十条不含半失能明细");
  assert.ok(a11?.includes("记忆训练") || a11?.includes("行走训练"), "demix 后第十一条拿到半失能列表");

  console.log(`smoke-rag-structure-corpus OK: ${CASES.length} questions × fixtures`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
