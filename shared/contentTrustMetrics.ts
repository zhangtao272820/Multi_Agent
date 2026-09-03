/**
 * 注入 / 不可信包装 Prometheus 计数（进程内，供 /metrics 导出）。
 */

let wrapTotal = 0
let sanitizeEmptyTotal = 0
let strictModeTotal = 0

export function recordContentTrustWrap(source?: string): void {
  wrapTotal += 1
  if (String(source || '').trim()) void source
}

export function recordContentTrustSanitizeEmpty(): void {
  sanitizeEmptyTotal += 1
}

export function recordContentTrustStrictMode(): void {
  strictModeTotal += 1
}

export function getContentTrustMetricsSnapshot(): {
  wrapTotal: number
  sanitizeEmptyTotal: number
  strictModeTotal: number
} {
  return { wrapTotal, sanitizeEmptyTotal, strictModeTotal }
}

export function resetContentTrustMetricsForTests(): void {
  wrapTotal = 0
  sanitizeEmptyTotal = 0
  strictModeTotal = 0
}
