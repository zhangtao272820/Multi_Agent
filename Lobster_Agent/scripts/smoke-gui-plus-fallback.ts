/**
 * gui-plus fallback 纯函数 smoke（无网络）
 */
import assert from 'node:assert/strict'
import {
  mapNormCoordToViewport,
  parseGuiPlusToolCall,
  resolveGuiPlusMaxSteps,
  shouldAttemptGuiPlusFallback,
} from '../server/services/lobsterGuiPlusFallback'

assert.equal(resolveGuiPlusMaxSteps({ LOBSTER_GUI_PLUS_MAX_STEPS: '3' } as any), 3)
assert.equal(resolveGuiPlusMaxSteps({ LOBSTER_GUI_PLUS_MAX_STEPS: '99' } as any), 4)

assert.equal(
  shouldAttemptGuiPlusFallback({ verifyOk: false, failureType: 'navigation_unverified' }),
  true,
)
assert.equal(
  shouldAttemptGuiPlusFallback({ verifyOk: false, failureType: 'element_not_found' }),
  true,
)
assert.equal(
  shouldAttemptGuiPlusFallback({ verifyOk: false, failureType: 'incomplete_task_output' }),
  false,
  'narrow: incomplete alone does not burn gui-plus',
)
assert.equal(shouldAttemptGuiPlusFallback({ verifyOk: true }), false)
assert.equal(
  shouldAttemptGuiPlusFallback({ verifyOk: false, failureType: 'captcha' }),
  false,
)
assert.equal(
  shouldAttemptGuiPlusFallback({ verifyOk: false, failureType: 'network' }),
  false,
  'network must not burn gui-plus',
)
assert.equal(
  shouldAttemptGuiPlusFallback({ verifyOk: false, failureType: 'network_unreachable' }),
  false,
  'network_unreachable must not burn gui-plus',
)
assert.equal(
  shouldAttemptGuiPlusFallback({
    verifyOk: false,
    failureType: 'navigation_unverified',
    taskKind: 'form_fill',
  }),
  false,
  'form_fill must use DOM fill, not gui-plus',
)
assert.equal(
  shouldAttemptGuiPlusFallback({
    verifyOk: false,
    failureType: 'login_wall',
    taskKind: 'login',
  }),
  false,
  'login must not burn gui-plus',
)
assert.equal(
  shouldAttemptGuiPlusFallback({
    verifyOk: false,
    failureType: 'navigation_unverified',
    taskKind: 'login',
  }),
  false,
  'login task_kind blocks gui-plus',
)
assert.equal(
  shouldAttemptGuiPlusFallback({
    verifyOk: false,
    failureType: 'navigation_unverified',
    formFilledCount: 2,
  }),
  false,
  'already filled fields → no gui-plus overwrite',
)
assert.equal(
  shouldAttemptGuiPlusFallback({
    verifyOk: false,
    failureType: 'no_effect',
    env: { LOBSTER_GUI_PLUS_FALLBACK: '0' } as any,
  }),
  false,
)

const mapped = mapNormCoordToViewport(500, 250, 1280, 720)
assert.equal(mapped.x, 640)
assert.equal(mapped.y, 180)

const parsed = parseGuiPlusToolCall(`<tool_call>
{"name":"computer_use","arguments":{"action":"left_click","coordinate":[100,200]}}
</tool_call>`)
assert.ok(parsed)
assert.equal(parsed!.action, 'left_click')
assert.deepEqual(parsed!.coordinate, [100, 200])

const term = parseGuiPlusToolCall(
  '```json\n{"name":"computer_use","arguments":{"action":"terminate","status":"success","text":"Hello"}}\n```',
)
assert.equal(term?.action, 'terminate')
assert.equal(term?.status, 'success')

console.log('smoke-gui-plus-fallback: PASS')
