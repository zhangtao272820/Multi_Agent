/**
 * smoke: resolveUserMessageAnchor — index miss + text fallback
 * run: npx tsx scripts/smoke/session/smoke-user-message-anchor.ts
 */
import assert from 'node:assert/strict'
import {
  normalizeUserAnchorText,
  resolveUserMessageAnchor,
  resolveUserMessageSessionIndex
} from '../../../server/api/manager-ws/wsSessionHelpers'

const messages = [
  { role: 'user' as const, content: '第一问' },
  { role: 'assistant' as const, content: '答1' },
  { role: 'user' as const, content: '查询林婉清足底\n[附件: a.png]' },
  { role: 'assistant' as const, content: '答2' },
  { role: 'user' as const, content: '第三问' },
  { role: 'assistant' as const, content: '答3' }
]

assert.equal(resolveUserMessageSessionIndex(messages, 1), 2)
assert.equal(resolveUserMessageSessionIndex(messages, 9), -1)

const byWrongIndex = resolveUserMessageAnchor(messages, {
  userMessageIndex: 9,
  text: '查询林婉清足底'
})
assert.ok(byWrongIndex)
assert.equal(byWrongIndex!.arrayIndex, 2)
assert.equal(byWrongIndex!.userMessageIndex, 1)

const byTextOnly = resolveUserMessageAnchor(messages, { text: '第三问' })
assert.ok(byTextOnly)
assert.equal(byTextOnly!.userMessageIndex, 2)

assert.equal(normalizeUserAnchorText('hello\n[附件: x]'), 'hello')

const miss = resolveUserMessageAnchor(messages, { userMessageIndex: 99, text: '不存在' })
assert.equal(miss, null)

console.log('smoke-user-message-anchor: ok')
