export type AgentConfig = {
  openaiApiKey?: string
  openaiBaseUrl?: string
  lobster?: {
    plannerModel?: string
    decisionModel?: string
    visionModel?: string
    /** CAP_GUI / gui-plus computer_use */
    guiModel?: string
    stagehandModel?: string
    useVision?: boolean
    promptChars?: number
    plannerMaxTokens?: number
    decisionMaxTokens?: number
    extractMaxTokens?: number
    visionMaxTokens?: number
    storageDir?: string
    traceDir?: string
    enableTrace?: boolean
    enableVideo?: boolean
    videoDir?: string
    runsDir?: string
    runTtlMs?: number
    maxConcurrentRuns?: number
    enableOcr?: boolean
    ocrMaxChars?: number
    visionSummaryMaxChars?: number
    maxDecisionCalls?: number
    maxVisionCalls?: number
    maxOcrCalls?: number
    observationCandidateLimit?: number
    observationTextChars?: number
    loginWaitMs?: number
    loginPollMs?: number
    headless?: boolean
    maxSteps?: number
    maxRecoverCount?: number
    maxForcedIntentsTotal?: number
    maxForcedIntentsPerFailure?: number
    allowRiskyRecoveryClicks?: boolean
    adminToken?: string
    /** classic | mcp | auto */
    executionMode?: string
    mcpEnabled?: boolean
    mcpUrl?: string
    mcpMaxSteps?: number
    crawlerSameOriginOnly?: boolean
    crawlerAllowHostSuffixes?: string[]
    crawlerMaxUrls?: number
    crawlerConcurrency?: number
    crawlerTimeoutMs?: number
    crawlerMaxBytes?: number
    crawlerMinIntervalMs?: number
    policy?: {
      enabled?: boolean
      defaultDecision?: 'allow' | 'confirm' | 'deny'
      criticalDecision?: 'confirm' | 'deny'
      maxConfirmationsPerRun?: number
      confirmActions?: string[]
      denyActions?: string[]
      confirmTextPatterns?: string[]
      denyTextPatterns?: string[]
      siteRules?: Record<
        string,
        {
          enabled?: boolean
          defaultDecision?: 'allow' | 'confirm' | 'deny'
          criticalDecision?: 'confirm' | 'deny'
          maxConfirmationsPerRun?: number
          confirmActions?: string[]
          denyActions?: string[]
          confirmTextPatterns?: string[]
          denyTextPatterns?: string[]
        }
      >
    }
  }
}

export type LobsterPublicState = {
  phase: string
  stepCount: number
  pageUrl: string
  stage?: string
  completionCriteria?: Record<string, any>
  gate?: Record<string, any>
}

export type LobsterRunInsightPayload = {
  taskSpec?: Record<string, unknown>
  picked?: { engine: string; source: string; confidence: number; reason: string }
  chain?: string[]
  activeIndex?: number
  profile?: string
  sidecarNote?: string
  engine?: string
  /** 实跑引擎真相（含 workflow） */
  actualEngine?: string
  attemptIndex?: number
  verify?: { ok: boolean; reason: string; failureType?: string; hints?: string[]; retryable?: boolean }
  runId?: string
  storageProfile?: string
  browserProfile?: string
  workflowId?: string
}

export type EmitEvent =
  | { type: 'log'; payload: { level: 'info' | 'warn' | 'error'; message: string; ts: number } }
  | { type: 'thinking'; payload: { stage: string; text: string; ts: number } }
  | { type: 'state'; payload: LobsterPublicState }
  | { type: 'screenshot'; payload: { dataUrl: string; pageUrl?: string; ts: number } }
  | { type: 'live_view'; payload: { vncUrl: string; hint?: string; ts: number } }
  | { type: 'confirm'; payload: { id: string; title: string; message: string; ts: number } }
  | { type: 'error'; payload: { message: string; ts: number } }
  | { type: 'result'; payload: any }
  | { type: 'candidates'; payload: any[] }
  | { type: 'step'; payload: { kind: 'begin' | 'end'; meta: any; ts: number } }
  | { type: 'understand'; payload: LobsterRunInsightPayload & { ts: number } }
  | { type: 'engine_chain'; payload: LobsterRunInsightPayload & { ts: number } }
  | { type: 'engine_active'; payload: LobsterRunInsightPayload & { ts: number } }
  | { type: 'verify'; payload: LobsterRunInsightPayload & { ts: number } }
  | { type: 'run_meta'; payload: LobsterRunInsightPayload & { ts: number } }

export type RunParams = {
  runId?: string
  task: string
  startUrl?: string
  sessionId?: string
  storageProfile?: string
  engineHint?: string
  /** OpenClaw 式 Workflow Macro id（workflows/*.json）；有则优先确定性管道 */
  workflowId?: string
  workflowArgs?: Record<string, unknown>
  taskSpec?: import('./lobsterTaskUnderstandSchema').LobsterTaskSpec
  config: AgentConfig
  signal: AbortSignal
  emit: (evt: EmitEvent) => void
  human?: {
    waitWhilePaused: (signal: AbortSignal) => Promise<void>
    tryPopAction: () => any | null
    waitConfirm: (id: string, signal: AbortSignal) => Promise<boolean>
  }
}
