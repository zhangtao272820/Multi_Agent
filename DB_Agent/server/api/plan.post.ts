import { getDataSource } from '../../utils/db'
import { introspectSchemaWithComments } from '../../utils/schema'
import { ensureRateLimit } from '../../utils/rate'
import { resolveAgentRuntimeConfig } from '../../utils/runtime'
import { parseManagerDbTaskFromJson } from '../../utils/manager_task_context'
import { getOrchestrationChatModel } from '../../utils/agent'
import { applyPlatformModelOverrides } from '../utils/platform_config'
import { resolvePlanEntities } from '../../utils/nlu/dbPlanEntityLlm'
import {
  inferQueryPlanStructural,
  shouldUseStructuralQueryPlan,
} from '../../utils/nlu/structural_query_plan'
import {
  discoverSchemaRelations,
  formatSchemaRelationsForAgent,
  loadTablesMeta,
  type SchemaRelation
} from '../../utils/schema_relations'
import { getMustTablesForDataDomain, loadDomainPatch } from '../../utils/domain_patch'
import { getDbAgentBlueprintEnv } from '../../utils/db_agent_env'
import { judgeTablesForQuestion, type SchemaTableJudgeResult, type TableBrief } from '../../utils/schema_table_judge'
import { stampLlmTableJudge } from '../../utils/prefetch_table_judge'
import type { QueryPlan } from '../../utils/nlu/query_plan'
import { buildDbAgentResult } from '../utils/agent_result'

function parseTablesFromSchemaText(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, '').split(/\s+/)[0]?.trim() || '')
    .filter(Boolean)
}

function parseTableCommentsFromSearchText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s+(\S+)(?:\s+\/\/\s*(.+))?/)
    if (m?.[1]) out[m[1]] = String(m[2] ?? '').trim()
  }
  return out
}

function clipText(text: string, max: number): string {
  const s = String(text ?? '').trim()
  return s.length <= max ? s : s.slice(0, max)
}

function compactColumnsHint(schemaText: string, maxColumns = 12): string {
  const lines = String(schemaText ?? '').split(/\r?\n/)
  const out: string[] = []
  let colCount = 0
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('Table:')) {
      out.push(t)
      continue
    }
    if (/^-/.test(t) || /^\s*-\s+/.test(line)) {
      if (colCount >= maxColumns) continue
      colCount += 1
      out.push(
        line
          .replace(/\([^)]*\)/g, '')
          .replace(/\s+(NOT NULL|NULL|PRI|UNI|MUL)\b/g, '')
          .replace(/\s+DEFAULT\s+[^\s]+/g, '')
          .replace(/\s{2,}/g, ' ')
          .trimEnd(),
      )
    }
  }
  return out.join('\n').trim()
}

/** 与 runSchemaGround 对齐：用结构性 plan 槽位增强 schema 检索词，避免整句复合任务污染探表 */
function buildPrefetchSearchKeywords(
  question: string,
  plan: QueryPlan,
  mgr: ReturnType<typeof parseManagerDbTaskFromJson>,
  patchKw: string[],
): string {
  const parts: string[] = [question]
  const mgrKw = String(mgr?.schema_search_keywords ?? '').trim()
  if (mgrKw) parts.push(mgrKw)
  if (patchKw.length) parts.push(...patchKw.slice(0, 8))
  if (mgr?.hint_tables?.length) parts.push(...mgr.hint_tables)
  if (plan.entities?.locations?.length) parts.push(...plan.entities.locations)
  if (plan.metrics?.length) parts.push(...plan.metrics.slice(0, 6))
  if (plan.filters?.where?.length) parts.push(...plan.filters.where.slice(0, 6))
  return clipText(parts.filter(Boolean).join(' '), 450)
}

function applyDomainMustTables(tables: string[], plan: QueryPlan, domainId: string): string[] {
  const domain = plan.data_domain
  if (!domain || domain === 'general') return tables
  const must = getMustTablesForDataDomain(domain, loadDomainPatch(domainId))
  if (!must.length) return tables
  return [...new Set([...must, ...tables])].slice(0, 8)
}

