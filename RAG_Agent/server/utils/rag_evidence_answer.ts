/**
 * 检索证据 → 回答：生成前证据优选、负向回答检测、证据直出兜底（通用，非领域词表）。
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createRagChatOpenAI } from "./rag_chat_openai";
import { getRagAgentEnv, ragFastJudgeModelName } from "./rag_agent_env";
import type { EvidenceItem } from "./retrieval_shared";
import {
  scoreTextOverlap,
  prioritizeEvidenceBySubQueries,
  distinctiveSubQueryTerms,
  listUncoveredSubQueries,
  areNearDuplicatePolicyDocNames,
} from "./retrieval_shared";

export { prioritizeEvidenceBySubQueries } from "./retrieval_shared";
import { filterTextsRelevantToQuery } from "./preference_context_gate";
import {
  buildEvidenceOnlyFallback,
  checkAnswerGroundedInEvidence,
} from "./citation_guard";
import {
  RAG_UNTRUSTED_POLICY,
  wrapRagUntrustedContext,
} from "./rag_playbook_prompts";

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
  "未提及",
  "没有提及",
  "未包含",
  "没有写明",
  "未写明",
  "文档未写",
  "文档中没有",
  "暂时没有",
];

/** 假未提及改写用（含「未规定」；不进全局 miss 检测，避免 §10 合法拒答误触发） */
const ABSENT_CLAIM_MARKERS = [
  ...NEGATIVE_ANSWER_MARKERS,
  "未规定",
  "没有规定",
];

export function answerLooksLikeRetrievalMiss(answer: string): boolean {
  const a = String(answer ?? "").trim();
  if (!a || a.length < 8) return true;
  return NEGATIVE_ANSWER_MARKERS.some((m) => a.includes(m));
}

/**
 * 证据已覆盖某子问时，删除对该子题的「未提及/未规定」假阴性句。
 * 「规范未规定」仅当证据未覆盖该子问时才允许保留。
 */
export function rewriteContradictoryAbsentClaims(
  answer: string,
  evidence: EvidenceItem[],
  subQueries: string[],
): string {
  const raw = String(answer ?? "").trim();
  if (!raw || !evidence.length) return raw;
  const parts = (subQueries || []).map((q) => String(q || "").trim()).filter((q) => q.length >= 4);
  if (parts.length < 2) return raw;

  const corpus = evidence.map((e) => String(e.content ?? "")).join("\n");
  const sentences = raw.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 1) return raw;

  const kept: string[] = [];
  for (const sent of sentences) {
    const isNeg = ABSENT_CLAIM_MARKERS.some((m) => sent.includes(m));
    if (!isNeg) {
      kept.push(sent);
      continue;
    }
    // 否定句若点到「已被证据覆盖」的子题主题 → 丢弃该句
    let contradictsCovered = false;
    for (const sq of parts) {
      const terms = distinctiveSubQueryTerms(sq, parts);
      const covered = terms.some((t) => t.length >= 2 && corpus.includes(t));
      if (!covered) continue;
      if (terms.some((t) => t.length >= 2 && sent.includes(t))) {
        contradictsCovered = true;
        break;
      }
    }
    if (!contradictsCovered) kept.push(sent);
  }

  const joined = kept.join("").trim();
  if (joined.length >= 8) return joined;
  return raw;
}

/** 子问仍未覆盖时，不得用「规范未规定」冒充拒答；改为检索未覆盖提示 */
export function appendUncoveredSubQueryHint(
  answer: string,
  evidence: EvidenceItem[],
  subQueries: string[],
): string {
  const uncovered = listUncoveredSubQueries(evidence, subQueries);
  if (!uncovered.length) return String(answer ?? "").trim();
  const base = String(answer ?? "").trim();
  const hint = `另有子问题检索未覆盖（${uncovered
    .map((q) => q.slice(0, 24))
    .join("；")}），请换问法或指定章节，勿将此视为「规范未规定」。`;
  if (!base) return hint;
  if (base.includes("检索未覆盖")) return base;
  return `${base}\n\n${hint}`;
}

