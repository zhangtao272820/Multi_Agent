/**
 * P3 向量经验库：成功检索问句 embedding 语义召回，注入检索 query 扩展。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getRagAgentEnv } from "./rag_agent_env";
import { embedQueryCached, getRagEmbeddings } from "./embedding_query_cache";
import { normalizeQuestionKey } from "./rag_learning";
import {
  loadRagExperienceVectorsFromPg,
  upsertRagExperienceVectorPg,
} from "../../utils/rag_experience_vector_store";
import {
  extractRagExperiencePathKey,
  resolveRagExperiencePathConflicts,
} from "./ragExperiencePathConflict";

export { extractRagExperiencePathKey, resolveRagExperiencePathConflicts } from "./ragExperiencePathConflict";
export { ragVectorExperienceRequireUseful } from "#agent-shared/experienceRecallPolicy";

export type RagExperienceRow = {
  id: string;
  ts: string;
  question_norm: string;
  question: string;
  vector: number[];
  hint: string;
  sources?: string[];
};

function dataDir() {
  const dir = join(process.cwd(), ".data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function vectorsFile() {
  return join(dataDir(), "rag-experience-vectors.json");
}

function loadRows(): RagExperienceRow[] {
  const p = vectorsFile();
  if (!existsSync(p)) return [];
  try {
    const o = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(o) ? (o as RagExperienceRow[]) : [];
  } catch {
    return [];
  }
}

async function loadRowsHybrid(): Promise<RagExperienceRow[]> {
  const pgRows = await loadRagExperienceVectorsFromPg(400);
  if (pgRows.length) {
    return pgRows.map((r) => ({
      id: r.id,
      ts: r.ts,
      question_norm: r.questionNorm,
      question: r.question,
      vector: r.vector,
      hint: r.hint,
      sources: r.sources,
    }));
  }
  return loadRows();
}

function saveRows(rows: RagExperienceRow[]) {
  const max = Number(process.env.RAG_VECTOR_EXPERIENCE_MAX ?? 400);
  writeFileSync(vectorsFile(), JSON.stringify(rows.slice(-max), null, 0), "utf8");
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export function clipTextForEmbedding(text: string, max = 180): string {
  let s = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[【】\[\]()（）]/g, "");
  if (s.length <= max) return s;
  return s.slice(0, max);
}

export async function indexRagExperience(input: {
  question: string;
  hint: string;
  sources?: string[];
}) {
  const env = getRagAgentEnv();
  if (!env.enableVectorExperience) return;
  const question = String(input.question ?? "").trim();
  const hint = String(input.hint ?? "").trim();
  if (!question || !hint || question.length < 6) return;

  const question_norm = normalizeQuestionKey(question);
  const rows = loadRows();
  const dup = rows.find((r) => r.question_norm === question_norm);
  const ts = new Date().toISOString();
  if (dup) {
    dup.hint = hint;
    dup.sources = input.sources;
    dup.ts = ts;
    saveRows(rows);
    void upsertRagExperienceVectorPg({
      id: dup.id,
      questionNorm: question_norm,
      question: clipTextForEmbedding(question, 120),
      hint,
      vector: dup.vector,
      sources: input.sources?.slice(0, 4),
      ts,
    }).catch(() => undefined);
    return;
  }

  const embeddings = getRagEmbeddings();
  const vec = await embedQueryCached(embeddings, question);
  if (!vec) return;
  const id = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  rows.push({
    id,
    ts,
    question_norm,
    question: clipTextForEmbedding(question, 120),
    vector: vec,
    hint,
    sources: input.sources?.slice(0, 4),
  });
  saveRows(rows);
  void upsertRagExperienceVectorPg({
    id,
    questionNorm: question_norm,
    question: clipTextForEmbedding(question, 120),
    hint,
    vector: vec,
    sources: input.sources?.slice(0, 4),
    ts,
  }).catch(() => undefined);
}

export type RagExperienceRecall = {
  question: string;
  hint: string;
  sources?: string[];
  score: number;
  pathKey?: string;
};

export async function recallRagExperience(question: string, limit = 3): Promise<RagExperienceRecall[]> {
  const env = getRagAgentEnv();
  if (!env.enableVectorExperience) return [];
  const q = String(question ?? "").trim();
  if (q.length < 4) return [];

  const rows = await loadRowsHybrid();
  if (!rows.length) return [];

  const embeddings = getRagEmbeddings();
  const queryVec = await embedQueryCached(embeddings, q);
  if (!queryVec) return [];

  const minScore = env.vectorExperienceMinScore;
  const scored = rows
    .map((r) => ({ r, s: cosineSimilarity(queryVec, r.vector) }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s);

  const seen = new Set<string>();
  const candidates: RagExperienceRecall[] = [];
  for (const { r, s } of scored) {
    const k = r.hint;
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push({
      question: r.question,
      hint: r.hint,
      sources: r.sources,
      score: s,
      pathKey: extractRagExperiencePathKey(r.hint, r.sources),
    });
    if (candidates.length >= Math.max(limit * 4, 8)) break;
  }
  const resolved = resolveRagExperiencePathConflicts(candidates);
  return resolved.slice(0, limit);
}

export function getRagExperienceSummary() {
  const env = getRagAgentEnv();
  return {
    count: loadRows().length,
    enabled: env.enableVectorExperience,
    minScore: env.vectorExperienceMinScore,
  };
}

export function clearRagExperienceVectors() {
  try {
    writeFileSync(vectorsFile(), "[]", "utf8");
  } catch {
    /* ignore */
  }
}
