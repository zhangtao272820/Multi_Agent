/**
 * formatDbPrefetchForPlanner：omitTableHints 时不得把建议表/schema 摘要灌进 planner。
 */
import { formatDbPrefetchForPlanner } from '../../../server/graph/core/db/dbPrefetch'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const prefetch = {
  ok: true,
  ms: 12,
  unified_task_plan: {
    prefetch_ready: true,
    entities: { names: ['张三'] },
    hints: {
      suggested_tables: ['domain_a_sensor_log', 'domain_b_archive'],
      evidence: '传感器域-检测记录'
    },
    query_plan_json: '{"intent":"detail"}'
  }
}

const withTables = formatDbPrefetchForPlanner(prefetch)
assert(withTables.includes('domain_a_sensor_log'), 'default may show suggested tables')
assert(withTables.includes('传感器域'), 'default may show evidence')

const omitted = formatDbPrefetchForPlanner(prefetch, { omitTableHints: true })
assert(!omitted.includes('domain_a_sensor_log'), 'omit must hide suggested tables')
assert(!omitted.includes('传感器域'), 'omit must hide schema evidence')
assert(omitted.includes('张三'), 'omit may keep entities')
assert(omitted.includes('自举') || omitted.includes('query_plan'), 'omit should note DB self-select')

console.log('smoke: db prefetch planner omit tables ok')
