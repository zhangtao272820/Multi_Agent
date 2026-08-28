/**
 * 单源 DB：对话式 Synth 只负责解读；查询结果表由系统确定性追加（对齐 Vanna 独立端）。
 */
import { extractTaggedBlockFull } from '../../../utils/shared/outputMarkers'

export type DbFieldDetail = {
  label?: string
  column?: string
  table?: string
  comment?: string
}

export type DbResultRow = Record<string, unknown>

function extractDbPayloadFromEvidence(evidence?: unknown[]): {
  rows: DbResultRow[]
  fieldDetails: DbFieldDetail[]
} {
  for (const ev of Array.isArray(evidence) ? evidence : []) {
    if (String((ev as { kind?: string })?.kind || '') !== 'db') continue
    const structured = (ev as { agentResult?: { structured?: Record<string, unknown> } })?.agentResult
      ?.structured
    const rows = Array.isArray(structured?.rows) ? (structured!.rows as DbResultRow[]) : []
    const fieldDetails = Array.isArray(structured?.field_details)
      ? (structured!.field_details as DbFieldDetail[])
      : Array.isArray(structured?.fieldDetails)
        ? (structured!.fieldDetails as DbFieldDetail[])
        : []
    if (rows.length || fieldDetails.length) return { rows, fieldDetails }
  }
  return { rows: [], fieldDetails: [] }
}

function escapeMdCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

export function rowsToMarkdownTable(rows: DbResultRow[]): string {
  if (!rows.length) return ''
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
  const header = `| ${keys.join(' | ')} |`
  const sep = `| ${keys.map(() => '---').join(' | ')} |`
  const body = rows
    .slice(0, 40)
    .map((row) => `| ${keys.map((k) => escapeMdCell(row[k])).join(' | ')} |`)
    .join('\n')
  return [header, sep, body].join('\n')
}

export function formatDbFieldDetailsBlock(details: DbFieldDetail[]): string {
  const items = details
    .map((d) => {
      const label = String(d.label || d.comment || '').trim()
      const column = String(d.column || '').trim()
      const table = String(d.table || '').trim()
      if (!label && !column) return ''
      const colPart = column ? `\`${column}\`` : ''
      const tablePart = table ? `（表 \`${table}\`）` : ''
      return `- ${label || column}：${colPart}${tablePart}`
    })
    .filter(Boolean)
  if (!items.length) return ''
  return ['### 字段说明', ...items, '仅展示与本次问句相关的列。'].join('\n')
}

function bodyAlreadyContainsDataBlock(body: string, tableMd: string): boolean {
  const b = String(body || '').trim()
  if (!b) return false
  if (/<!--\s*TABLE_DATA\s*-->/.test(b)) return true
  const firstRow = tableMd.split('\n')[2]
  if (firstRow && b.includes(firstRow.slice(0, Math.min(24, firstRow.length)))) return true
  return false
}

/** 单源 DB 终稿：解读 + 必展示查询结果（表 + 字段映射） */
export function buildMandatoryDbDataBlock(input: {
  synthBody?: string
  sourceText?: string
  evidence?: unknown[]
}): string {
  const existing = extractTaggedBlockFull(String(input.synthBody || input.sourceText || ''), 'TABLE_DATA')
  if (existing?.trim()) return ''

  const { rows, fieldDetails } = extractDbPayloadFromEvidence(input.evidence)
  const tableMd = rowsToMarkdownTable(rows)
  if (tableMd) {
    if (bodyAlreadyContainsDataBlock(String(input.synthBody || ''), tableMd)) return ''
    const fieldBlock = formatDbFieldDetailsBlock(fieldDetails)
    return [
      '### 查询结果',
      `<!--TABLE_DATA-->\n${tableMd}\n<!--/TABLE_DATA-->`,
      fieldBlock
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  const src = String(input.sourceText || '').trim()
  if (src.length >= 16 && !bodyAlreadyContainsDataBlock(String(input.synthBody || ''), src)) {
    return `### 查询结果\n\n${src}`
  }
  return ''
}

export function mergeConversationalDbSynthWithDataBlock(input: {
  synthBody: string
  sourceText: string
  evidence?: unknown[]
  /** Presentation Plan 为 false 时不追加查询表 */
  includeDataBlock?: boolean
}): string {
  const body = String(input.synthBody || '').trim()
  if (input.includeDataBlock === false) return body || String(input.sourceText || '').trim()
  const dataBlock = buildMandatoryDbDataBlock({
    synthBody: body,
    sourceText: input.sourceText,
    evidence: input.evidence
  })
  if (!body) return dataBlock || String(input.sourceText || '').trim()
  if (!dataBlock) return body
  return `${body}\n\n${dataBlock}`
}
