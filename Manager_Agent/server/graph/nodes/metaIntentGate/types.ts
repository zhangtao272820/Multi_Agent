import type { SendEvent } from '../../state/graphFactoryHelpers'

export type CreateMetaIntentGateNodeDeps = {
  opts: {
    sendEvent: SendEvent
    runId?: string
    openaiApiKey?: string
    openaiModel?: string
    openaiBaseUrl?: string
  }
  lastUserText: (messages: unknown, routedQuery?: string) => string
  mergeMeta: (state: unknown, patch: Record<string, unknown>) => unknown
}
