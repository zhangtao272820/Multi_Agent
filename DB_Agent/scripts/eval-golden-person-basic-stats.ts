/**
 * 离线 eval：golden-person-basic-stats.json — Plan-only 槽位与 assemble 门禁
 * 用法：cd DB_Agent && npx tsx scripts/eval-golden-person-basic-stats.ts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { assemblePlanSlotsOrNull } from '../utils/nlu/assemble_plan_slots.ts'
import { defaultQueryPlan, type QueryPlan } from '../utils/nlu/query_plan.ts'
import { applyPersonBasicPrimaryTableConstraint } from '../utils/schema_table_judge.ts'

const root = dirname(fileURLToPath(import.meta.url))
const goldenPath = join(root, '../eval/golden-person-basic-stats.json')

type GoldenCase = {
  id: string
  user: string
  expect: {
    intent?: string
    locations?: string[]
    primaryTable?: string
    dimensions?: string[]
    path_any?: string[]
  }
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

function planFromCase(c: GoldenCase): QueryPlan {
  const loc = c.expect.locations?.[0]
  const intent = (c.expect.intent as QueryPlan['intent']) || 'aggregation'
  const isLookup = intent === 'lookup' || intent === 'detail'
  return {
    ...defaultQueryPlan(),
    intent,
    subject: 'person',
    data_domain: 'person_basic',
    confidence: 0.82,
    entities: {
      names: isLookup ? [c.user.replace(/查一下|的基本信息|住在哪里|的年龄是多少/g, '').trim()].filter(Boolean).slice(0, 1) : [],
      locations: loc ? [loc] : [],
      orgs: [],
      ids: [],
    },
    metrics: isLookup ? [] : ['人数'],
    dimensions: c.expect.dimensions ?? [],
    filters: {
      time_range: { start: '', end: '', relative: '' },
      where: [],
      slots: loc
        ? [{ field_hint: 'region', value: loc, sql_match_value: loc }]
        : [],
    },
  }
}

function main() {
  const raw = JSON.parse(readFileSync(goldenPath, 'utf8')) as { cases: GoldenCase[]; min_cases?: number }
  const minCases = Number(raw.min_cases ?? process.env.DB_NL2SQL_MIN_CASES ?? 20)
  assert(Array.isArray(raw.cases) && raw.cases.length >= minCases, `need >=${minCases} golden cases`)
  let ok = 0
  for (const c of raw.cases) {
    assert(Array.isArray(c.expect.path_any) && c.expect.path_any.length >= 1, `${c.id}: path_any required`)
    const assembled = assemblePlanSlotsOrNull(planFromCase(c))
    assert(assembled, `${c.id}: assemble rejected valid plan`)
    if (c.expect.locations?.length) {
      assert(
        c.expect.locations.every((l) => assembled!.entities.locations.includes(l)),
        `${c.id}: locations mismatch ${JSON.stringify(assembled!.entities.locations)}`,
      )
    }
    if (c.expect.primaryTable) {
      const briefs = [
        { name: 'remote_person', comment: '', columns: [] },
        { name: c.expect.primaryTable, comment: '人员主表', columns: [] },
      ]
      const judge = applyPersonBasicPrimaryTableConstraint(
        {
          ranked_tables: ['remote_person', c.expect.primaryTable],
          primary_tables: ['remote_person'],
          auxiliary_tables: [],
          reasoning: 'eval',
          sql_hint: '',
        },
        briefs as any,
        assembled!,
      )
      assert(
        judge.primary_tables.includes(c.expect.primaryTable),
        `${c.id}: judge must lock ${c.expect.primaryTable}`,
      )
    }
    ok += 1
  }
  console.log(`eval-golden-person-basic-stats: OK (${ok}/${raw.cases.length})`)
}

main()
