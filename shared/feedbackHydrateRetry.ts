/**
 * Docker 重建后 PG / 鉴权短暂不可用时，有用/无用回灌常一次失败后不再重试，
 * 表现为「须退出再登录才恢复」。此处对 hydrate 结果做有限退避重试。
 */

export type FeedbackHydrateStatus = 'ok' | 'empty' | 'auth' | 'error'

export type FeedbackHydrateRetryOptions = {
  /** 最大尝试次数（含首次），默认 10（覆盖更长 Docker 暖机） */
  attempts?: number
  /** 首次退避 ms，默认 500 */
  baseDelayMs?: number
  /** 最大退避 ms，默认 5000 */
  maxDelayMs?: number
  /**
   * empty 是否重试。Docker 暖机时 list 可能暂时空；
   * 无历史轮次时应传 false，避免无意义等待。默认 true。
   */
  retryEmpty?: boolean
  sleep?: (ms: number) => Promise<void>
}

/** 有历史轮次时推荐参数（暖机假空 + 鉴权抖动） */
export const FEEDBACK_HYDRATE_WARM_OPTS: FeedbackHydrateRetryOptions = {
  attempts: 10,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  retryEmpty: true
}

/** 无历史轮次时较短窗口 */
export const FEEDBACK_HYDRATE_COLD_OPTS: FeedbackHydrateRetryOptions = {
  attempts: 5,
  baseDelayMs: 400,
  maxDelayMs: 2500,
  retryEmpty: false
}

export function shouldRetryFeedbackHydrate(
  status: FeedbackHydrateStatus,
  opts?: { retryEmpty?: boolean }
): boolean {
  if (status === 'ok') return false
  if (status === 'auth' || status === 'error') return true
  if (status === 'empty') return opts?.retryEmpty !== false
  return false
}

export async function retryFeedbackHydrate(
  run: () => Promise<FeedbackHydrateStatus>,
  opts: FeedbackHydrateRetryOptions = {}
): Promise<FeedbackHydrateStatus> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 10))
  const base = Math.max(50, Math.floor(opts.baseDelayMs ?? 500))
  const maxDelay = Math.max(base, Math.floor(opts.maxDelayMs ?? 5000))
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last: FeedbackHydrateStatus = 'error'
  for (let i = 0; i < attempts; i++) {
    last = await run()
    if (!shouldRetryFeedbackHydrate(last, { retryEmpty: opts.retryEmpty })) return last
    if (i + 1 >= attempts) break
    const delay = Math.min(maxDelay, Math.round(base * Math.pow(1.5, i)))
    await sleep(delay)
  }
  return last
}
