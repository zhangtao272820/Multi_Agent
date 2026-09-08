/**
 * 单源 DB：对话式 Synth 只负责解读；查询结果表由系统确定性追加（对齐 Vanna 独立端）。
 *
 * 协议要点：
 * - rows / field_details 可能分布在 kind=db 顶层、agentResult.structured、或拆条 agent_result
 * - 禁止「仅有 field_details」的条目抢先 return，挡住后续带真实行的 evidence
 * - 已有 TABLE_DATA 若无有效单元格，必须用 evidence 覆盖（禁止空表占位）
 * - 表头优先用 field_details.label，取值按 label 或 column 对齐（兼容英文字段名行）
 */
import { extractTaggedBlockFull } from '../../../utils/shared/outputMarkers'

export type DbFieldDetail = {
  label?: string
  column?: string
  table?: string
  comment?: string
}

export type DbResultRow = Record<string, unknown>

function isDbEvidenceRow(ev: { kind?: string; agent?: string }): boolean {
  const kind = String(ev?.kind || '').trim()
  if (kind === 'db') return true
  // stepOutcome 会另推一条 kind=agent_result + agent=db
  return kind === 'agent_result' && String(ev?.agent || '').trim() === 'db'
}

function pickFieldDetails(raw: unknown): DbFieldDetail[] {
  if (!Array.isArray(raw)) return []
  return raw as DbFieldDetail[]
}

function pickRows(raw: unknown): DbResultRow[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((r) => r && typeof r === 'object' && !Array.isArray(r)) as DbResultRow[]
}

/** 行内是否有至少一个非空展示值 */
export function rowHasDisplayValues(row: DbResultRow): boolean {
  for (const v of Object.values(row || {})) {
    if (v == null) continue
    if (String(v).trim()) return true
  }
  return false
}

function scoreRows(rows: DbResultRow[]): number {
  if (!rows.length) return 0
  let score = rows.length
  for (const row of rows.slice(0, 40)) {
    if (rowHasDisplayValues(row)) score += 100
    score += Math.min(20, Object.keys(row || {}).length)
  }
  return score
}

function extractDbPayloadFromEvidence(evidence?: unknown[]): {
  rows: DbResultRow[]
  fieldDetails: DbFieldDetail[]
} {
  let bestRows: DbResultRow[] = []
  let bestScore = 0
  let bestDetails: DbFieldDetail[] = []

  for (const ev of Array.isArray(evidence) ? evidence : []) {
    const row = ev as {
      kind?: string
      agent?: string
      rows?: unknown
      field_details?: unknown
      fieldDetails?: unknown
      agentResult?: { structured?: Record<string, unknown> }
    }
    if (!isDbEvidenceRow(row)) continue
    const structured = row.agentResult?.structured
    const rowsFromAr = pickRows(structured?.rows)
    const rowsTop = pickRows(row.rows)
    // 优先有展示值的一侧；两侧都有值时取更长/更完整
    const candidates = [rowsFromAr, rowsTop].filter((r) => r.length)
    let rows: DbResultRow[] = []
    for (const c of candidates) {
      if (scoreRows(c) > scoreRows(rows)) rows = c
    }
    const fieldDetailsFromAr = pickFieldDetails(
      structured?.field_details ?? structured?.fieldDetails
    )
    const fieldDetailsTop = pickFieldDetails(row.field_details ?? row.fieldDetails)
    const fieldDetails = fieldDetailsFromAr.length ? fieldDetailsFromAr : fieldDetailsTop

    const sc = scoreRows(rows)
    if (sc > bestScore) {
      bestScore = sc
      bestRows = rows
    }
    if (fieldDetails.length && (!bestDetails.length || (sc > 0 && rows === bestRows))) {
      bestDetails = fieldDetails
    } else if (fieldDetails.length && !bestDetails.length) {
      bestDetails = fieldDetails
    }
  }
  return { rows: bestRows, fieldDetails: bestDetails }
}

function escapeMdCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

function cellFromRow(row: DbResultRow, label: string, column: string): unknown {
  if (label && Object.prototype.hasOwnProperty.call(row, label)) return row[label]
  if (column && Object.prototype.hasOwnProperty.call(row, column)) return row[column]
  // 大小写不敏感列名
  const keys = Object.keys(row || {})
  if (column) {
    const hit = keys.find((k) => k.toLowerCase() === column.toLowerCase())
    if (hit) return row[hit]
  }
  if (label) {
    const hit = keys.find((k) => k === label || k.toLowerCase() === label.toLowerCase())
    if (hit) return row[hit]
  }
  return undefined
}

