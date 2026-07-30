/**
 * Lobster ↔ Manager Progress / Final 协议契约（P3-L5）
 * WS / HTTP status / MCP 三路径应对齐：截图指纹去重 · 思考抽样 · agentResult 必有
 */

export type LobsterGuiAgentResultLite = {
  ok: boolean
  agent: string
  answer?: string
  sources?: Array<{ type: string; ref: string }>
  structured?: Record<string, unknown>
  needs_clarify?: boolean
  error_code?: string
  latency_ms?: number
  trace_id?: string
}

/** G2 验收建议上限（思考条数；截图按 URL/指纹变） */
export const LOBSTER_GUI_PROGRESS_LIMITS = {
  /** 总管思考流硬上限（Stagehand-first 轻装） */
  maxThinkingLines: 12,
  /** status poll 间隔 ms */
  pollIntervalMs: 400,
} as const

export function guiScreenshotFingerprint(dataUrl: string, pageUrl?: string): string {
  const s = String(dataUrl || '')
  return `${s.length}:${s.slice(0, 96)}:${s.slice(-48)}:${String(pageUrl || '')}`
}

/** 是否应转发到总管思考流（禁 step_end JSON / 引擎元数据 / 感知刷屏） */
export function shouldForwardGuiThinking(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if (/^step_(begin|end)\b/i.test(t)) return false
  if (/^\s*\{[\s\S]*"pageContentHash"/.test(t)) return false
  if (/结果验证：继续下一轮感知/i.test(t)) return false
  if (/正在进行 OCR|正在理解界面|视觉感知|智能决策/i.test(t) && t.length < 40) return false
  // 引擎元数据 / 链噪音
  if (/^actualEngine=/i.test(t)) return false
  if (/引擎链|engine_chain|run_meta|activeIndex/i.test(t)) return false
  if (/^\[stagehand\]/i.test(t)) return false
  if (/observe：\s*\[/i.test(t) || /observe：\s*\{/i.test(t)) return false
  if (/已加载 \d+ 条 cookie|已保存 \d+ 条 cookie/i.test(t)) return false
  if (/MCP=无头 sidecar|sidecarNote/i.test(t)) return false
  return true
}

export function hasStableGuiFinalPayload(input: {
  agentResult?: LobsterGuiAgentResultLite | null
  answer?: string
  itemsCount?: number
  finalUrl?: string
}): boolean {
  const ar = input.agentResult
  if (ar && typeof ar === 'object') {
    if (String(ar.answer || '').trim().length >= 6) return true
    const src = Array.isArray(ar.sources) ? ar.sources.length : 0
    if (src > 0) return true
  }
  if (String(input.answer || '').trim().length >= 6) return true
  if (Math.max(0, Number(input.itemsCount || 0)) > 0) return true
  return false
}

/**
 * 搜索抽取类：禁止「仅有 finalUrl」当作成功。
 * open-first / 导航类可仅用最终 URL。
 */
export function searchTaskRequiresContentPayload(task: string): boolean {
  const t = String(task || '')
  // 与 lobsterRunVerifyLite 既有任务形态检测同源字段，供契约层复用
  const searchLike = /(搜索|search|查找|query)/i.test(t)
  if (!searchLike) return false
  const extractLike = /(抽取|提取|获取|输出|列表|结果|items|前\s*\d+\s*条|top\s*\d+)/i.test(t)
  return extractLike
}

export function assertMcpGuiRunHasAgentResult(payload: Record<string, unknown>): boolean {
  const ar = payload.agentResult
  return !!(ar && typeof ar === 'object' && 'ok' in (ar as object) && 'agent' in (ar as object))
}