/** 仅写入候选；有模型选表时才带权威 table_judge（judge_source=llm） */
function buildPrefetchSchemaGround(input: {
  tables: string[]
  evidence: string
  searchKeywords: string
  relations: SchemaRelation[]
  tableJudge?: SchemaTableJudgeResult | null
}): string | undefined {
  const tables = input.tables.filter(Boolean).slice(0, 6)
  if (!tables.length) return undefined
  const hasLlmJudge =
    Boolean(input.tableJudge?.primary_tables?.length) &&
    String((input.tableJudge as { judge_source?: string })?.judge_source ?? '') === 'llm'
  return JSON.stringify({
    candidate_tables: tables,
    ...(hasLlmJudge && input.tableJudge
      ? {
          table_judge: input.tableJudge,
          table_judge_hint: `主查表：${input.tableJudge.primary_tables.join('、')}`,
        }
      : {}),
    schema_summary: input.evidence.slice(0, 1400),
    search_keywords: input.searchKeywords.slice(0, 160),
    relations: input.relations.slice(0, 8),
  })
}

function mergeEntitiesIntoQueryPlan(
  plan: ReturnType<typeof inferQueryPlanStructural>,
  entities: { names: string[]; dates: string[]; records: string[]; locations: string[] },
) {
  const out = { ...plan, entities: { ...plan.entities } }
  if (entities.names.length) {
    out.entities.names = Array.from(new Set([...(out.entities.names ?? []), ...entities.names])).slice(0, 6)
  }
  if (entities.locations.length) {
    out.entities.locations = Array.from(new Set([...(out.entities.locations ?? []), ...entities.locations])).slice(0, 6)
    out.filters = {
      ...out.filters,
      where: Array.from(new Set([...(out.filters.where ?? []), ...entities.locations])).slice(0, 8),
    }
  }
  if (entities.dates.length) {
    out.entities.dates = Array.from(new Set([...(out.entities.dates ?? []), ...entities.dates])).slice(0, 6)
  }
  if (entities.records.length) {
    out.entities.records = Array.from(new Set([...(out.entities.records ?? []), ...entities.records])).slice(0, 6)
  }
  return out
}

