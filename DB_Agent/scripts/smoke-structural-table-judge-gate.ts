/**
 * 配置域 structural 选表：须 queryPlan 槽位对齐域标记，不得仅因候选含主从表就硬锁。
 */
import { queryPlanAlignsWithFootDomain } from '../utils/schema_relations'
import { tryStructuralFootTableJudge } from '../utils/schema_table_judge'
import type { QueryPlan } from '../utils/nlu/query_plan'
import { getFootLogTable, getFootMeasureTable } from '../utils/schema_relations'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const main = getFootLogTable()
const measure = getFootMeasureTable()
const briefs = [
  { name: main, comment: '主记录-检测记录' },
  { name: measure, comment: '区域信息-扩展' },
  { name: 'other_business_archive', comment: '业务档案' }
]

const unrelatedPlan = {
  intent: 'detail',
  confidence: 0.8,
  entities: { names: ['张三'], locations: [], records: [], dates: [], ids: [] },
  metrics: ['业务档案明细'],
  dimensions: [],
  filters: { time_range: { start: '', end: '', relative: '' }, where: [], slots: [] },
  missing_slots: [],
  data_domain: 'generic_archive',
  subject: 'person'
} as QueryPlan

assert(!queryPlanAlignsWithFootDomain(unrelatedPlan), 'unrelated plan must not align foot domain')
assert(tryStructuralFootTableJudge(briefs, unrelatedPlan) === null, 'structural must not lock without domain alignment')

const alignedPlan = {
  ...unrelatedPlan,
  metrics: ['足底压力检测'],
  data_domain: 'foot_pressure'
} as QueryPlan

assert(queryPlanAlignsWithFootDomain(alignedPlan), 'aligned plan must match domain markers')
const locked = tryStructuralFootTableJudge(briefs, alignedPlan)
assert(locked?.primary_tables?.[0] === main, 'aligned plan may use structural main table')

console.log('smoke: structural table judge domain gate ok')
