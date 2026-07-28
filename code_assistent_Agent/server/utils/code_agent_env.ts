/**
 * Code Agent 运行时常量；原细粒度环境变量收敛至此，.env 只保留密钥、模型与必要开关。
 * 注：本文件会被 nuxt.config 在 alias 生效前加载，不可 import #agent-shared。
 */

function isCodePromptEvolutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CODE_ENABLE_PROMPT_EVOLUTION
  if (raw !== undefined && String(raw).trim() !== '') {
    return !/^(0|false|off|no)$/i.test(String(raw).trim())
  }
  const mode = String(env.EVO_MODE ?? env.MANAGER_EVOLUTION_MODE ?? '').trim().toLowerCase()
  if (mode === 'off' || mode === '0' || mode === 'false' || mode === 'no') return false
  return true
}

function resolveCodeLearningMaster(): boolean {
  const mode = String(process.env.CODE_LEARNING_MODE ?? '').trim().toLowerCase()
  if (mode === 'convergence' || mode === 'learning' || mode === 'on') return true
  if (mode === 'off' || mode === '0' || mode === 'false') return false
  return parseEnvBool('CODE_ENABLE_LEARNING', CODE_AGENT_DEFAULTS.enableLearningLoop)
}

function parseEnvBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v == null || String(v).trim() === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(v).trim())
}

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function parseEnvScopes(raw: string | undefined, fallback: string[]): string[] {
  const s = String(raw ?? '').trim()
  if (!s) return fallback
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

export const CODE_AGENT_DEFAULTS = {
  openaiEmbeddingModel: 'text-embedding-v1',
  chatOnlyMode: false,
  writeToolEnabled: false,
  commandToolEnabled: false,
  commandTimeoutMs: 90_000,
  requireAuthForDangerousTools: true,
  autoValidateAfterWrite: true,
  autoValidateLevel: 'quick' as 'quick' | 'full',
  autoValidateStopOnFail: true,
  autoRepairOnValidateFail: false,
  autoRepairMaxRounds: 1,
  autoRepairSecondLayer: false,
  authEnabled: false,
  requireScopesForDangerousTools: true,
  dangerousToolScopes: ['write:repo', 'run:script'] as string[],
  rateLimitEnabled: true,
  rateLimitMaxPerMinute: 60,
  incomingQuestionMaxChars: 4_000,
  computeMaxContextChars: 12_000,
  computeMaxQuestionChars: 2_000,
  enableMetrics: true,
  metricsRecentLimit: 50,
  retrieveMaxResults: 10,
  retrieveMaxFiles: 800,
  retrieveMaxCandidates: 60,
  enableLearningLoop: true,
  enableCodeClarification: true,
  learningSignalsMaxRead: 600,
  enableVectorExperience: true,
  vectorExperienceMaxEntries: 300,
  vectorExperienceMinScore: 0.72,
  vectorIndexMinQuestionChars: 8,
  embeddingMaxInputChars: 400,
  embeddingQueryCacheTtlSec: 300,
  enablePromptEvolution: true,
  enableCrossAgentMemory: true,
  enableCrossAgentWriteBack: false,
  enablePromptAbTest: true,
  promptAbTreatmentPercent: 50,
  promptEvolveMinHits: 3,
  repoMapEnabled: true,
  repoMapTokenBudget: 1024,
  repoMapMaxFiles: 600,
  editFormat: 'search_replace' as const,
  editValidateRequired: true,
  editValidateRecover: true,
  runCommandEnabled: false,
  runCommandTimeoutMs: 90_000,
  agentWorktreeMode: 'off' as 'off' | 'branch' | 'worktree',
  architectMode: false,
  subagentEnabled: false,
  subagentMinFiles: 3,
  exportFactsEnabled: true,
  /** ReAct 工具轮次上限（防死循环，对齐 N2） */
  maxToolRounds: 12,
} as const

export type CodeAgentEnv = typeof CODE_AGENT_DEFAULTS

let cached: { at: number; env: CodeAgentEnv } | null = null

export function getCodeAgentEnv(): CodeAgentEnv {
  const now = Date.now()
  if (cached && now - cached.at < 5_000) return cached.env
  const d = CODE_AGENT_DEFAULTS
  const env: CodeAgentEnv = {
    openaiEmbeddingModel: String(process.env.OPENAI_EMBEDDING_MODEL || d.openaiEmbeddingModel).trim() || d.openaiEmbeddingModel,
    chatOnlyMode: parseEnvBool('CHAT_ONLY_MODE', d.chatOnlyMode),
    writeToolEnabled: parseEnvBool('WRITE_TOOL_ENABLED', d.writeToolEnabled),
    commandToolEnabled: parseEnvBool('COMMAND_TOOL_ENABLED', d.commandToolEnabled),
    commandTimeoutMs: parseEnvInt('COMMAND_TOOL_TIMEOUT_MS', d.commandTimeoutMs, 5_000, 600_000),
    requireAuthForDangerousTools: parseEnvBool('REQUIRE_AUTH_FOR_DANGEROUS_TOOLS', d.requireAuthForDangerousTools),
    autoValidateAfterWrite: parseEnvBool('AUTO_VALIDATE_AFTER_WRITE', d.autoValidateAfterWrite),
    autoValidateLevel: process.env.AUTO_VALIDATE_LEVEL === 'full' ? 'full' : d.autoValidateLevel,
    autoValidateStopOnFail: parseEnvBool('AUTO_VALIDATE_STOP_ON_FAIL', d.autoValidateStopOnFail),
    autoRepairOnValidateFail: parseEnvBool('AUTO_REPAIR_ON_VALIDATE_FAIL', d.autoRepairOnValidateFail),
    autoRepairMaxRounds: parseEnvInt('AUTO_REPAIR_MAX_ROUNDS', d.autoRepairMaxRounds, 1, 3),
    autoRepairSecondLayer: parseEnvBool('AUTO_REPAIR_SECOND_LAYER', d.autoRepairSecondLayer),
    authEnabled: parseEnvBool('AUTH_ENABLED', d.authEnabled),
    requireScopesForDangerousTools: parseEnvBool('REQUIRE_SCOPES_FOR_DANGEROUS_TOOLS', d.requireScopesForDangerousTools),
    dangerousToolScopes: parseEnvScopes(process.env.DANGEROUS_TOOL_SCOPES, [...d.dangerousToolScopes]),
    rateLimitEnabled: parseEnvBool('RATE_LIMIT_ENABLED', d.rateLimitEnabled),
    rateLimitMaxPerMinute: parseEnvInt('RATE_LIMIT_MAX_PER_MINUTE', d.rateLimitMaxPerMinute, 10, 600),
    incomingQuestionMaxChars: parseEnvInt('CODE_INCOMING_MAX_CHARS', d.incomingQuestionMaxChars, 200, 16_000),
    computeMaxContextChars: parseEnvInt('CODE_COMPUTE_MAX_CONTEXT_CHARS', d.computeMaxContextChars, 500, 32_000),
    computeMaxQuestionChars: parseEnvInt('CODE_COMPUTE_MAX_QUESTION_CHARS', d.computeMaxQuestionChars, 80, 8_000),
    enableMetrics: parseEnvBool('CODE_ENABLE_METRICS', d.enableMetrics),
    metricsRecentLimit: parseEnvInt('CODE_METRICS_RECENT', d.metricsRecentLimit, 10, 200),
    retrieveMaxResults: parseEnvInt('CODE_RETRIEVE_MAX_RESULTS', d.retrieveMaxResults, 1, 50),
    retrieveMaxFiles: parseEnvInt('CODE_RETRIEVE_MAX_FILES', d.retrieveMaxFiles, 50, 2_000),
    retrieveMaxCandidates: parseEnvInt('CODE_RETRIEVE_MAX_CANDIDATES', d.retrieveMaxCandidates, 5, 200),
    enableLearningLoop: parseEnvBool('CODE_ENABLE_LEARNING', resolveCodeLearningMaster()),
    enableCodeClarification: parseEnvBool('CODE_ENABLE_CLARIFICATION', d.enableCodeClarification),
    learningSignalsMaxRead: parseEnvInt('CODE_LEARNING_MAX_READ', d.learningSignalsMaxRead, 100, 2_000),
    enableVectorExperience: parseEnvBool('CODE_ENABLE_VECTOR_EXPERIENCE', resolveCodeLearningMaster() && d.enableVectorExperience),
    vectorExperienceMaxEntries: parseEnvInt('CODE_VECTOR_MAX_ENTRIES', d.vectorExperienceMaxEntries, 50, 2_000),
    vectorExperienceMinScore: Number(process.env.CODE_VECTOR_MIN_SCORE) || d.vectorExperienceMinScore,
    vectorIndexMinQuestionChars: parseEnvInt('CODE_VECTOR_MIN_QUESTION_CHARS', d.vectorIndexMinQuestionChars, 4, 40),
    embeddingMaxInputChars: parseEnvInt('CODE_EMBEDDING_MAX_CHARS', d.embeddingMaxInputChars, 80, 2_000),
    embeddingQueryCacheTtlSec: parseEnvInt('CODE_EMBEDDING_CACHE_TTL', d.embeddingQueryCacheTtlSec, 30, 3600),
    enablePromptEvolution: parseEnvBool('CODE_ENABLE_PROMPT_EVOLUTION', isCodePromptEvolutionEnabled(process.env)),
    enableCrossAgentMemory: parseEnvBool('CODE_ENABLE_CROSS_AGENT_MEMORY', d.enableCrossAgentMemory),
    enableCrossAgentWriteBack: parseEnvBool('CODE_ENABLE_CROSS_AGENT_WRITE_BACK', d.enableCrossAgentWriteBack),
    enablePromptAbTest: parseEnvBool('CODE_ENABLE_PROMPT_AB', d.enablePromptAbTest),
    promptAbTreatmentPercent: parseEnvInt('CODE_PROMPT_AB_TREATMENT_PCT', d.promptAbTreatmentPercent, 0, 100),
    promptEvolveMinHits: parseEnvInt('CODE_PROMPT_EVOLVE_MIN_HITS', d.promptEvolveMinHits, 2, 12),
    repoMapEnabled: parseEnvBool('CODE_REPO_MAP_ENABLED', true),
    repoMapTokenBudget: parseEnvInt('CODE_REPO_MAP_TOKENS', 1024, 256, 8192),
    repoMapMaxFiles: parseEnvInt('CODE_REPO_MAP_MAX_FILES', 600, 100, 2000),
    editFormat: (process.env.CODE_EDIT_FORMAT === 'udiff' || process.env.CODE_EDIT_FORMAT === 'whole'
      ? process.env.CODE_EDIT_FORMAT
      : 'search_replace') as 'search_replace' | 'udiff' | 'whole',
    editValidateRequired: parseEnvBool('CODE_EDIT_VALIDATE_REQUIRED', true),
    editValidateRecover: parseEnvBool('CODE_EDIT_VALIDATE_RECOVER', true),
    runCommandEnabled: parseEnvBool('CODE_RUN_COMMAND_ENABLED', parseEnvBool('COMMAND_TOOL_ENABLED', d.commandToolEnabled)),
    runCommandTimeoutMs: parseEnvInt('CODE_RUN_COMMAND_TIMEOUT_MS', d.runCommandTimeoutMs, 5_000, 600_000),
    agentWorktreeMode: (() => {
      const v = String(process.env.CODE_AGENT_WORKTREE ?? '0').trim().toLowerCase()
      if (v === 'branch') return 'branch' as const
      if (v === 'worktree' || v === '1' || v === 'true') return 'worktree' as const
      return 'off' as const
    })(),
    architectMode: parseEnvBool('CODE_ARCHITECT_MODE', false),
    subagentEnabled: parseEnvBool('CODE_SUBAGENT_ENABLED', false),
    subagentMinFiles: parseEnvInt('CODE_SUBAGENT_MIN_FILES', 3, 2, 12),
    exportFactsEnabled: parseEnvBool('CODE_EXPORT_FACTS', true),
    maxToolRounds: parseEnvInt('CODE_MAX_TOOL_ROUNDS', d.maxToolRounds, 1, 24),
  }
  cached = { at: now, env }
  return env
}

/** 供 nuxt.config.ts 构建 runtimeConfig */
export function buildCodeAgentRuntimeConfig() {
  const e = getCodeAgentEnv()
  return {
    chatOnlyMode: e.chatOnlyMode,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    openaiModel: process.env.OPENAI_MODEL,
    openaiEmbeddingModel: e.openaiEmbeddingModel,
    tools: {
      writeEnabled: e.writeToolEnabled,
      commandEnabled: e.commandToolEnabled,
      commandTimeoutMs: e.commandTimeoutMs,
      requireAuthForDangerousTools: e.requireAuthForDangerousTools,
      autoValidateAfterWrite: e.autoValidateAfterWrite,
      autoValidateLevel: e.autoValidateLevel,
      autoValidateStopOnFail: e.autoValidateStopOnFail,
      autoRepairOnValidateFail: e.autoRepairOnValidateFail,
      autoRepairMaxRounds: e.autoRepairMaxRounds,
      autoRepairSecondLayer: e.autoRepairSecondLayer,
    },
    auth: {
      enabled: e.authEnabled,
      jwtSecret: process.env.JWT_SECRET,
      requireScopesForDangerousTools: e.requireScopesForDangerousTools,
      dangerousToolScopes: e.dangerousToolScopes,
    },
    rateLimit: {
      enabled: e.rateLimitEnabled,
      maxPerMinute: e.rateLimitMaxPerMinute,
    },
    public: {
      chatOnlyMode: e.chatOnlyMode,
      openaiModel: process.env.OPENAI_MODEL,
      openaiEmbeddingModel: e.openaiEmbeddingModel,
      authEnabled: e.authEnabled,
      writeToolEnabled: e.writeToolEnabled,
      commandToolEnabled: e.commandToolEnabled,
    },
  }
}
