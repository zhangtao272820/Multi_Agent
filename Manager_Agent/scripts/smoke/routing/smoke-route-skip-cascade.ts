/**
 * 路由审查 skip 级联 + SLI 字段契约（不调 LLM、不连外部 Agent）
 */
import {
  shouldSkipRouteReviewLlm,
  probeStrongSolePlane,
  formatSessionAnchorCoalesceHint,
  estimateRouteLlmCalls,
  buildRouteSkipsSnapshot
} from '../../../server/graph/core/routing/routeSkipCascade'
import {
  buildRouteAuthorityChain,
  routeAuthorityMetricExtra
} from '../../../server/graph/orchestrate/routeAuthorityChain'
import { aggregateManagerSli } from '../../../server/graph/core/runtime/sliAggregate'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke:route-skip-cascade] ${msg}`)
}

async function main() {
  console.log('smoke:route-skip-cascade: start')

  // ambiguous 禁止 skip
  const amb = shouldSkipRouteReviewLlm({
    allowedAgents: ['db'],
    planShortcut: 'db_only',
    sourceCommitmentRaw: { sourceCommitment: 'ambiguous', committedPlanes: ['db'] }
  })
  assert(!amb.skipAlign && !amb.skipPlane, 'ambiguous no skip')
  assert(amb.reasons.includes('ambiguous'), 'ambiguous reason')

  // clear sole plane
  const clear = shouldSkipRouteReviewLlm({
    allowedAgents: ['db'],
    planShortcut: 'db_only',
    sourceCommitmentRaw: { sourceCommitment: 'clear', committedPlanes: ['db'] }
  })
  assert(clear.skipAlign && clear.skipPlane, 'clear sole skip')
  assert(clear.reasons.includes('clear_sole_plane'), 'clear reason')

  // admin_only clear
  const admin = shouldSkipRouteReviewLlm({
    allowedAgents: ['admin'],
    planShortcut: 'admin_only',
    sourceCommitmentRaw: { sourceCommitment: 'clear', committedPlanes: ['admin'] }
  })
  assert(admin.skipAlign && admin.skipPlane, 'admin_only clear skip')
  assert(admin.reasons.includes('admin_only_clear'), 'admin reason')

  // true multi 不跳
  const multi = shouldSkipRouteReviewLlm({
    allowedAgents: ['db', 'rag'],
    planShortcut: 'none',
    sourceCommitmentRaw: { sourceCommitment: 'clear', committedPlanes: ['db', 'rag'] },
    meta: { allowedAgents: ['db', 'rag'] }
  })
  assert(!multi.skipAlign && !multi.skipPlane, 'true multi no skip')

  // probe 强单源（无 db_only shortcut，避免被 clear_sole 先吞）
  assert(probeStrongSolePlane({ db: { executable: true }, rag: { hits: 0 } }) === 'db', 'probe strong db')
  assert(probeStrongSolePlane({ db: { matched: false }, rag: { hits: 3 } }) === 'rag', 'probe strong rag')
  const probeSkip = shouldSkipRouteReviewLlm({
    allowedAgents: ['db'],
    planShortcut: 'none',
    sourceCommitmentRaw: { sourceCommitment: 'none', committedPlanes: [] },
    probe: { db: { executable: true }, rag: { hits: 0 } }
  })
  assert(probeSkip.skipPlane, 'probe strong db skips plane')
  assert(probeSkip.reasons.includes('probe_strong_db'), 'probe reason')
  assert(!probeSkip.skipAlign, 'probe without clear keeps align')

  // 缺口 A：continuation coalesce hint
  const hint = formatSessionAnchorCoalesceHint({
    turnKind: 'continuation',
    turnScopeMode: 'continuation',
    coalescedTask: '查询林雨欣足底压力次数',
    lastExecutedAgents: ['db']
  })
  assert(hint.includes('多轮合并锚点'), 'coalesce hint present')
  assert(hint.includes('足底压力'), 'coalesce task text')
  assert(
    !formatSessionAnchorCoalesceHint({
      turnKind: 'new_task',
      turnScopeMode: 'current_only',
      coalescedTask: '查规范'
    }),
    'new_task no coalesce hint'
  )

  const skips = buildRouteSkipsSnapshot({
    skipAlign: true,
    skipPlane: true,
    skipWebAlign: true,
    plannerBypassed: true,
    skipAudit: true
  })
  assert(skips.align && skips.planner && skips.audit, 'skips snapshot')

  const calls = estimateRouteLlmCalls({
    priorAuxCalls: 1,
    ranOrchestratorLlm: true,
    skipAlign: true,
    skipPlane: true,
    skipWebAlign: true
  })
  assert(calls === 2, `route llm calls with skips expect 2 got ${calls}`)

  // Phase0：route_authority 扩展字段
  const chain = buildRouteAuthorityChain({
    meta: {
      orchestrationThickness: 'single_source',
      orchestratorSource: 'full_llm_skip_align_skip_plane_cover',
      allowedAgents: ['rag'],
      intentClassify: { planShortcut: 'rag_only' },
      routeSkips: skips,
      routeLlmCalls: 2,
      sourceCommitment: 'clear',
      committedPlanes: ['rag']
    },
    turnScopeMode: 'current_only',
    turnKind: 'new_task',
    allowedAgents: ['rag']
  })
  assert(chain.orchestrationThickness === 'single_source', 'thickness on chain')
  assert(chain.routeSkips.align === true, 'skips on chain')
  assert(chain.routeLlmCalls === 2, 'llm calls on chain')
  const extra = routeAuthorityMetricExtra(chain)
  assert(extra.orchestrationThickness === 'single_source', 'extra thickness')
  assert(typeof extra.routeLlmCalls === 'number', 'extra llm calls')

  const sli = aggregateManagerSli([
    {
      runId: 'r1',
      phase: 'route_authority',
      ms: 0,
      ok: true,
      extra: {
        ...extra,
        singleSourcePassthrough: true,
        sourceCommitment: 'clear'
      }
    },
    {
      runId: 'r2',
      phase: 'route_authority',
      ms: 0,
      ok: true,
      extra: {
        sourceCommitment: 'ambiguous',
        singleSourcePassthrough: false,
        trueMulti: true,
        orchestrationThickness: 'complex',
        routeSkips: { align: false, plane: false, webAlign: false, planner: false, audit: false },
        routeLlmCalls: 4
      }
    }
  ])
  assert(sli.routeAuthoritySamples === 2, 'sli samples')
  assert(sli.routeSkipAlignRate === 0.5, `skip align rate got ${sli.routeSkipAlignRate}`)
  assert(sli.routeAvgLlmCalls === 3, `avg llm calls got ${sli.routeAvgLlmCalls}`)
  assert(sli.routeByThickness.single_source === 1, 'by thickness')

  console.log('smoke:route-skip-cascade: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
