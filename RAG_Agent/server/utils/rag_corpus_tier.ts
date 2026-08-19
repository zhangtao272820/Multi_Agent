/**
 * 知识库规模档位：.env 只设 RAG_CORPUS_TIER，自动套用检索/重排/LLM 节制预设。
 * 显式设置的 RAG_* 细项变量仍优先于档位默认值。
 */

export type RagCorpusTierId = "s" | "m" | "l";

export type RagCorpusTierPreset = {
  fastPathVectorTopK?: number;
  vectorSearchTopK?: number;
  maxRetrievalQueries?: number;
  maxRerankCandidates?: number;
  rerankDocPreviewChars?: number;
  maxContextChars?: number;
  maxContextSnippets?: number;
  smallCorpusTurboMaxDocs?: number;
  docRoutingTopN?: number;
  docRoutingMinConfidence?: number;
  docRoutingRelaxRatio?: number;
  enableMultiQuery?: boolean;
  enableGapFillVector?: boolean;
  enableCrossEncoderRerank?: boolean;
  enableLocalRerank?: boolean;
  enableEmbeddingRerank?: boolean;
  enableRetrievalBandit?: boolean;
  retrievalBanditExplorePercent?: number;
  enableSubQueryParallelRetrieval?: boolean;
  subQueryLaneTopK?: number;
  enableAgenticRetrieval?: boolean;
  agenticMaxRounds?: number;
  enableVectorExperience?: boolean;
  vectorExperienceMaxEntries?: number;
  enableLearningLoop?: boolean;
  enableUserPreferences?: boolean;
  enableCrossAgentProfile?: boolean;
  enablePromptAbTest?: boolean;
  chunkOverlap?: number;
  banditTargetLatencyMs?: number;
};

/** S：≤50 份文档，速度优先 */
const TIER_S: RagCorpusTierPreset = {
  fastPathVectorTopK: 8,
  vectorSearchTopK: 10,
  maxRetrievalQueries: 3,
  maxRerankCandidates: 8,
  maxContextChars: 4800,
  maxContextSnippets: 4,
  smallCorpusTurboMaxDocs: 50,
  docRoutingTopN: 5,
  docRoutingMinConfidence: 2,
  docRoutingRelaxRatio: 0.65,
  enableMultiQuery: false,
  enableGapFillVector: false,
  enableCrossEncoderRerank: true,
  enableLocalRerank: true,
  enableEmbeddingRerank: false,
  enableRetrievalBandit: false,
  retrievalBanditExplorePercent: 0,
  enableSubQueryParallelRetrieval: true,
  subQueryLaneTopK: 3,
  enableAgenticRetrieval: true,
  agenticMaxRounds: 1,
  enableVectorExperience: false,
  enableLearningLoop: false,
  enableUserPreferences: false,
  enableCrossAgentProfile: false,
  enablePromptAbTest: false,
  banditTargetLatencyMs: 8000,
};

/** M：50～500 份，速度与召回平衡 */
const TIER_M: RagCorpusTierPreset = {
  fastPathVectorTopK: 8,
  vectorSearchTopK: 12,
  maxRetrievalQueries: 4,
  maxRerankCandidates: 10,
  maxContextChars: 4800,
  maxContextSnippets: 4,
  smallCorpusTurboMaxDocs: 8,
  docRoutingTopN: 8,
  docRoutingMinConfidence: 2,
  docRoutingRelaxRatio: 0.65,
  enableMultiQuery: false,
  enableGapFillVector: false,
  enableCrossEncoderRerank: true,
  enableLocalRerank: true,
  enableEmbeddingRerank: false,
  enableRetrievalBandit: true,
  retrievalBanditExplorePercent: 3,
  enableSubQueryParallelRetrieval: true,
  subQueryLaneTopK: 3,
  enableAgenticRetrieval: true,
  agenticMaxRounds: 1,
  enableVectorExperience: true,
  vectorExperienceMaxEntries: 200,
  enableLearningLoop: true,
  enableUserPreferences: true,
  enableCrossAgentProfile: false,
  enablePromptAbTest: false,
  banditTargetLatencyMs: 12000,
};

/** L：500+ 份，先路由缩范围 */
const TIER_L: RagCorpusTierPreset = {
  fastPathVectorTopK: 8,
  vectorSearchTopK: 10,
  maxRetrievalQueries: 3,
  maxRerankCandidates: 8,
  rerankDocPreviewChars: 350,
  maxContextChars: 4800,
  maxContextSnippets: 4,
  smallCorpusTurboMaxDocs: 8,
  docRoutingTopN: 12,
  docRoutingMinConfidence: 3,
  docRoutingRelaxRatio: 0.55,
  enableMultiQuery: false,
  enableGapFillVector: false,
  enableCrossEncoderRerank: true,
  enableLocalRerank: true,
  enableEmbeddingRerank: false,
  enableRetrievalBandit: true,
  retrievalBanditExplorePercent: 0,
  enableSubQueryParallelRetrieval: true,
  subQueryLaneTopK: 2,
  enableAgenticRetrieval: true,
  agenticMaxRounds: 1,
  enableVectorExperience: false,
  enableLearningLoop: false,
  enableUserPreferences: true,
  enableCrossAgentProfile: false,
  enablePromptAbTest: false,
  chunkOverlap: 180,
  banditTargetLatencyMs: 15000,
};

export const RAG_CORPUS_TIER_PRESETS: Record<RagCorpusTierId, RagCorpusTierPreset> = {
  s: TIER_S,
  m: TIER_M,
  l: TIER_L,
};

export const RAG_CORPUS_TIER_LABELS: Record<RagCorpusTierId, string> = {
  s: "小库（≤50 份文档，速度优先）",
  m: "中库（50～500 份，平衡）",
  l: "大库（500+ 份，先路由再检）",
};

/** 按文档数自动选档 */
export function resolveCorpusTierFromDocCount(docCount: number): RagCorpusTierId {
  const n = Math.max(0, Math.floor(docCount));
  if (n <= 50) return "s";
  if (n <= 500) return "m";
  return "l";
}

/** 解析 .env：s/m/l、small/medium/large、小/中/大、auto */
export function parseRagCorpusTierEnv(raw: unknown): RagCorpusTierId | "auto" | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "auto" || s === "自动") return "auto";
  if (["s", "small", "小", "小库"].includes(s)) return "s";
  if (["m", "medium", "中", "中库"].includes(s)) return "m";
  if (["l", "large", "大", "大库"].includes(s)) return "l";
  // 历史误写 standard（检索档位名）时按规模自动套用，避免档位预设静默失效
  if (["standard", "default", "normal"].includes(s)) return "auto";
  return null;
}

export function resolveActiveCorpusTier(docCount?: number): RagCorpusTierId | null {
  const parsed = parseRagCorpusTierEnv(process.env.RAG_CORPUS_TIER);
  if (!parsed) return null;
  if (parsed === "auto") {
    if (typeof docCount === "number" && Number.isFinite(docCount)) {
      return resolveCorpusTierFromDocCount(docCount);
    }
    return "m";
  }
  return parsed;
}

export function mergeCorpusTierIntoDefaults<T extends Record<string, unknown>>(
  defaults: T,
  tier: RagCorpusTierId | null
): T {
  if (!tier) return defaults;
  const preset = RAG_CORPUS_TIER_PRESETS[tier];
  return { ...defaults, ...preset };
}
