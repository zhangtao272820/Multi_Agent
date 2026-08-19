import {
  mergeCorpusTierIntoDefaults,
  resolveActiveCorpusTier,
  RAG_CORPUS_TIER_LABELS,
  type RagCorpusTierId,
} from "./rag_corpus_tier";

/** Docker 内 shared 在 agent-repo-shared，不可用 ../../../shared；此处内联 EVO 解析。 */
function isRagPromptEvolutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.RAG_ENABLE_PROMPT_EVOLUTION;
  if (raw !== undefined && String(raw).trim() !== "") {
    return !/^(0|false|off|no)$/i.test(String(raw).trim());
  }
  const mode = String(env.EVO_MODE ?? env.MANAGER_EVOLUTION_MODE ?? "").trim().toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false" || mode === "no") return false;
  return true;
}

/**
 * RAG 运行时常量：原 RAG_* 细粒度环境变量收敛至此，.env 只保留密钥、模型与向量连接。
 * 规模档位：设 RAG_CORPUS_TIER=s|m|l|auto，细项 RAG_* 仍可单独覆盖档位默认值。
 */

const envBool = (v: unknown, defaultValue: boolean) => {
  if (v === undefined || v === null || v === "") return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
};

const envNum = (v: unknown, defaultValue: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
};

export const RAG_AGENT_DEFAULTS = {
  minHybridScore: 0.08,
  minResultCount: 2,
  docRoutingTopN: 5,
  docRoutingMinConfidence: 2,
  docRoutingRelaxRatio: 0.65,
  enableMultiQuery: false,
  enableRerank: true,
  multiQueryMinLen: 6,
  rerankMinCandidates: 4,
  maxContextChars: 4800,
  maxContextSnippets: 4,
  maxRerankCandidates: 10,
  rerankDocPreviewChars: 400,
  vectorSearchTopK: 12,
  /** retrieve-first / probe：单次向量检索 topK，减少 embedding 调用量 */
  fastPathVectorTopK: 8,
  maxRetrievalQueries: 4,
  rerankKeepTopBase: 3,
  keywordTopGuard: 3,
  enableGapFillVector: false,
  enableRoutingExplain: false,
  enableRrfFusion: true,
  rrfK: 60,
  rrfSemanticWeight: 1,
  rrfKeywordWeight: 0.9,
  /** P-Data-2：进程内 BM25 词法通道（与向量 RRF 融合） */
  enableBm25Lexical: true,
  rrfBm25Weight: 0.85,
  preferDocumentQueryWhenDocsExist: true,
  /** 文档助手 UI：有文档时优先 retrieve-first，命中则直出回答，失败再走 LangGraph */
  enableRetrieveFirstChat: true,
  /** 快路径跳过 LLM 文本重排（embedding/CE 重排仍执行，兼顾速度） */
  retrieveFirstSkipLlmRerank: true,
  /** 快路径跳过证据 LLM 精选（retrieve-first 用 fastPath 直出重排结果） */
  retrieveFirstSkipEvidenceSelect: true,
  /** 复合/列全/多轮复杂问句：由 Dify 分档 + RAGFlow 加深，不再强制走 LangGraph */
  retrieveFirstSkipComplex: false,
  /** 双事实/双字段问句（非列全）走 compound_fast，避免 LangGraph 全链路 */
  enableRetrieveFirstCompound: true,
  /** 小库（≤N 份文档）跳过重 bandit/embedding 重排与偏好 LLM 注入 */
  smallCorpusTurboMaxDocs: 8,
  retrieveFirstMaxSubQueries: 2,
  enableExplicitDocAnchor: true,
  enableQueryCondense: true,
  condenseRecentMessages: 8,
  enableQueryPlan: true,
  queryPlanMinLen: 6,
  enableLexicalRerank: true,
  lexicalRerankSkipLlmThreshold: 10,
  chunkSize: 900,
  chunkOverlap: 220,
  structureAwareChunking: true,
  /** P2：Markdown/TSV 表格按行分组切分，保留表头 */
  enableTableAwareChunking: true,
  /** H2：子块检索 + parent_text 扩展 */
  enableParentChildChunking: true,
  enableParentExpand: true,
  parentTextMaxChars: 6000,
  /** H3：MMR 去冗余 */
  enableMmr: true,
  mmrLambda: 0.7,
  /** 多文档 top-k：按 source 至少保留 1 条，减轻近义挤占 */
  enableSourceCoverage: true,
  sourceCoveragePerSourceMin: 1,
  /** H4：Top1/Top2 分差过小且分数偏低 → Corrective */
  correctiveMinScoreGap: 0.015,
  correctiveAmbiguousTopMax: 0.22,
  /** H5：答案数字/条款须出现在证据原文 */
  enableCitationGuard: true,
  /** P2：复合问句按子问句并行检索 lane */
  enableSubQueryParallelRetrieval: true,
  subQueryLaneTopK: 3,
  subQueryKeywordLimitPerLane: 24,
  /** DashScope text-embedding 单次 batch 上限为 10 */
  embeddingBatchSize: 10,
  /** P2：证据不足时改写 query 再检（默认 1 轮，平衡速度与召回） */
  enableAgenticRetrieval: true,
  agenticMaxRounds: 1,
  /** J 波：专家内 Agentic 工具多跳（catalog/retrieve/scoped） */
  enableAgenticToolLoop: true,
  agenticToolMaxRounds: 4,
  /** K 波：MinerU 重解析入库 */
  enableHeavyParse: true,
  mineruApiUrl: "" as string,
  heavyParseTimeoutMs: 120_000,
  /** P2：从 rag-learning-signals 调检索偏好 */
  enableLearningLoop: true,
  /** P2：gte-rerank 等；未配则词法 + LLM */
  enableCrossEncoderRerank: true,
  crossEncoderSkipLlmThreshold: 0.72,
  /** P3：成功问句向量经验召回 */
  enableVectorExperience: true,
  vectorExperienceMinScore: 0.72,
  vectorExperienceMaxEntries: 400,
  /** P3：负反馈 prompt 影子进化 */
  enablePromptEvolution: true,
  /** P3：会话摘要 + 主题分层（仅 chat 带 conversationId） */
  enableLayeredSessionMemory: true,
  sessionMemoryMaxTopics: 8,
  /** P4：影子补丁晋级阈值 */
  promptPromoteMinHits: 3,
  /** 默认关：反馈只写 shadow；晋级须人审 */
  enableAutoCurateOnFeedback: false,
  /** P4：跨会话用户画像 */
  enableUserPreferences: true,
  userPrefsFromConversationId: true,
  userPrefsMaxTopics: 10,
  /** P4：eval 最低通过率（CI） */
  evalMinPassRate: 0.5,
  /** P5：晋级补丁 A/B（treatment=含已晋级，control=仅影子） */
  enablePromptAbTest: true,
  promptAbTreatmentPercent: 50,
  /** P5：读取 DB_Agent 用户偏好 */
  enableCrossAgentProfile: true,
  /** P6：离线 TF-IDF 重排（远程 CE 失败时） */
  enableLocalRerank: true,
  localRerankSkipLlmThreshold: 8,
  /** P6：后台定时 curator */
  enableAutoCuratorScheduler: true,
  autoCuratorIntervalMs: 3_600_000,
  /** P6：A/B 显著性达标才自动晋级（定时任务） */
  /** 默认关：A/B 达标也不自动晋级 */
  enableAbAutoPromote: false,
  abAutoPromoteMinSamples: 20,
  abAutoPromoteMinDelta: 0.08,
  /** P6：读取总管 user-session-map */
  enableSharedIdentity: true,
  enforceIdentityRoles: false,
  requiredIdentityRoles: [] as string[],
  /** P7：专用 rerank HTTP（ONNX/小型 CE 网关） */
  enableDedicatedRerank: false,
  dedicatedRerankUrl: "" as string,
  dedicatedRerankModel: "bge-reranker-base",
  /** P7：检索重排 Bandit */
  /** P8：进程内 embedding 余弦重排（默认关闭以省 token；可开 lexical/CE/onnx） */
  enableEmbeddingRerank: false,
  embeddingRerankSkipLlmThreshold: 0.68,
  /** P8：可选 ONNX（需 onnxruntime-node + RAG_ONNX_RERANK_MODEL） */
  enableOnnxRerank: false,
  enableRetrievalBandit: true,
  retrievalBanditExplorePercent: 10,
  enableBanditMultiObjective: true,
  banditTargetLatencyMs: 2500,
  /** P7：OIDC Bearer */
  enableOidc: false,
  oidcIssuer: "" as string,
  oidcAudience: "" as string,
  oidcUserinfoUrl: "" as string,
  oidcTrustGateway: false,
} as const;

