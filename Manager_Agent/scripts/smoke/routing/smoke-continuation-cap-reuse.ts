/**
 * Phase2 续轮 cap 复用契约（不调 LLM）
 */
import {
  resolveContinuationRouteBypass,
  buildContinuationBypassDecision,
  continuationProbeConflictsAnchor
} from '../../../server/graph/core/routing/continuationRouteBypass'
import { resolveTurnRoutingScope } from '../../../server/graph/core/routing/turnScope'
import { shouldSkipOrchestratorRagRecall } from '../../../server/graph/orchestrate/orchestratorHeuristic'
import { HumanMessage } from '@langchain/core/messages'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke:continuation-cap-reuse] ${msg}`)
}

async function main() {
  console.log('smoke:continuation-cap-reuse: start')

  const contScope = resolveTurnRoutingScope({
    messages: [new HumanMessage('查销售Top5'), new HumanMessage('只要前3名')],
    lastUser: '只要前3名',
    sessionAnchor: {
      primaryIntent: 'db',
      primaryPlane: 'db',
      planShortcut: 'db_only',
      isDbAnchored: true,
      isMulti: false,
      coalescedTask: '查销售Top5',
      lastExecutedAgents: ['db'],
      updatedAt: new Date().toISOString()
    },
    turnScopeLlm: {
      mode: 'continuation',
      turnKind: 'continuation',
      clarifyKind: 'none',
      directChitchatSynth: false,
      confidence: 0.86,
      rationale: '筛选条件承接'
    }
  })

  const ok = resolveContinuationRouteBypass({
    turnScope: contScope,
    sessionAnchor: {
      primaryIntent: 'db',
      primaryPlane: 'db',
      planShortcut: 'db_only',
      isDbAnchored: true,
      isMulti: false,
      coalescedTask: '查销售Top5',
      lastExecutedAgents: ['db'],
      updatedAt: new Date().toISOString()
    },
    lastUser: '只要前3名',
    probe: { db: { executable: true }, rag: { hits: 0 } }
  })
  assert(ok.ok, 'continuation bypass ok')
  assert(ok.allowedAgents.join(',') === 'db', 'reuse db')
  assert(ok.reasons.includes('continuation_cap_reuse'), 'reason')

  const decision = buildContinuationBypassDecision({
    bypass: ok,
    turnScope: contScope,
    lastUser: '只要前3名'
  })
  assert(decision.allowedAgents.join(',') === 'db', 'decision agents')
  assert(decision.metaPatch.continuationCapReuse === true, 'meta flag')
  assert(decision.intent === 'db', 'intent db')

  // topic_shift 不复用
  const shift = resolveContinuationRouteBypass({
    turnScope: {
      ...contScope,
      mode: 'topic_shift',
      turnKind: 'new_task',
      suppressSessionAnchor: true
    },
    sessionAnchor: {
      primaryIntent: 'db',
      primaryPlane: 'db',
      planShortcut: 'db_only',
      isDbAnchored: true,
      isMulti: false,
      lastExecutedAgents: ['db'],
      updatedAt: new Date().toISOString()
    },
    lastUser: '天气怎么样'
  })
  assert(!shift.ok && shift.reasons.includes('topic_shift'), 'topic_shift no bypass')

  // probe 冲突：上轮 rag，本轮 db 强命中
  assert(
    continuationProbeConflictsAnchor({
      probe: { db: { executable: true }, rag: { hits: 0 } },
      allowedAgents: ['rag']
    }),
    'probe conflicts rag vs db'
  )
  const conflict = resolveContinuationRouteBypass({
    turnScope: contScope,
    sessionAnchor: {
      primaryIntent: 'rag',
      primaryPlane: 'rag',
      planShortcut: 'rag_only',
      isDbAnchored: false,
      isMulti: false,
      coalescedTask: '查探视制度',
      lastExecutedAgents: ['rag'],
      updatedAt: new Date().toISOString()
    },
    lastUser: '再细一点',
    probe: { db: { executable: true }, rag: { hits: 0 } }
  })
  assert(!conflict.ok && conflict.reasons.includes('probe_conflict'), 'probe conflict blocks')

  // 结构多行 → 不 bypass
  const multiLine = resolveContinuationRouteBypass({
    turnScope: { ...contScope, lastOnly: '只要返回销售前三名即可\n另外再查一下知识库探视制度怎么写' },
    sessionAnchor: {
      primaryIntent: 'db',
      primaryPlane: 'db',
      planShortcut: 'db_only',
      isDbAnchored: true,
      isMulti: false,
      lastExecutedAgents: ['db'],
      updatedAt: new Date().toISOString()
    },
    lastUser: '只要返回销售前三名即可\n另外再查一下知识库探视制度怎么写'
  })
  assert(!multiLine.ok && multiLine.reasons.includes('structural_multi_lines'), 'multi-line blocks')

  // Phase3：续轮单源跳过 intent RAG recall
  assert(
    shouldSkipOrchestratorRagRecall({
      turnScopeMode: 'continuation',
      turnKind: 'continuation',
      sessionAnchorAgents: ['db']
    }),
    'skip rag recall on continuation single plane'
  )
  assert(
    !shouldSkipOrchestratorRagRecall({
      turnScopeMode: 'continuation',
      turnKind: 'continuation',
      sessionAnchorAgents: ['db', 'rag']
    }),
    'multi anchor still may recall'
  )

  console.log('smoke:continuation-cap-reuse: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
