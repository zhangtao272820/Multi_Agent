/**
 * Probe 结果解读：区分「业务库表命中」与「RAG/向量库元数据表命中」。
 * dify_knowledge_doc* 等是知识库后端存储，不得作为 db Agent 路由依据。
 */

export type ProbeDbSlice = {
  matched?: boolean
  tables?: string[]
  /** 与问句无关的业务库表库存（能力清单） */
  tableInventory?: string[]
  schemaMatched?: boolean
  executable?: boolean
  schemaSummary?: string
}

export type ProbeRagSlice = {
  hits?: number
  hasDocs?: boolean
  sources?: string[]
  snippets?: string[]
  /** 知识库已索引文档名库存（能力清单） */
  docInventory?: string[]
}

const CATALOG_DB_MAX = 520
const CATALOG_RAG_MAX = 520

/** 表名是否属于 RAG/知识库基础设施（非用户要查的业务库表） */
export function isRagInfrastructureTableName(table: string): boolean {
  const t = String(table ?? '').trim().toLowerCase()
  if (!t) return false
  if (t.includes('dify_knowledge') || t.includes('knowledge_doc')) return true
  if (t.includes('vector_store') || t.includes('embedding') || t.includes('doc_segment')) return true
  if (t.startsWith('rag_') && (t.includes('doc') || t.includes('chunk') || t.includes('segment'))) return true
  return false
}

/** DB probe 是否应对路由/预取生效（业务库表，非 RAG 元数据） */
export function isProbeDbRoutingRelevant(db?: ProbeDbSlice | null): boolean {
  if (!db) return false
  const tables = (Array.isArray(db.tables) ? db.tables : []).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!tables.length) return Boolean(db.matched && db.executable !== false)
  const business = tables.filter((t) => !isRagInfrastructureTableName(t))
  return business.length > 0
}

export function interpretProbeDbForRouting(db?: ProbeDbSlice | null): {
  routingRelevant: boolean
  ragInfraOnly: boolean
  businessTables: string[]
  infraTables: string[]
} {
  const tables = (Array.isArray(db?.tables) ? db!.tables! : []).map((s) => String(s ?? '').trim()).filter(Boolean)
  const infraTables = tables.filter(isRagInfrastructureTableName)
  const businessTables = tables.filter((t) => !isRagInfrastructureTableName(t))
  const ragInfraOnly = tables.length > 0 && businessTables.length === 0
  const routingRelevant = isProbeDbRoutingRelevant(db)
  return { routingRelevant, ragInfraOnly, businessTables, infraTables }
}

export function formatProbeForOrchestrator(probe?: {
  db?: ProbeDbSlice
  rag?: ProbeRagSlice
} | null): string {
  const ragHits = Number(probe?.rag?.hits ?? 0)
  const dbInterp = interpretProbeDbForRouting(probe?.db)
  const lines = [
    '【探测说明】仅表示服务可达；RAG 元数据表命中 ≠ 用户要查业务库',
    `RAG 可达: ${ragHits > 0 ? `${ragHits} hits` : 'no hit'}`
  ]
  if (dbInterp.ragInfraOnly) {
    lines.push(
      `DB schema 命中 RAG 元数据表（${dbInterp.infraTables.slice(0, 3).join(',')}），routingRelevant=false，禁止因此加 db Agent`
    )
  } else if (dbInterp.routingRelevant) {
    lines.push(`DB 业务表命中: ${dbInterp.businessTables.slice(0, 3).join(',') || 'yes'}`)
  } else {
    lines.push('DB 业务表: 未命中')
  }
  return lines.join('\n')
}

/**
 * 运行时目录：能力库存（inventory）+ 本轮命中（hits）。
 * 库存供编排判断「哪类源能答」；命中仅弱参考，非权威路由。
 */
export function formatRuntimeCatalogsForOrchestrator(probe?: {
  db?: ProbeDbSlice
  rag?: ProbeRagSlice
} | null): string {
  const dbInterp = interpretProbeDbForRouting(probe?.db)
  const hitTables = dbInterp.businessTables.slice(0, 8)
  const inventoryTables = (Array.isArray(probe?.db?.tableInventory) ? probe!.db!.tableInventory! : [])
    .map((t) => String(t || '').trim())
    .filter((t) => t && !isRagInfrastructureTableName(t))
    .slice(0, 12)
  const schemaBit = String(probe?.db?.schemaSummary || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)

  const dbLines = [
    '【db_catalog·弱参考】对照库存判断库表能否答本轮（非权威路由）：',
    inventoryTables.length
      ? `库存表：${inventoryTables.join(', ')}`
      : '库存表：暂无（仍可按 structured_query 判 db，勿臆造表名）',
    hitTables.length
      ? `本轮命中：${hitTables.join(', ')}${schemaBit ? `；摘要：${schemaBit}` : ''}`
      : '本轮命中：无'
  ]

  const docInventory = (Array.isArray(probe?.rag?.docInventory) ? probe!.rag!.docInventory! : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 12)
  const hitSources = (Array.isArray(probe?.rag?.sources) ? probe!.rag!.sources! : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 6)
  const snip = (Array.isArray(probe?.rag?.snippets) ? probe!.rag!.snippets! : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s.slice(0, 80))

  const ragLines = [
    '【rag_catalog·弱参考】对照库存判断文档面能否答本轮（非权威路由）：',
    docInventory.length
      ? `库存文档：${docInventory.join('；')}`
      : '库存文档：暂无（仍可按 document_retrieval 判 rag，勿臆造条文）',
    hitSources.length
      ? `本轮命中：${hitSources.join('；')}${snip.length ? `；片段：${snip.join(' | ')}` : ''}`
      : '本轮命中：无'
  ]

  return [dbLines.join('\n').slice(0, CATALOG_DB_MAX), ragLines.join('\n').slice(0, CATALOG_RAG_MAX)].join('\n')
}
