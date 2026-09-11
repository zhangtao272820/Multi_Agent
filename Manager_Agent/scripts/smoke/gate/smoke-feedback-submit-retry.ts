/**
 * 契约：有用/无用提交失败不得锁死按钮（失败 ack 须可识别，且不得持久化）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FEEDBACK_FAIL_ACK,
  FEEDBACK_PENDING_ACK,
  clearStaleFeedbackPendingAcks,
  isFeedbackFailAck,
  stripFeedbackFailAcks
} from '#agent-shared/feedbackSubmitUi'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

assert.equal(FEEDBACK_FAIL_ACK, '反馈提交失败，请重试')
assert.equal(FEEDBACK_PENDING_ACK, '提交中…')
assert.ok(isFeedbackFailAck(FEEDBACK_FAIL_ACK))
assert.ok(!isFeedbackFailAck('已标记为有用 · 感谢反馈'))

const scores: Record<string, number> = {}
const acks: Record<string, string> = { 'umidx:1': FEEDBACK_FAIL_ACK, 'umidx:2': '已标记为有用' }
const stripped = stripFeedbackFailAcks(scores, acks)
assert.ok(!stripped['umidx:1'], 'fail ack without score must strip')
assert.equal(stripped['umidx:2'], '已标记为有用')

const pendingScores: Record<string, 0 | 1> = { k1: 1 }
const pendingAcks: Record<string, string> = { k1: FEEDBACK_PENDING_ACK }
clearStaleFeedbackPendingAcks(pendingScores, pendingAcks)
assert.ok(pendingScores.k1 === undefined)
assert.ok(pendingAcks.k1 === undefined)

const files = [
  'RAG_Agent/app/app.vue',
  'AI_admin_Agent/frontend/src/App.tsx',
  'DB_Agent/app/composables/useDbChatPage.ts',
  'Manager_Agent/app/composables/useManagerSession.ts',
  'Manager_Agent/app/components/chat/ManagerChatThread.vue'
]
for (const rel of files) {
  const src = readFileSync(join(root, rel), 'utf8')
  assert.ok(src.includes('markFeedbackSubmitFailed') || src.includes('retryFeedback'), `${rel} has retry path`)
  assert.ok(
    src.includes('FEEDBACK_FAIL_ACK') || src.includes('反馈提交失败，请重试'),
    `${rel} knows fail ack`
  )
  assert.ok(!/applyTurnFeedback\([^)]*反馈提交失败/.test(src), `${rel} must not lock score on fail via applyTurnFeedback`)
}

console.log('smoke-feedback-submit-retry: ok')
