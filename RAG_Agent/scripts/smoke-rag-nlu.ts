/**
 * RAG NLU smoke：意图 Playbook 召回 + 总管侧车 + 编排检索档位（纯函数，无 API）。
 * 用法：cd RAG_Agent && npm run smoke:nlu
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  splitCompoundQueries,
  type ManagerRagTaskPayload,
} from "../../shared/managerSubAgentProtocol.ts";
import { RAG_INTENT_PLAYBOOK } from "../server/utils/rag_intent_playbook.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function tokenBag(text: string): Set<string> {
  const norm = String(text || "").toLowerCase();
  const parts = norm.match(/[\u4e00-\u9fff]+|[a-z]+|\d+/g) || [];
  return new Set(parts.slice(0, 160));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function recallRagIntentPlaybook(query: string) {
  const q = String(query || "").trim();
  for (const entry of RAG_INTENT_PLAYBOOK) {
    for (const p of entry.paraphrases) {
      if (p.length >= 2 && q.includes(p)) {
        return { id: entry.id, score: 1, intent: entry.intent };
      }
    }
  }
  const bag = tokenBag(q);
  let best: { id: string; score: number; intent: string } | null = null;
  for (const entry of RAG_INTENT_PLAYBOOK) {
    for (const p of entry.paraphrases) {
      const score = jaccard(bag, tokenBag(p));
      if (!best || score > best.score) best = { id: entry.id, score, intent: entry.intent };
    }
  }
  return best && best.score >= 0.12 ? best : null;
}

function resolveOrchestratedMode(task: ManagerRagTaskPayload) {
  if (task.force_deep_retrieval) return "standard";
  if (String(task.scope_hint ?? "").trim().length > 80) return "standard";
  if ((task.sub_queries?.length ?? 0) >= 2) return "compound_fast";
  if (task.query_intent === "multi_part") return "compound_fast";
  return "fast";
}

const subs = splitCompoundQueries("月收入和月支出分别是多少，行走时长是多少");
assert(subs.length >= 2, `compound split failed: ${JSON.stringify(subs)}`);

const qmark = splitCompoundQueries(
  "护理员岗位补贴是每人每月多少？夜班津贴怎么算、有没有月上限？",
);
assert(qmark.length >= 2, `question-mark compound must split: ${JSON.stringify(qmark)}`);
assert(
  qmark.some((p) => p.includes("夜班")),
  `night-shift must be its own subquery: ${JSON.stringify(qmark)}`,
);

const mgrSubs = splitCompoundQueries("神能满足度压力测试和行走时长分别是多少");
assert(mgrSubs.length >= 2, `manager compound subs failed: ${JSON.stringify(mgrSubs)}`);

const task: ManagerRagTaskPayload = {
  source: "manager",
  lean_query: "神能满足度压力测试和行走时长分别是多少",
  sub_queries: mgrSubs,
  dialog_anchor: "用户上一轮问了足底压力，本轮追问两个指标分别是多少",
  query_intent: "multi_part",
  output_style: "manager_bullets",
};

const recall = recallRagIntentPlaybook("对比两份方案在申领门槛上的差异");
assert(recall?.intent === "comparison", `intent recall failed: ${JSON.stringify(recall)}`);

const goldenPath = join(dirname(fileURLToPath(import.meta.url)), "../eval/golden-rag-intent-paraphrase.json");
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
  cases: Array<{ id: string; user: string; expect: { intent: string; includes?: string[] } }>;
};
for (const c of golden.cases.slice(0, 2)) {
  assert(c.user.length >= 4, `${c.id}: golden user`);
  for (const inc of c.expect.includes ?? []) {
    assert(c.user.includes(inc), `${c.id}: includes ${inc}`);
  }
}

const modeCompound = resolveOrchestratedMode(task);
assert(modeCompound === "compound_fast", `mode compound expected, got ${modeCompound}`);

const modeDeep = resolveOrchestratedMode({ ...task, force_deep_retrieval: true });
assert(modeDeep === "standard", `mode deep expected, got ${modeDeep}`);

const ragNluSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../server/utils/rag_nlu.ts"), "utf8");
assert(!ragNluSrc.includes("recall.intent"), "playbook must not override intent from recall");
assert(ragNluSrc.includes("playbook 仅 hint"), "playbook hint-only comment missing");
assert(ragNluSrc.includes("buildOrchestratedRagQueryPlanFromManagerTask"), "RAG call-fusion builder");

console.log("smoke-rag-nlu: OK", {
  subs: subs.length,
  mgrSubs: mgrSubs.length,
  recall: recall?.id,
  modeCompound,
  modeDeep,
});
