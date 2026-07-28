/**
 * 出图 / 可视化结构性标记 SSOT（非 LLM 路由；供 drift 检测、evaluator 结构门、clarify 排除用）。
 * 图表类型名词与动作词统一在此，避免各处 regex 漏检「柱状图」等。
 */
export const VISUALIZE_MARKERS = [
  '图表',
  '可视化',
  'echarts',
  '柱状图',
  '折线图',
  '饼图',
  '条形图',
  '散点图',
  '仪表盘',
  '画图',
  '对比图',
  '做成图',
  '绘制'
] as const

/** 「画…图」短模式（画个图 / 画柱状图） */
const DRAW_CHART_RE = /画.{0,4}图/

export function textWantsVisualizeStructural(text: string): boolean {
  const t = String(text ?? '')
  if (!t.trim()) return false
  const lower = t.toLowerCase()
  if (VISUALIZE_MARKERS.some((m) => lower.includes(m.toLowerCase()))) return true
  return DRAW_CHART_RE.test(t)
}