export type RagAgentEnv = typeof RAG_AGENT_DEFAULTS & {
  /** 当前生效档位（未设 RAG_CORPUS_TIER 时为 null） */
  corpusTier: RagCorpusTierId | null;
  corpusTierLabel: string | null;
  chatModel: string | undefined;
  expansionModel: string | undefined;
  rerankModel: string | undefined;
  condenseModel: string | undefined;
  queryPlanModel: string | undefined;
  evidenceSelectModel: string | undefined;
  contextExtractModel: string | undefined;
  summaryModel: string | undefined;
  crossEncoderModel: string | undefined;
  dedicatedRerankUrl: string | undefined;
  dedicatedRerankModel: string | undefined;
  embeddingModel: string;
  vectorBackend: "memory" | "pgvector";
  mineruApiUrl: string;
};

export function chatModelName() {
  return process.env.CHAT_MODEL ?? process.env.OPENAI_MODEL;
}

/** 意图/相关性/condense 判定等小任务统一用 flash 级模型，避免拖慢主链路 */
export function ragFastJudgeModelName() {
  return (
    process.env.DOC_SCOPE_MODEL ??
    process.env.CONTEXT_RELEVANCE_MODEL ??
    process.env.CONDENSE_MODEL ??
    process.env.EXPANSION_MODEL ??
    process.env.QUERY_PLAN_MODEL ??
    chatModelName()
  );
}

