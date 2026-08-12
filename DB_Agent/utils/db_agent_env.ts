/**
 * 蓝图与运行时常量；成本相关项可通过 .env 覆盖（见 getDbAgentBlueprintEnv）。
 */

import { isAgentPromptEvolutionEnabled } from "#agent-shared/agentEvolutionMode";
import { areDbLegacyShortcutsEnabled, isSchemaFirstRouteEnabled } from "./db_route_mode";

function parseEnvBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return fallback;
  const s = String(v).trim().toLowerCase();
  if (/^(0|false|off|no)$/i.test(s)) return false;
  return /^(1|true|yes|on)$/i.test(s);
}

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseEnvFloat(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 代码内默认值（偏省 token）；生产以 getDbAgentBlueprintEnv() 为准（含 .env 覆盖）。 */
export const DB_AGENT_DEFAULTS = {
  sqlAgentMaxIter: 6,
  sqlAgentTopK: 8,
  enableExplore: false,
  exploreMaxTables: 2,
  exploreMaxChars: 720,
  enableBlueprintHints: true,
  enableSqlBusinessGuard: true,
  enableSqlPreflight: true,
  sqlPreflightMinQuestionChars: 6,
  agentPlanMaxChars: 900,
  agentPreflightMaxChars: 460,
  schemaSummaryMaxTables: 3,
  schemaSummaryCharsPerTable: 380,
  maxModelInputChars: 2800,
  sqlDirectMaxContextChars: 2400,
  experienceBlockMaxChars: 300,
  sqlTemplateBlockMaxChars: 380,
  chatHistoryMaxMessages: 6,
  chatHistoryMaxChars: 1200,
  chatHistoryMessageMaxChars: 320,
  enableSchemaGround: true,
  enableSqlDirect: true,
  enableExplainPreflight: true,
  enableDomainSkills: false,
  domain: "p2026",
  profile: "balanced",
  enableQueryLearning: true,
  enablePromptEvolution: true,
  enableRoutePolicy: true,
  enableSchemaTableJudge: true,
  enableBlueprintLlmSelect: false,
  promptPromoteMinHits: 3,
  enableSqlTemplateLearning: true,
  /** 默认关：curate 只产出 shadow；晋级须人审（见 evolutionPromotePolicy） */
  enableAutoCurateOnQuery: false,
  enableClarificationLoop: true,
  clarificationConfidenceThreshold: 0.55,
  enableUserPreferences: true,
  enableTaskStack: true,
  enableVectorExperience: true,
  vectorExperienceMinScore: 0.72,
  vectorExperienceMaxEntries: 200,
  embeddingMaxInputChars: 96,
  embeddingQueryCacheTtlSec: 600,
  vectorRecallOnlyWhenNgramWeak: true,
  vectorNgramStrongScore: 0.72,
  vectorIndexMinQuestionChars: 8,
  enableFailureReflect: true,
  failureReflectMinQuestionChars: 10,
  /** P0：空结果 / 软失败不进 ReAct，仅硬错误才 fallback Agent */
  agentFallbackOnlyOnHardFail: true,
  /** P6：列链接 + QueryIR 编译（L2+ 复杂条件） */
  enableQueryIr: true,
  /** P2：高相似度历史 SQL 直出（跳过 LLM 生成） */
  enableSqlTemplateDirect: true,
  sqlTemplateDirectMinScore: 0.88,
  /** P2-3：向量经验库带 SQL 直出 */
  enableExperienceSqlDirect: true,
  experienceSqlDirectMinScore: 0.85,
  /** P3：补丁 metrics.json 统计直出（0 LLM） */
  enableMetricsDirect: false,
  enableSchemaFirstRoute: true,
  schemaCacheTtlSec: 300,
  /** P0-2：preflight + sql 单次 LLM（跳过独立 sql_preflight） */
  enableSqlPlanDirect: true,
  /** P0 进阶：结构性 QueryPlan，跳过 plan LLM（low_token 默认开；生产默认关） */
  enableStructuralPlan: false,
  structuralPlanMinConfidence: 0.62,
} as const;

export type DbAgentProfile = "balanced" | "low_token" | "full";

export type DbAgentBlueprintEnv = {
  sqlAgentMaxIter: number;
  sqlAgentTopK: number;
  enableExplore: boolean;
  exploreMaxTables: number;
  exploreMaxChars: number;
  enableBlueprintHints: boolean;
  enableSqlBusinessGuard: boolean;
  enableSqlPreflight: boolean;
  sqlPreflightMinQuestionChars: number;
  agentPlanMaxChars: number;
  agentPreflightMaxChars: number;
  schemaSummaryMaxTables: number;
  schemaSummaryCharsPerTable: number;
  maxModelInputChars: number;
  sqlDirectMaxContextChars: number;
  experienceBlockMaxChars: number;
  sqlTemplateBlockMaxChars: number;
  chatHistoryMaxMessages: number;
  chatHistoryMaxChars: number;
  chatHistoryMessageMaxChars: number;
  enableSchemaGround: boolean;
  enableSqlDirect: boolean;
  enableExplainPreflight: boolean;
  enableQueryLearning: boolean;
  enablePromptEvolution: boolean;
  enableRoutePolicy: boolean;
  enableSchemaTableJudge: boolean;
  enableBlueprintLlmSelect: boolean;
  promptPromoteMinHits: number;
  enableSqlTemplateLearning: boolean;
  enableAutoCurateOnQuery: boolean;
  enableClarificationLoop: boolean;
  clarificationConfidenceThreshold: number;
  enableUserPreferences: boolean;
  enableTaskStack: boolean;
  enableVectorExperience: boolean;
  vectorExperienceMinScore: number;
  vectorExperienceMaxEntries: number;
  embeddingMaxInputChars: number;
  embeddingQueryCacheTtlSec: number;
  vectorRecallOnlyWhenNgramWeak: boolean;
  vectorNgramStrongScore: number;
  vectorIndexMinQuestionChars: number;
  enableFailureReflect: boolean;
  failureReflectMinQuestionChars: number;
  enableDomainSkills: boolean;
  domain: string;
  profile: DbAgentProfile;
  agentFallbackOnlyOnHardFail: boolean;
  enableQueryIr: boolean;
  enableSqlTemplateDirect: boolean;
  sqlTemplateDirectMinScore: number;
  enableExperienceSqlDirect: boolean;
  experienceSqlDirectMinScore: number;
  enableMetricsDirect: boolean;
  enableSchemaFirstRoute: boolean;
  schemaCacheTtlSec: number;
  enableSqlPlanDirect: boolean;
  enableStructuralPlan: boolean;
  structuralPlanMinConfidence: number;
};

function resolveProfile(): DbAgentProfile {
  const raw = String(process.env.DB_AGENT_PROFILE ?? DB_AGENT_DEFAULTS.profile).trim().toLowerCase();
  if (raw === "low_token" || raw === "full") return raw;
  return "balanced";
}

function applyProfile(base: DbAgentBlueprintEnv, profile: DbAgentProfile): DbAgentBlueprintEnv {
  if (profile === "low_token") {
    return {
      ...base,
      enableSchemaTableJudge: false,
      enableSchemaFirstRoute: false,
      enableSqlPreflight: false,
      enableFailureReflect: false,
      enableTaskStack: false,
      enableMetricsDirect: true,
      sqlAgentMaxIter: Math.min(base.sqlAgentMaxIter, 3),
      maxModelInputChars: Math.min(base.maxModelInputChars, 1800),
      schemaSummaryMaxTables: Math.min(base.schemaSummaryMaxTables, 2),
      sqlDirectMaxContextChars: Math.min(base.sqlDirectMaxContextChars, 2000),
      agentFallbackOnlyOnHardFail: true,
      enableSqlPlanDirect: true,
      enableStructuralPlan: true,
    };
  }
  if (profile === "full") {
    return {
      ...base,
      enableSchemaTableJudge: true,
      enableSchemaFirstRoute: true,
      enableSqlPreflight: true,
      enableFailureReflect: true,
      enableTaskStack: true,
      enableQueryIr: true,
      enableMetricsDirect: base.enableMetricsDirect,
      agentFallbackOnlyOnHardFail: false,
    };
  }
  if (profile === "balanced") {
    return {
      ...base,
      enableSchemaTableJudge: true,
      enableSchemaFirstRoute: true,
      enableStructuralPlan: false,
      enableSqlPlanDirect: true,
      enableMetricsDirect: base.enableMetricsDirect,
      enableDomainSkills: false,
      agentFallbackOnlyOnHardFail: true,
    };
  }
  return base;
}

export function getDbAgentBlueprintEnv(): DbAgentBlueprintEnv {
  const d = DB_AGENT_DEFAULTS;
  const domain =
    String(process.env.DB_AGENT_DOMAIN ?? process.env.AGENT_DOMAIN ?? d.domain).trim() || d.domain;
  const base: DbAgentBlueprintEnv = {
    ...d,
    domain,
    profile: resolveProfile(),
    sqlAgentMaxIter: parseEnvInt("SQL_AGENT_MAX_ITER", d.sqlAgentMaxIter, 3, 12),
    sqlAgentTopK: parseEnvInt("SQL_AGENT_TOP_K", d.sqlAgentTopK, 4, 20),
    exploreMaxChars: parseEnvInt("EXPLORE_MAX_CHARS", d.exploreMaxChars, 200, 2000),
    agentPlanMaxChars: parseEnvInt("AGENT_PLAN_MAX_CHARS", d.agentPlanMaxChars, 400, 2000),
    agentPreflightMaxChars: parseEnvInt("AGENT_PREFLIGHT_MAX_CHARS", d.agentPreflightMaxChars, 200, 1200),
    schemaSummaryMaxTables: parseEnvInt("SCHEMA_SUMMARY_MAX_TABLES", d.schemaSummaryMaxTables, 1, 8),
    schemaSummaryCharsPerTable: parseEnvInt("SCHEMA_CHARS_PER_TABLE", d.schemaSummaryCharsPerTable, 200, 800),
    maxModelInputChars: parseEnvInt("MAX_MODEL_INPUT_CHARS", d.maxModelInputChars, 1200, 6000),
    sqlDirectMaxContextChars: parseEnvInt("SQL_DIRECT_MAX_CONTEXT_CHARS", d.sqlDirectMaxContextChars, 1200, 4000),
    experienceBlockMaxChars: parseEnvInt("EXPERIENCE_BLOCK_MAX_CHARS", d.experienceBlockMaxChars, 120, 600),
    sqlTemplateBlockMaxChars: parseEnvInt("SQL_TEMPLATE_BLOCK_MAX_CHARS", d.sqlTemplateBlockMaxChars, 120, 800),
    chatHistoryMaxMessages: parseEnvInt("CHAT_HISTORY_MAX_MESSAGES", d.chatHistoryMaxMessages, 2, 12),
    chatHistoryMaxChars: parseEnvInt("CHAT_HISTORY_MAX_CHARS", d.chatHistoryMaxChars, 400, 4000),
    chatHistoryMessageMaxChars: parseEnvInt("CHAT_HISTORY_MESSAGE_MAX_CHARS", d.chatHistoryMessageMaxChars, 120, 800),
    vectorExperienceMaxEntries: parseEnvInt("VECTOR_EXPERIENCE_MAX_ENTRIES", d.vectorExperienceMaxEntries, 50, 500),
    embeddingMaxInputChars: parseEnvInt("EMBEDDING_MAX_INPUT_CHARS", d.embeddingMaxInputChars, 32, 256),
    embeddingQueryCacheTtlSec: parseEnvInt("EMBEDDING_QUERY_CACHE_TTL_SEC", d.embeddingQueryCacheTtlSec, 60, 3600),
    vectorRecallOnlyWhenNgramWeak: parseEnvBool("VECTOR_RECALL_ONLY_WHEN_NGRAM_WEAK", d.vectorRecallOnlyWhenNgramWeak),
    vectorNgramStrongScore: parseEnvFloat("VECTOR_NGRAM_STRONG_SCORE", d.vectorNgramStrongScore, 0.5, 0.95),
    vectorIndexMinQuestionChars: parseEnvInt("VECTOR_INDEX_MIN_QUESTION_CHARS", d.vectorIndexMinQuestionChars, 4, 40),
    enableExplore: parseEnvBool("ENABLE_EXPLORE", d.enableExplore),
    enableBlueprintHints: parseEnvBool("ENABLE_BLUEPRINT_HINTS", d.enableBlueprintHints),
    enableSqlBusinessGuard: parseEnvBool("ENABLE_SQL_BUSINESS_GUARD", d.enableSqlBusinessGuard),
    enableSqlPreflight: parseEnvBool("ENABLE_SQL_PREFLIGHT", d.enableSqlPreflight),
    enableSchemaGround: parseEnvBool("ENABLE_SCHEMA_GROUND", d.enableSchemaGround),
    enableSqlDirect: parseEnvBool("ENABLE_SQL_DIRECT", d.enableSqlDirect),
    enableExplainPreflight: parseEnvBool("ENABLE_EXPLAIN_PREFLIGHT", d.enableExplainPreflight),
    enableQueryLearning: parseEnvBool("ENABLE_QUERY_LEARNING", d.enableQueryLearning),
    enablePromptEvolution: parseEnvBool("ENABLE_PROMPT_EVOLUTION", isAgentPromptEvolutionEnabled(process.env)),
    enableRoutePolicy: parseEnvBool("ENABLE_ROUTE_POLICY", d.enableRoutePolicy),
    enableSchemaTableJudge: parseEnvBool("ENABLE_SCHEMA_TABLE_JUDGE", d.enableSchemaTableJudge),
    enableBlueprintLlmSelect: parseEnvBool("ENABLE_BLUEPRINT_LLM_SELECT", d.enableBlueprintLlmSelect),
    enableSqlTemplateLearning: parseEnvBool("ENABLE_SQL_TEMPLATE_LEARNING", d.enableSqlTemplateLearning),
    enableAutoCurateOnQuery: parseEnvBool("ENABLE_AUTO_CURATE_ON_QUERY", d.enableAutoCurateOnQuery),
    enableClarificationLoop: parseEnvBool("ENABLE_CLARIFICATION_LOOP", d.enableClarificationLoop),
    enableUserPreferences: parseEnvBool("ENABLE_USER_PREFERENCES", d.enableUserPreferences),
    enableTaskStack: parseEnvBool("ENABLE_TASK_STACK", d.enableTaskStack),
    enableVectorExperience: parseEnvBool("ENABLE_VECTOR_EXPERIENCE", d.enableVectorExperience),
    enableFailureReflect: parseEnvBool("ENABLE_FAILURE_REFLECT", d.enableFailureReflect),
    enableDomainSkills: parseEnvBool("ENABLE_DOMAIN_SKILLS", areDbLegacyShortcutsEnabled(process.env)),
    agentFallbackOnlyOnHardFail: parseEnvBool("AGENT_FALLBACK_ONLY_ON_HARD_FAIL", d.agentFallbackOnlyOnHardFail),
    enableQueryIr: parseEnvBool("ENABLE_QUERY_IR", d.enableQueryIr),
    enableSqlTemplateDirect: parseEnvBool("ENABLE_SQL_TEMPLATE_DIRECT", d.enableSqlTemplateDirect),
    sqlTemplateDirectMinScore: parseEnvFloat("SQL_TEMPLATE_DIRECT_MIN_SCORE", d.sqlTemplateDirectMinScore, 0.7, 0.99),
    enableExperienceSqlDirect: parseEnvBool("ENABLE_EXPERIENCE_SQL_DIRECT", d.enableExperienceSqlDirect),
    experienceSqlDirectMinScore: parseEnvFloat(
      "EXPERIENCE_SQL_DIRECT_MIN_SCORE",
      d.experienceSqlDirectMinScore,
      0.7,
      0.99,
    ),
    enableMetricsDirect: parseEnvBool("ENABLE_METRICS_DIRECT", areDbLegacyShortcutsEnabled(process.env) && d.enableMetricsDirect),
    enableSchemaFirstRoute: parseEnvBool("ENABLE_SCHEMA_FIRST_ROUTE", isSchemaFirstRouteEnabled(process.env)),
    schemaCacheTtlSec: parseEnvInt("SCHEMA_CACHE_TTL_SEC", d.schemaCacheTtlSec, 30, 3600),
    enableSqlPlanDirect: parseEnvBool("ENABLE_SQL_PLAN_DIRECT", d.enableSqlPlanDirect),
    enableStructuralPlan: parseEnvBool("ENABLE_STRUCTURAL_PLAN", d.enableStructuralPlan),
    structuralPlanMinConfidence: parseEnvFloat(
      "STRUCTURAL_PLAN_MIN_CONFIDENCE",
      d.structuralPlanMinConfidence,
      0.45,
      0.95,
    ),
    failureReflectMinQuestionChars: parseEnvInt(
      "FAILURE_REFLECT_MIN_QUESTION_CHARS",
      d.failureReflectMinQuestionChars,
      4,
      80,
    ),
  };
  return applyProfile(base, base.profile);
}
