import { extractCrawlerTableMarkdown } from '../../../utils/crawler/managerCrawlerTaskPayload'
import { extractCrawlerItemsFromText, formatSourcesTableMarkdown } from '../../../utils/crawler/crawlerItemsParse'
import {
  AUX_BLOCK_TAGS,
  extractAuxBlocksStructural,
  tableDataBlockHasValues
} from '#agent-shared/auxBlocks'
import { normalizeModelReplyHtml } from '#agent-shared/replyHtmlNormalize'

/** 轻量收尾：保留 Synth 流式正文，仅分离/回挂附属块与 HTML 归一（不用正则删段落/表格） */
export function polishFinalPayload(text: string): string {
  const raw = String(text ?? '')
  const { narrative, blocks } = extractAuxBlocksStructural(raw)
  let body = normalizeModelReplyHtml(String(narrative ?? '').trim())
  body = collapseExtraBlankLines(body)

  const crawlerBlock = blocks.get('CRAWLER_TABLE')
  if (crawlerBlock) {
    const crawlerMd = extractCrawlerTableMarkdown(crawlerBlock)
    if (crawlerMd) {
      const compact = compactCrawlerTableMarkdown(crawlerMd, 5)
      blocks.set('CRAWLER_TABLE', `<!--CRAWLER_TABLE-->\n${compact}\n<!--/CRAWLER_TABLE-->`)
    }
  }

  // 空 TABLE_DATA 不得回挂（否则数据看板只剩表头）
  const tableBlock = blocks.get('TABLE_DATA')
  if (tableBlock && !tableDataBlockHasValues(tableBlock)) {
    blocks.delete('TABLE_DATA')
  }

  const ordered: string[] = []
  for (const tag of AUX_BLOCK_TAGS) {
    const block = blocks.get(tag)
    if (block) ordered.push(block)
  }
  if (!ordered.length) return body
  return `${body}\n\n${ordered.join('\n\n')}`.trim()
}

function trimTrailingSpaces(line: string): string {
  let i = line.length
  while (i > 0) {
    const ch = line.charCodeAt(i - 1)
    if (ch !== 32 && ch !== 9) break
    i -= 1
  }
  return line.slice(0, i)
}

function collapseExtraBlankLines(s: string): string {
  const lines = String(s ?? '').split('\n')
  const out: string[] = []
  let blankRun = 0
  for (const line of lines) {
    if (!line.trim()) {
      blankRun += 1
      if (blankRun <= 2) out.push('')
      continue
    }
    blankRun = 0
    out.push(trimTrailingSpaces(line))
  }
  return out.join('\n').trim()
}

/** 压缩抓取表：最多 5 条，统一为「序号|标题|站点|链接」四列 */
export function compactCrawlerTableMarkdown(rawTable: string, maxRows = 5): string {
  const wrapped = `<!--CRAWLER_TABLE-->\n${String(rawTable ?? '').trim()}\n<!--/CRAWLER_TABLE-->`
  const items = extractCrawlerItemsFromText(wrapped).slice(0, maxRows)
  return formatSourcesTableMarkdown(items, maxRows)
}

/** @deprecated 保留导出名；行为与 polishFinalPayload 相同 */
export function polishUserFacingAnswer(text: string): string {
  return polishFinalPayload(text)
}
