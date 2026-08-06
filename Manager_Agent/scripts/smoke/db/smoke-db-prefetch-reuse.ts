/**
 * DB prefetch 复用回归（纯函数）：无 judge_source=llm 不得锁 primary。
 */
import {
  enrichManagerDbTaskFromPrefetch,
  prefetchHasDbHints,
  schemaGroundHasLlmTableJudge
} from '../../../server/utils/db/managerDbPrefetchReuse'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const queryPlanJson = JSON.stringify({
  intent: 'aggregation',
  confidence: 0.72,
  entities: { names: ['陈子墨'], locations: ['河西区'], records: [], dates: [], ids: [] },
  metrics: ['人数'],
  filters: { time_range: { start: '', end: '', relative: '' }, where: ['河西区'], slots: [] },
  missing_slots: [],
  data_domain: 'person_basic',
  subject: 'person'
})

const hints = {
  suggested_tables: ['remote_nursing_chronic', 'person_health_rec', 'remote_activity_foot_log'],
  suggested_fields: ['chief_complaint'],
  schema_fk_hints: 'person_health_rec.id = remote_nursing_chronic.health_id',
  evidence: '- remote_nursing_chronic // 慢病档案'
}

/** 旧契约：切片伪造成 primary（manager_prefetch_*）→ 不得 prefetch_reuse */
const fakeJudgeMeta = {
  dbPlanPrefetch: {
    ok: true,
    unified_task_plan: {
      entities: { names: ['陈子墨'], records: [], locations: [], dates: [] },
      prefetch_ready: true,
      query_plan_json: queryPlanJson,
      schema_ground_json: JSON.stringify({
        candidate_tables: hints.suggested_tables,
        table_judge: {
          ranked_tables: hints.suggested_tables,
          primary_tables: hints.suggested_tables.slice(0, 4),
          auxiliary_tables: [],
          reasoning: 'manager_prefetch_reuse',
          sql_hint: ''
        }
      }),
      hints
    }
  }
}

const fakeEnriched = enrichManagerDbTaskFromPrefetch(null, fakeJudgeMeta)
assert(fakeEnriched?.prefetch_reuse !== true, 'fake manager_prefetch_reuse must not lock prefetch_reuse')
assert((fakeEnriched?.hint_tables?.length ?? 0) >= 2, 'hint_tables still passed as candidates')
assert(
  !schemaGroundHasLlmTableJudge(fakeEnriched?.prefetch_schema_ground_json),
  'fake judge is not authoritative llm'
)

/** 仅 hints、无 schema_ground_json：兜底只产出候选，不伪造 primary */
const candidatesOnlyMeta = {
  dbPlanPrefetch: {
    ok: true,
    unified_task_plan: {
      entities: { names: ['陈子墨'], records: [], locations: [], dates: [] },
      prefetch_ready: true,
      query_plan_json: queryPlanJson,
      hints
    }
  }
}
const candidatesOnly = enrichManagerDbTaskFromPrefetch(null, candidatesOnlyMeta)
assert(candidatesOnly?.prefetch_reuse !== true, 'candidates-only must not prefetch_reuse')
assert(String(candidatesOnly?.prefetch_schema_ground_json || '').includes('candidate_tables'), 'has candidates')
assert(
  !String(candidatesOnly?.prefetch_schema_ground_json || '').includes('primary_tables'),
  'must not fabricate primary_tables'
)
assert(
  !String(candidatesOnly?.prefetch_schema_ground_json || '').includes('manager_prefetch_reuse'),
  'must not stamp manager_prefetch_reuse'
)

/** 权威 LLM 选表：可 prefetch_reuse */
const llmJudgeMeta = {
  dbPlanPrefetch: {
    ok: true,
    unified_task_plan: {
      entities: { names: ['陈子墨'], records: [], locations: [], dates: [] },
      prefetch_ready: true,
      query_plan_json: queryPlanJson,
      schema_ground_json: JSON.stringify({
        candidate_tables: ['remote_nursing_chronic', 'person_health_rec', 'remote_activity_foot_log'],
        table_judge: {
          ranked_tables: ['remote_nursing_chronic', 'person_health_rec'],
          primary_tables: ['remote_nursing_chronic'],
          auxiliary_tables: ['person_health_rec'],
          reasoning: '问句指向慢病检测主记录',
          sql_hint: '主查 remote_nursing_chronic',
          judge_source: 'llm'
        }
      }),
      hints
    }
  }
}
const llmEnriched = enrichManagerDbTaskFromPrefetch(null, llmJudgeMeta)
assert(llmEnriched?.prefetch_reuse === true, 'llm judge_source enables prefetch_reuse')
assert(String(llmEnriched?.query_plan_json || '').includes('aggregation'), 'query_plan_json from prefetch')
assert(schemaGroundHasLlmTableJudge(llmEnriched?.prefetch_schema_ground_json), 'llm judge detected')
assert(
  String(llmEnriched?.prefetch_schema_ground_json || '').includes('"judge_source":"llm"'),
  'preserves judge_source'
)

assert(prefetchHasDbHints(llmJudgeMeta), 'prefetchHasDbHints true')
assert(!prefetchHasDbHints({}), 'prefetchHasDbHints false when empty')

/** omitSchemaHints：预取建议了任意错表时，不得注入 hint_tables / query_plan */
const commentCollisionMeta = {
  dbPlanPrefetch: {
    ok: true,
    question: '查李四的业务档案明细',
    unified_task_plan: {
      entities: { names: ['李四'], records: [], locations: [], dates: [] },
      prefetch_ready: true,
      query_plan_json: JSON.stringify({
        intent: 'detail',
        confidence: 0.8,
        entities: { names: ['李四'] },
        metrics: ['业务档案明细']
      }),
      hints: {
        suggested_tables: ['domain_a_sensor_log', 'domain_b_archive'],
        evidence: '传感器域-检测记录'
      }
    }
  }
}
const omitBase = {
  source: 'manager' as const,
  refined_question: '查李四的业务档案明细',
  must_filters: [] as string[],
  schema_search_keywords: '',
  query_plan_json: JSON.stringify({ intent: 'detail', entities: { names: ['李四'] } }),
  execution_shape_hint: 'detail_rows' as const
}
const omitted = enrichManagerDbTaskFromPrefetch(omitBase, commentCollisionMeta, {
  omitSchemaHints: true,
  allowReuse: true
})
assert(!(omitted?.hint_tables ?? []).includes('domain_a_sensor_log'), 'omit must strip wrong hint_tables')
assert(!(omitted?.hint_tables ?? []).length, 'omit must not inject any hint_tables')
assert(!omitted?.prefetch_schema_ground_json, 'omit must strip prefetch_schema_ground_json')
assert(omitted?.prefetch_reuse !== true, 'omit must not lock prefetch_reuse')
assert(!String(omitted?.query_plan_json || '').trim(), 'omit must strip query_plan_json')
assert(!omitted?.execution_shape_hint, 'omit must strip execution_shape_hint')

console.log('smoke: db prefetch reuse ok')
