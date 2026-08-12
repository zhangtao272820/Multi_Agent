/**
 * Wave7：换域烟雾 — 同一套形态断言，只换合成 catalog（orders ↔ courses）。
 * 零改 Manager 路由源码；失败 = 某处隐式绑旧域。
 * CI：npm run smoke:domain-transfer
 */
import { formatRuntimeCatalogsForOrchestrator } from '../../../server/graph/core/probe/probeInterpretation'
import { capFloorFromPuStackMeta } from '../../../server/graph/orchestrate/puStackOrchestratorAuthority'
import { sortAgentsByPipelineOrder } from '../../../server/graph/core/routing/clauses'
import { gatePlaneCoverageFlip, catalogsHaveInventory } from '../../../server/graph/llm/planeCoverageRejudgeLlm'
import { assertNoDomainBleed } from '../fixtures/domainBleedDenyList'
import {
  CATALOG_COURSES,
  CATALOG_ORDERS,
  ROUTE_SHAPE_CASES,
  probeForCatalog,
  type ShapeCase
} from '../fixtures/routeShapeCatalogs'

process.env.MANAGER_ROUTE_MODE ??= 'convergence'
process.env.MANAGER_PRO_MODE ??= 'strong'
process.env.MANAGER_LLM_FIRST_ROUTE ??= '1'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-domain-transfer] ${msg}`)
}

function assertShapeOnDomain(domain: 'orders' | 'courses', c: ShapeCase): string[] {
  const probe = probeForCatalog(domain)
  const catalogText = formatRuntimeCatalogsForOrchestrator(probe)
  assertNoDomainBleed(catalogText, `${domain}:${c.id}`)

  if (domain === 'orders') {
    assert(catalogText.includes('orders') || catalogText.includes('customers'), 'orders tables visible')
    assert(catalogText.includes('refund_policy.md') || catalogText.includes('shipping_sla.md'), 'orders docs visible')
  } else {
    assert(catalogText.includes('courses') || catalogText.includes('enrollments'), 'courses tables visible')
    assert(
      catalogText.includes('student_handbook.md') || catalogText.includes('grading_policy.md'),
      'courses docs visible'
    )
  }

  const meta = {
    ...c.meta,
    stepDispatchDraft: c.draft.map((d, i) => ({ ...d, clauseIds: [`c${i + 1}`] }))
  }
  const cap = sortAgentsByPipelineOrder(capFloorFromPuStackMeta(meta, null)).map(String)
  for (const a of c.expectCap) {
    assert(cap.includes(a), `${c.id}@${domain}: missing ${a} got=${cap.join(',')}`)
  }
  return cap
}

console.log('smoke-domain-transfer: start')

assert(catalogsHaveInventory(CATALOG_ORDERS), 'orders inventory')
assert(catalogsHaveInventory(CATALOG_COURSES), 'courses inventory')
assert(CATALOG_ORDERS.db.tableInventory[0] !== CATALOG_COURSES.db.tableInventory[0], 'domains differ')

const domains: Array<'orders' | 'courses'> = ['orders', 'courses']
const report: Array<{ id: string; domain: string; cap: string }> = []

for (const domain of domains) {
  // 模拟「只换 DB_AGENT_DOMAIN / catalog」：环境标签仅用于日志，不进路由分支
  process.env.DB_AGENT_DOMAIN = domain === 'orders' ? 'generic' : 'generic'
  process.env.SMOKE_SYNTHETIC_CATALOG = domain

  for (const c of ROUTE_SHAPE_CASES) {
    const cap = assertShapeOnDomain(domain, c)
    report.push({ id: c.id, domain, cap: cap.join('+') })
    console.log(`transfer ok: ${c.id}@${domain} → ${cap.join('+')}`)
  }

  // 库存再判门禁在两套域上行为一致（合成名，无养老专名）
  const flip =
    domain === 'orders'
      ? gatePlaneCoverageFlip('db', {
          dbCanAnswer: false,
          ragCanAnswer: true,
          preferredPlane: 'rag',
          confidence: 0.9,
          rationale: 'refund_policy inventory'
        })
      : gatePlaneCoverageFlip('db', {
          dbCanAnswer: false,
          ragCanAnswer: true,
          preferredPlane: 'rag',
          confidence: 0.9,
          rationale: 'handbook inventory'
        })
  assert(flip === 'rag', `${domain}: db→rag inventory flip`)
}

// 同 shape 在两域 cap 必须一致（证明不绑表名/文档名）
for (const c of ROUTE_SHAPE_CASES) {
  const a = report.find((r) => r.id === c.id && r.domain === 'orders')
  const b = report.find((r) => r.id === c.id && r.domain === 'courses')
  assert(a && b, `${c.id}: both domains`)
  assert(a!.cap === b!.cap, `${c.id}: cap diverged across domains ${a!.cap} vs ${b!.cap}`)
}

console.log(`smoke-domain-transfer: ok (shapes=${ROUTE_SHAPE_CASES.length} domains=2)`)
