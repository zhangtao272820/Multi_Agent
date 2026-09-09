import type { RagRelevanceJudge, RagEvidenceMatchJudge, RagScopeHintJudge } from '../../../utils/rag/managerRagRelevance'
import type { ManagerGraphState } from '../../state/state'
import type { Intent, Step } from '../../../utils/shared/taskPlan'

export type AgentExecutorOpts = {
  runId: string
  threadId?: string
  sessionId?: string
  userId?: string
  tenantId?: string
  timeoutMs: number
  signal?: AbortSignal
  dbAgentWsUrl: string
  dbAgentHttpUrl: string
  dbId?: string
  ragAgentHttpUrl: string
  ragHistory?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  ragConversationId?: string
  codeAgentWsUrl: string
  crawlerAgentWsUrl: string
  lobsterAgentWsUrl: string
  aiAdminAgentWsUrl: string
  multimodalAgentHttpUrl: string
  musicAgentWsUrl: string
  videoAgentWsUrl: string
  sendEvent: (event: { event: string; data?: unknown; from?: string }) => void
}

export type AgentExecutorDeps = {
  callDbAgent: (input: Record<string, unknown>) => Promise<import('../../../utils/agents/types').DbResult>
  callRagAgent: (input: Record<string, unknown>) => Promise<string | import('../../../utils/agents/agentResult').AgentCallResult>
  callCrawlerAgent: (input: Record<string, unknown>) => Promise<unknown>
  callLobsterAgent: (input: Record<string, unknown>) => Promise<unknown>
  callCodeAgent: (input: Record<string, unknown>) => Promise<{ answer: string; meta?: unknown }>
  callAiAdminAgent: (input: Record<string, unknown>) => Promise<unknown>
  callMultimodalAgent: (input: Record<string, unknown>) => Promise<string | import('../../../utils/agents/agentResult').AgentCallResult>
  callMusicAgent: (input: Record<string, unknown>) => Promise<string | import('../../../utils/agents/agentResult').AgentCallResult>
  callVideoAgent: (input: Record<string, unknown>) => Promise<string | import('../../../utils/agents/agentResult').AgentCallResult>
  probeRagEvidence: (query: string) => Promise<unknown>
  ragEvidenceFromProbe?: (query: string, probeRag?: unknown) => unknown
  filterCrawlerResultDomestic: (obj: unknown) => unknown
  isDbNoData: (text: string) => boolean
  ragRelevanceJudge: RagRelevanceJudge
  ragEvidenceMatchJudge?: RagEvidenceMatchJudge
  ragScopeHintJudge?: RagScopeHintJudge
  lastUserText: (messages: ManagerGraphState['messages']) => string
  buildClarifyQuestions?: (text: string, intent?: Intent, probe?: ManagerGraphState['probe']) => string[]
  runInternalAgent?: (
    kind: 'clean' | 'visualize' | 'report',
    question: string,
    state: ManagerGraphState,
    contextInput?: unknown
  ) => Promise<string | { answer: string; resources?: unknown; meta?: unknown }>
}

export type AgentStepSuccess = {
  ok: true
  agent: Step['agent']
  output: string
  query: string
  parsed?: unknown
  meta?: unknown
  evidence?: Record<string, unknown>
  clarifyQuestions?: string[]
}

export type AgentStepFailure = {
  ok: false
  agent: Step['agent']
  output: string
  query: string
  error: string
  clarifyQuestions?: string[]
  meta?: unknown
}

export type AgentStepOutcome = AgentStepSuccess | AgentStepFailure

export type VoteScore = {
  score: number
  reason?: string
}
