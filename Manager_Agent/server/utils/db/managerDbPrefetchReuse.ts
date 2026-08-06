import type { ManagerDbTaskPayload } from './managerDbTaskPayload'
import { executionShapeHintFromQueryPlanJson } from './managerDbExecutionShapeHint'

type PrefetchUnified = {
  entities?: {
    names?: string[]
    records?: string[]
    locations?: string[]
    dates?: string[]
  }
  hints?: {
    suggested_tables?: string[]
    suggested_fields?: string[]
    schema_fk_hints?: string
    evidence?: string
  }
  query_plan_json?: string
  schema_ground_json?: string
  prefetch_ready?: boolean
}

function uniqStrings(items: string[], max: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of items) {
    const t = String(x ?? '').trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

/** 预取 schema_ground 是否含模型选表（judge_source=llm）；切片伪造的 primary 不算权威 */
export function schemaGroundHasLlmTableJudge(raw: string | undefined | null): boolean {
  const s = String(raw ?? '').trim()
  if (!s) return false
  try {
    const g = JSON.parse(s) as {
      table_judge?: { primary_tables?: string[]; judge_source?: string; reasoning?: string }
    }
    const judge = g.table_judge
    if (!judge?.primary_tables?.length) return false
    if (String(judge.judge_source ?? '').trim() !== 'llm') return false
    const reasoning = String(judge.reasoning ?? '').trim()
    if (reasoning === 'manager_prefetch_plan' || reasoning === 'manager_prefetch_reuse') return false
    return true
  } catch {
    return false
  }
}

/**
 * 从 hints 表列表拼装候选 SchemaGround（仅 candidate_tables，不伪造 primary）。
 * 主表须由 DB /api/plan 的模型选表或执行期 judgeTablesForQuestion 决定。
 */
function schemaGroundJsonFromPrefetch(hints: PrefetchUnified['hints'], tables: string[]): string | undefined {
  if (!tables.length) return undefined
  const evidence = String(hints?.evidence ?? '').trim()
  const fk = String(hints?.schema_fk_hints ?? '').trim()
  return JSON.stringify({
    candidate_tables: tables,
    schema_summary: evidence.slice(0, 1400),
    search_keywords: '',
    ...(fk ? { relations_text: fk } : {}),
  })
}

function queryPlanUsableForPrefetch(raw: string | undefined): string | undefined {
  const s = String(raw ?? '').trim()
  if (!s || s.length < 8) return undefined
  try {
    const p = JSON.parse(s) as {
      intent?: string
      confidence?: number
      entities?: { names?: string[]; locations?: string[] }
      metrics?: string[]
      filters?: { where?: string[] }
    }
    if (String(p.intent || '') === 'unknown' && Number(p.confidence ?? 0) < 0.55) return undefined
    const hasEntity =
      (p.entities?.names?.length ?? 0) > 0 ||
      (p.entities?.locations?.length ?? 0) > 0 ||
      (p.filters?.where?.length ?? 0) > 0
    const hasMetrics = (p.metrics?.length ?? 0) > 0
    if (!hasEntity && !hasMetrics && Number(p.confidence ?? 0) < 0.62) return undefined
    return s
  } catch {
    return undefined
  }
}

/** 去掉全部 prefetch 侧车（问句不对齐：表线索 + query_plan） */
export function stripMisalignedPrefetchFromManagerTask(
  payload: ManagerDbTaskPayload | null
): ManagerDbTaskPayload | null {
  if (!payload) return null
  const {
    prefetch_reuse: _pr,
    prefetch_schema_ground_json: _sg,
    query_plan_json: _qp,
    hint_tables: _ht,
    hint_fields: _hf,
    schema_fk_hints: _fk,
    ...rest
  } = payload
  return { ...rest, prefetch_reuse: undefined, prefetch_schema_ground_json: undefined, query_plan_json: undefined }
}

/**
 * omitSchemaHints：剥掉全部不可信预取侧车（锁表字段 + query_plan / execution_shape），
 * 让 DB 用执行问句自行跑 plan LLM，与独立端同权。
 */
export function stripTableLockingPrefetchFields(
  payload: ManagerDbTaskPayload | null
): ManagerDbTaskPayload | null {
  if (!payload) return null
  const {
    prefetch_reuse: _pr,
    prefetch_schema_ground_json: _sg,
    hint_tables: _ht,
    hint_fields: _hf,
    schema_fk_hints: _fk,
    query_plan_json: _qp,
    execution_shape_hint: _esh,
    ...rest
  } = payload
  return {
    ...rest,
    prefetch_reuse: undefined,
    prefetch_schema_ground_json: undefined,
    hint_tables: undefined,
    hint_fields: undefined,
    schema_fk_hints: undefined,
    query_plan_json: undefined,
    execution_shape_hint: undefined
  }
}

function resolvePrefetchUnified(meta: unknown): PrefetchUnified | null {
  const cached = (meta as { dbPlanPrefetch?: { ok?: boolean; unified_task_plan?: PrefetchUnified } } | null)
    ?.dbPlanPrefetch
  if (!cached?.ok || !cached.unified_task_plan) return null
  return cached.unified_task_plan
}

/** 将 prefetch 节点 /api/plan 结果并入 managerTask；仅 LLM 选表后才 prefetch_reuse 跳过二次选表 */
export function enrichManagerDbTaskFromPrefetch(
  payload: ManagerDbTaskPayload | null,
  meta: unknown,
  opts?: { omitSchemaHints?: boolean; allowReuse?: boolean }
): ManagerDbTaskPayload | null {
  if (opts?.allowReuse === false) return stripMisalignedPrefetchFromManagerTask(payload)
  if (String(process.env.MANAGER_DB_PREFETCH_REUSE ?? '1').trim() === '0') {
    return opts?.omitSchemaHints ? stripTableLockingPrefetchFields(payload) : payload
  }

  const unified = resolvePrefetchUnified(meta)
  if (!unified) {
    return opts?.omitSchemaHints ? stripTableLockingPrefetchFields(payload) : payload
  }

  const hints = unified.hints ?? {}
  const queryPlan =
    queryPlanUsableForPrefetch(unified.query_plan_json) ||
    queryPlanUsableForPrefetch(payload?.query_plan_json)
  const executionShapeHint =
    payload?.execution_shape_hint ||
    executionShapeHintFromQueryPlanJson(queryPlan || payload?.query_plan_json)

  const base: ManagerDbTaskPayload = payload ?? {
    source: 'manager',
    refined_question: '',
    must_filters: [],
    schema_search_keywords: ''
  }

  // omit：禁止锁表与预取 plan 短路，DB 自主 NLU（与独立端同权）
  if (opts?.omitSchemaHints) {
    return stripTableLockingPrefetchFields(payload)
  }

  const tables = uniqStrings(
    [...(hints.suggested_tables ?? []), ...(payload?.hint_tables ?? [])],
    6
  )
  const fields = uniqStrings([...(hints.suggested_fields ?? []), ...(payload?.hint_fields ?? [])], 12)
  const fk = String(hints.schema_fk_hints ?? payload?.schema_fk_hints ?? '').trim()
  const fromApi = String(unified.schema_ground_json ?? '').trim()
  const schemaGround = fromApi || schemaGroundJsonFromPrefetch(hints, tables) || undefined
  const hasLlmJudge = schemaGroundHasLlmTableJudge(schemaGround)

  if (!tables.length && !queryPlan && !fk && !fields.length && !schemaGround) return payload

  return {
    ...base,
    source: 'manager',
    hint_tables: tables.length ? tables : base.hint_tables,
    hint_fields: fields.length ? fields : base.hint_fields,
    schema_fk_hints: fk || base.schema_fk_hints,
    ...(queryPlan ? { query_plan_json: queryPlan } : {}),
    ...(executionShapeHint ? { execution_shape_hint: executionShapeHint } : {}),
    // 无 LLM 选表时仍可下发候选表，但不锁 primary（prefetch_reuse=false）
    prefetch_reuse: Boolean(hasLlmJudge && (unified.prefetch_ready || queryPlan)),
    prefetch_schema_ground_json: schemaGround || base.prefetch_schema_ground_json
  }
}

export function prefetchHasDbHints(meta: unknown): boolean {
  const cached = (meta as { dbPlanPrefetch?: { ok?: boolean; unified_task_plan?: PrefetchUnified } } | null)
    ?.dbPlanPrefetch
  const unified = cached?.unified_task_plan
  const tables = unified?.hints?.suggested_tables
  return Boolean(
    cached?.ok &&
      ((Array.isArray(tables) && tables.length > 0) ||
        Boolean(unified?.schema_ground_json) ||
        Boolean(unified?.query_plan_json))
  )
}
