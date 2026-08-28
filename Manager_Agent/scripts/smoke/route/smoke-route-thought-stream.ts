/**
 * 契约：路由流式思考 chunk 解析与过滤（无 LLM）
 */
import assert from 'node:assert/strict'
import {
  buildRouteThoughtHeartbeats,
  extractContentFromStreamChunk,
  extractReasoningFromStreamChunk,
  isManagerRouteThoughtStreamEnabled,
  sanitizeRouteThoughtForUser
} from '../../../server/utils/chat/routeThoughtStream'

assert.equal(isManagerRouteThoughtStreamEnabled({ MANAGER_ROUTE_THOUGHT_STREAM: '1' } as NodeJS.ProcessEnv), true)
assert.equal(isManagerRouteThoughtStreamEnabled({ MANAGER_ROUTE_THOUGHT_STREAM: '0' } as NodeJS.ProcessEnv), false)

assert.equal(
  extractReasoningFromStreamChunk({ additional_kwargs: { reasoning_content: '先看 RAG' } }),
  '先看 RAG'
)
assert.equal(extractContentFromStreamChunk({ content: '{"intent"' }), '{"intent"')
assert.equal(sanitizeRouteThoughtForUser('{"allowedAgents":[]}'), '')
assert.equal(sanitizeRouteThoughtForUser('用户问的是护理规范'), '用户问的是护理规范')

const beats = buildRouteThoughtHeartbeats('编排')
assert(beats.length >= 3, 'heartbeats')
assert(beats[0]!.includes('编排'), 'label in heartbeat')

console.log('smoke-route-thought-stream: ok')
