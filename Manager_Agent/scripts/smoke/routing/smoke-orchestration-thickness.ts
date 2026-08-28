/**
 * 编排厚度契约 smoke（不调 LLM、不连外部 Agent）
 */
import {
  buildMemoryCaptureAckText,
  resolveOrchestrationThickness,
  resolveHotGateCaptureContext,
  shouldShortCircuitMemoryCapture,
  shouldRunMemoryMetaIntentCapture,
  hasMemoryCaptureStructuralContext,
  resolveMemoryCaptureHotGateMinConfidence,
  isMemoryHotGateEligible,
  shouldBypassPlannerRoute,
  shouldUseConversationalDbSynth,
  shouldUseConversationalRagSynth,
  resolvePostPrefetchRoute,
  resolveIntentForOrchestrationThickness,
} from '../../../server/graph/core/routing/orchestrationThickness'
import { isMemoryMetaIntentHotGateEnabled } from '../../../server/graph/core/memory/memoryMetaIntent'
import { shouldPassthroughRagOnly } from '#agent-shared/deterministicPassthrough'
import { shouldSkipCriticLlm } from '../../../server/graph/core/output/criticPolicy'
import { shouldPrefetchRagRetrieve } from '../../../server/graph/core/rag/ragPrefetch'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke:orchestration-thickness] ${msg}`)
}

async function main() {
  console.log('smoke:orchestration-thickness: start')

  assert(isMemoryMetaIntentHotGateEnabled(), 'hot gate default on')
  assert(
    shouldShortCircuitMemoryCapture({ kind: 'save_playbook', confidence: 0.9, title: '查补贴打法' }),
    'save_playbook short circuit'
  )
  assert(!shouldShortCircuitMemoryCapture({ kind: 'none', confidence: 0.9 }), 'none no short circuit')

  assert(
    resolveOrchestrationThickness({ meta: { metaIntentHotGate: true }, intent: 'multi' }) === 'memory_capture',
    'hot gate thickness'
  )
  assert(
    resolveOrchestrationThickness({
      meta: { allowedAgents: ['rag'], intentClassify: { planShortcut: 'rag_only' } },
      intent: 'rag',
    }) === 'single_source',
    'rag single source'
  )
  assert(
    resolveOrchestrationThickness({
      meta: { allowedAgents: ['db', 'rag'] },
      intent: 'multi',
    }) === 'complex',
    'multi source complex'
  )
  assert(
    resolveOrchestrationThickness({
      meta: { allowedAgents: ['rag'], intentClassify: { planShortcut: 'rag_only' } },
      intent: 'multi',
    }) === 'single_source',
    'rag_only stays single_source even when intent=multi'
  )

  assert(
    shouldBypassPlannerRoute({
      intent: 'multi',
      meta: { allowedAgents: ['rag'], intentClassify: { planShortcut: 'rag_only' } },
      allowedAgents: ['rag'],
    }),
    'rag_only bypasses planner'
  )
  assert(
    resolvePostPrefetchRoute({
      intent: 'multi',
      meta: { allowedAgents: ['rag'], intentClassify: { planShortcut: 'rag_only' } },
      allowedAgents: ['rag'],
    }) === 'rag',
    'post-prefetch rag direct'
  )
  assert(
    resolvePostPrefetchRoute({
      intent: 'multi',
      meta: { allowedAgents: ['db', 'rag'] },
      allowedAgents: ['db', 'rag'],
    }) === 'planner',
    'true multi stays planner'
  )
  assert(
    resolveIntentForOrchestrationThickness({
      intent: 'multi',
      meta: { allowedAgents: ['rag'], intentClassify: { planShortcut: 'rag_only' } },
      allowedAgents: ['rag'],
    }) === 'rag',
    'single source intent normalized to rag'
  )

  assert(
    hasMemoryCaptureStructuralContext({
      sessionAnchor: {
        primaryIntent: 'rag',
        primaryPlane: 'rag',
        planShortcut: 'rag_only',
        isDbAnchored: false,
        isMulti: false,
        coalescedTask: '养老机构护理员补贴标准是多少？',
        lastExecutedAgents: ['rag'],
        updatedAt: new Date().toISOString(),
      },
      turnKind: 'continuation',
    }),
    'memory structural continuation'
  )
  assert(
    resolveMemoryCaptureHotGateMinConfidence(true) < resolveMemoryCaptureHotGateMinConfidence(false),
    'structural context lowers hot gate threshold'
  )
  assert(
    shouldShortCircuitMemoryCapture(
      { kind: 'save_playbook', confidence: 0.64, title: '查补贴打法' },
      resolveMemoryCaptureHotGateMinConfidence(true)
    ),
    'save_playbook short circuit with structural ctx'
  )

  const topicShiftScope = {
    mode: 'topic_shift' as const,
    turnKind: 'new_task' as const,
    clarifyKind: 'none' as const,
    lastOnly: '查王建国的慢性病检测记录',
    routingContext: '查王建国的慢性病检测记录',
    suppressSessionAnchor: true,
    suppressMultiTurnMerge: true,
    directChitchatSynth: false,
    refreshSessionAnchor: true,
  }
  assert(!isMemoryHotGateEligible(topicShiftScope), 'topic_shift blocks memory hot gate')
  assert(
    !shouldShortCircuitMemoryCapture(
      { kind: 'save_answer', confidence: 0.95, title: '保存王建国查询结果' },
      0.62,
      topicShiftScope
    ),
    'new db query must not short-circuit memory capture'
  )
  assert(
    !shouldRunMemoryMetaIntentCapture({
      turnScope: topicShiftScope,
      meta: { memoryMetaIntentParsed: { kind: 'save_answer', confidence: 0.95 } },
    }),
    'topic_shift blocks finalize cold-path memory capture'
  )
  assert(
    shouldRunMemoryMetaIntentCapture({
      turnScope: topicShiftScope,
      meta: { metaIntentHotGate: true, orchestrationThickness: 'memory_capture' },
    }),
    'hot gate memory capture still runs on topic follow-up turn'
  )

  const ack = buildMemoryCaptureAckText({ kind: 'save_playbook', confidence: 0.9, title: '补贴查法' })
  assert(ack.includes('playbook') || ack.includes('草稿'), 'ack text')

  assert(
    !shouldPassthroughRagOnly({
      intent: 'rag',
      planSteps: [{ agent: 'rag' }],
      results: { rag: '根据制度文件，护理员补贴标准为每月800元。' },
      evidence: [{ kind: 'rag', empty: false }],
      meta: { orchestrationThickness: 'single_source' },
      professionalMode: true,
    }),
    'single_source uses conversational synth not passthrough'
  )
  assert(
    shouldUseConversationalRagSynth({
      intent: 'rag',
      meta: { orchestrationThickness: 'single_source', allowedAgents: ['rag'] },
      results: { rag: '护理员补贴标准为每月800元。' },
    }),
    'single source conversational rag synth'
  )
  assert(
    shouldUseConversationalDbSynth({
      intent: 'db',
      meta: { orchestrationThickness: 'single_source', allowedAgents: ['db'] },
      results: { db: '男性 5 人，女性 3 人，合计 8 人。' },
    }),
    'single source conversational db synth'
  )
  assert(
    !shouldPrefetchRagRetrieve({
      intent: 'rag',
      allowedAgents: ['rag'],
      meta: { allowedAgents: ['rag'], intentClassify: { planShortcut: 'rag_only' } },
    }),
    'single source skips rag retrieve prefetch'
  )
  assert(
    shouldPrefetchRagRetrieve({
      intent: 'multi',
      allowedAgents: ['db', 'rag'],
      meta: { allowedAgents: ['db', 'rag'] },
    }),
    'multi still prefetches rag'
  )

  const criticSkip = shouldSkipCriticLlm({
    routeConfidence: 0.85,
    intent: 'rag',
    planStepCount: 1,
    planAgents: ['rag'],
    timeLeftMs: 60_000,
    meta: { orchestrationThickness: 'single_source' },
    results: { rag: 'ok content here' },
  })
  assert(criticSkip.skip, 'critic skip single source')

  const ctx = resolveHotGateCaptureContext({
    messages: [],
    sessionAnchor: {
      primaryIntent: 'rag',
      primaryPlane: 'rag',
      planShortcut: 'rag_only',
      isDbAnchored: false,
      isMulti: false,
      coalescedTask: '养老机构护理员补贴标准是多少？',
      lastExecutedAgents: ['rag'],
      updatedAt: new Date().toISOString(),
    },
    lastUser: '以后都按这种方式查补贴',
  })
  assert(ctx.businessQuestion.includes('补贴'), 'hot gate business question from anchor')
  assert(ctx.planAgents.includes('rag'), 'hot gate plan agents')

  console.log('smoke:orchestration-thickness: ok')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
