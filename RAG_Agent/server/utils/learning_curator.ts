/**
 * P4 Curator：汇总学习状态；默认只写 shadow / 出候选，不自动晋级。
 */
import { getLearningSummary } from "./rag_learning";
import { getRagExperienceSummary } from "./experience_vectors";
import {
  autoPromoteEligiblePatchesVerified,
  getPromptEvolutionSummary,
  listPromptPatches,
} from "./prompt_evolution";
import { readRagLearningSignalsSync } from "../../utils/learning_signal_store";
import { getUserPreferencesSummary } from "./user_preferences";
import { listEvolvedHints } from "./rag_evolved_config";
import { analyzeAbSignificance, type AbSignificanceReport } from "./ab_significance";
import { getRagAgentEnv } from "./rag_agent_env";
import { resolveCurateAutoPromote } from "#agent-shared/evolutionPromotePolicy";

export type RagCuratorReport = {
  ts: string;
  promotedHints: string[];
  verifyGate?: Awaited<ReturnType<typeof import("#agent-shared/evolutionVerify").verifyBeforePromote>>;
  topFailureModes: Array<{ mode: string; count: number }>;
  abSignificance: AbSignificanceReport;
  abAutoPromoted: boolean;
  shadowPatches: number;
  promotableRemaining: number;
  evolvedHintCount: number;
  learning: ReturnType<typeof getLearningSummary>;
  experience: ReturnType<typeof getRagExperienceSummary>;
  evolution: ReturnType<typeof getPromptEvolutionSummary>;
  userPreferences: ReturnType<typeof getUserPreferencesSummary>;
  autoPromoteAllowed?: boolean;
};

function scanTopFailureModes() {
  const signals = readRagLearningSignalsSync(400).filter((s) => Number(s.score) < 0.5);
  const counts = new Map<string, number>();
  for (const s of signals) {
    const comment = String(s.comment || "").trim();
    let mode = "weak_evidence";
    if (comment.includes("来源")) mode = "source_misroute";
    else if (comment.includes("假阴") || comment.includes("没搜到")) mode = "false_negative";
    else if (comment.includes("幻觉") || comment.includes("不准")) mode = "hallucination";
    counts.set(mode, (counts.get(mode) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([mode, count]) => ({ mode, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

export async function runRagLearningCurator(opts?: {
  autoPromote?: boolean;
  minHits?: number;
  promoteFromAb?: boolean;
}): Promise<RagCuratorReport> {
  const env = getRagAgentEnv();
  const allowAuto = resolveCurateAutoPromote(opts?.autoPromote);
  const abSignificance = analyzeAbSignificance();
  const abAutoPromoted =
    allowAuto &&
    opts?.promoteFromAb !== false &&
    env.enableAbAutoPromote &&
    abSignificance.significant;

  let promotedHints: string[] = [];
  let verifyGate: RagCuratorReport["verifyGate"];
  if (allowAuto) {
    const abGated = Boolean(opts?.promoteFromAb && env.enableAbAutoPromote);
    if (!abGated || abAutoPromoted) {
      const verified = await autoPromoteEligiblePatchesVerified(opts?.minHits);
      promotedHints = verified.promoted;
      verifyGate = verified.verify;
    }
  }

  const evolution = getPromptEvolutionSummary();

  return {
    ts: new Date().toISOString(),
    promotedHints,
    verifyGate,
    topFailureModes: scanTopFailureModes(),
    abSignificance,
    abAutoPromoted: Boolean(abAutoPromoted && promotedHints.length),
    shadowPatches: listPromptPatches().filter((p) => !p.promotedAt).length,
    promotableRemaining: evolution.promotableCount,
    evolvedHintCount: listEvolvedHints().length,
    learning: getLearningSummary(),
    experience: getRagExperienceSummary(),
    evolution,
    userPreferences: getUserPreferencesSummary(),
    autoPromoteAllowed: allowAuto,
  };
}

/** 反馈后轻量：默认不晋级（enableAutoCurateOnFeedback 现默认 false） */
export function runLightweightCuratorOnFeedback() {
  const env = getRagAgentEnv();
  if (!env.enableAutoCurateOnFeedback) return;
  if (!resolveCurateAutoPromote(true)) return;
  void autoPromoteEligiblePatchesVerified()
    .then(() => undefined)
    .catch(() => undefined);
}
