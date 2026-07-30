/**
 * 多源管线不得把 clean 机械堆砌当 Code 确定性结果（须走 Code Agent 对照/计算）。
 */
import {
  isMultiSourceDataPipeline,
  tryDeterministicCodeFromDbResults,
  tryDeterministicStructuralCode
} from '#agent-shared/dbPipelineDeterministic'
import { extractStructuredPayload } from '../../../server/graph/core/shared'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const multi = {
  db: JSON.stringify({
    answer: 'db',
    facts: [
      { key: '创建人', value: '1' },
      { key: '足底压力', value: 17.8 }
    ]
  }),
  crawler: JSON.stringify({
    answer: 'web',
    facts: [
      { key: '参考区间下限', value: 10 },
      { key: '参考区间上限', value: 25 }
    ]
  }),
  clean: JSON.stringify({
    answer: '已机械合并 2 个数据源（4 项事实）。',
    sources: [{ agent: 'db' }, { agent: 'crawler' }],
    facts: [
      { key: '创建人', value: '1', source: 'db.创建人' },
      { key: '足底压力', value: 17.8, source: 'db.足底压力' },
      { key: '参考区间下限', value: 10, source: 'crawler.参考区间下限' },
      { key: '参考区间上限', value: 25, source: 'crawler.参考区间上限' }
    ],
    data: { mode: 'multi_source_structural' }
  })
}

assert(isMultiSourceDataPipeline(multi), 'db+crawler is multi-source')
assert(tryDeterministicCodeFromDbResults(multi, extractStructuredPayload) === null, 'no db-primary det')
assert(tryDeterministicStructuralCode(multi, extractStructuredPayload) === null, 'no structural passthrough on multi-source')

const single = {
  db: JSON.stringify({
    answer: 'only db',
    facts: [
      { key: 'a', value: 1 },
      { key: 'b', value: 2 }
    ]
  })
}
assert(!isMultiSourceDataPipeline(single), 'db-only')
assert(Boolean(tryDeterministicStructuralCode(single, extractStructuredPayload)), 'single-source may stay deterministic')

console.log('smoke-code-multi-source-no-passthrough ok')
