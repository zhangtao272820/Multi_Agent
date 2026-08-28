import { fetchDbTaskPlan } from '../../../utils/agents/dbClient'
import { resolveDbPrefetchQuestionFromState } from './dbStepQuestion'
import { resolvePrefetchTargets, type PrefetchGateState } from '../probe/prefetchGate'
import type { Step } from '../../../utils/shared/taskPlan'

type VannaPlanResponse = {
  ok?: boolean
  path?: string
  tables?: string[]
  question?: string
  unified_task_plan?: Record<string, unknown> | null
}

/** 将 Vanna /api/plan 响应适配为 Manager prefetch 契约（兼容未升级的 DB Agent） */
export function normalizeDbPlanPrefetchResponse(res: VannaPlanResponse | null | undefined): {
  unified_task_plan?: Record<string, unknown> | null
} | null {
  if (!res || typeof res !== 'object') return null
  if (res.unified_task_plan && typeof res.unified_task_plan === 'object') return res
  const tables = (Array.isArray(res.tables) ? res.tables : [])
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
  if (!tables.length) return res
  return {
    ...res,
    unified_task_plan: {
      intent: 'db',
      entities: { names: [], records: [], locations: [], dates: [] },
      hints: {
        suggested_tables: tables,
        suggested_fields: [],
        evidence: ''
      },
      prefetch_ready: true
    }
  }
}

export type DbPlanPrefetchResult = {
  ok: boolean
  ms: number
  /** 发起 /api/plan 时使用的问句（供 exec 对齐判定） */
  question?: string
  unified_task_plan?: Record<string, unknown> | null
  error?: string
}

/** route 后、planner 前是否可并行预取 DB plan（与 omitSchemaHints 解耦：预取供 DB 内跳过 plan LLM） */
export function canPrefetchDbQuestionForState(
  state: PrefetchGateState & { meta?: unknown; intent?: string; routedQuery?: string; messages?: unknown[] },
  lastUser: string,
  fallbackTask: string
): boolean {
  const dbQ = resolveDbPrefetchQuestionFromState(state, lastUser, fallbackTask)
  const full = String(lastUser || fallbackTask || '').trim()
  if (!dbQ || dbQ.length < 4) return false
  if (String(state.intent || '').trim() === 'db') return true
  if (!full) return true
  const nDb = dbQ.replace(/\s+/g, '')
  const nFull = full.replace(/\s+/g, '')
  if (nDb === nFull) return false
  return nDb.length <= nFull.length * 0.92
}

export function shouldPrefetchDbPlan(
  state: PrefetchGateState & { meta?: unknown; intent?: string; routedQuery?: string },
  lastUser = '',
  fallbackTask = ''
): boolean {
  if (String(process.env.MANAGER_PREFETCH_DB_PLAN ?? '1').trim() === '0') return false
  if (!resolvePrefetchTargets(state).db) return false
  const lu = String(lastUser || '').trim()
  const fb = String(fallbackTask || state.routedQuery || lu || '').trim()
  return canPrefetchDbQuestionForState(state as any, lu, fb)
}

export async function prefetchDbTaskPlan(params: {
  dbAgentHttpUrl: string
  question: string
  timeoutMs: number
  dbId?: string
  traceId?: string
}): Promise<DbPlanPrefetchResult> {
  const t0 = Date.now()
  try {
    const res = await fetchDbTaskPlan({
      dbAgentHttpUrl: params.dbAgentHttpUrl,
      question: params.question,
      timeoutMs: params.timeoutMs,
      dbId: params.dbId,
      traceId: params.traceId
    })
    const normalized = normalizeDbPlanPrefetchResponse(res as VannaPlanResponse | null)
    return {
      ok: Boolean(normalized?.unified_task_plan),
      ms: Date.now() - t0,
      question: String(params.question ?? '').trim(),
      unified_task_plan: (normalized?.unified_task_plan as Record<string, unknown>) ?? null
    }
  } catch (e: unknown) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: String((e as Error)?.message || e || 'prefetch failed')
    }
  }
}

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

/** 注入 Planner：DB plan 预取摘要。omitTableHints 时不下发建议表/schema 摘要，避免注释撞车锁错表。 */
export function formatDbPrefetchForPlanner(
  prefetch?: DbPlanPrefetchResult | null,
  opts?: { omitTableHints?: boolean }
): string {
  if (!prefetch) return ''
  const unified = prefetch.unified_task_plan as PrefetchUnified | null | undefined
  const omitTables = Boolean(opts?.omitTableHints)
  const tables = omitTables
    ? []
    : (unified?.hints?.suggested_tables ?? []).map((t) => String(t ?? '').trim()).filter(Boolean)
  const names = (unified?.entities?.names ?? []).map((t) => String(t ?? '').trim()).filter(Boolean)
  const lines: string[] = [
    prefetch.ok
      ? '【DB plan 预取（route 后并行 /api/plan，供规划参考）】'
      : '【DB plan 预取（未完成，规划时勿假定已有 entities）】'
  ]
  if (prefetch.ms != null) lines.push(`- 耗时：${prefetch.ms}ms`)
  if (unified?.prefetch_ready) {
    lines.push(
      omitTables
        ? '- 预取可复用：query_plan（执行步可跳过 plan LLM；选表由 DB 自举）'
        : '- 预取可复用：query_plan + schema_ground（执行步可跳过 plan/探表 LLM）'
    )
  }
  if (tables.length) lines.push(`- 建议表：${tables.slice(0, 4).join('、')}`)
  else if (omitTables && prefetch.ok) lines.push('- 建议表：省略（由 DB 执行期自举，避免预取锁表）')
  if (names.length) lines.push(`- 实体：${names.slice(0, 4).join('、')}`)
  if (!omitTables) {
    const evidence = String(unified?.hints?.evidence ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (evidence) lines.push(`- schema 摘要：${evidence}`)
  }
  return lines.join('\n')
}

/** planNode：优先消费 prefetch 节点并行的 dbPlanPrefetch */
export function enrichTaskPlanWithDbPlan(
  taskPlan: { intent: string; entities?: Record<string, unknown>; steps: Step[] },
  state: { meta?: Record<string, unknown> | null },
  intent: string,
  plan: Step[],
  mergeTaskPlanFn: (base: any, patch: any, fallbackIntent: string, fallbackSteps: Step[]) => any,
  fetchFallback?: () => Promise<any>
): Promise<any> {
  const cached = state.meta?.dbPlanPrefetch as DbPlanPrefetchResult | undefined
  if (cached?.ok && cached.unified_task_plan) {
    const unified = cached.unified_task_plan as Record<string, any>
    return Promise.resolve(
      mergeTaskPlanFn(
        taskPlan,
        {
          intent: taskPlan.intent,
          entities: {
            names: Array.isArray(unified?.entities?.names) ? unified.entities.names : [],
            records: Array.isArray(unified?.entities?.records) ? unified.entities.records : [],
            locations: Array.isArray(unified?.entities?.locations) ? unified.entities.locations : [],
            dates: Array.isArray(unified?.entities?.dates) ? unified.entities.dates : []
          }
        },
        intent,
        plan
      )
    )
  }
  if (!fetchFallback) return Promise.resolve(taskPlan)
  return fetchFallback()
}
