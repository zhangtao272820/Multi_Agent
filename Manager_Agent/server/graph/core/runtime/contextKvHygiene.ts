/**
 * Context / KV-cache 卫生（Phase F）：稳定 system 前缀，避免秒级时间戳打头废缓存。
 * 纯函数；不调 LLM。
 */

/** 秒级/毫秒时间戳打头会整段废 KV cache（Manus 教训） */
const LEADING_CLOCK =
  /^(?:\s*(?:当前时间|现在时间|系统时间|timestamp|now)\s*[:：]?\s*)?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/i

/** JSON 键序不稳定也会废前缀缓存：序列化时按 key 排序 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(o).sort()) sorted[key] = o[key]
      return sorted
    }
    return v
  })
}

/**
 * 若文本以精确到秒的时钟开头，挪到末尾（保留信息、稳住前缀）。
 */
export function stabilizePromptPrefix(text: string): string {
  const s = String(text || '')
  if (!s.trim()) return s
  const m = s.match(LEADING_CLOCK)
  if (!m || m.index !== 0) return s
  const clock = m[0].trim()
  const rest = s.slice(m[0].length).replace(/^\s*[|\n]+/, '').trimStart()
  if (!rest) return s
  return `${rest}\n\n（时钟注记：${clock}）`
}

export function isKvHostileLeadingClock(text: string): boolean {
  return LEADING_CLOCK.test(String(text || ''))
}
