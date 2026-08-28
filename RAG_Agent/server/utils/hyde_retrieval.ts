/**
 * L1：HyDE — 假想文档嵌入检索辅助（事实可不准，仅用于 embedding 召回）。
 */
import { createRagChatOpenAI } from "./rag_chat_openai";
import { getRagAgentEnv, ragFastJudgeModelName } from "./rag_agent_env";

export type HydeGenerateResult = {
  hypotheticalDoc: string;
  source: "llm" | "skipped";
};

/** 纯函数：RRF 合并两路排名（key → rank 从 1 起） */
export function fuseRankMapsRrf(
  maps: Array<{ ranks: Map<string, number>; weight: number }>,
  k = 60
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const lane of maps) {
    for (const [key, rank] of lane.ranks) {
      if (!Number.isFinite(rank) || rank < 1) continue;
      const add = lane.weight * (1 / (k + rank));
      scores.set(key, (scores.get(key) ?? 0) + add);
    }
  }
  return scores;
}

export function ranksFromScoreMap(scoreMap: Map<string, number>): Map<string, number> {
  const ordered = Array.from(scoreMap.entries()).sort((a, b) => b[1] - a[1]);
  const ranks = new Map<string, number>();
  ordered.forEach(([key], i) => ranks.set(key, i + 1));
  return ranks;
}

export async function generateHypotheticalDocument(params: {
  query: string;
  intent?: string;
}): Promise<HydeGenerateResult> {
  const q = String(params.query || "").trim();
  if (!q) return { hypotheticalDoc: "", source: "skipped" };
  const env = getRagAgentEnv();
  const model = createRagChatOpenAI({
    modelName: env.expansionModel || ragFastJudgeModelName(),
    temperature: 0.2,
  });
  const prompt = [
    "你在辅助检索。请写一段 120～220 字的「假想制度/手册摘录」，文体像企业内部规范，用于向量检索。",
    "要求：不要声称来源；不要编造具体对外公开的真实法规编号；围绕用户问题主题写条款口吻。",
    "只输出正文，不要标题或解释。",
    `用户问题：${q}`,
    params.intent ? `问题类型：${params.intent}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const res = await model.invoke(prompt);
    const text = String((res as { content?: unknown })?.content ?? "").trim().slice(0, 800);
    if (text.length < 40) return { hypotheticalDoc: "", source: "skipped" };
    return { hypotheticalDoc: text, source: "llm" };
  } catch (e) {
    console.warn("[HyDE] generate failed:", e);
    return { hypotheticalDoc: "", source: "skipped" };
  }
}
