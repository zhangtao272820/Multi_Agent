/**
 * query_plan 复用：仅非 omit、且槽位完备时才 prefer。
 * Manager 默认单步 db 走 omitSchemaHints → 不携带预取 plan，不走本 prefer 短路。
 * Fixture 用抽象实体/指标，不绑定真实业务问句。
 */
import { shouldPreferManagerQueryPlan } from '../utils/manager_task_context'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const detailPlan = JSON.stringify({
  intent: 'detail',
  confidence: 0.82,
  entities: { names: ['张三'], locations: [], records: [], dates: [], ids: [] },
  metrics: ['业务档案明细'],
  filters: { time_range: { start: '', end: '', relative: '' }, where: [], slots: [] },
  missing_slots: [],
  data_domain: 'generic_archive',
  subject: 'person'
})

assert(
  shouldPreferManagerQueryPlan({
    source: 'manager',
    refined_question: '查张三的业务档案明细',
    must_filters: [],
    query_plan_json: detailPlan,
    prefetch_reuse: false
  }) === true,
  'non-omit manager query_plan with entity slots may prefer plan'
)

assert(
  shouldPreferManagerQueryPlan({
    source: 'manager',
    refined_question: '查张三的业务档案明细',
    must_filters: [],
    query_plan_json: detailPlan,
    prefetch_reuse: true
  }) === true,
  'manager query_plan with prefetch_reuse still prefers plan when present'
)

assert(
  shouldPreferManagerQueryPlan({
    source: 'manager',
    refined_question: 'x',
    must_filters: [],
    query_plan_json: JSON.stringify({ intent: 'detail', confidence: 0.9, entities: { names: [] } }),
    prefetch_reuse: false
  }) === false,
  'detail without entity slots must not prefer'
)

assert(
  shouldPreferManagerQueryPlan({
    source: 'manager',
    refined_question: '查张三的业务档案明细',
    must_filters: [],
    prefetch_reuse: false
  }) === false,
  'omit path (no query_plan_json) must not prefer — DB runs own plan LLM'
)

console.log('smoke: manager query plan prefer ok')
