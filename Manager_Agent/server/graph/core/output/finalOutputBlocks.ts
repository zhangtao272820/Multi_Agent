import {
  extractTaggedBlockFull,
  hasTaggedBlockPair,
  wrapTaggedBlock
} from '../../../utils/shared/outputMarkers'
import { resolveRenderableEchartsOptionFromText } from '#agent-shared/codeAuthorityPayload'

export function buildEchartsOptionBlock(raw: string): string {
  try {
    const normalized = resolveRenderableEchartsOptionFromText(String(raw || ''))
    if (!normalized) return ''
    return wrapTaggedBlock('ECHARTS_OPTION', JSON.stringify(normalized, null, 2))
  } catch {
    // 图表 option 不可序列化时不得拖垮整轮 synth
    return ''
  }
}

/** 在 final 正文末尾补齐 visualize 的图表/表格块 */
export function ensureVisualizeBlocksInFinal(
  baseText: string,
  directVisualize: string,
  _agentResults?: Record<string, string>
): string {
  const current = String(baseText || '')
  if (!directVisualize) return current
  if (hasTaggedBlockPair(current, 'ECHARTS_OPTION') && hasTaggedBlockPair(current, 'TABLE_DATA')) {
    return current
  }
  const echartBlock = buildEchartsOptionBlock(directVisualize)
  const tableBlock = extractTaggedBlockFull(directVisualize, 'TABLE_DATA')
  const parts: string[] = []
  if (echartBlock && !hasTaggedBlockPair(current, 'ECHARTS_OPTION')) parts.push(`\n\n${echartBlock}`)
  if (tableBlock && !hasTaggedBlockPair(current, 'TABLE_DATA')) parts.push(`\n\n${tableBlock}`)
  return parts.length ? `${current}${parts.join('')}` : current
}