/** 按 field_details 对齐列；无 details 时回退为行内键序 */
export function rowsToMarkdownTable(rows: DbResultRow[], fieldDetails?: DbFieldDetail[]): string {
  if (!rows.length) return ''

  const details = Array.isArray(fieldDetails) ? fieldDetails : []
  if (details.length) {
    const cols = details
      .map((d) => {
        const label = String(d.label || d.comment || d.column || '').trim()
        const column = String(d.column || '').trim()
        if (!label && !column) return null
        return { label: label || column, column }
      })
      .filter(Boolean) as Array<{ label: string; column: string }>
    if (cols.length) {
      const anyAligned = rows.some((row) =>
        cols.some((c) => String(cellFromRow(row, c.label, c.column) ?? '').trim())
      )
      // 行键已是展示 label 且比 details 更宽（present_rows 产物）→ 用行键，避免丢列
      const labelKeyRows = rows.some((row) =>
        cols.some((c) => Object.prototype.hasOwnProperty.call(row, c.label))
      )
      const allKeys: string[] = []
      const seenK = new Set<string>()
      for (const row of rows) {
        for (const k of Object.keys(row || {})) {
          const key = String(k || '').trim()
          if (!key || seenK.has(key)) continue
          seenK.add(key)
          allKeys.push(key)
        }
      }
      if (anyAligned && labelKeyRows && allKeys.length >= cols.length) {
        const header = `| ${allKeys.join(' | ')} |`
        const sep = `| ${allKeys.map(() => '---').join(' | ')} |`
        const body = rows
          .slice(0, 40)
          .map((row) => `| ${allKeys.map((k) => escapeMdCell(row[k])).join(' | ')} |`)
          .join('\n')
        return [header, sep, body].join('\n')
      }
      if (anyAligned) {
        const header = `| ${cols.map((c) => c.label).join(' | ')} |`
        const sep = `| ${cols.map(() => '---').join(' | ')} |`
        const body = rows
          .slice(0, 40)
          .map(
            (row) =>
              `| ${cols.map((c) => escapeMdCell(cellFromRow(row, c.label, c.column))).join(' | ')} |`
          )
          .join('\n')
        return [header, sep, body].join('\n')
      }
    }
  }

  const keys: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const k of Object.keys(row || {})) {
      const key = String(k || '').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }
  if (!keys.length) return ''
  if (!rows.some(rowHasDisplayValues)) return ''
  const header = `| ${keys.join(' | ')} |`
  const sep = `| ${keys.map(() => '---').join(' | ')} |`
  const body = rows
    .slice(0, 40)
    .map((row) => `| ${keys.map((k) => escapeMdCell(row[k])).join(' | ')} |`)
    .join('\n')
  return [header, sep, body].join('\n')
}

/**
 * 已废弃：用户面不再追加「本次展示字段」清单。
 * 保留空实现以免外部误引用；表头中文名仍由 rowsToMarkdownTable 使用 field_details。
 */
export function formatDbFieldDetailsBlock(_details: DbFieldDetail[]): string {
  return ''
}

/** 从 evidence 收集须对用户屏蔽的表名/字段原名 */
export function collectDbSchemaIdentifiers(evidence?: unknown[]): string[] {
  const out = new Set<string>()
  const push = (raw: unknown) => {
    const s = String(raw || '').trim()
    if (!s || s.length < 2) return
    // 只要技术标识（含下划线/点号，或纯英文标识符）
    if (!/^[a-zA-Z_][\w.]*$/.test(s)) return
    if (/[\u4e00-\u9fff]/.test(s)) return
    out.add(s)
    const short = s.includes('.') ? s.split('.').pop()! : ''
    if (short && short !== s) out.add(short)
  }
  for (const ev of Array.isArray(evidence) ? evidence : []) {
    const row = ev as {
      kind?: string
      agent?: string
      field_details?: DbFieldDetail[]
      fieldDetails?: DbFieldDetail[]
      tables?: unknown
      executed_sql?: unknown
      agentResult?: { structured?: Record<string, unknown> }
    }
    const kind = String(row?.kind || '').trim()
    const isDb =
      kind === 'db' || (kind === 'agent_result' && String(row?.agent || '').trim() === 'db')
    if (!isDb) continue
    const structured = row.agentResult?.structured
    const details = [
      ...pickFieldDetails(row.field_details ?? row.fieldDetails),
      ...pickFieldDetails(structured?.field_details ?? structured?.fieldDetails)
    ]
    for (const d of details) {
      push(d.column)
      push(d.table)
    }
    const tables = structured?.tables ?? row.tables
    if (Array.isArray(tables)) for (const t of tables) push(t)
  }
  return Array.from(out).sort((a, b) => b.length - a.length)
}

