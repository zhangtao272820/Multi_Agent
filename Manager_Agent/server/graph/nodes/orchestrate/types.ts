import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'

export type CreateOrchestrateNodeDeps = {
  policyDir: string
  sessionId?: string
  opts: {
    sendEvent: (event: { event: string; data?: any; from?: string }) => void
    runId?: string
    multimodalAgentHttpUrl?: string
    signal?: AbortSignal
  }
  lastUserText: (messages: any[]) => string
  llmInvoke: LlmInvokeFn
  mergeMeta: (state: any, patch: Record<string, any>) => Record<string, any>
}
