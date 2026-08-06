/**
 * 编排 LLM 遇 429 限流：识别正确、不进 JSON repair、退避仅针对限流。
 */
import {
  isLlmRateLimitError,
  withLlmRateLimitRetry
} from '../../../server/utils/chat/llmRateLimit'
import { resolveTaskOrchestrationByLlm } from '../../../server/graph/llm/taskOrchestrator/resolve'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

// --- isLlmRateLimitError ---
assert(isLlmRateLimitError({ status: 429, message: 'x' }), 'status 429')
assert(isLlmRateLimitError(Object.assign(new Error('rate limit'), { statusCode: 429 })), 'statusCode')
assert(
  isLlmRateLimitError(
    new Error(
      '429 You have exceeded your current request limit. For details, see: https://help.aliyun.com/zh/model-studio/error-code#rate-limit'
    )
  ),
  'aliyun message'
)
assert(isLlmRateLimitError(new Error('Too Many Requests')), 'too many requests')
assert(!isLlmRateLimitError(new Error('invalid json schema')), 'non-rate-limit')
assert(!isLlmRateLimitError({ status: 400, message: 'bad request' }), '400 not rate limit')
console.log('llm-rate-limit ok: classify')

// --- withLlmRateLimitRetry：非限流立即抛；限流退避后成功 ---
{
  let n = 0
  try {
    await withLlmRateLimitRetry(async () => {
      n++
      throw new Error('parse failed')
    }, { maxAttempts: 3, baseDelayMs: 10 })
    assert(false, 'non-rate should throw')
  } catch (e) {
    assert(String(e).includes('parse failed'), 'non-rate message')
    assert(n === 1, 'non-rate no retry')
  }
}
{
  let n = 0
  const out = await withLlmRateLimitRetry(async () => {
    n++
    if (n < 3) {
      const err = new Error('429 rate limit') as Error & { status: number }
      err.status = 429
      throw err
    }
    return 'ok'
  }, { maxAttempts: 3, baseDelayMs: 20 })
  assert(out === 'ok', 'retry then ok')
  assert(n === 3, 'retried twice after first')
}
console.log('llm-rate-limit ok: retry helper')

// --- resolve：始终 429 时不得进入 repair（调用次数 = stage 次数，不含 repair）---
{
  let invokeCount = 0
  const rateErr = Object.assign(
    new Error('429 You have exceeded your current request limit. For details, see: rate-limit'),
    { status: 429 }
  )
  const result = await resolveTaskOrchestrationByLlm({
    messages: [],
    lastUser: '查一下龙奶奶的基本信息和联系方式',
    routingContext: '查一下龙奶奶的基本信息和联系方式',
    llmInvoke: async () => {
      invokeCount++
      throw rateErr
    },
    state: { meta: {}, resources: {} }
  })
  assert(result.bundle === null, 'rate limit → no bundle')
  assert(result.failures.length >= 1, 'has failure')
  assert(
    result.failures.some((f) => isLlmRateLimitError(f.reason) || /429|rate\s*limit/i.test(f.reason)),
    'failure notes rate limit'
  )
  // LLM-First 仅 full；非 First 也可能在第一 stage 就 break，均不应再打 repair
  assert(invokeCount === 1, `rate limit must skip repair (got ${invokeCount} invokes)`)
}
console.log('llm-rate-limit ok: resolve skips repair on 429')
console.log('smoke-llm-rate-limit: PASS')
