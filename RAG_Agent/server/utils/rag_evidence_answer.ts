/**
 * 检索证据 → 回答：生成前证据优选、负向回答检测、证据直出兜底（通用，非领域词表）。
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createRagChatOpenAI } from "./rag_chat_openai";
import { getRagAgentEnv, ragFastJudgeModelName } from "./rag_agent_env";
import type { EvidenceItem } from "./retrieval_shared";
import { scoreTextOverlap, scoreDocByQueryTerms, tokenizeForKeywordSearch } from "./retrieval_shared";
import { filterTextsRelevantToQuery } from "./preference_context_gate";
import {
  buildEvidenceOnlyFallback,
  checkAnswerGroundedInEvidence,
} from "./citation_guard";

/** 模型常误判「无结果」的表述（字符串包含检测，非业务 regex 扩词） */
const NEGATIVE_ANSWER_MARKERS = [
  "暂未找到",
  "未找到",
  "没有找到",
  "未检索到",
  "无法找到",
  "查不到",
  "没有相关",
  "无相关",
  "文档里没有",
  "文档中未",
  "知识库中未",
  "库里暂未",
  "无法确定",
  "没有更多关于",
];

export function answerLooksLikeRetrievalMiss(answer: string): boolean {
  const a = String(answer ?? "").trim();
  if (!a || a.length < 8) return true;
  return NEGATIVE_ANSWER_MARKERS.some((m) => a.includes(m));
}

function scoreEvidenceItem(queries: string[], item: EvidenceItem): number {
  const content = String(item.content ?? "");
  const source = String(item.source ?? "");
  let score = 0;
  for (const q of queries) {
    if (!q) continue;
    score += scoreTextOverlap(q, content) * 2;
    score += scoreTextOverlap(q, source) * 3;
  }
  return score;
}

