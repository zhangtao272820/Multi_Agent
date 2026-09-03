/**
 * RAG 经验仅有用：学习信号召回门控 + 向量索引默认要求有用反馈。
 * 纯函数 / 契约，不调 LLM、不写盘。
 */
import assert from 'node:assert/strict'
import { mayUseRagLearningSignalForRecall } from '../utils/learning_signal_store'
import {
  isConfirmedExperienceRow,
  ragVectorExperienceRequireUseful
} from '#agent-shared/experienceRecallPolicy'
import { experienceSyncStatus } from '#agent-shared/experienceBridgeContract'

const envOn = { EXPERIENCE_RECALL_CONFIRMED_ONLY: '1', EXPERIENCE_STANDALONE_EXCLUDE_FEDERATED: '1' } as NodeJS.ProcessEnv
const envOff = { EXPERIENCE_RECALL_CONFIRMED_ONLY: '0' } as NodeJS.ProcessEnv

assert.equal(
  mayUseRagLearningSignalForRecall(
    { question: 'q', score: 1, at: 't', source: 'manager_finalize_sync', source_plane: 'manager_orchestrated' },
    envOn
  ),
  false,
  'finalize sync must not boost prefs'
)

assert.equal(
  mayUseRagLearningSignalForRecall(
    { question: 'q', score: 1, at: 't', source: 'rag_feedback|useful|docA', source_plane: 'standalone' },
    envOn
  ),
  true,
  'useful feedback allowed'
)

assert.equal(
  mayUseRagLearningSignalForRecall(
    { question: 'q', score: -1, at: 't', source: 'rag_feedback|useless|docA', source_plane: 'standalone' },
    envOn
  ),
  true,
  'explicit useless still readable for negative prefs'
)

assert.equal(
  mayUseRagLearningSignalForRecall(
    { question: 'q', score: 1, at: 't', source: 'manager_feedback_confirmed', source_plane: 'manager_orchestrated' },
    envOn
  ),
  false,
  'standalone plane excludes federated even when useful'
)

assert.equal(
  mayUseRagLearningSignalForRecall(
    { question: 'q', score: 1, at: 't', source: 'some_doc.pdf', source_plane: 'standalone' },
    envOff
  ),
  true,
  'when confirmed-only off, score=1 passes'
)

assert.equal(ragVectorExperienceRequireUseful({}), true)
assert.equal(ragVectorExperienceRequireUseful({ RAG_VECTOR_EXPERIENCE_REQUIRE_USEFUL: '0' }), false)

assert.equal(isConfirmedExperienceRow({ source: 'rag_feedback|useful|x' }), true)
assert.equal(experienceSyncStatus({}), 'pending')
assert.equal(experienceSyncStatus({ force: true }), 'confirmed')

console.log('smoke-rag-experience-useful-only: OK')