/**
 * 用户面脱敏：剥表名/字段原名（返回体清洗，非用户意图识别）。
 * 保留中文注释名与业务数值。
 * 注意：禁止直接 scrub 含 TABLE_DATA 的整段终稿——会掏空表头/单元格；请用 scrubProsePreservingTableData。
 */
export function scrubDbSchemaIdentifiers(text: string, identifiers?: string[]): string {
  let s = String(text || '')
  if (!s.trim()) return s
  // 结构性泄漏：`（表 xxx）` / 表 `xxx`
  s = s.replace(/（\s*表\s*`[^`]+`\s*）/g, '')
  s = s.replace(/（\s*表\s*[a-zA-Z_][\w.]*\s*）/g, '')
  s = s.replace(/表\s*`([a-zA-Z_][\w.]*)`/g, '')
  s = s.replace(/(?:^|[\s，,。；;：:])表\s+([a-zA-Z_][\w.]*)(?=[\s，,。；;：:]|$)/g, (m) =>
    m.replace(/表\s+[a-zA-Z_][\w.]*/, '').trim()
  )
  // 反引号包裹的技术标识（snake_case / dotted）
  s = s.replace(/`([a-zA-Z_][\w.]*)`/g, (_m, id: string) => {
    if (/^[a-zA-Z_][\w.]*$/.test(id) && (id.includes('_') || id.includes('.') || id.length >= 4)) {
      return ''
    }
    return _m
  })
  const ids = (identifiers || []).filter(Boolean)
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    s = s.replace(new RegExp(`\`${esc}\``, 'g'), '')
    s = s.replace(new RegExp(`\\b${esc}\\b`, 'g'), '')
  }
  // 清理残留空括号/多余空白
  s = s.replace(/（\s*）/g, '')
  s = s.replace(/[ \t]+\n/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.replace(/[ \t]{2,}/g, ' ')
  return s.trim()
}

/**
 * 只 scrub 解读正文；TABLE_DATA 整块原样保留（查询结果单元格不得被 \bcolumn\b 掏空）。
 */
export function scrubProsePreservingTableData(text: string, identifiers?: string[]): string {
  const s = String(text || '')
  if (!s.trim()) return s
  const re = /<!--\s*TABLE_DATA\s*-->[\s\S]*?<!--\s*\/TABLE_DATA\s*-->/gi
  const kept: string[] = []
  const withSlots = s.replace(re, (block) => {
    const i = kept.length
    kept.push(block)
    return `\n%%TABLE_DATA_SLOT_${i}%%\n`
  })
  let scrubbed = scrubDbSchemaIdentifiers(withSlots, identifiers)
  for (let i = 0; i < kept.length; i++) {
    scrubbed = scrubbed.replace(`%%TABLE_DATA_SLOT_${i}%%`, kept[i]!)
  }
  return scrubbed.replace(/\n{3,}/g, '\n\n').trim()
}

/** evidence 是否含可展示的查询行（有值） */
export function evidenceHasDisplayableDbRows(evidence?: unknown[]): boolean {
  const { rows } = extractDbPayloadFromEvidence(evidence)
  return rows.some(rowHasDisplayValues)
}

/** 结构化表是否含至少一个非空单元格 */
export function structuredTableHasValues(table?: {
  headers?: string[]
  rows?: string[][]
} | null): boolean {
  if (!table?.headers?.length || !table?.rows?.length) return false
  return table.rows.some((r) => (r || []).some((c) => String(c ?? '').trim()))
}

