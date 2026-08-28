/**
 * RAG 经验 path 冲突仲裁 — 纯函数 smoke（不调 LLM / 不连 PG）
 */
import {
  extractRagExperiencePathKey,
  resolveRagExperiencePathConflicts,
} from '../server/utils/ragExperiencePathConflict'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-rag-experience-path-conflict] ${msg}`)
}

assert(
  extractRagExperiencePathKey('路径=hybrid_rrf；来源：制度A') === 'hybrid_rrf',
  'extract path from hint'
)

const resolved = resolveRagExperiencePathConflicts([
  {
    question: '护理员配比标准是什么',
    hint: '路径=keyword_only；结果摘要=旧',
    sources: ['doc-a'],
    score: 0.72,
  },
  {
    question: '护理员配比标准是什么',
    hint: '路径=hybrid_rrf；结果摘要=新',
    sources: ['doc-b'],
    score: 0.81,
  },
  {
    question: '护理员配比标准是什么',
    hint: '路径=hybrid_rrf；结果摘要=同 path 较低分',
    sources: ['doc-c'],
    score: 0.7,
  },
])

assert(resolved.length === 1, `expected 1 after conflict, got ${resolved.length}`)
assert(resolved[0]?.hint.includes('hybrid_rrf'), 'higher-score path wins across conflicting paths')
assert(resolved[0]?.score === 0.81, 'kept best score among winning path')

console.log('smoke-rag-experience-path-conflict: OK')
