/**
 * Wave7：抽象 taskIntent 形态黄金集（合成 catalog，无养老/p2026 专名）。
 * 断言 cap / taskIntent / turn_scope / routeAuthorityChain，不绑具体业务问句为生产契约。
 * CI：npm run smoke:route-shape-transfer
 */
import { HumanMessage } from '@langchain/core/messages'
import { capFloorFromPuStackMeta } from '../../../server/graph/orchestrate/puStackOrchestratorAuthority'
import { buildBlueprintFromPuStackDispatch } from '../../../server/graph/llm/planBlueprintLlm'
import { sortAgentsByPipelineOrder } from '../../../server/graph/core/routing/clauses'
import { resolveTurnRoutingScope } from '../../../server/graph/core/routing/turnScope'
import { buildRouteAuthorityChain } from '../../../server/graph/orchestrate/routeAuthorityChain'
import { formatRuntimeCatalogsForOrchestrator } from '../../../server/graph/core/probe/probeInterpretation'
import { assertNoDomainBleed } from '../fixtures/domainBleedDenyList'
import {
  CATALOG_ORDERS,
  ROUTE_SHAPE_CASES,
  type ShapeCase,
  type SyntheticProbe
} from '../fixtures/routeShapeCatalogs'

process.env.MANAGER_ROUTE_MODE ??= 'convergence'
process.env.MANAGER_PRO_MODE ??= 'strong'
process.env.MANAGER_LLM_FIRST_ROUTE ??= '1'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-route-shape-transfer] ${msg}`)
}

function runShapeCase(c: ShapeCase, probe: SyntheticProbe, label: string): void {
  assertNoDomainBleed(c.userTask, `${c.id}.userTask`)
  for (const d of c.draft) assertNoDomainBleed(d.scopedUserLanguage, `${c.id}.draft`)

  const catalogText = formatRuntimeCatalogsForOrchestrator(probe)
  assertNoDomainBleed(catalogText, `${label}:${c.id}.catalog`)
  assert(catalogText.includes('db_catalog') || catalogText.includes('库存表'), `${c.id}: catalog db block`)
  assert(catalogText.includes('rag_catalog') || catalogText.includes('库存文档'), `${c.id}: catalog rag block`)

  const meta = {
    ...c.meta,
    stepDispatchDraft: c.draft.map((d, i) => ({ ...d, clauseIds: [`c${i + 1}`] }))
  }
  const cap = sortAgentsByPipelineOrder(capFloorFromPuStackMeta(meta, null))
  for (const a of c.expectCap) {
    assert(cap.includes(a as (typeof cap)[number]), `${c.id}@${label}: cap missing ${a} got=${cap.join(',')}`)
  }
  if (c.expectCap.length === 1 && !c.meta.requiresAgentPipelineHint) {
    assert(cap.length === 1, `${c.id}@${label}: single-source cap len`)
  }
  if (c.expectCap.length >= 2) {
    const bp = buildBlueprintFromPuStackDispatch({
      allowedAgents: cap.map(String),
      stepDispatchDraft: meta.stepDispatchDraft as Array<{ agent: string; scopedUserLanguage: string }>,
      userTask: c.userTask
    })
    assert(bp && bp.steps.length >= c.expectCap.length, `${c.id}@${label}: blueprint steps`)
    const bpAgents = bp!.steps.map((s) => String(s.agent))
    for (const a of c.expectCap) assert(bpAgents.includes(a), `${c.id}@${label}: blueprint missing ${a}`)
  }

  const intent = String(c.meta.dataPlaneTaskIntent || c.taskIntent || '')
  if (intent === 'structured_query' || intent === 'document_retrieval' || intent === 'hybrid') {
    assert(String(c.meta.dataPlaneTaskIntent) === intent || c.taskIntent === intent, `${c.id}: taskIntent`)
  }

  const chain = buildRouteAuthorityChain({
    meta: {
      ...meta,
      allowedAgents: cap,
      intent: c.expectCap.length > 1 ? 'multi' : c.expectCap[0],
      planShortcut:
        c.expectCap.length > 1 ? 'multi' : c.expectCap[0] === 'db' ? 'db_only' : c.expectCap[0] === 'rag' ? 'rag_only' : undefined,
      sourceCommitment: 'clear',
      committedPlanes: c.expectCap.filter((a) => a === 'db' || a === 'rag' || a === 'admin')
    },
    turnScopeMode: 'current_only',
    turnKind: 'new_task',
    allowedAgents: cap.map(String)
  })
  assert(Array.isArray(chain.allowedAgents) && chain.allowedAgents.length > 0, `${c.id}: authority agents`)
  assert(chain.turnScopeMode === 'current_only', `${c.id}: turnScope default`)
  if (c.expectCap.length === 1 && (c.expectCap[0] === 'db' || c.expectCap[0] === 'rag')) {
    assert(chain.singleSourcePassthrough === true, `${c.id}: singleSourcePassthrough`)
  }
  if (c.expectCap.includes('rag') && c.expectCap.includes('db')) {
    assert(chain.trueMulti === true, `${c.id}: trueMulti`)
  }

  console.log(`shape ok: ${c.id}@${label} → ${cap.join('+')} intent=${c.taskIntent}`)
}

console.log('smoke-route-shape-transfer: start')
assert(ROUTE_SHAPE_CASES.length >= 4, 'shape cases present')

for (const c of ROUTE_SHAPE_CASES) {
  runShapeCase(c, CATALOG_ORDERS, 'orders')
}

/** topic_shift：文档面 → 结构化面，靠 intentBreak，不问句 regex */
{
  const prev = '手册里关于冷静期或缺勤规则原文怎么写的'
  const next = '统计本月成交笔数按客户汇总'
  assertNoDomainBleed(prev, 'K1.prev')
  assertNoDomainBleed(next, 'K1.next')
  const scope = resolveTurnRoutingScope({
    messages: [new HumanMessage(prev), new HumanMessage(next)],
    lastUser: next,
    sessionAnchor: {
      primaryIntent: 'rag',
      planShortcut: 'rag_only',
      suggestedAgents: ['rag'],
      isDbAnchored: false,
      isMulti: false,
      updatedAt: new Date().toISOString(),
      lastExecutedAgents: ['rag']
    },
    intentClassify: {
      primaryIntent: 'db',
      planShortcut: 'db_only',
      suggestedAgents: ['db'],
      isDbAnchored: true,
      isMulti: false,
      confidence: 0.8,
      dataSources: ['db']
    }
  })
  assert(scope.mode === 'topic_shift', `K1 topic_shift got=${scope.mode}`)
  const cont = resolveTurnRoutingScope({
    messages: [new HumanMessage(prev), new HumanMessage('再详细一点')],
    lastUser: '再详细一点',
    sessionAnchor: {
      primaryIntent: 'rag',
      planShortcut: 'rag_only',
      suggestedAgents: ['rag'],
      isDbAnchored: false,
      isMulti: false,
      updatedAt: new Date().toISOString(),
      lastExecutedAgents: ['rag']
    },
    intentClassify: {
      primaryIntent: 'rag',
      planShortcut: 'rag_only',
      suggestedAgents: ['rag'],
      isDbAnchored: false,
      isMulti: false,
      confidence: 0.75,
      dataSources: ['rag']
    }
  })
  assert(cont.mode === 'continuation', `K1 continuation got=${cont.mode}`)
  console.log('shape ok: K1_topic_shift + continuation')
}

console.log('smoke-route-shape-transfer: ok')
