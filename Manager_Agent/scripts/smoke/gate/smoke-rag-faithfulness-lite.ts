/**
 * RAG 引用忠实度轻量契约（规则重叠，不调 LLM / 不调 RAG）。
 */
import {
  RAG_FAITHFULNESS_LITE_THRESHOLD,
  scoreRagFaithfulnessLite
} from '../../../agent-repo-shared/ragFaithfulnessLite'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-rag-faithfulness-lite] ${msg}`)
}

console.log('smoke-rag-faithfulness-lite: start')

const good = scoreRagFaithfulnessLite(
  '探视制度下午14点至16点开放探视。',
  ['探视制度：下午14:00-16:00为探视时段。', '护理员配比按失能等级划分。']
)
assert(good.matched >= 1, 'good answer should match evidence chunk')
assert(good.pass === good.score >= RAG_FAITHFULNESS_LITE_THRESHOLD, 'pass aligns threshold')

const bad = scoreRagFaithfulnessLite('今天天气不错。', ['探视制度：下午14:00-16:00为探视时段。'])
assert(!bad.pass, 'unrelated answer should fail')
assert(bad.score < RAG_FAITHFULNESS_LITE_THRESHOLD, 'low score')

const empty = scoreRagFaithfulnessLite('任意回答', [])
assert(!empty.pass && empty.total === 0, 'empty evidence fails closed')

console.log('smoke-rag-faithfulness-lite: OK')
