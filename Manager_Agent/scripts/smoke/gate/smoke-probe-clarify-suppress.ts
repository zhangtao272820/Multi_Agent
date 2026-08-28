/**
 * probe/prefetch RAG 命中时抑制 slot 澄清（纯函数，无 LLM）。
 */
import {
  applyRagProbeClarifySuppress,
  applyDbProbeClarifySuppress,
  hasRagPrefetchOrStepEvidence,
  prefetchClarifySuppressMetaPatch,
  shouldSuppressSlotClarifyWhenRagProbeHit,
  shouldSuppressSlotClarifyWhenDbProbeHit,
} from '../../../server/graph/orchestrate/clarifyProbeGate'
import { shouldClearClarifyForSingleSourceRag, shouldClearClarifyForSingleSourceDb } from '../../../server/graph/orchestrate/orchestratorInvariants'
import { inferDbAnchorFromProbe } from '../../../server/graph/core/probe/probeRoutingAnchor'
import type { IntentClassifyResult } from '../../../server/graph/llm/intentClassifyLlm'
import type { TaskOrchestratorBundle } from '../../../server/graph/llm/taskOrchestrator'
import type { OrchestratorDecision } from '../../../server/graph/orchestrate/orchestratorInvariants'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const baseClassify: IntentClassifyResult = {
  primaryIntent: 'rag',
  isMulti: false,
  suggestedAgents: ['rag'],
  isDbAnchored: false,
  needsAdmin: false,
  needsWeb: false,
  explicitWantsReport: false,
  explicitWantsVisualize: false,
  planShortcut: 'rag_only',
  dataSources: ['rag'],
  requiresAgentPipeline: false,
  allowChatWebDirect: true,
  confidence: 0.9,
  rationale: 'document lookup'
}

assert(
  shouldSuppressSlotClarifyWhenRagProbeHit({
    probe: { rag: { hits: 6 } },
    bundle: {
      raw: { taskIntent: 'document_retrieval', sourceCommitment: 'clear', committedPlanes: ['rag'] }
    } as unknown as TaskOrchestratorBundle,
    decision: {
      needsClarify: true,
      clarifyKind: 'slot',
      allowedAgents: ['rag'],
      intent: 'rag',
      intentClassify: baseClassify,
      metaPatch: {}
    }
  }),
  'probe hit + slot → suppress'
)

assert(
  !shouldSuppressSlotClarifyWhenRagProbeHit({
    probe: { rag: { hits: 6 } },
    bundle: {
      raw: { sourceCommitment: 'ambiguous', committedPlanes: [] }
    } as unknown as TaskOrchestratorBundle,
    decision: {
      needsClarify: true,
      clarifyKind: 'plane',
      allowedAgents: ['rag', 'db'],
      intent: 'multi',
      intentClassify: { ...baseClassify, primaryIntent: 'multi', dataSources: ['rag', 'db'] },
      metaPatch: { clarifyForAmbiguousCommitment: true }
    }
  }),
  'plane/ambiguous must NOT suppress'
)

assert(
  !shouldSuppressSlotClarifyWhenRagProbeHit({
    probe: { rag: { hits: 0 } },
    bundle: {
      raw: { taskIntent: 'document_retrieval', sourceCommitment: 'clear', committedPlanes: ['rag'] }
    } as unknown as TaskOrchestratorBundle,
    decision: {
      needsClarify: true,
      clarifyKind: 'slot',
      allowedAgents: ['rag'],
      intent: 'rag',
      intentClassify: baseClassify,
      metaPatch: {}
    }
  }),
  'no probe hit → no suppress'
)

const decisionStub = {
  needsClarify: true,
  clarifyKind: 'slot' as const,
  clarifyQuestions: ['护理员类别？', '地区？'],
  allowedAgents: ['rag'] as any,
  intent: 'rag',
  intentClassify: baseClassify,
  coalescedTask: '养老机构护理员补贴标准是多少？',
  routedQuery: '养老机构护理员补贴标准是多少？',
  clauses: [],
  constraints: {} as any,
  planBlueprint: null,
  directChitchatSynth: false,
  needsWebSearch: false,
  turnScopeMode: 'current_only' as const,
  raw: {
    taskIntent: 'document_retrieval',
    sourceCommitment: 'clear',
    committedPlanes: ['rag'],
    needsClarify: true,
    clarifyKind: 'slot'
  },
  metaPatch: { needsClarify: true, clarifyKind: 'slot' }
} as unknown as OrchestratorDecision

const cleared = applyRagProbeClarifySuppress(decisionStub, {
  probe: { rag: { hits: 6 } },
  bundle: {
    raw: decisionStub.raw,
    intentClassify: baseClassify,
    allowedAgents: ['rag'],
    needsClarify: true,
    clarifyKind: 'slot',
    clarifyQuestions: ['护理员类别？']
  } as unknown as TaskOrchestratorBundle
})
assert(cleared.needsClarify === false, 'apply suppress clears needsClarify')
assert(cleared.metaPatch?.clarifySuppressedByRagProbeHit === true, 'meta flag probe')
assert((cleared.clarifyQuestions || []).length === 0, 'questions cleared')

