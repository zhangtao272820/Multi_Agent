export const AUX_BLOCK_TAGS = ['ECHARTS_OPTION', 'TABLE_DATA', 'REPORT', 'CRAWLER_TABLE'] as const
export type AuxBlockTag = (typeof AUX_BLOCK_TAGS)[number]

export function extractAuxBlocksStructural(text: string): {
  narrative: string
  blocks: Map<AuxBlockTag, string>
} {
  let narrative = String(text ?? '')
  const blocks = new Map<AuxBlockTag, string>()
  for (const tag of AUX_BLOCK_TAGS) {
    const open = `<!--${tag}-->`
    const close = `<!--/${tag}-->`
    let searchFrom = 0
    while (searchFrom < narrative.length) {
      const start = narrative.indexOf(open, searchFrom)
      if (start < 0) break
      const end = narrative.indexOf(close, start + open.length)
      if (end < 0) break
      const full = narrative.slice(start, end + close.length).trim()
      blocks.set(tag, full)
      narrative = `${narrative.slice(0, start)}${narrative.slice(end + close.length)}`.trim()
      searchFrom = Math.max(0, start)
    }
  }
  return { narrative: narrative.trim(), blocks }
}

/** TABLE_DATA 是否含非空数据单元格（跳过表头/分隔行） */
export function tableDataBlockHasValues(block: string): boolean {
  const open = '<!--TABLE_DATA-->'
  const close = '<!--/TABLE_DATA-->'
  const s = String(block || '')
  const start = s.indexOf(open)
  const end = start >= 0 ? s.indexOf(close, start + open.length) : -1
  const inner =
    start >= 0 && end > start ? s.slice(start + open.length, end) : s.replace(/<!--\s*\/?TABLE_DATA\s*-->/gi, '')
  const lines = String(inner || '')
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

/** 合并两侧 TABLE_DATA：有单元格的优先；禁止空壳盖掉有数表（定稿一闪而过根因） */
export function pickRicherTableDataBlock(
  primary?: string,
  secondary?: string
): string | undefined {
  const a = String(primary || '').trim()
  const b = String(secondary || '').trim()
  const aOk = Boolean(a && tableDataBlockHasValues(a))
  const bOk = Boolean(b && tableDataBlockHasValues(b))
  if (aOk && bOk) return b.length >= a.length * 0.9 ? b : a
  if (aOk) return a
  if (bOk) return b
  return undefined
}

export function mergeMissingAuxBlocksFrom(base: string, donor: string): string {
  let out = String(base ?? '').trim()
  const donorBlocks = extractAuxBlocksStructural(donor).blocks
  for (const tag of AUX_BLOCK_TAGS) {
    const block = donorBlocks.get(tag)
    if (!block) continue
    if (tag === 'TABLE_DATA') {
      if (tableDataBlockHasValues(block) && !tableDataBlockHasValues(out)) {
        out = out
          .replace(/<!--\s*TABLE_DATA\s*-->[\s\S]*?<!--\s*\/TABLE_DATA\s*-->/gi, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        out = `${out}\n\n${block}`.trim()
      }
      continue
    }
    if (out.includes(`<!--${tag}-->`)) continue
    out = `${out}\n\n${block}`.trim()
  }
  return out
}

/** 取更长的叙事正文，并合并两侧附属块（流式预览 vs 落盘 final 对齐） */
export function pickRicherNarrativeWithAuxBlocks(primary: string, secondary: string): string {
  const a = extractAuxBlocksStructural(String(primary ?? ''))
  const b = extractAuxBlocksStructural(String(secondary ?? ''))
  let narrative = a.narrative.trim()
  const bNarr = b.narrative.trim()
  if (!narrative) narrative = bNarr
  else if (bNarr.length > narrative.length * 1.05) narrative = bNarr
  else if (narrative.length < bNarr.length * 0.85 && bNarr.length > 0) narrative = bNarr
  let out = narrative.trim()
  // 清掉叙事里空 TABLE_DATA，避免空壳占位
  out = out
    .replace(/<!--\s*TABLE_DATA\s*-->[\s\S]*?<!--\s*\/TABLE_DATA\s*-->/gi, (full) =>
      tableDataBlockHasValues(full) ? full : ''
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  for (const tag of AUX_BLOCK_TAGS) {
    let block: string | undefined
    if (tag === 'TABLE_DATA') {
      block = pickRicherTableDataBlock(a.blocks.get(tag), b.blocks.get(tag))
    } else {
      block = b.blocks.get(tag) || a.blocks.get(tag)
    }
    if (!block) continue
    if (out.includes(`<!--${tag}-->`)) {
      if (tag === 'TABLE_DATA' && !tableDataBlockHasValues(out) && tableDataBlockHasValues(block)) {
        out = out
          .replace(/<!--\s*TABLE_DATA\s*-->[\s\S]*?<!--\s*\/TABLE_DATA\s*-->/gi, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        out = `${out}\n\n${block}`.trim()
      }
      continue
    }
    out = `${out}\n\n${block}`.trim()
  }
  return out
}
