/**
 * 只读语义缓存契约：写路径不可缓存（不调 LLM / 无写副作用）。
 */
import { ReadOnlySemanticCache, isWritePathIntent } from '../../../agent-repo-shared/readOnlySemanticCache'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-semantic-cache-readonly] ${msg}`)
}

console.log('smoke-semantic-cache-readonly: start')

assert(isWritePathIntent('write'), 'write intent')
assert(isWritePathIntent('query', 't1') === false, 'read blast')
assert(isWritePathIntent('query', 't2'), 't2 blast')

const cache = new ReadOnlySemanticCache()
const denied = cache.trySet({
  tenantId: 't1',
  query: '查张三血压',
  answer: '120/80',
  intent: 'write'
})
assert(!denied.ok && denied.reason === 'write_path_not_cacheable', 'write denied')

const ok = cache.trySet({
  tenantId: 't1',
  query: '查张三血压',
  answer: '120/80',
  intent: 'query',
  blastRadius: 't0'
})
assert(ok.ok, 'read ok')
const hit = cache.get('t1', '查张三血压')
assert(hit?.answer === '120/80', 'cache hit')

const miss = cache.get('t2', '查张三血压')
assert(!miss, 'tenant isolated')

console.log('smoke-semantic-cache-readonly: OK')