const prefetchKill = prefetchClarifySuppressMetaPatch(
  { needsClarify: true, clarifyKind: 'slot' },
  { ok: true, ms: 140, hits: 6, needsClarify: false }
)
assert(prefetchKill?.needsClarify === false, 'prefetch kill clears clarify')
assert(prefetchKill?.clarifySuppressedByPrefetchHit === true, 'prefetch meta flag')

assert(
  prefetchClarifySuppressMetaPatch(
    { needsClarify: true, clarifyKind: 'plane', clarifyForAmbiguousCommitment: true },
    { ok: true, ms: 10, hits: 3 }
  ) === null,
  'prefetch must not kill plane clarify'
)

assert(
  hasRagPrefetchOrStepEvidence({
    meta: { ragRetrievePrefetch: { ok: true, hits: 6, ms: 100 } },
    hasDataEvidence: false
  }),
  'prefetch counts as evidence'
)
assert(
  !hasRagPrefetchOrStepEvidence({ meta: {}, hasDataEvidence: false }),
  'no prefetch no evidence'
)

// multi cap + probe：单源豁免不生效，但 probe 闸门仍应 suppress
assert(
  !shouldClearClarifyForSingleSourceRag({
    planShortcut: 'none',
    allowedAgents: ['rag', 'db'],
    intent: 'multi'
  }),
  'multi does not get single-source clear'
)
assert(
  shouldSuppressSlotClarifyWhenRagProbeHit({
    probe: { rag: { hits: 6 } },
    bundle: {
      raw: { taskIntent: 'document_retrieval', sourceCommitment: 'clear', committedPlanes: ['rag'] }
    } as unknown as TaskOrchestratorBundle,
    decision: {
      needsClarify: true,
      clarifyKind: 'slot',
      allowedAgents: ['rag', 'db'],
      intent: 'multi',
      intentClassify: { ...baseClassify, primaryIntent: 'multi', dataSources: ['rag', 'db'], planShortcut: 'none' },
      metaPatch: {}
    }
  }),
  'multi+document_retrieval+probe still suppresses slot'
)

// document RAG + probe hit：不得被 DB probe 误锚成 db_only
const kept = inferDbAnchorFromProbe({
  classify: baseClassify,
  probe: {
    db: { matched: true, tables: ['remote_nursing_chronic_sys_tenant_info'], tableInventory: ['remote_nursing_chronic_sys_tenant_info'] } as any,
    rag: { hits: 6 }
  },
  clauses: [{ id: 'c1', text: '护理员补贴', agents: ['rag'] }]
})
assert(kept.primaryIntent === 'rag', 'doc rag not flipped to db')
assert(kept.dataSources?.includes('rag') && !kept.isDbAnchored, 'stay rag-anchored')

assert(
  shouldClearClarifyForSingleSourceDb({
    planShortcut: 'db_only',
    taskIntent: 'structured_query',
    intent: 'db',
    allowedAgents: ['db'],
    isDbAnchored: true,
  }),
  'single source db clears clarify'
)

assert(
  shouldSuppressSlotClarifyWhenDbProbeHit({
    probe: { db: { matched: true, tables: ['remote_nursing_chronic_sys_tenant_info'] } },
    bundle: {
      raw: { taskIntent: 'structured_query', sourceCommitment: 'clear', committedPlanes: ['db'] },
    } as unknown as TaskOrchestratorBundle,
    decision: {
      needsClarify: true,
      clarifyKind: 'slot',
      allowedAgents: ['db'],
      intent: 'db',
      intentClassify: {
        ...baseClassify,
        primaryIntent: 'db',
        planShortcut: 'db_only',
        dataSources: ['db'],
        isDbAnchored: true,
      },
      metaPatch: {},
    },
  }),
  'db probe hit + slot → suppress'
)

const dbDecisionStub = {
  ...decisionStub,
  clarifyKind: 'slot' as const,
  allowedAgents: ['db'] as any,
  intent: 'db',
  intentClassify: {
    ...baseClassify,
    primaryIntent: 'db',
    planShortcut: 'db_only',
    dataSources: ['db'],
    isDbAnchored: true,
  },
  coalescedTask: '查王建国的慢性病检测记录',
  routedQuery: '查王建国的慢性病检测记录',
  raw: {
    taskIntent: 'structured_query',
    sourceCommitment: 'clear',
    committedPlanes: ['db'],
    needsClarify: true,
    clarifyKind: 'slot',
  },
} as unknown as OrchestratorDecision

const dbCleared = applyDbProbeClarifySuppress(dbDecisionStub, {
  probe: { db: { matched: true, tables: ['remote_nursing_chronic_sys_tenant_info'] } },
  bundle: {
    raw: dbDecisionStub.raw,
    intentClassify: dbDecisionStub.intentClassify,
    allowedAgents: ['db'],
    needsClarify: true,
    clarifyKind: 'slot',
    clarifyQuestions: ['请确认时间范围？'],
  } as unknown as TaskOrchestratorBundle,
})
assert(dbCleared.needsClarify === false, 'db probe apply suppress')
assert(dbCleared.metaPatch?.clarifySuppressedByDbProbeHit === true, 'db probe meta flag')

console.log('smoke-probe-clarify-suppress: OK')
