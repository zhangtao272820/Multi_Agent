/**
 * DashScope / OpenAI 兼容 API 的 429 限流识别与有限退避。
 * 仅分类传输层错误，不参与用户意图判断。
 */

export function readHttpStatusFromError(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as Record<string, unknown>
  for (const key of ['status', 'statusCode', 'httpStatus'] as const) {
    const n = Number(e[key])
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  const resp = e.response
  if (resp && typeof resp === 'object') {
    const st = Number((resp as Record<string, unknown>).status)
    if (Number.isFinite(st) && st > 0) return Math.floor(st)
  }
  return undefined
}

export function isLlmRateLimitError(err: unknown): boolean {
  const status = readHttpStatusFromError(err)
  if (status === 429) return true
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (!msg) return false
  return /(?:^|[^\d])429(?:[^\d]|$)|rate\s*limit|request\s*limit|too\s*many\s*requests|throttl/i.test(msg)
}

function readRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as Record<string, unknown>
  const headers = (e.headers ?? (e.response as Record<string, unknown> | undefined)?.headers) as
    | Record<string, unknown>
    | undefined
  if (!headers || typeof headers !== 'object') return undefined
  const raw =
    headers['retry-after'] ??
    headers['Retry-After'] ??
    (typeof (headers as { get?: (k: string) => unknown }).get === 'function'
      ? (headers as { get: (k: string) => unknown }).get('retry-after')
      : undefined)
  if (raw == null) return undefined
  const sec = Number(raw)
  if (Number.isFinite(sec) && sec >= 0) return Math.min(30_000, Math.floor(sec * 1000))
  return undefined
}

export type LlmRateLimitRetryOptions = {
  /** 含首次调用，默认 3（即最多再退避重试 2 次） */
  maxAttempts?: number
  baseDelayMs?: number
}

export async function withLlmRateLimitRetry<T>(
  fn: () => Promise<T>,
  options?: LlmRateLimitRetryOptions
): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(options?.maxAttempts ?? 3)))
  const baseDelayMs = Math.max(100, Math.min(10_000, Math.floor(options?.baseDelayMs ?? 800)))

  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (!isLlmRateLimitError(e) || attempt >= maxAttempts - 1) throw e
      const retryAfter = readRetryAfterMs(e)
      const delay = retryAfter ?? baseDelayMs * 2 ** attempt
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastErr
}