/** TABLE_DATA 正文是否含至少一个非空数据单元格（跳过表头/分隔行） */
export function tableMarkdownHasValues(md: string): boolean {
  const lines = String(md || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const tableLines = lines.filter((l) => l.includes('|'))
  if (tableLines.length < 2) return false
  for (const line of tableLines.slice(1)) {
    if (/^\|?\s*:?-{3,}/.test(line)) continue
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    if (cells.some((c) => c.length > 0)) return true
  }
  return false
}

function bodyAlreadyContainsDataBlock(body: string, tableMd: string): boolean {
  const b = String(body || '').trim()
  if (!b) return false
  if (/<!--\s*TABLE_DATA\s*-->/.test(b)) {
    const existing = extractTaggedBlockFull(b, 'TABLE_DATA')
    // 已有空表不算「已含数据」，允许覆盖
    if (existing?.trim() && tableMarkdownHasValues(existing)) return true
    return false
  }
  const firstRow = tableMd.split('\n')[2]
  if (firstRow && b.includes(firstRow.slice(0, Math.min(24, firstRow.length)))) return true
  return false
}

function stripEmptyTableDataBlocks(text: string): string {
  const loose = /<!--\s*TABLE_DATA\s*-->([\s\S]*?)<!--\s*\/TABLE_DATA\s*-->/gi
  const s = String(text || '').replace(loose, (_full, inner: string) => {
    if (tableMarkdownHasValues(String(inner || ''))) return _full
    return ''
  })
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

/** 单源 DB 终稿：解读 + 必展示查询结果表（不追加「本次展示字段」清单） */
export function buildMandatoryDbDataBlock(input: {
  synthBody?: string
  sourceText?: string
  evidence?: unknown[]
}): string {
  const synthBody = String(input.synthBody || '')
  const sourceText = String(input.sourceText || '')
  const existing = extractTaggedBlockFull(synthBody || sourceText, 'TABLE_DATA')
  // 已有有效数据表 → 不重复追加
  if (existing?.trim() && tableMarkdownHasValues(existing)) return ''

  const { rows, fieldDetails } = extractDbPayloadFromEvidence(input.evidence)
  const tableMd = rowsToMarkdownTable(rows, fieldDetails)
  if (tableMd) {
    if (bodyAlreadyContainsDataBlock(synthBody, tableMd)) return ''
    // 仅 TABLE_DATA：UI「数据看板」已有标题，勿再堆「查询结果 / 本次展示字段」
    return `<!--TABLE_DATA-->\n${tableMd}\n<!--/TABLE_DATA-->`
  }

  const src = sourceText.trim()
  if (src.length >= 16 && !bodyAlreadyContainsDataBlock(synthBody, src)) {
    return src
  }
  return ''
}

export function mergeConversationalDbSynthWithDataBlock(input: {
  synthBody: string
  sourceText: string
  evidence?: unknown[]
  /** Presentation Plan 为 false 时不追加查询表；若 evidence 已有真实行则仍强制追加 */
  includeDataBlock?: boolean
}): string {
  let body = String(input.synthBody || '').trim()
  const schemaIds = collectDbSchemaIdentifiers(input.evidence)
  // 解读正文先脱敏；先剥空表，避免后续误判
  body = scrubDbSchemaIdentifiers(stripEmptyTableDataBlocks(body), schemaIds)

  const hasDisplayRows = evidenceHasDisplayableDbRows(input.evidence)
  // 展示计划可折叠装饰表，但不可隐藏已查到的真实行（否则数据看板空壳 / 一闪而过）
  const allowDataBlock = input.includeDataBlock !== false || hasDisplayRows
  if (!allowDataBlock) {
    return body || scrubDbSchemaIdentifiers(String(input.sourceText || '').trim(), schemaIds)
  }

  const dataBlock = buildMandatoryDbDataBlock({
    synthBody: body,
    sourceText: input.sourceText,
    evidence: input.evidence
  })
  if (!body) {
    const fallback = dataBlock || String(input.sourceText || '').trim()
    return scrubProsePreservingTableData(fallback, schemaIds)
  }
  if (!dataBlock) return scrubProsePreservingTableData(body, schemaIds)
  return scrubProsePreservingTableData(`${body}\n\n${dataBlock}`, schemaIds)
}

/** 供 userFacing / 测试：从 evidence 直接解析表（不依赖 TABLE_DATA 标记） */
export function tableFromDbEvidence(evidence?: unknown[]): {
  headers: string[]
  rows: string[][]
} | null {
  const { rows, fieldDetails } = extractDbPayloadFromEvidence(evidence)
  const md = rowsToMarkdownTable(rows, fieldDetails)
  if (!md || !tableMarkdownHasValues(md)) return null
  const lines = md.split('\n').map((l) => l.trim()).filter(Boolean)
  const splitRow = (line: string) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
  const headers = splitRow(lines[0] || '')
  if (!headers.length) return null
  const outRows: string[][] = []
  for (const line of lines.slice(1)) {
    if (/^\|?\s*:?-{3,}/.test(line)) continue
    const cells = splitRow(line)
    if (cells.every((c) => !c)) continue
    while (cells.length < headers.length) cells.push('')
    outRows.push(cells.slice(0, headers.length))
    if (outRows.length >= 40) break
  }
  if (!outRows.length) return null
  return { headers, rows: outRows }
}