/** 有证据时剥离开头假「未找到」句，保留实质回答（确定性，非用户原话 regex 路由） */
export function stripContradictoryMissWhenEvidencePresent(
  answer: string,
  evidenceCount: number,
): string {
  const raw = String(answer ?? "").trim();
  if (!raw || evidenceCount <= 0) return raw;
  if (!answerLooksLikeRetrievalMiss(raw)) return raw;

  const paragraphs = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 2) {
    const lead = paragraphs[0]!;
    if (answerLooksLikeRetrievalMiss(lead) && lead.length < 180) {
      const body = paragraphs.slice(1).join("\n\n").trim();
      if (body.length >= 20 && !answerLooksLikeRetrievalMiss(body)) return body;
    }
  }

  const sentences = raw.split(/(?<=[。！？!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length >= 2 && answerLooksLikeRetrievalMiss(sentences[0]!)) {
    const rest = sentences.slice(1).join(" ").trim();
    if (rest.length >= 20 && !answerLooksLikeRetrievalMiss(rest)) return rest;
  }

  return raw;
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
  opts?: { forceMultiSource?: boolean },
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
  // 近义政策对（验收 md ↔ 规范 docx）：禁止分数略胜就塌成单源
  const nearDupPolicyPair =
    Boolean(dominant && runner) &&
    areNearDuplicatePolicyDocNames(String(dominant![0]), String(runner![0]));
  // 仅当主导源显著领先时塌缩；假阴性再检可 forceMultiSource 禁止塌缩
  const dominantWins =
    !opts?.forceMultiSource &&
    !nearDupPolicyPair &&
    Boolean(dominant) &&
    dominant![1].total > 0 &&
    (!runner || dominant![1].total >= runner[1].total * 1.35);

  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  const pushItem = (item: EvidenceItem) => {
    const key = `${item.source}:${String(item.content ?? "").slice(0, 48)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push(item);
    return true;
  };

  if (dominantWins) {
    for (const item of dominant![1].rows) {
      pushItem(item);
      if (out.length >= max) break;
    }
  } else if (sourceRank.length >= 2 || opts?.forceMultiSource) {
    const queues = sourceRank.map(([, v]) => [...v.rows]);
    let guard = 0;
    while (out.length < max && queues.some((q) => q.length) && guard < max * 8) {
      guard += 1;
      for (const q of queues) {
        if (out.length >= max) break;
        while (q.length) {
          const item = q.shift()!;
          if (pushItem(item)) break;
        }
      }
    }
  } else {
    for (const row of scored) {
      pushItem(row.item);
      if (out.length >= max) break;
    }
  }
  return out.length ? out : list.slice(0, max);
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
  RAG_UNTRUSTED_POLICY,
  "规则：",
  "1) 用户问法与文档字段/文件名表述不同时，只要证据语义相关就必须作答（抽象问法 ↔ 具体字段名视为同一主题）；",
  "2) 只写证据中可核对的事实（数字、日期、实体），不要编造；",
  "3) 禁止写「未找到/暂无/无法确定」——调用方已确认存在相关证据；",
  "4) 多子问题时逐子问题作答；证据已有某子题条款时禁止对该子题写「文档未提到」；",
  "5) 最后一行单独写：参考：<文档文件名>（多个用顿号）；只列实际用到的来源；",
  "6) 不要提检索过程、路由或 Skill。",
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
  const wrappedEvidence = wrapRagUntrustedContext(
    "rag_evidence",
    context.slice(0, env.maxContextChars),
    env.maxContextChars + 200,
  );
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
        wrappedEvidence,
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
  /** 复合问子句：用于禁假未提及 / 未覆盖提示 */
  subQueries?: string[];
}): Promise<string> {
  let answer = String(input.draftAnswer ?? "").trim();
  if (!input.evidence.length) return answer;
  const subs = input.subQueries || [];
  answer = stripContradictoryMissWhenEvidencePresent(answer, input.evidence.length);
  if (subs.length >= 2) {
    answer = rewriteContradictoryAbsentClaims(answer, input.evidence, subs);
  }
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
  if (!env.enableCitationGuard) {
    return subs.length >= 2
      ? appendUncoveredSubQueryHint(answer, input.evidence, subs)
      : answer;
  }

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
  answer = stripContradictoryMissWhenEvidencePresent(answer, input.evidence.length);
  if (subs.length >= 2) {
    answer = rewriteContradictoryAbsentClaims(answer, input.evidence, subs);
    answer = appendUncoveredSubQueryHint(answer, input.evidence, subs);
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