const isDashScopeBase = () => String(process.env.OPENAI_BASE_URL ?? "").includes("dashscope.aliyuncs.com");

/** LLM 文本重排用 chat 模型；RERANK_MODEL / gte-rerank 仅用于 cross_encoder API */
function llmRerankChatModel(chat: string | undefined, expansion: string | undefined): string | undefined {
  const explicit = String(process.env.RAG_LLM_RERANK_MODEL ?? "").trim();
  if (explicit) return explicit;
  const legacy = String(process.env.RERANK_MODEL ?? "").trim();
  if (legacy && !/rerank/i.test(legacy)) return legacy;
  return expansion ?? chat;
}

export function getRagAgentEnv(opts?: { docCount?: number }): RagAgentEnv {
  const activeTier = resolveActiveCorpusTier(opts?.docCount);
  const d = mergeCorpusTierIntoDefaults(RAG_AGENT_DEFAULTS, activeTier);
  const chat = chatModelName();
  const expansion = process.env.EXPANSION_MODEL ?? (isDashScopeBase() ? "qwen-flash" : chat);
  return {
    ...d,
    minHybridScore: envNum(process.env.RAG_MIN_HYBRID_SCORE, d.minHybridScore),
    minResultCount: envNum(process.env.RAG_MIN_RESULT_COUNT, d.minResultCount),
    docRoutingTopN: envNum(process.env.RAG_DOC_ROUTING_TOP_N, d.docRoutingTopN),
    docRoutingMinConfidence: Math.max(0, envNum(process.env.RAG_DOC_ROUTING_MIN_CONFIDENCE, d.docRoutingMinConfidence)),
    docRoutingRelaxRatio: Math.max(0, Math.min(1, envNum(process.env.RAG_DOC_ROUTING_RELAX_RATIO, d.docRoutingRelaxRatio))),
    enableMultiQuery: envBool(process.env.RAG_ENABLE_MULTI_QUERY, d.enableMultiQuery),
    enableRerank: envBool(process.env.RAG_ENABLE_RERANK, d.enableRerank),
    multiQueryMinLen: envNum(process.env.RAG_MULTI_QUERY_MIN_LEN, d.multiQueryMinLen),
    rerankMinCandidates: Math.max(3, Math.floor(envNum(process.env.RAG_RERANK_MIN_CANDIDATES, d.rerankMinCandidates))),
    maxContextChars: envNum(process.env.RAG_MAX_CONTEXT_CHARS, d.maxContextChars),
    maxContextSnippets: Math.max(1, Math.floor(envNum(process.env.RAG_MAX_CONTEXT_SNIPPETS, d.maxContextSnippets))),
    maxRerankCandidates: Math.max(3, Math.floor(envNum(process.env.RAG_MAX_RERANK_CANDIDATES, d.maxRerankCandidates))),
    rerankDocPreviewChars: Math.max(80, Math.floor(envNum(process.env.RAG_RERANK_DOC_PREVIEW_CHARS, d.rerankDocPreviewChars))),
    vectorSearchTopK: Math.max(4, Math.floor(envNum(process.env.RAG_VECTOR_TOP_K, d.vectorSearchTopK))),
    fastPathVectorTopK: Math.max(4, Math.floor(envNum(process.env.RAG_FAST_PATH_VECTOR_TOP_K, d.fastPathVectorTopK))),
    maxRetrievalQueries: Math.max(4, Math.floor(envNum(process.env.RAG_MAX_RETRIEVAL_QUERIES, d.maxRetrievalQueries))),
    rerankKeepTopBase: Math.max(1, Math.floor(envNum(process.env.RAG_RERANK_KEEP_TOP_BASE, d.rerankKeepTopBase))),
    keywordTopGuard: Math.max(0, Math.floor(envNum(process.env.RAG_KEYWORD_TOP_GUARD, d.keywordTopGuard))),
    enableGapFillVector: envBool(process.env.RAG_ENABLE_GAP_FILL_VECTOR, d.enableGapFillVector),
    enableRoutingExplain: envBool(process.env.RAG_ENABLE_ROUTING_EXPLAIN, d.enableRoutingExplain),
    enableRrfFusion: envBool(process.env.RAG_ENABLE_RRF_FUSION, d.enableRrfFusion),
    rrfK: Math.max(10, Math.floor(envNum(process.env.RAG_RRF_K, d.rrfK))),
    rrfSemanticWeight: Math.max(0, envNum(process.env.RAG_RRF_SEMANTIC_WEIGHT, d.rrfSemanticWeight)),
    rrfKeywordWeight: Math.max(0, envNum(process.env.RAG_RRF_KEYWORD_WEIGHT, d.rrfKeywordWeight)),
    enableBm25Lexical: envBool(process.env.RAG_ENABLE_BM25, d.enableBm25Lexical),
    rrfBm25Weight: Math.max(0, envNum(process.env.RAG_RRF_BM25_WEIGHT, d.rrfBm25Weight)),
    preferDocumentQueryWhenDocsExist: envBool(process.env.RAG_PREFER_DOCUMENT_QUERY_WHEN_DOCS_EXIST, d.preferDocumentQueryWhenDocsExist),
    enableRetrieveFirstChat: envBool(process.env.RAG_ENABLE_RETRIEVE_FIRST_CHAT, d.enableRetrieveFirstChat),
    retrieveFirstSkipLlmRerank: envBool(process.env.RAG_RETRIEVE_FIRST_SKIP_LLM_RERANK, d.retrieveFirstSkipLlmRerank),
    retrieveFirstSkipEvidenceSelect: envBool(
      process.env.RAG_RETRIEVE_FIRST_SKIP_EVIDENCE_SELECT,
      d.retrieveFirstSkipEvidenceSelect
    ),
    retrieveFirstSkipComplex: envBool(process.env.RAG_RETRIEVE_FIRST_SKIP_COMPLEX, d.retrieveFirstSkipComplex),
    enableRetrieveFirstCompound: envBool(
      process.env.RAG_ENABLE_RETRIEVE_FIRST_COMPOUND,
      d.enableRetrieveFirstCompound
    ),
    smallCorpusTurboMaxDocs: Math.max(
      2,
      Math.floor(envNum(process.env.RAG_SMALL_CORPUS_TURBO_MAX_DOCS, d.smallCorpusTurboMaxDocs))
    ),
    retrieveFirstMaxSubQueries: Math.max(
      1,
      Math.floor(envNum(process.env.RAG_RETRIEVE_FIRST_MAX_SUB_QUERIES, d.retrieveFirstMaxSubQueries))
    ),
    enableExplicitDocAnchor: envBool(process.env.RAG_ENABLE_EXPLICIT_DOC_ANCHOR, d.enableExplicitDocAnchor),
    enableQueryCondense: envBool(process.env.RAG_ENABLE_QUERY_CONDENSE, d.enableQueryCondense),
    condenseRecentMessages: Math.max(2, Math.floor(envNum(process.env.RAG_CONDENSE_RECENT_MESSAGES, d.condenseRecentMessages))),
    enableQueryPlan: envBool(process.env.RAG_ENABLE_QUERY_PLAN, d.enableQueryPlan),
    queryPlanMinLen: envNum(process.env.RAG_QUERY_PLAN_MIN_LEN, d.queryPlanMinLen),
    enableLexicalRerank: envBool(process.env.RAG_ENABLE_LEXICAL_RERANK, d.enableLexicalRerank),
    lexicalRerankSkipLlmThreshold: envNum(process.env.RAG_LEXICAL_RERANK_SKIP_LLM, d.lexicalRerankSkipLlmThreshold),
    chunkSize: envNum(process.env.RAG_CHUNK_SIZE, d.chunkSize),
    chunkOverlap: envNum(process.env.RAG_CHUNK_OVERLAP, d.chunkOverlap),
    structureAwareChunking: envBool(process.env.RAG_STRUCTURE_AWARE_CHUNKING, d.structureAwareChunking),
    enableTableAwareChunking: envBool(process.env.RAG_ENABLE_TABLE_AWARE_CHUNKING, d.enableTableAwareChunking),
    enableParentChildChunking: envBool(process.env.RAG_ENABLE_PARENT_CHILD, d.enableParentChildChunking),
    enableParentExpand: envBool(process.env.RAG_PARENT_EXPAND, d.enableParentExpand),
    parentTextMaxChars: Math.max(
      800,
      Math.floor(envNum(process.env.RAG_PARENT_TEXT_MAX_CHARS, d.parentTextMaxChars))
    ),
    enableMmr: envBool(process.env.RAG_ENABLE_MMR, d.enableMmr),
    mmrLambda: Math.max(0, Math.min(1, envNum(process.env.RAG_MMR_LAMBDA, d.mmrLambda))),
    enableSourceCoverage: envBool(process.env.RAG_ENABLE_SOURCE_COVERAGE, d.enableSourceCoverage),
    sourceCoveragePerSourceMin: Math.max(
      1,
      Math.min(3, Math.floor(envNum(process.env.RAG_SOURCE_COVERAGE_PER_SOURCE, d.sourceCoveragePerSourceMin))),
    ),
    correctiveMinScoreGap: Math.max(0, envNum(process.env.RAG_CORRECTIVE_MIN_SCORE_GAP, d.correctiveMinScoreGap)),
    correctiveAmbiguousTopMax: Math.max(
      0,
      envNum(process.env.RAG_CORRECTIVE_AMBIGUOUS_TOP_MAX, d.correctiveAmbiguousTopMax)
    ),
    enableCitationGuard: envBool(process.env.RAG_ENABLE_CITATION_GUARD, d.enableCitationGuard),
    enableSubQueryParallelRetrieval: envBool(
      process.env.RAG_ENABLE_SUB_QUERY_PARALLEL,
      d.enableSubQueryParallelRetrieval
    ),
    subQueryLaneTopK: Math.max(2, Math.floor(envNum(process.env.RAG_SUB_QUERY_LANE_TOP_K, d.subQueryLaneTopK))),
    subQueryKeywordLimitPerLane: Math.max(
      12,
      Math.floor(envNum(process.env.RAG_SUB_QUERY_KEYWORD_LIMIT, d.subQueryKeywordLimitPerLane))
    ),
    embeddingBatchSize: Math.max(1, Math.min(10, Math.floor(envNum(process.env.RAG_EMBEDDING_BATCH_SIZE, d.embeddingBatchSize)))),
    enableAgenticRetrieval: envBool(process.env.RAG_ENABLE_AGENTIC_RETRIEVAL, d.enableAgenticRetrieval),
    agenticMaxRounds: Math.max(0, Math.min(3, Math.floor(envNum(process.env.RAG_AGENTIC_MAX_ROUNDS, d.agenticMaxRounds)))),
    enableAgenticToolLoop: envBool(process.env.RAG_ENABLE_AGENTIC_TOOL_LOOP, d.enableAgenticToolLoop),
    agenticToolMaxRounds: Math.max(
      1,
      Math.min(8, Math.floor(envNum(process.env.RAG_AGENTIC_TOOL_MAX_ROUNDS, d.agenticToolMaxRounds)))
    ),
    enableHeavyParse: envBool(process.env.RAG_HEAVY_PARSE, d.enableHeavyParse),
    mineruApiUrl: String(process.env.MINERU_API_URL ?? d.mineruApiUrl ?? "").trim(),
    heavyParseTimeoutMs: Math.max(
      5_000,
      Math.floor(envNum(process.env.RAG_HEAVY_PARSE_TIMEOUT_MS, d.heavyParseTimeoutMs))
    ),
    enableLearningLoop: envBool(process.env.RAG_ENABLE_LEARNING_LOOP, d.enableLearningLoop),
    enableCrossEncoderRerank: envBool(process.env.RAG_ENABLE_CROSS_ENCODER, d.enableCrossEncoderRerank),
    crossEncoderSkipLlmThreshold: envNum(process.env.RAG_CROSS_ENCODER_SKIP_LLM, d.crossEncoderSkipLlmThreshold),
    enableVectorExperience: envBool(process.env.RAG_ENABLE_VECTOR_EXPERIENCE, d.enableVectorExperience),
    vectorExperienceMinScore: envNum(process.env.RAG_VECTOR_EXPERIENCE_MIN_SCORE, d.vectorExperienceMinScore),
    vectorExperienceMaxEntries: Math.max(50, Math.floor(envNum(process.env.RAG_VECTOR_EXPERIENCE_MAX, d.vectorExperienceMaxEntries))),
    enablePromptEvolution: envBool(process.env.RAG_ENABLE_PROMPT_EVOLUTION, isRagPromptEvolutionEnabled(process.env)),
    enableLayeredSessionMemory: envBool(process.env.RAG_ENABLE_LAYERED_MEMORY, d.enableLayeredSessionMemory),
    sessionMemoryMaxTopics: Math.max(2, Math.floor(envNum(process.env.RAG_SESSION_MAX_TOPICS, d.sessionMemoryMaxTopics))),
    promptPromoteMinHits: Math.max(2, Math.floor(envNum(process.env.RAG_PROMPT_PROMOTE_MIN_HITS, d.promptPromoteMinHits))),
    enableAutoCurateOnFeedback: envBool(process.env.RAG_AUTO_CURATE_ON_FEEDBACK, d.enableAutoCurateOnFeedback),
    enableUserPreferences: envBool(process.env.RAG_ENABLE_USER_PREFERENCES, d.enableUserPreferences),
    userPrefsFromConversationId: envBool(process.env.RAG_USER_PREFS_FROM_CONVERSATION, d.userPrefsFromConversationId),
    userPrefsMaxTopics: Math.max(4, Math.floor(envNum(process.env.RAG_USER_PREFS_MAX_TOPICS, d.userPrefsMaxTopics))),
    evalMinPassRate: Math.max(0, Math.min(1, envNum(process.env.RAG_EVAL_MIN_PASS_RATE, d.evalMinPassRate))),
    enablePromptAbTest: envBool(process.env.RAG_ENABLE_PROMPT_AB, d.enablePromptAbTest),
    promptAbTreatmentPercent: Math.max(0, Math.min(100, Math.floor(envNum(process.env.RAG_PROMPT_AB_TREATMENT_PCT, d.promptAbTreatmentPercent)))),
    enableCrossAgentProfile: envBool(process.env.RAG_ENABLE_CROSS_AGENT_PROFILE, d.enableCrossAgentProfile),
    enableLocalRerank: envBool(process.env.RAG_ENABLE_LOCAL_RERANK, d.enableLocalRerank),
    localRerankSkipLlmThreshold: envNum(process.env.RAG_LOCAL_RERANK_SKIP_LLM, d.localRerankSkipLlmThreshold),
    enableAutoCuratorScheduler: envBool(process.env.RAG_ENABLE_AUTO_CURATOR, d.enableAutoCuratorScheduler),
    autoCuratorIntervalMs: Math.max(60_000, Math.floor(envNum(process.env.RAG_AUTO_CURATOR_INTERVAL_MS, d.autoCuratorIntervalMs))),
    enableAbAutoPromote: envBool(process.env.RAG_AB_AUTO_PROMOTE, d.enableAbAutoPromote),
    abAutoPromoteMinSamples: Math.max(5, Math.floor(envNum(process.env.RAG_AB_AUTO_PROMOTE_MIN_SAMPLES, d.abAutoPromoteMinSamples))),
    abAutoPromoteMinDelta: Math.max(0, Math.min(1, envNum(process.env.RAG_AB_AUTO_PROMOTE_MIN_DELTA, d.abAutoPromoteMinDelta))),
    enableSharedIdentity: envBool(process.env.RAG_ENABLE_SHARED_IDENTITY, d.enableSharedIdentity),
    enforceIdentityRoles: envBool(process.env.RAG_ENFORCE_IDENTITY_ROLES, d.enforceIdentityRoles),
    requiredIdentityRoles: String(process.env.RAG_REQUIRED_IDENTITY_ROLES ?? "")
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    enableDedicatedRerank: envBool(process.env.RAG_ENABLE_DEDICATED_RERANK, d.enableDedicatedRerank),
    dedicatedRerankUrl: String(process.env.RAG_DEDICATED_RERANK_URL ?? d.dedicatedRerankUrl).trim() || undefined,
    dedicatedRerankModel: String(process.env.RAG_DEDICATED_RERANK_MODEL ?? d.dedicatedRerankModel).trim(),
    enableEmbeddingRerank: envBool(process.env.RAG_ENABLE_EMBEDDING_RERANK, d.enableEmbeddingRerank),
    embeddingRerankSkipLlmThreshold: Math.max(
      0,
      Math.min(1, envNum(process.env.RAG_EMBEDDING_RERANK_SKIP_LLM, d.embeddingRerankSkipLlmThreshold))
    ),
    enableOnnxRerank: envBool(process.env.RAG_ENABLE_ONNX_RERANK, d.enableOnnxRerank),
    enableRetrievalBandit: envBool(process.env.RAG_ENABLE_RETRIEVAL_BANDIT, d.enableRetrievalBandit),
    retrievalBanditExplorePercent: Math.max(0, Math.min(30, Math.floor(envNum(process.env.RAG_RETRIEVAL_BANDIT_EXPLORE_PCT, d.retrievalBanditExplorePercent)))),
    enableBanditMultiObjective: envBool(process.env.RAG_BANDIT_MULTI_OBJECTIVE, d.enableBanditMultiObjective),
    banditTargetLatencyMs: Math.max(500, Math.floor(envNum(process.env.RAG_BANDIT_TARGET_LATENCY_MS, d.banditTargetLatencyMs))),
    enableOidc: envBool(process.env.RAG_OIDC_ENABLED, d.enableOidc),
    oidcIssuer: String(process.env.RAG_OIDC_ISSUER ?? "").trim(),
    oidcAudience: String(process.env.RAG_OIDC_AUDIENCE ?? "").trim(),
    oidcUserinfoUrl: String(process.env.RAG_OIDC_USERINFO_URL ?? "").trim(),
    oidcTrustGateway: envBool(process.env.RAG_OIDC_TRUST_GATEWAY, d.oidcTrustGateway),
    corpusTier: activeTier,
    corpusTierLabel: activeTier ? RAG_CORPUS_TIER_LABELS[activeTier] : null,
    chatModel: chat,
    expansionModel: expansion,
    rerankModel: llmRerankChatModel(chat, expansion),
    condenseModel: process.env.CONDENSE_MODEL ?? expansion,
    queryPlanModel: process.env.QUERY_PLAN_MODEL ?? expansion,
    evidenceSelectModel: process.env.RAG_EVIDENCE_SELECT_MODEL ?? chat,
    crossEncoderModel:
      process.env.RAG_CROSS_ENCODER_MODEL ?? (isDashScopeBase() ? "gte-rerank-v2" : undefined),
    contextExtractModel: process.env.RAG_CONTEXT_EXTRACT_MODEL ?? chat,
    summaryModel: process.env.SUMMARY_MODEL ?? chat,
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-v3",
    vectorBackend: (() => {
      const s = String(process.env.RAG_VECTOR_BACKEND ?? "memory").trim().toLowerCase();
      return s === "pg" || s === "postgres" || s === "pgvector" ? "pgvector" : "memory";
    })(),
  };
}
