/**
 * G3：日志 / 指标 / Observation 脱敏与截断（与 contentTrust 入模 wrap 叠加）。
 */

export type RedactOptions = {
  maxChars?: number
  /** 单字段字符串最大长度 */
  maxFieldChars?: number
}

const SECRET_PATTERNS: Array<(s: string) => string> = [
  (s) => s.replace(/sk-[A-Za-z0-9]{10,}/g, 'sk-***REDACTED***'),
  (s) => s.replace(/(bearer)\s+[A-Za-z0-9._-]{10,}/gi, '$1 ***REDACTED***'),
  (s) =>
    s.replace(
      /(openai_api_key|api_key|apikey|token|secret|password|passwd)\s*[:=]\s*['"]?[^'"\s]{8,}['"]?/gi,
      '$1=***REDACTED***'
    ),
  (s) =>
    s.replace(
      /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
      '***REDACTED_PRIVATE_KEY***'
    ),
  (s) => s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***REDACTED***')
]

export function redactSecrets(text: string): string {
  let s = String(text ?? '')
  for (const fn of SECRET_PATTERNS) s = fn(s)
  return s
}

export function truncateText(text: string, maxChars: number): string {
  const s = String(text ?? '')
  if (maxChars <= 0 || s.length <= maxChars) return s
  return `${s.slice(0, maxChars)}…[truncated ${s.length - maxChars} chars]`
}

/** 递归 scrub 对象用于 metrics.jsonl / 日志落盘 */
export function redactForPersistence(value: unknown, opts?: RedactOptions): unknown {
  const maxField = opts?.maxFieldChars ?? 2000
  const maxRoot = opts?.maxChars

  if (value == null) return value
  if (typeof value === 'string') {
    let s = redactSecrets(value)
    if (maxRoot && s.length > maxRoot) s = truncateText(s, maxRoot)
    else if (s.length > maxField) s = truncateText(s, maxField)
    return s
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactForPersistence(v, opts))
  }
  const out: Record<string, unknown> = {}
  const row = value as Record<string, unknown>
  const keys = Object.keys(row).slice(0, 80)
  for (const k of keys) {
    if (/^(password|secret|api_key|apikey|token|authorization)$/i.test(k)) {
      out[k] = '***REDACTED***'
      continue
    }
    out[k] = redactForPersistence(row[k], opts)
  }
  return out
}

/** 工具 Observation 默认截断 */
export function redactObservation(text: string, maxChars = 4000): string {
  return truncateText(redactSecrets(String(text ?? '')), maxChars)
}

/** smoke：样例中不应残留的明文密钥模式 */
export function containsPlainSecretPatterns(text: string): boolean {
  const s = String(text ?? '')
  if (/sk-[A-Za-z0-9]{10,}/.test(s)) return true
  if (/api_key\s*[:=]\s*['"]?[A-Za-z0-9._-]{8,}/i.test(s)) return true
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(s)) return true
  return false
}
