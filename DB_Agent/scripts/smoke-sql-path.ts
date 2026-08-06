/**
 * D-P1-3 SQL 路径收敛 smoke：Playbook prompt + guard pipeline SSOT。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  sqlDirectSystemPrompt,
  sqlPlanDirectSystemPrompt,
  sqlPreflightSystemPrompt,
  sqlRepairSystemPrompt,
  validateGeneratedSelectSql,
  prepareSelectForExecution,
} from '../utils/sql/index.ts'
import { defaultQueryPlan } from '../utils/nlu/query_plan.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const root = dirname(fileURLToPath(import.meta.url))

const preflight = sqlPreflightSystemPrompt()
assert(preflight.includes('JSON'), 'preflight prompt loaded')
assert(preflight.includes('must_filters'), 'preflight mentions must_filters')

const direct = sqlDirectSystemPrompt()
assert(direct.includes('SELECT'), 'direct prompt loaded')
assert(direct.includes('LIMIT'), 'direct mentions limit')

const planDirect = sqlPlanDirectSystemPrompt()
assert(planDirect.includes('clarify'), 'planDirect prompt loaded')

const repair = sqlRepairSystemPrompt()
assert(repair.includes('MySQL') || repair.includes('修复'), 'repair prompt loaded')

const plan = {
  ...defaultQueryPlan(),
  confidence: 0.85,
  entities: { names: ['张三'], locations: [], orgs: [], ids: [] },
  filters: {
    time_range: { start: '', end: '', relative: '' },
    where: [],
    slots: [],
  },
}

const bad = validateGeneratedSelectSql('DELETE FROM person_info', { queryPlan: plan })
assert(!bad.ok && bad.stage === 'readonly', 'rejects non-select')

const missingName = validateGeneratedSelectSql('SELECT COUNT(*) FROM person_info', {
  queryPlan: plan,
  preflight: { refined_question: '张三', schema_search_keywords: '张三', sql_intent_summary: '', must_filters: ['张三'], risk_notes: [] },
})
assert(!missingName.ok && missingName.stage === 'plan_guard', 'plan guard catches missing name')

const regionPlan = {
  ...defaultQueryPlan(),
  confidence: 0.9,
  intent: 'aggregation' as const,
  subject: 'person' as const,
  data_domain: 'person_basic' as const,
  entities: { names: [], locations: ['东城区'], orgs: [], ids: [] },
  dimensions: ['性别'],
  metrics: ['人数'],
  filters: {
    time_range: { start: '', end: '', relative: '' },
    where: ['年龄段 60-69'],
    slots: [
      { field_hint: 'region', value: '东城区', sql_match_value: '东城区' },
      { field_hint: 'age', value: '60-69', sql_match_value: '60-69' },
    ],
  },
}
const missingRegion = validateGeneratedSelectSql(
  'SELECT is_gender, COUNT(*) c FROM person_info WHERE age BETWEEN 60 AND 69 GROUP BY is_gender',
  { queryPlan: regionPlan },
)
assert(!missingRegion.ok && missingRegion.stage === 'plan_guard', 'plan guard catches missing region')
assert(
  String((missingRegion as { guard?: { reason?: string } }).guard?.reason || '') === 'missing_region_filter' ||
    String((missingRegion as { reason?: string }).reason || '').includes('region'),
  'missing_region_filter reason',
)

const regionOk = validateGeneratedSelectSql(
  "SELECT is_gender, COUNT(*) c FROM person_info WHERE provinces_and_cities LIKE '%东城区%' AND age BETWEEN 60 AND 69 GROUP BY is_gender",
  { queryPlan: regionPlan },
)
assert(regionOk.ok, 'region+age select passes plan guard')

const ok = validateGeneratedSelectSql("SELECT * FROM person_info WHERE name LIKE '%张三%'", {
  queryPlan: plan,
  preflight: { refined_question: '张三', schema_search_keywords: '张三', sql_intent_summary: '', must_filters: ['张三'], risk_notes: [] },
})
assert(ok.ok, 'valid select passes guard pipeline')

const prepared = prepareSelectForExecution(ok.ok ? ok.sql : 'SELECT 1', 15)
assert(prepared.includes('LIMIT'), 'prepare adds limit')
assert(prepared.includes('MAX_EXECUTION_TIME'), 'prepare adds timeout hint')

const runSqlDirect = readFileSync(join(root, '../utils/sql/direct/runSqlDirect.ts'), 'utf8')
assert(runSqlDirect.includes('validateGeneratedSelectSql'), 'sql_direct uses guard pipeline')
assert(runSqlDirect.includes('irValidated'), 'query_ir uses plan guard before execute')
assert(!runSqlDirect.includes('DIRECT_SYSTEM_INLINE'), 'sql_direct inline prompt removed')

const preflightTs = readFileSync(join(root, '../utils/sql_preflight.ts'), 'utf8')
assert(preflightTs.includes('sqlPreflightSystemPrompt'), 'sql_preflight uses shared prompts')

console.log('smoke-sql-path: OK')
