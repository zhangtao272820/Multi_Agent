/**
 * Artifact 导出 / 报告修订注 — 纯函数，可 smoke。
 */
const REVISED_NOTE_PREFIX = '报告已在分析面板修订'

export function formatReportRevisionNote(editedAt?: string): string {
  const raw = String(editedAt || '').trim()
  let when = ''
  if (raw) {
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0')
      when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
  }
  return when
    ? `${REVISED_NOTE_PREFIX}（${when}）。完整内容见下方分析面板。`
    : `${REVISED_NOTE_PREFIX}。完整内容见下方分析面板。`
}

export function isReportRevisionNoteLine(line: string): boolean {
  return String(line || '').trim().startsWith(REVISED_NOTE_PREFIX)
}

/** 幂等：去掉旧修订注后再追加（用于 summary 文本层） */
export function mergeSummaryWithRevisionNote(summary: string, note: string): string {
  const base = String(summary || '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      if (t === '>' || t === '>---' || t === '---') return true
      if (isReportRevisionNoteLine(t.replace(/^>\s*/, ''))) return false
      if (/^\*\*?报告已在分析面板修订/.test(t)) return false
      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const n = String(note || '').trim()
  if (!n) return base
  if (!base) return `> ${n}`
  return `${base}\n\n> ${n}`
}

export function tableToCsv(table: { headers: string[]; rows: string[][] } | null | undefined): string {
  if (!table?.headers?.length) return ''
  const esc = (cell: unknown) => {
    const s = String(cell ?? '')
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const lines = [table.headers.map(esc).join(',')]
  for (const row of table.rows || []) {
    lines.push(table.headers.map((_, i) => esc(row[i])).join(','))
  }
  return `${lines.join('\n')}\n`
}

export type ArtifactExportFile = {
  name: string
  /** utf-8 text or binary */
  content: string | Uint8Array
  mime: string
}

export function buildArtifactExportManifest(input: {
  turnId: number
  title?: string
  hasReport?: boolean
  hasTable?: boolean
  hasChart?: boolean
  reportEdited?: boolean
}): string {
  return JSON.stringify(
    {
      kind: 'manager_artifact_bundle',
      turnId: input.turnId,
      title: String(input.title || '分析面板').slice(0, 120),
      files: [
        input.hasReport ? 'report.md' : null,
        input.hasTable ? 'table.csv' : null,
        input.hasChart ? 'chart.png' : null
      ].filter(Boolean),
      reportEdited: Boolean(input.reportEdited),
      exportedAt: new Date().toISOString()
    },
    null,
    2
  )
}

/** CRC32 for ZIP (IEEE) */
function crc32(buf: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  return b
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  b[2] = (n >>> 16) & 0xff
  b[3] = (n >>> 24) & 0xff
  return b
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/**
 * 无依赖 ZIP（仅 STORE，无压缩）— 浏览器可下载。
 */
export function buildZipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const nameBytes = encodeUtf8(f.name.replace(/\\/g, '/'))
    const data = f.data
    const crc = crc32(data)
    const local = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data
    ])
    const central = concatBytes([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes
    ])
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralDir = concatBytes(centrals)
  const end = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0)
  ])
  return concatBytes([...locals, centralDir, end])
}

export function textFile(name: string, text: string, mime = 'text/plain;charset=utf-8'): ArtifactExportFile {
  return { name, content: text, mime }
}

export function base64PngToBytes(dataUrlOrB64: string): Uint8Array | null {
  const s = String(dataUrlOrB64 || '')
  const m = s.match(/^data:image\/png;base64,(.+)$/i)
  const b64 = m ? m[1]! : s.includes(',') ? null : s
  if (!b64) return null
  try {
    if (typeof atob === 'function') {
      const bin = atob(b64)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    }
    // Node smoke / SSR
    const Buf = (globalThis as { Buffer?: { from: (s: string, enc: string) => Uint8Array } }).Buffer
    if (Buf) return new Uint8Array(Buf.from(b64, 'base64'))
    return null
  } catch {
    return null
  }
}
