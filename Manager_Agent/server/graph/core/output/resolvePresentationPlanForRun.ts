import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'
import { resolveOrchestrationThickness } from '../routing/orchestrationThickness'
import {
  buildAvailableArtifacts,
  type PresentationPlan
} from '#agent-shared/presentationPlan'
import { resolvePresentationPlan } from '../../llm/presentationPlanLlm'

export async function resolvePresentationPlanForRun(input: {
  question: string
  results?: Record<string, unknown>
  evidence?: unknown[]
  meta?: Record<string, unknown>
  planSteps?: Array<{ agent?: string }>
  intent?: string
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<PresentationPlan> {
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {}
  const thickness = resolveOrchestrationThickness({
    meta,
    intent: input.intent,
    allowedAgents: Array.isArray(meta.allowedAgents)
      ? (meta.allowedAgents as string[])
      : undefined
  })
  const artifacts = buildAvailableArtifacts({
    results: input.results,
    evidence: input.evidence,
    meta,
    planSteps: input.planSteps
  })
  const turnScopeLlm = meta.turnScopeLlm as { turnKind?: string } | undefined
  const turnKind =
    String(meta.turnKind || turnScopeLlm?.turnKind || '').trim() || undefined
  return resolvePresentationPlan({
    question: input.question,
    thickness,
    turnKind,
    artifacts,
    llmInvoke: input.llmInvoke,
    state: input.state
  })
}
