/**
 * RAG probe / prefetch 命中时的 slot 澄清抑制（确定性闸门，对齐 legacy router skipRouterClarify）。
 * 不读用户原话 regex；plane / ambiguous / 缺源澄清不受影响。
 */
import type { TaskOrchestratorBundle } from '../llm/taskOrchestrator'
import type { OrchestratorDecision } from './orchestratorInvariants'
import { shouldClarifyForAmbiguousCommitment, sourceCommitmentFromRaw } from './sourceCommitment'
import type { RagRetrievePrefetchResult } from '../core/rag/ragPrefetch'
import { isProbeDbRoutingRelevant, type ProbeDbSlice } from '../core/probe/probeInterpretation'

export function ragProbeHitCount(probe?: { rag?: { hits?: number } } | null): number {
  const n = Number(probe?.rag?.hits ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function ragPrefetchHitCount(prefetch?: RagRetrievePrefetchResult | null): number {
  if (!prefetch?.ok) return 0
  const n = Number(prefetch.hits ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** plane / ambiguous / 库存缺源：不得被 probe 抑制 */
export function isPlaneClarifyLocked(input: {
  decision?: Pick<OrchestratorDecision, 'clarifyKind' | 'metaPatch'>
  meta?: Record<string, unknown> | null
}): boolean {
  const meta = (input.meta && typeof input.meta === 'object' ? input.meta : input.decision?.metaPatch) as
    | Record<string, unknown>
    | undefined
  const ck = String(input.decision?.clarifyKind ?? meta?.clarifyKind ?? '').trim()
  if (ck === 'plane') return true
  if (meta?.clarifyForAmbiguousCommitment === true) return true
  if (meta?.clarifyForNoCoverage === true) return true
  if (String(meta?.sourceCommitment ?? '').trim() === 'ambiguous') return true
  return false
}

export function capIncludesRag(allowedAgents?: readonly string[] | null): boolean {
  return (allowedAgents ?? []).some((a) => String(a || '').trim() === 'rag')
}

export function dbProbeMatched(probe?: { db?: ProbeDbSlice } | null): boolean {
  return isProbeDbRoutingRelevant(probe?.db)
}

export function capIncludesDb(allowedAgents?: readonly string[] | null): boolean {
  return (allowedAgents ?? []).some((a) => String(a || '').trim() === 'db')
}

export function shouldSuppressSlotClarifyWhenDbProbeHit(input: {
  probe?: { db?: ProbeDbSlice; rag?: { hits?: number } } | null
  bundle?: TaskOrchestratorBundle
  decision?: Pick<
    OrchestratorDecision,
    'needsClarify' | 'clarifyKind' | 'allowedAgents' | 'intent' | 'intentClassify' | 'metaPatch'
  >
  meta?: Record<string, unknown> | null
}): boolean {
  if (!dbProbeMatched(input.probe)) return false
  if (isPlaneClarifyLocked({ decision: input.decision, meta: input.meta })) return false

  const taskIntent = String(
    (input.bundle?.raw as { taskIntent?: string } | undefined)?.taskIntent ||
      (input.meta as { taskIntent?: string } | undefined)?.taskIntent ||
      ''
  ).trim()
  const slice = sourceCommitmentFromRaw(input.bundle?.raw as Record<string, unknown>)
  if (shouldClarifyForAmbiguousCommitment(slice)) return false

  const ck = String(input.decision?.clarifyKind ?? (input.meta as { clarifyKind?: string })?.clarifyKind ?? 'none').trim()
  if (ck === 'plane') return false

  if (taskIntent === 'structured_query') return true
  if (slice.committedPlanes.includes('db')) return true
  if (capIncludesDb(input.decision?.allowedAgents)) return true
  if (String(input.decision?.intent || '').trim() === 'db') return true
  if (String(input.decision?.intentClassify?.planShortcut || '').trim() === 'db_only') return true
  if (String(input.decision?.intentClassify?.primaryIntent || '').trim() === 'db') return true
  if (input.decision?.intentClassify?.isDbAnchored === true) return true
  return false
}

export function shouldSuppressSlotClarifyWhenRagProbeHit(input: {
  probe?: { rag?: { hits?: number } } | null
  bundle?: TaskOrchestratorBundle
  decision?: Pick<
    OrchestratorDecision,
    'needsClarify' | 'clarifyKind' | 'allowedAgents' | 'intent' | 'intentClassify' | 'metaPatch'
  >
  meta?: Record<string, unknown> | null
}): boolean {
  if (ragProbeHitCount(input.probe) <= 0) return false
  if (isPlaneClarifyLocked({ decision: input.decision, meta: input.meta })) return false

  const taskIntent = String(
    (input.bundle?.raw as { taskIntent?: string } | undefined)?.taskIntent ||
      (input.meta as { taskIntent?: string } | undefined)?.taskIntent ||
      ''
  ).trim()
  const slice = sourceCommitmentFromRaw(input.bundle?.raw as Record<string, unknown>)
  if (shouldClarifyForAmbiguousCommitment(slice)) return false

  const ck = String(input.decision?.clarifyKind ?? (input.meta as { clarifyKind?: string })?.clarifyKind ?? 'none').trim()
  if (ck === 'plane') return false

  if (taskIntent === 'document_retrieval') return true
  if (slice.committedPlanes.includes('rag')) return true
  if (capIncludesRag(input.decision?.allowedAgents)) return true
  if (String(input.decision?.intent || '').trim() === 'rag') return true
  if (String(input.decision?.intentClassify?.planShortcut || '').trim() === 'rag_only') return true
  if (String(input.decision?.intentClassify?.primaryIntent || '').trim() === 'rag') return true
  return false
}

export function clearOrchestratorSlotClarify(
  decision: OrchestratorDecision,
  reason:
    | 'clarifySuppressedByRagProbeHit'
    | 'clarifySuppressedByPrefetchHit'
    | 'clarifySuppressedByDbProbeHit'
): OrchestratorDecision {
  return {
    ...decision,
    needsClarify: false,
    clarifyQuestions: [],
    clarifyKind: 'none',
    raw: {
      ...decision.raw,
      needsClarify: false,
      clarifyKind: 'none',
      clarifyQuestions: []
    },
    metaPatch: {
      ...decision.metaPatch,
      needsClarify: false,
      clarifyQuestions: [],
      clarifyKind: 'none',
      [reason]: true
    }
  }
}

export function applyRagProbeClarifySuppress(
  decision: OrchestratorDecision,
  input: {
    probe?: { rag?: { hits?: number } } | null
    bundle: TaskOrchestratorBundle
  }
): OrchestratorDecision {
  if (!decision.needsClarify) return decision
  if (
    !shouldSuppressSlotClarifyWhenRagProbeHit({
      probe: input.probe,
      bundle: input.bundle,
      decision
    })
  ) {
    return decision
  }
  return clearOrchestratorSlotClarify(decision, 'clarifySuppressedByRagProbeHit')
}

export function applyDbProbeClarifySuppress(
  decision: OrchestratorDecision,
  input: {
    probe?: { db?: ProbeDbSlice; rag?: { hits?: number } } | null
    bundle: TaskOrchestratorBundle
  }
): OrchestratorDecision {
  if (!decision.needsClarify) return decision
  if (
    !shouldSuppressSlotClarifyWhenDbProbeHit({
      probe: input.probe,
      bundle: input.bundle,
      decision
    })
  ) {
    return decision
  }
  return clearOrchestratorSlotClarify(decision, 'clarifySuppressedByDbProbeHit')
}

export function prefetchClarifySuppressMetaPatch(
  stateMeta: Record<string, unknown> | null | undefined,
  ragRes: RagRetrievePrefetchResult | null | undefined
): Record<string, unknown> | null {
  if (ragPrefetchHitCount(ragRes) <= 0) return null
  if (!Boolean(stateMeta?.needsClarify)) return null
  if (isPlaneClarifyLocked({ meta: stateMeta ?? undefined })) return null
  return {
    needsClarify: false,
    clarifyQuestions: [],
    clarifyKind: 'none',
    clarifySuppressedByPrefetchHit: true
  }
}

/** multi 执行层：prefetch / 步 evidence 已存在时不应再 clarify */
export function hasRagPrefetchOrStepEvidence(input: {
  meta?: Record<string, unknown> | null
  hasDataEvidence?: boolean
}): boolean {
  if (input.hasDataEvidence) return true
  const prefetch = input.meta?.ragRetrievePrefetch as RagRetrievePrefetchResult | undefined
  return ragPrefetchHitCount(prefetch) > 0
}
