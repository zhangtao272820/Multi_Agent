/**
 * 查询学习闭环：经验回放、失败归因、供 NLU/SQL 阶段注入的提示块。
 * 对标总管 unifiedLearning，DB 侧聚焦「问句 → 正确 SQL 路径」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { persistDbLearningSignal, readDbLearningSignalsSync, signalsFilePath } from "./learning_signal_store";
import { persistDbExperience, readDbExperienceForRecall } from "./experience_store";
import { clipText } from "./nlu/text";
import type { QueryPath } from "./query_metrics";
import type { EmbeddingClientConfig } from "./agent";
import { getDbAgentBlueprintEnv } from "./db_agent_env";
import { clearExperienceVectors, getExperienceVectorSummary, indexExperienceVector, recallByVectorSimilarity } from "./experience_vectors";
import { dbExperienceBlueprintEligible, resolveDbIntentRagBlueprintDomain } from "./nlu/dbIntentRagDomain";
import { findPromptHygieneViolations } from "#agent-shared/promptHygiene";

export type DbLearningSignal = {
  ts: string;
  question: string;
  question_norm: string;
  path: QueryPath;
  ok: boolean;
  empty?: boolean;
  data_domain?: string;
  intent?: string;
  tables?: string[];
  ms?: number;
  reason?: string;
  feedback?: number;
};

export type DbExperienceEntry = {
  ts: string;
  question_norm: string;
  path: QueryPath;
  data_domain?: string;
  blueprint_domain?: string;
  tables?: string[];
  hint: string;
};

function dataDir() {
  const dir = join(process.cwd(), ".data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function signalsFile() {
  return join(dataDir(), "db-learning-signals.jsonl");
}

function experienceFile() {
  return join(dataDir(), "db-query-experience.jsonl");
}

export function normalizeQuestionKey(question: string): string {
  return String(question ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，,。.;；:：!?？]/g, "")
    .slice(0, 120);
}

export function recordLearningSignal(
  sig: Omit<DbLearningSignal, "ts" | "question_norm"> & { question: string },
  opts?: { embeddingConfig?: EmbeddingClientConfig },
) {
  const row: DbLearningSignal = {
    ...sig,
    ts: new Date().toISOString(),
    question_norm: normalizeQuestionKey(sig.question),
  };
  void persistDbLearningSignal(row);
  if (sig.ok && !sig.empty) {
    const hint = buildExperienceHint(row);
    if (hint) {
      const exp: DbExperienceEntry = {
        ts: row.ts,
        question_norm: row.question_norm,
        path: row.path,
        data_domain: row.data_domain,
        blueprint_domain: getDbAgentBlueprintEnv().domain,
        tables: row.tables,
        hint,
      };
      void persistDbExperience(exp);
      if (opts?.embeddingConfig) {
        void indexExperienceVector({
          question: sig.question,
          hint: exp.hint,
          path: row.path,
          data_domain: row.data_domain,
          blueprint_domain: exp.blueprint_domain,
          tables: row.tables,
          embeddingConfig: opts.embeddingConfig,
        }).catch(() => {});
      }
    }
  }
}

function buildExperienceHint(sig: DbLearningSignal): string {
  const parts: string[] = [];
  if (sig.data_domain) parts.push(`数据域=${sig.data_domain}`);
  if (sig.path) parts.push(`成功路径=${sig.path}`);
  if (sig.tables?.length) parts.push(`常用表=${sig.tables.join("、")}`);
  return parts.join("；");
}

function readJsonlLines<T>(file: string, maxLines = 400): T[] {
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const slice = lines.slice(-maxLines);
    const out: T[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

function overlapScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const setA = new Set(a.split(""));
  const setB = new Set(b.split(""));
  let inter = 0;
  for (const c of setA) if (setB.has(c)) inter += 1;
  return inter / Math.max(setA.size, setB.size, 1);
}

function experienceRecallEligible(e: DbExperienceEntry): boolean {
  const active = resolveDbIntentRagBlueprintDomain();
  if (!dbExperienceBlueprintEligible(e.blueprint_domain, active)) return false;
  if (findPromptHygieneViolations(e.question_norm).length) return false;
  return true;
}

function recallSimilarExperienceScored(question: string, limit = 3) {
  const key = normalizeQuestionKey(question);
  if (!key) return { hits: [] as DbExperienceEntry[], bestScore: 0 };
  const all = readDbExperienceForRecall(500).filter((e) => experienceRecallEligible(e));
  const scored = all
    .map((e) => ({ e, s: overlapScore(key, e.question_norm) }))
    .filter((x) => x.s >= 0.45)
    .sort((a, b) => b.s - a.s);
  const seen = new Set<string>();
  const hits: DbExperienceEntry[] = [];
  for (const { e } of scored) {
    const k = `${e.path}|${e.hint}`;
    if (seen.has(k)) continue;
    seen.add(k);
    hits.push(e);
    if (hits.length >= limit) break;
  }
  return { hits, bestScore: scored[0]?.s ?? 0 };
}

/** 检索与当前问句相近的成功经验（n-gram + 可选向量语义，供 plan/SQL 阶段注入）。 */
export async function recallSimilarExperienceAsync(
  question: string,
  limit = 3,
  embeddingConfig?: EmbeddingClientConfig,
): Promise<DbExperienceEntry[]> {
  const key = normalizeQuestionKey(question);
  if (!key) return [];

  const env = getDbAgentBlueprintEnv();
  const { hits: ngramHits, bestScore } = recallSimilarExperienceScored(question, limit);
  if (!env.enableVectorExperience || !embeddingConfig?.openaiApiKey) {
    return ngramHits;
  }

  const ngramStrong =
    ngramHits.length >= 2 ||
    (ngramHits.length >= 1 && bestScore >= env.vectorNgramStrongScore);
  if (env.vectorRecallOnlyWhenNgramWeak && ngramStrong) {
    return ngramHits;
  }

  const vectorHits = await recallByVectorSimilarity(question, embeddingConfig, limit);
  const seen = new Set<string>();
  const merged: DbExperienceEntry[] = [];
  for (const e of [...vectorHits, ...ngramHits]) {
    const k = `${e.path}|${e.hint}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(e);
    if (merged.length >= limit) break;
  }
  return merged;
}

/** 同步 n-gram 召回（无向量 API 成本）。 */
export function recallSimilarExperience(question: string, limit = 3): DbExperienceEntry[] {
  return recallSimilarExperienceScored(question, limit).hits;
}

export async function formatExperienceBlockForAgentAsync(
  question: string,
  embeddingConfig?: EmbeddingClientConfig,
): Promise<string> {
  const env = getDbAgentBlueprintEnv();
  const hits = await recallSimilarExperienceAsync(question, 2, embeddingConfig);
  if (!hits.length) return "";
  const lines = [
    "[经验回放]（相似问句成功路径；仅供参考，勿照搬 SQL/表；与当前问句条件不一致时必须忽略，以当前问句为准）",
  ];
  for (const h of hits) {
    lines.push(`- ${h.hint}`);
  }
  return clipText(lines.join("\n"), env.experienceBlockMaxChars);
}

export function formatExperienceBlockForAgent(question: string): string {
  const env = getDbAgentBlueprintEnv();
  const hits = recallSimilarExperience(question, 2);
  if (!hits.length) return "";
  const lines = [
    "[经验回放]（相似问句成功路径；仅供参考，勿照搬 SQL/表；与当前问句条件不一致时必须忽略，以当前问句为准）",
  ];
  for (const h of hits) {
    lines.push(`- ${h.hint}`);
  }
  return clipText(lines.join("\n"), env.experienceBlockMaxChars);
}

export function getLearningSummary() {
  const signals = readJsonlLines<DbLearningSignal>(signalsFile(), 800);
  const total = signals.length;
  const ok = signals.filter((s) => s.ok && !s.empty).length;
  const empty = signals.filter((s) => s.empty).length;
  const byPath: Record<string, number> = {};
  for (const s of signals) {
    const k = String(s.path || "other");
    byPath[k] = (byPath[k] || 0) + 1;
  }
  return { total, ok, empty, okRate: total ? ok / total : 0, byPath, experienceCount: readJsonlLines(experienceFile(), 1).length };
}

export function applyFeedbackToSignal(question: string, score: number) {
  recordLearningSignal({
    question,
    path: "other",
    ok: score > 0,
    feedback: score,
    reason: "explicit_feedback",
  });
}

/** 该问句是否曾被用户标为不准确（用于跳过 SQL 模板/结构快路径） */
export function hasNegativeFeedbackForQuestion(question: string, maxLines = 400): boolean {
  const key = normalizeQuestionKey(question);
  if (!key) return false;
  const signals = readDbLearningSignalsSync(maxLines) as DbLearningSignal[];
  for (let i = signals.length - 1; i >= 0; i--) {
    const s = signals[i];
    if (s.question_norm !== key) continue;
    if (s.feedback === -1 || (s.reason === "explicit_feedback" && s.ok === false)) return true;
  }
  return false;
}

export function shouldBypassFastPathsForQuestion(question: string): boolean {
  return hasNegativeFeedbackForQuestion(question);
}

export function readLearningSignals(maxLines = 800): DbLearningSignal[] {
  return readDbLearningSignalsSync(maxLines) as DbLearningSignal[];
}

export function clearLearningData(tenantId?: string) {
  const tid = String(tenantId || "default").trim() || "default";
  for (const file of [signalsFile(), experienceFile(), signalsFilePath(tid)]) {
    try {
      writeFileSync(file, "", "utf8");
    } catch {
      /* ignore */
    }
  }
  void import("#agent-shared/agentPgClient")
    .then(({ agentPgQuery }) =>
      Promise.all([
        agentPgQuery(`DELETE FROM db_learning_signals WHERE tenant_id = $1`, [tid]),
        agentPgQuery(`DELETE FROM db_query_experience WHERE tenant_id = $1`, [tid]),
        agentPgQuery(`DELETE FROM db_route_stats WHERE tenant_id = $1`, [tid])
      ])
    )
    .catch(() => undefined);
  clearExperienceVectors();
}

export function getExperienceRecallSummary() {
  return getExperienceVectorSummary();
}
