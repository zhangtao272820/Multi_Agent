/**
 * Docker 重建后 PG / 鉴权短暂不可用时，有用/无用回灌常一次失败后不再重试，
 * 表现为「须退出再登录才恢复」。此处对 hydrate 结果做有限退避重试；
 * 焦点页签无 visibility 事件时用 dirty watch 定时补灌。
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

export type FeedbackHydrateWatchOptions = {
  /** 轮询间隔 ms，默认 12000 */
  intervalMs?: number
  /** 最长补灌窗口 ms，默认 180000（3 分钟） */
  maxMs?: number
  /** 有历史轮次时 empty 视为仍 dirty；默认 true */
  retryEmpty?: boolean
  /** 是否可见；默认读 document.visibilityState */
  isVisible?: () => boolean
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  now?: () => number
}

export function isFeedbackHydrateDirty(
  status: FeedbackHydrateStatus,
  opts?: { retryEmpty?: boolean }
): boolean {
  return shouldRetryFeedbackHydrate(status, opts)
}

/**
 * 焦点页签 Docker 重建时常无 visibility/online 事件：在 dirty 时定时再灌，直到 ok 或超时。
 * 返回 stop()；调用方在 unmount / 换会话时须 stop。
 */
export function watchFeedbackHydrateUntilOk(
  run: () => Promise<FeedbackHydrateStatus>,
  opts: FeedbackHydrateWatchOptions = {}
): { stop: () => void; kick: () => void } {
  const intervalMs = Math.max(50, Math.floor(opts.intervalMs ?? 12000))
  const maxMs = Math.max(intervalMs, Math.floor(opts.maxMs ?? 180_000))
  const retryEmpty = opts.retryEmpty !== false
  const isVisible =
    opts.isVisible ??
    (() => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'))
  const setInt = opts.setIntervalFn ?? setInterval
  const clearInt = opts.clearIntervalFn ?? clearInterval
  const now = opts.now ?? (() => Date.now())

  let timer: ReturnType<typeof setInterval> | null = null
  let startedAt = 0
  let inFlight = false
  let stopped = false

  const stop = () => {
    stopped = true
    if (timer != null) {
      clearInt(timer)
      timer = null
    }
  }

  const tick = () => {
    if (stopped || inFlight) return
    if (!isVisible()) return
    if (startedAt && now() - startedAt >= maxMs) {
      stop()
      return
    }
    inFlight = true
    void Promise.resolve()
      .then(() => run())
      .then((status) => {
        if (stopped) return
        if (!isFeedbackHydrateDirty(status, { retryEmpty })) {
          stop()
        }
      })
      .catch(() => {
        /* keep watching until maxMs */
      })
      .finally(() => {
        inFlight = false
      })
  }

  const kick = () => {
    if (stopped) {
      stopped = false
    }
    if (!startedAt) startedAt = now()
    if (timer == null) {
      timer = setInt(tick, intervalMs)
    }
    tick()
  }

  return { stop, kick }
}

/**
 * 先跑有限退避重试；若仍 dirty 则启动 watch。返回最终 status 与 stopWatch。
 */
export async function retryFeedbackHydrateThenWatch(
  run: () => Promise<FeedbackHydrateStatus>,
  opts: FeedbackHydrateRetryOptions & FeedbackHydrateWatchOptions = {}
): Promise<{ status: FeedbackHydrateStatus; stopWatch: () => void }> {
  const status = await retryFeedbackHydrate(run, opts)
  if (!isFeedbackHydrateDirty(status, { retryEmpty: opts.retryEmpty })) {
    return { status, stopWatch: () => {} }
  }
  const { stop, kick } = watchFeedbackHydrateUntilOk(run, opts)
  kick()
  return { status, stopWatch: stop }
}