/** 按问句相关度重排证据；多文档库时优先与问句最相关的来源簇 */
export function prioritizeEvidenceForGeneration(
  query: string,
  effectiveQuery: string,
  items: EvidenceItem[],
  max = 6,
  docCatalog?: { name: string; summary?: string }[],
): EvidenceItem[] {
  const list = (items || []).filter((e) => String(e.content ?? "").trim().length >= 4);
  if (!list.length) return [];
  const queries = [effectiveQuery, query].map((s) => String(s || "").trim()).filter(Boolean);

  const summaryBoostBySource = new Map<string, number>();
  for (const doc of docCatalog ?? []) {
    const name = String(doc.name ?? "");
    if (!name) continue;
    let boost = 0;
    for (const q of queries) {
      boost += scoreTextOverlap(q, String(doc.summary ?? "")) * 5;
      boost += scoreTextOverlap(q, name) * 4;
    }
    summaryBoostBySource.set(name, boost);
  }

  const scored = list.map((item) => {
    const src = String(item.source ?? "");
    let score = scoreEvidenceItem(queries, item);
    for (const [docName, boost] of summaryBoostBySource) {
      if (src.includes(docName) || docName.includes(src)) score += boost;
    }
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return list.slice(0, max);

  const bySource = new Map<string, { total: number; rows: EvidenceItem[] }>();
  for (const row of scored) {
    const src = String(row.item.source ?? "unknown");
    const prev = bySource.get(src) ?? { total: 0, rows: [] };
    prev.total += row.score;
    prev.rows.push(row.item);
    bySource.set(src, prev);
  }
  const sourceRank = [...bySource.entries()].sort((a, b) => b[1].total - a[1].total);
  const dominant = sourceRank[0];
  const runner = sourceRank[1];
  const dominantWins =
    dominant &&
    dominant[1].total > 0 &&
    (!runner || dominant[1].total >= runner[1].total * 1.35 || top.score >= 0.08);

  const pool = dominantWins ? dominant![1].rows : scored.map((s) => s.item);
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const item of pool) {
    const key = `${item.source}:${String(item.content ?? "").slice(0, 48)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out.length ? out : list.slice(0, max);
}

/** 复合问句：每个子问句至少保留 1 条证据，避免 dominant source 挤掉另一主题 */
export function prioritizeEvidenceBySubQueries(
  subQueries: string[],
  items: EvidenceItem[],
  max = 6,
): EvidenceItem[] {
  const list = (items || []).filter((e) => String(e.content ?? "").trim().length >= 4);
  if (!list.length) return [];
  const parts = subQueries.map((q) => String(q || "").trim()).filter((q) => q.length >= 4);
  if (parts.length < 2) {
    return list.slice(0, max);
  }
  const perSub = Math.max(1, Math.floor(max / parts.length));
  const picked: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const sq of parts) {
    const terms = tokenizeForKeywordSearch(sq);
    const ranked = list
      .map((item) => ({
        item,
        score: scoreDocByQueryTerms(String(item.content ?? ""), terms),
      }))
      .sort((a, b) => b.score - a.score);
    let added = 0;
    for (const { item, score } of ranked) {
      if (score <= 0 && added > 0) continue;
      const key = `${item.source}:${String(item.content ?? "").slice(0, 48)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(item);
      added += 1;
      if (added >= perSub) break;
    }
  }
  if (!picked.length) return list.slice(0, max);
  for (const item of list) {
    if (picked.length >= max) break;
    const key = `${item.source}:${String(item.content ?? "").slice(0, 48)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(item);
  }
  return picked.slice(0, max);
}

/** 生成前：模型筛掉与问句明显无关的证据块（多文档库防串台） */
export async function focusEvidenceForGeneration(
  query: string,
  effectiveQuery: string,
  items: EvidenceItem[],
  max = 6,
  docCatalog?: { name: string; summary?: string }[],
): Promise<EvidenceItem[]> {
  const prioritized = prioritizeEvidenceForGeneration(
    query,
    effectiveQuery,
    items,
    max + 2,
    docCatalog,
  );
  if (prioritized.length <= 2) return prioritized;
  const focusQuery = [effectiveQuery, query].filter(Boolean).join("\n");
  const labeled = prioritized.map(
    (e, i) => `[${i}] [来源:${String(e.source ?? "unknown")}] ${String(e.content ?? "").slice(0, 900)}`,
  );
  try {
    const kept = await filterTextsRelevantToQuery(focusQuery, labeled);
    if (!kept.length) return prioritized.slice(0, max);
    const keptSet = new Set(kept);
    const filtered = prioritized.filter((_, i) => keptSet.has(labeled[i]!));
    return (filtered.length ? filtered : prioritized).slice(0, max);
  } catch {
    return prioritized.slice(0, max);
  }
}

const EXTRACT_SYSTEM = [
  "你是文档问答助手。仅根据【检索证据】回答【用户问题】，输出自然、口语化的中文。",
  "规则：",
  "1) 用户问法与文档字段/文件名表述不同时，只要证据语义相关就必须作答（抽象问法 ↔ 具体字段名视为同一主题）；",
  "2) 只写证据中可核对的事实（数字、日期、实体），不要编造；",
  "3) 禁止写「未找到/暂无/无法确定」——调用方已确认存在相关证据；",
  "4) 最后一行单独写：参考：<文档文件名>（多个用顿号）；",
  "5) 不要提检索过程、路由或 Skill。",
].join("\n");

/** 主生成误判「无结果」时，flash 从证据直出（通用兜底） */
export async function extractAnswerFromEvidence(input: {
  question: string;
  effectiveQuery: string;
  evidence: EvidenceItem[];
}): Promise<string> {
  const env = getRagAgentEnv();
  const items = input.evidence.slice(0, env.maxContextSnippets);
  const context = items
    .map((e) => `[内容] ${String(e.content ?? "").trim()}\n[来源] ${String(e.source ?? "unknown")}`)
    .join("\n\n");
  const model = createRagChatOpenAI({
    modelName: env.queryPlanModel ?? ragFastJudgeModelName(),
    maxTokens: 720,
  });
  const res = await model.invoke([
    new SystemMessage(EXTRACT_SYSTEM),
    new HumanMessage(
      [
        `【用户问题】${String(input.question || "").trim().slice(0, 400)}`,
        `【检索焦点】${String(input.effectiveQuery || input.question || "").trim().slice(0, 400)}`,
        `【检索证据】\n${context.slice(0, env.maxContextChars)}`,
      ].join("\n\n"),
    ),
  ]);
  return String(res.content ?? "").trim();
}

/** 流式主模型 + 证据兜底 + H5 citation guard */
export async function finalizeRagAnswerWithEvidenceGuard(input: {
  question: string;
  effectiveQuery: string;
  evidence: EvidenceItem[];
  draftAnswer: string;
}): Promise<string> {
  let answer = String(input.draftAnswer ?? "").trim();
  if (!input.evidence.length) return answer;
  if (answerLooksLikeRetrievalMiss(answer)) {
    try {
      const extracted = await extractAnswerFromEvidence({
        question: input.question,
        effectiveQuery: input.effectiveQuery,
        evidence: input.evidence,
      });
      if (extracted.length >= 12 && !answerLooksLikeRetrievalMiss(extracted)) {
        answer = extracted;
      }
    } catch (e) {
      console.warn("[EvidenceAnswerGuard] fallback failed:", e);
    }
  }

  const env = getRagAgentEnv();
  if (!env.enableCitationGuard) return answer;

  let grounded = checkAnswerGroundedInEvidence(answer, input.evidence);
  if (!grounded.ok && !answerLooksLikeRetrievalMiss(answer)) {
    try {
      const extracted = await extractAnswerFromEvidence({
        question: input.question,
        effectiveQuery: input.effectiveQuery,
        evidence: input.evidence,
      });
      if (extracted.length >= 12) {
        answer = extracted;
        grounded = checkAnswerGroundedInEvidence(answer, input.evidence);
      }
    } catch (e) {
      console.warn("[CitationGuard] re-extract failed:", e);
    }
  }
  if (!grounded.ok) {
    return buildEvidenceOnlyFallback(input.question || input.effectiveQuery, input.evidence, grounded.missing);
  }
  return answer;
}

export function buildGenerateQuestionForRag(input: {
  rawQuestion: string;
  effectiveQuery: string;
}): string {
  const raw = String(input.rawQuestion ?? "").trim();
  const eff = String(input.effectiveQuery ?? "").trim();
  if (!eff || eff === raw) return raw;
  return `${raw}\n（检索焦点：${eff}）`;
}
