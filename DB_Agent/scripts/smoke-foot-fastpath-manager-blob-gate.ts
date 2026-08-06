/**
 * 足底快路径门禁：慢性病等非足底问句 + 候选含足底表 + manager blob 含 foot 表名
 * → 不得触发；问句/plan 含足底 markers 时仍可触发。
 */
import {
  shouldTryFootPressureFastPath,
  planMentionsFootPressure,
} from '../utils/foot_pressure_fastpath'
import {
  queryPlanAlignsWithFootDomain,
  reorderFootPressureCandidates,
  getFootLogTable,
  getFootMeasureTable,
} from '../utils/schema_relations'
import type { QueryPlan } from '../utils/nlu/query_plan'
import type { SchemaGroundResult } from '../utils/schema_ground'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const footMain = getFootLogTable()
const footMeasure = getFootMeasureTable()

const chronicPlan = {
  intent: 'detail',
  confidence: 0.85,
  entities: { names: ['王建国'], locations: [], records: [], dates: [], ids: [] },
  metrics: ['慢性病检测记录'],
  dimensions: [],
  filters: { time_range: { start: '', end: '', relative: '' }, where: [], slots: [] },
  missing_slots: [],
  data_domain: 'general',
  subject: 'person',
} as QueryPlan

const schemaWithFoot: SchemaGroundResult = {
  candidate_tables: ['remote_nursing_chronic', footMain, footMeasure],
  schema_summary: '',
  search_keywords: '',
  table_judge: {
    primary_tables: [footMain],
    auxiliary_tables: [],
    judge_source: 'llm',
    reasoning: 'contaminated',
  },
}

const managerBlob = `hint_tables: ${footMain}, remote_nursing_chronic`

assert(!planMentionsFootPressure(chronicPlan), 'chronic metrics must not mention foot')
assert(!queryPlanAlignsWithFootDomain(chronicPlan), 'chronic plan must not align foot domain')

assert(
  shouldTryFootPressureFastPath({
    question: '查王建国的慢性病检测记录',
    plan: chronicPlan,
    schemaGround: schemaWithFoot,
    managerContextBlob: managerBlob,
  }) === false,
  'chronic question + foot table in manager blob must NOT trigger foot fastpath',
)

const footPlan = {
  ...chronicPlan,
  metrics: ['足底压力检测'],
  data_domain: 'general',
} as QueryPlan

assert(
  shouldTryFootPressureFastPath({
    question: '林雨欣做过几次足底压力检测',
    plan: footPlan,
    schemaGround: schemaWithFoot,
    managerContextBlob: managerBlob,
  }) === true,
  'foot question/plan markers must still trigger fastpath',
)

const mixed = [footMeasure, 'remote_nursing_chronic', footMain]
const reorderedChronic = reorderFootPressureCandidates(
  mixed,
  { [footMeasure]: '区域信息' },
  chronicPlan,
)
assert(
  reorderedChronic[0] === footMeasure || reorderedChronic[0] === 'remote_nursing_chronic',
  'reorder must not promote foot tables when plan not foot-aligned',
)
assert(reorderedChronic.join(',') === mixed.join(','), 'non-aligned reorder is identity')

const reorderedFoot = reorderFootPressureCandidates(mixed, { [footMeasure]: '区域信息' }, footPlan)
assert(reorderedFoot[0] === footMain, 'aligned plan may promote foot main table')

console.log('smoke: foot fastpath manager blob gate ok')