/** Manager fetchDbTaskPlan 对齐：预规划实体 + 表/字段/FK 线索 */
export default defineEventHandler(async (event) => {
  ensureRateLimit(event, { max: 60, refillPerSec: 30 })
  const body = await readBody<{
    question?: string
    dbId?: string
    manager_task_json?: string
    managerTask?: Record<string, unknown>
  }>(event)

  const question = String(body?.question ?? '').trim()
  if (!question) {
    throw createError({ statusCode: 400, statusMessage: 'question 不能为空' })
  }

  const mgrJson = (() => {
    if (typeof body?.manager_task_json === 'string' && body.manager_task_json.trim()) {
      return body.manager_task_json.trim()
    }
    if (body?.managerTask && typeof body.managerTask === 'object') {
      try {
        return JSON.stringify(body.managerTask)
      } catch {
        return ''
      }
    }
    return ''
  })()
  const mgr = parseManagerDbTaskFromJson(mgrJson)
  const planQuestion = String(mgr?.refined_question || question).trim() || question

  const runtimeConfig = useRuntimeConfig(event) as any
  let config = resolveAgentRuntimeConfig(runtimeConfig)
  config = await applyPlatformModelOverrides(config)
  const ds = await getDataSource(config)
  const dbName = String((ds.options as any)?.database ?? '')
  const orchModel = getOrchestrationChatModel(config)

  const domainId = getDbAgentBlueprintEnv().domain
  const patchKw = loadDomainPatch(domainId).blueprint.schemaSearchKeywords ?? []

  let structuralPlan = inferQueryPlanStructural(planQuestion)
  const entities = await resolvePlanEntities(orchModel, planQuestion)
  structuralPlan = mergeEntitiesIntoQueryPlan(structuralPlan, entities)

  const searchQ = buildPrefetchSearchKeywords(planQuestion, structuralPlan, mgr, patchKw)
  const searchResult = await introspectSchemaWithComments(ds, `search:${searchQ}`)
  const text = typeof searchResult === 'string' ? searchResult : ''
  const tableComments = parseTableCommentsFromSearchText(text)
  let tables = [
    ...new Set([...parseTablesFromSchemaText(text), ...(mgr?.hint_tables ?? [])])
  ].slice(0, 8)
  tables = applyDomainMustTables(tables, structuralPlan, domainId)

  if (tables.length) {
    for (const t of tables.slice(0, 3)) {
      if (t && !entities.records.includes(t)) entities.records.push(t)
    }
  }

  const queryPlanJson =
    shouldUseStructuralQueryPlan(planQuestion) || structuralPlan.confidence >= 0.62
      ? JSON.stringify(structuralPlan)
      : undefined

  let relations: SchemaRelation[] = []
  let suggested_fields: string[] = []
  let schema_fk_hints = mgr?.schema_fk_hints?.trim() || ''
  let llmTableJudge: SchemaTableJudgeResult | null = null

  if (tables.length) {
    relations = await discoverSchemaRelations(ds, tables)
    if (!schema_fk_hints) schema_fk_hints = formatSchemaRelationsForAgent(relations)
    const metas = await loadTablesMeta(ds, tables.slice(0, 4))
    const fieldSet = new Set<string>()
    for (const hint of mgr?.hint_fields ?? []) {
      const h = String(hint ?? '').trim()
      if (h) fieldSet.add(h)
    }
    for (const meta of metas) {
      for (const col of meta.columns.slice(0, 16)) {
        const label = `${meta.name}.${col.name}`
        const commentHit = (mgr?.hint_fields ?? []).some(
          (h) => col.comment.includes(h) || col.name.includes(h) || h.includes(col.comment)
        )
        if (commentHit || fieldSet.size < 12) fieldSet.add(label)
      }
    }
    suggested_fields = [...fieldSet].slice(0, 24)

    // 主表必须由模型判定，禁止把检索命中表切片伪造成 primary
    if (getDbAgentBlueprintEnv().enableSchemaTableJudge && orchModel && tables.length > 0) {
      const briefs: TableBrief[] = []
      for (const name of tables.slice(0, 6)) {
        let columnsSummary = ''
        try {
          const schemaText = await introspectSchemaWithComments(ds, `schema:${name}`)
          columnsSummary = compactColumnsHint(String(schemaText || ''), 12)
        } catch {
          columnsSummary = ''
        }
        briefs.push({ name, comment: tableComments[name] || '', columnsSummary })
      }
      const judged = await judgeTablesForQuestion(orchModel, {
        question: planQuestion,
        queryPlan: structuralPlan,
        tables: briefs,
      })
      if (judged?.primary_tables?.length) {
        llmTableJudge = stampLlmTableJudge(judged)
      }
    }
  }

  const schemaGroundJson = buildPrefetchSchemaGround({
    tables,
    evidence: text.split('\n').filter((l) => /^\s*-\s+/.test(l)).slice(0, 8).join('\n'),
    searchKeywords: searchQ,
    relations,
    tableJudge: llmTableJudge,
  })
  const prefetchReady = Boolean(
    tables.length &&
      queryPlanJson &&
      schemaGroundJson &&
      llmTableJudge?.primary_tables?.length &&
      String((llmTableJudge as { judge_source?: string }).judge_source) === 'llm',
  )

  // D1：无候选表，或开启 Judge 却无 LLM 主表 → schema_miss（禁止恒 ok:true）
  const schemaMiss = !tables.length
  const judgeRequired = getDbAgentBlueprintEnv().enableSchemaTableJudge
  const judgeMiss =
    judgeRequired && tables.length > 0 && !llmTableJudge?.primary_tables?.length
  const planErrorCode = schemaMiss || judgeMiss ? 'schema_miss' : undefined
  const agentResult = planErrorCode
    ? buildDbAgentResult({
        answer: schemaMiss
          ? '未能定位可用数据表，请补充业务域或表线索。'
          : '未能判定主查表（schema table judge 未产出 primary_tables）。',
        empty: true,
        reason: schemaMiss ? 'no_schema_ground' : 'no_primary_table',
        error_code: planErrorCode,
        path: 'plan',
      })
    : undefined

  return {
    ok: !planErrorCode,
    db: dbName,
    matched: tables.length > 0,
    tables,
    ...(agentResult ? { agentResult } : {}),
    unified_task_plan: {
      intent: 'db',
      entities,
      hints: {
        suggested_tables: tables,
        suggested_fields,
        schema_fk_hints: schema_fk_hints || undefined,
        foreign_keys: relations.slice(0, 8),
        evidence: text.split('\n').filter((l) => /^\s*-\s+/.test(l)).slice(0, 6).join('\n')
      },
      ...(queryPlanJson ? { query_plan_json: queryPlanJson } : {}),
      ...(schemaGroundJson ? { schema_ground_json: schemaGroundJson } : {}),
      prefetch_ready: prefetchReady,
    }
  }
})
