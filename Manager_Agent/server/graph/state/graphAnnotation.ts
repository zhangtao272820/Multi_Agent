import { Annotation } from '@langchain/langgraph'
import { BaseMessage } from '@langchain/core/messages'
import { z } from 'zod'
import {
  ForceIntentSchema,
  IntentSchema,
  normalizeEntities,
  type ForceIntent,
  type Intent,
  type Step,
  type TaskPlan
} from '../../utils/shared/taskPlan'

const FixStrategySchema = z.object({
  intent: IntentSchema,
  query: z.string().min(1),
  rationale: z.string().optional(),
  skipAgents: z.array(z.string()).optional()
})

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => []
  }),
  humanDecision: Annotation<'confirm' | 'cancel' | null>({
    reducer: (_x, y) => {
      const v = y as any
      if (v === 'confirm' || v === 'cancel') return v
      return null
    },
    default: () => null
  }),
  /** Admin 写确认后续跑：metacog 直达 admin_confirm_resume，禁止整图重路由 */
  resumeAdminConfirm: Annotation<boolean>({
    reducer: (_x, y) => (typeof y === 'boolean' ? y : Boolean(y)),
    default: () => false
  }),
  /** 确认后仅重 synth（不重新编排） */
  resumeToSynth: Annotation<boolean>({
    reducer: (_x, y) => (typeof y === 'boolean' ? y : Boolean(y)),
    default: () => false
  }),
  forceIntent: Annotation<ForceIntent>({
    reducer: (_x, y) => (ForceIntentSchema.safeParse(y).success ? (y as ForceIntent) : 'auto'),
    default: () => 'auto'
  }),
  mediaAttachment: Annotation<{
    filePath: string
    mediaType: 'image' | 'video' | 'audio'
    filename?: string
  } | null>({
    reducer: (_x, y) => (y === null || y === undefined ? null : y),
    default: () => null
  }),
  intent: Annotation<Intent>({
    reducer: (_x, y) => y ?? 'db',
    default: () => 'db'
  }),
  allowedAgents: Annotation<
    Array<'db' | 'rag' | 'code' | 'crawler' | 'admin' | 'visualize' | 'report' | 'clean' | 'multimodal' | 'music' | 'video'>
  >({
    reducer: (_x, y) => Array.isArray(y) ? y : [],
    default: () => []
  }),
  plan: Annotation<Step[]>({
    reducer: (_x, y) => y ?? [],
    default: () => []
  }),
  taskPlan: Annotation<TaskPlan | null>({
    reducer: (_x, y) => y ?? null,
    default: () => null
  }),
  routedQuery: Annotation<string>({
    reducer: (_x, y) => y ?? '',
    default: () => ''
  }),
  fixQuery: Annotation<string>({
    reducer: (_x, y) => y ?? '',
    default: () => ''
  }),
  fixIntent: Annotation<Intent | undefined>({
    reducer: (_x, y) => y,
    default: () => undefined
  }),
  entities: Annotation<{
    names: string[]
    records: string[]
    locations: string[]
    dates: string[]
  }>({
    /**
     * 仅用本轮路由返回值覆盖，不做跨轮累积合并。
     * 否则前几轮的人名/记录会一直留在 state，污染 planLint、规划与下游提示。
     */
    reducer: (x, y) => {
      if (y === undefined) return x ?? { names: [], records: [], locations: [], dates: [] }
      return normalizeEntities(y as any)
    },
    default: () => ({ names: [], records: [], locations: [], dates: [] })
  }),
  probe: Annotation<{
    db: { matched: boolean; tables: string[] }
    rag: { hasDocs: boolean; hits: number; sources: string[] }
  }>({
    reducer: (_x, y) =>
      y ?? {
        db: { matched: false, tables: [] },
        rag: { hasDocs: false, hits: 0, sources: [] }
      },
    default: () => ({ db: { matched: false, tables: [] }, rag: { hasDocs: false, hits: 0, sources: [] } })
  }),
  security: Annotation<{
    riskLevel: 'low' | 'medium' | 'high'
    flags: string[]
    checkedAt?: string
  }>({
    reducer: (_x, y) => y ?? { riskLevel: 'low', flags: [] },
    default: () => ({ riskLevel: 'low', flags: [] })
  }),
  scheduler: Annotation<{
    maxParallel: number
    timeoutScale: number
    contextBudget?: Record<string, number>
    skipAgents?: string[]
    agentTimeoutScale?: Record<string, number>
    circuitOpenAgents?: string[]
    degradeOptionalAgents?: string[]
    healthSummary?: string
    reason?: string
    generatedAt?: string
  }>({
    reducer: (_x, y) =>
      y ?? {
        maxParallel: 3,
        timeoutScale: 1,
        contextBudget: {},
        skipAgents: [],
        agentTimeoutScale: {},
        circuitOpenAgents: [],
        degradeOptionalAgents: [],
        healthSummary: ''
      },
    default: () => ({
      maxParallel: 3,
      timeoutScale: 1,
      contextBudget: {},
      skipAgents: [],
      agentTimeoutScale: {},
      circuitOpenAgents: [],
      degradeOptionalAgents: [],
      healthSummary: ''
    })
  }),
  executionMode: Annotation<{
    mode: 'serial' | 'parallel' | 'vote'
    reason?: string
    voteTargets?: string[]
    generatedAt?: string
  }>({
    reducer: (_x, y) => y ?? { mode: 'parallel', reason: 'default' },
    default: () => ({ mode: 'parallel', reason: 'default', voteTargets: [] })
  }),
  votePolicy: Annotation<{
    enabled: boolean
    targets: string[]
    scoring: {
      factWeight: number
      missingPenalty: number
      lengthPenalty: number
      evidenceSupportWeight: number
      conflictPenalty: number
    }
    generatedAt?: string
  }>({
    reducer: (_x, y) =>
      y ?? {
        enabled: false,
        targets: [],
        scoring: {
          factWeight: 1,
          missingPenalty: 1,
          lengthPenalty: 0.0002,
          evidenceSupportWeight: 1.2,
          conflictPenalty: 1.5
        }
      },
    default: () => ({
      enabled: false,
      targets: [],
      scoring: {
        factWeight: 1,
        missingPenalty: 1,
        lengthPenalty: 0.0002,
        evidenceSupportWeight: 1.2,
        conflictPenalty: 1.5
      }
    })
  }),
  monitor: Annotation<{
    resultAgents: string[]
    dataEvidenceCount: number
    errorCount: number
    clarifyCount: number
    summary: string
    checkedAt?: string
  }>({
    reducer: (_x, y) =>
      y ?? {
        resultAgents: [],
        dataEvidenceCount: 0,
        errorCount: 0,
        clarifyCount: 0,
        summary: ''
      },
    default: () => ({
      resultAgents: [],
      dataEvidenceCount: 0,
      errorCount: 0,
      clarifyCount: 0,
      summary: ''
    })
  }),
  evaluation: Annotation<{
    score: number
    hasAnswer: boolean
    hasDataEvidence: boolean
    errorCount: number
    timeoutErrorCount: number
    unsupportedClaims: number
    recommendation: 'accept' | 'retry' | 'retry_if_possible' | 'clarify'
    checkedAt?: string
  }>({
    reducer: (_x, y) =>
      y ?? {
        score: 0.7,
        hasAnswer: false,
        hasDataEvidence: false,
        errorCount: 0,
        timeoutErrorCount: 0,
        unsupportedClaims: 0,
        recommendation: 'accept'
      },
    default: () => ({
      score: 0.7,
      hasAnswer: false,
      hasDataEvidence: false,
      errorCount: 0,
      timeoutErrorCount: 0,
      unsupportedClaims: 0,
      recommendation: 'accept'
    })
  }),
  optimizer: Annotation<{
    action: 'clarify' | 'fix' | 'verifier' | 'replan_multi'
    reason?: string
    at?: string
  }>({
    reducer: (_x, y) => y ?? { action: 'verifier', reason: 'init' },
    default: () => ({ action: 'verifier', reason: 'init' })
  }),
  toolHealth: Annotation<{
    updatedAt: string
    summary: string
    registryVersion?: string
    agents: Array<{
      agent: string
      status: 'healthy' | 'degraded' | 'down' | 'unknown'
      avgMs: number
      p95Ms: number
      samples: number
      stepSkipCount?: number
      endpoint?: string
      liveProbe?: 'ok' | 'fail' | 'skip'
    }>
  }>({
    reducer: (_x, y) =>
      y ?? {
        updatedAt: '',
        summary: '未检测',
        agents: []
      },
    default: () => ({
      updatedAt: '',
      summary: '未检测',
      agents: []
    })
  }),
  results: Annotation<Record<string, string>>({
    reducer: (x, y) => ({ ...(x ?? {}), ...(y ?? {}) }),
    default: () => ({})
  }),
  evidence: Annotation<any[]>({
    reducer: (x, y) => (x ?? []).concat(y ?? []),
    default: () => []
  }),
  final: Annotation<string>({
    reducer: (_x, y) => y ?? '',
    default: () => ''
  }),
  retryCount: Annotation<number>({
    reducer: (_x, y) => y ?? 0,
    default: () => 0
  }),
  meta: Annotation<{
    capabilityOk: boolean
    boundaryReason?: string
    routeConfidence?: number
    finalConfidence?: number
    uncertainty?: 'low' | 'medium' | 'high'
    needsClarify?: boolean
    clarifyQuestions?: string[]
    lowCostMode?: boolean
    planLintOk?: boolean
    planLintIssues?: string[]
    evidenceSupportedClaimRate?: number
    unsupportedClaims?: string[]
    voteSummary?: string
    /** Synth 流式 LLM 正文（与 delta 一致，finalize/WS 优先使用） */
    synthStreamBody?: string
    /** 路由前 LLM 合并多轮后的纯任务句，供规划启发式优先使用 */
    nlHeuristicTask?: string
    nlCoalesceUsed?: boolean
    intentMergedLlm?: boolean
    sessionIntentAnchor?: {
      primaryIntent: string
      planShortcut: string
      suggestedAgents: string[]
      isDbAnchored: boolean
      isMulti: boolean
      coalescedTask?: string
      updatedAt: string
    }
    intentRagMultiTurn?: boolean
    nlCoalesceUsed?: boolean
    /** 子任务子句拆解结果 */
    taskClauses?: Array<{ id: string; text: string; agents: string[]; relevance?: Record<string, number> }>
    clauseDecomposeMode?: 'heuristic' | 'llm'
    clauseCount?: number
    experienceReplayCount?: number
    experienceReplayScenarioKey?: string
    planQualitySamples?: number
  }>({
    reducer: (x, y) => ({ ...(x ?? {}), ...(y ?? {}) }),
    default: () => ({
      capabilityOk: true,
      uncertainty: 'medium',
      needsClarify: false,
      clarifyQuestions: [],
      lowCostMode: false,
      planLintOk: true,
      planLintIssues: [],
      evidenceSupportedClaimRate: undefined,
        unsupportedClaims: [],
        voteSummary: ''
    })
  }),
  resources: Annotation<{
    startedAtMs: number
    deadlineAtMs: number
    budgetUsd?: number
    budgetTokens?: number
    usedUsd: number
    usedTokens: number
    modelRoute: string
    modelPlan: string
    modelSynth: string
    modelCritic: string
    modelVerifier: string
    modelLowCost: string
    modelClean: string
    modelVisualize: string
    modelReport: string
    costPer1kTokensUsd: number
  }>({
    reducer: (_x, y) => y,
    default: () => ({
      startedAtMs: Date.now(),
      deadlineAtMs: Date.now() + 60_000,
      usedUsd: 0,
      usedTokens: 0,
      modelRoute: '',
      modelPlan: '',
      modelSynth: '',
      modelCritic: '',
      modelVerifier: '',
      modelLowCost: '',
      modelClean: '',
      modelVisualize: '',
      modelReport: '',
      costPer1kTokensUsd: 0
    })
  })
})

export { FixStrategySchema, GraphState }
export type FixStrategy = z.infer<typeof FixStrategySchema>
