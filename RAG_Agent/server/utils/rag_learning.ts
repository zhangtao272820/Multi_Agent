/**
 * RAG 学习闭环：从 feedback / metrics 信号提炼检索偏好（来源加权、相似问句提示）。
 * P0：合并 PG run 级 artifact confirmed/revoked 偏好。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { persistRagLearningSignal, readRagLearningSignalsSync, signalsFilePath as ragSignalsFilePath } from "../../utils/learning_signal_store";
import { loadRagArtifactPrefs } from "#agent-shared/artifactStore";

export type RagLearningSignal = {
  question: string;
  question_norm?: string;
  score: number;
  comment?: string;
  path?: string;
  source?: string;
  at: string;
};

export type RagRetrievalPreferences = {
  sourceBoosts: Record<string, number>;
  sourcePenalties: Record<string, number>;
  positiveQueries: string[];
  negativeQueries: string[];
  totalSignals: number;
  positiveCount: number;
  negativeCount: number;
};

let cachedPrefs: { at: number; prefs: RagRetrievalPreferences } | null = null;
let artifactPrefsCache: Awaited<ReturnType<typeof loadRagArtifactPrefs>> | null = null;
let artifactPrefsAt = 0;
const CACHE_TTL_MS = 30_000;

export async function refreshArtifactPrefsCache(force = false): Promise<void> {
  const now = Date.now();
  if (!force && artifactPrefsCache && now - artifactPrefsAt < CACHE_TTL_MS) return;
  artifactPrefsCache = await loadRagArtifactPrefs();
  artifactPrefsAt = now;
}

void refreshArtifactPrefsCache(true).catch(() => undefined);

function dataDir() {
  const dir = join(process.cwd(), ".data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function signalsFile() {
  return ragSignalsFilePath();
}

export function preferencesFile() {
  return join(dataDir(), "rag-route-preferences.json");
}

export function normalizeQuestionKey(question: string): string {
  return String(question ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，,。.;；:：!?？]/g, "")
    .slice(0, 120);
}

function readJsonlLines<T>(file: string, maxLines = 500): T[] {
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const slice = lines.slice(-maxLines);
    const out: T[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalizeQuestionKey(a).match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}/g) ?? []);
  const tb = new Set(normalizeQuestionKey(b).match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}/g) ?? []);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

export function buildRetrievalPreferences(): RagRetrievalPreferences {
  const signals = readRagLearningSignalsSync(600);
  const sourceBoosts: Record<string, number> = {};
  const sourcePenalties: Record<string, number> = {};
  const positiveQueries: string[] = [];
  const negativeQueries: string[] = [];
  let positiveCount = 0;
  let negativeCount = 0;

  for (const sig of signals) {
    const score = Number(sig.score);
    if (score === 1) {
      positiveCount++;
      if (sig.question) positiveQueries.push(sig.question.slice(0, 200));
      if (sig.source) sourceBoosts[sig.source] = (sourceBoosts[sig.source] ?? 0) + 1;
      if (sig.path === "document_query" && sig.comment) {
        const m = sig.comment.match(/来源[:：]\s*([^\s,，;；]+)/);
        if (m?.[1]) sourceBoosts[m[1]] = (sourceBoosts[m[1]] ?? 0) + 1;
      }
    } else if (score === -1) {
      negativeCount++;
      if (sig.question) negativeQueries.push(sig.question.slice(0, 200));
      if (sig.source) sourcePenalties[sig.source] = (sourcePenalties[sig.source] ?? 0) + 1;
    }
  }

  const prefs: RagRetrievalPreferences = {
    sourceBoosts,
    sourcePenalties,
    positiveQueries: positiveQueries.slice(-80),
    negativeQueries: negativeQueries.slice(-40),
    totalSignals: signals.length,
    positiveCount,
    negativeCount,
  };

  try {
    writeFileSync(preferencesFile(), JSON.stringify({ updatedAt: new Date().toISOString(), ...prefs }, null, 2), "utf8");
  } catch {
    /* ignore */
  }

  return prefs;
}

export function getRetrievalPreferences(force = false): RagRetrievalPreferences {
  const now = Date.now();
  if (!force && cachedPrefs && now - cachedPrefs.at < CACHE_TTL_MS) {
    return cachedPrefs.prefs;
  }
  const prefs = buildRetrievalPreferences();
  cachedPrefs = { at: now, prefs };
  return prefs;
}

export function getLearningHintsForQuestion(question: string): {
  boostedSources: string[];
  similarPositiveQueries: string[];
  sourceScoreAdjust: (source: string) => number;
} {
  const prefs = getRetrievalPreferences();
  const boostedSources = Object.entries(prefs.sourceBoosts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k]) => k);

  const similarPositiveQueries = prefs.positiveQueries
    .map((q) => ({ q, sim: tokenOverlap(question, q) }))
    .filter((r) => r.sim >= 0.35)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3)
    .map((r) => r.q);

  const sourceScoreAdjust = (source: string) => {
    const s = String(source ?? "").trim();
    if (!s) return 0;
    const art = artifactPrefsCache;
    if (art?.revokedSources.size) {
      for (const name of art.revokedSources) {
        if (s.includes(name) || name.includes(s)) return -0.25;
      }
    }
    if (art?.confirmedSources.size) {
      for (const name of art.confirmedSources) {
        if (s.includes(name) || name.includes(s)) return Math.min(0.18, 0.08 + 0.02);
      }
    }
    let adj = 0;
    for (const [name, boost] of Object.entries(prefs.sourceBoosts)) {
      if (s.includes(name) || name.includes(s)) adj += Math.min(0.12, boost * 0.04);
    }
    for (const [name, pen] of Object.entries(prefs.sourcePenalties)) {
      if (s.includes(name) || name.includes(s)) adj -= Math.min(0.15, pen * 0.05);
    }
    return adj;
  };

  return { boostedSources, similarPositiveQueries, sourceScoreAdjust };
}

export function recordLearningSignal(sig: Omit<RagLearningSignal, "at" | "question_norm"> & { question: string }) {
  const row: RagLearningSignal = {
    ...sig,
    question_norm: normalizeQuestionKey(sig.question),
    at: new Date().toISOString(),
  };
  void persistRagLearningSignal(row);
  cachedPrefs = null;
  void refreshArtifactPrefsCache(true).catch(() => undefined);
}

export function clearLearningSignals(tenantId?: string) {
  const tid = String(tenantId || "default").trim() || "default";
  try {
    writeFileSync(signalsFile(), "", "utf8");
    writeFileSync(ragSignalsFilePath(tid), "", "utf8");
    cachedPrefs = null;
  } catch {
    /* ignore */
  }
  void import("#agent-shared/agentPgClient")
    .then(({ agentPgQuery }) => agentPgQuery(`DELETE FROM rag_learning_signals WHERE tenant_id = $1`, [tid]))
    .catch(() => undefined);
}

export function getLearningSummary() {
  const prefs = getRetrievalPreferences(true);
  const okRate =
    prefs.positiveCount + prefs.negativeCount > 0
      ? prefs.positiveCount / (prefs.positiveCount + prefs.negativeCount)
      : null;
  return {
    total: prefs.totalSignals,
    positive: prefs.positiveCount,
    negative: prefs.negativeCount,
    okRate,
    boostedSources: Object.keys(prefs.sourceBoosts).slice(0, 8),
    penalizedSources: Object.keys(prefs.sourcePenalties).slice(0, 8),
  };
}
