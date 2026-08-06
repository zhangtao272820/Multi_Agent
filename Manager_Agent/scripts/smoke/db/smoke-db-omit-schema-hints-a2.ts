/**
 * 通用契约：intent=db/multi 时 omitSchemaHints，即使预取对齐并建议了错表，
 * managerTask 也不得携带 hint_tables / schema_ground / query_plan（DB 自主 NLU）。
 * Fixture 用抽象表名，不绑定真实业务问句。
 */
import { shouldOmitManagerDbSchemaHints } from '../../../server/utils/db/managerDbSchemaHintsPolicy'
import { buildManagerDbTaskPayloadFromState } from '../../../server/utils/db/managerDbTaskPayload'
import { enrichManagerDbTaskFromPrefetch } from '../../../server/utils/db/managerDbPrefetchReuse'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const q = '查张三的业务档案明细'
const wrongTable = 'domain_a_sensor_log'
const otherTable = 'domain_b_archive'
const meta = {
  dbPlanPrefetch: {
    ok: true,
    question: q,
    unified_task_plan: {
      entities: { names: ['张三'], records: [], locations: [], dates: [] },
      prefetch_ready: true,
      query_plan_json: JSON.stringify({
        intent: 'detail',
        confidence: 0.82,
        entities: { names: ['张三'] },
        metrics: ['业务档案明细']
      }),
      hints: {
        suggested_tables: [wrongTable, otherTable],
        evidence: '传感器域-检测记录'
      },
      schema_ground_json: JSON.stringify({
        candidate_tables: [wrongTable],
        table_judge: {
          primary_tables: [wrongTable],
          judge_source: 'llm',
          reasoning: '检测记录'
        }
      })
    }
  }
}

const omit = shouldOmitManagerDbSchemaHints({ question: q, lastUser: q, meta, intent: 'db' })
assert(omit === true, 'intent=db must omit schema hints')

const base = buildManagerDbTaskPayloadFromState(q, {
  intent: 'db',
  meta,
  probe: { db: { matched: true, tables: [wrongTable, otherTable] } },
  messages: []
})
assert(!(base?.hint_tables ?? []).includes(wrongTable), 'base payload must not lock wrong suggested table')

const enriched = enrichManagerDbTaskFromPrefetch(base, meta, { omitSchemaHints: true, allowReuse: true })
assert(!(enriched?.hint_tables ?? []).length, 'omit+aligned must not inject hint_tables')
assert(!String(enriched?.prefetch_schema_ground_json || '').includes(wrongTable), 'omit must strip schema ground lock')
assert(enriched?.prefetch_reuse !== true, 'omit must not prefetch_reuse')
assert(!String(enriched?.query_plan_json || '').trim(), 'omit must strip query_plan_json so DB runs own plan LLM')
assert(!String(enriched?.execution_shape_hint || '').trim(), 'omit must strip execution_shape_hint')

assert(
  shouldOmitManagerDbSchemaHints({ question: q, lastUser: q, meta, intent: 'multi' }) === true,
  'intent=multi must omit'
)

console.log('smoke: db omit schema hints ok')
