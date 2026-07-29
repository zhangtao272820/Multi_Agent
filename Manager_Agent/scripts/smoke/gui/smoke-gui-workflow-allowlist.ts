/**
 * GUI workflow 白名单：未知宏丢弃；已知 httpbin-form-fill 保留
 */
import assert from 'node:assert/strict'
import {
  BUILTIN_GUI_WORKFLOW_IDS,
  isKnownGuiWorkflowId,
  listKnownGuiWorkflowIds,
  resolveGuiWorkflowForTaskKind,
  sanitizeGuiWorkflowId,
} from '../../../server/utils/gui/guiWorkflowAllowlist'
import { guiOperateKindFromMeta } from '../../../server/utils/gui/guiOperateKindLlm'
import { isDockerHeadlessMcpGui, resolveGuiBlockedErrorCode } from '../../../server/utils/gui/guiHumanConfirm'

assert.ok(BUILTIN_GUI_WORKFLOW_IDS.includes('httpbin-form-fill'))
assert.ok(listKnownGuiWorkflowIds().includes('httpbin-form-fill'))
assert.equal(sanitizeGuiWorkflowId('httpbin-form-fill').ok, true)
assert.equal((sanitizeGuiWorkflowId('httpbin-form-fill') as { ok: true; id: string }).id, 'httpbin-form-fill')

const dropped = sanitizeGuiWorkflowId('navigate-and-extract-title')
assert.equal(dropped.ok, false)
assert.equal((dropped as { ok: false; dropped: string }).dropped, 'navigate-and-extract-title')
assert.equal(isKnownGuiWorkflowId('navigate-and-extract-title'), false)

const fakeMeta = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'extract',
    needs_login: false,
    confidence: 0.9,
    rationale: '抽标题',
    workflow_id: 'navigate-and-extract-title',
  },
})
assert.ok(fakeMeta)
assert.equal(fakeMeta?.workflow_id, undefined, 'unknown macro stripped from decision')
assert.equal(fakeMeta?.dropped_workflow_id, 'navigate-and-extract-title')
assert.equal(fakeMeta?.task_kind, 'extract', 'task_kind kept')

const knownMeta = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'form_fill',
    needs_login: false,
    confidence: 0.91,
    rationale: '宏填表',
    workflow_id: 'httpbin-form-fill',
    workflow_args: { customer_name: 'alice' },
  },
})
assert.equal(knownMeta?.workflow_id, 'httpbin-form-fill')
assert.equal(knownMeta?.dropped_workflow_id, undefined)

// browse 类误挂 form 宏 → 丢弃
const mismatchNav = resolveGuiWorkflowForTaskKind('httpbin-form-fill', 'navigate')
assert.equal(mismatchNav.ok, false)
assert.equal((mismatchNav as { ok: false; dropped: string }).dropped, 'httpbin-form-fill')
const mismatchExtract = resolveGuiWorkflowForTaskKind('httpbin-form-fill', 'extract')
assert.equal(mismatchExtract.ok, false)
assert.equal(resolveGuiWorkflowForTaskKind('httpbin-form-fill', 'form_fill').ok, true)

const navMeta = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'navigate',
    needs_login: false,
    confidence: 0.95,
    rationale: '打开 runoob',
    workflow_id: 'httpbin-form-fill',
  },
})
assert.equal(navMeta?.workflow_id, undefined, 'navigate must drop httpbin-form-fill')
assert.equal(navMeta?.dropped_workflow_id, 'httpbin-form-fill')
assert.equal(navMeta?.task_kind, 'navigate')

const envAllow = {
  MANAGER_GUI_WORKFLOW_ALLOWLIST: 'custom-macro-a, other-b',
} as NodeJS.ProcessEnv
assert.ok(isKnownGuiWorkflowId('custom-macro-a', envAllow))
assert.ok(isKnownGuiWorkflowId('httpbin-form-fill', envAllow))

assert.equal(isDockerHeadlessMcpGui({ MANAGER_GUI_MCP_FIRST: '1' } as NodeJS.ProcessEnv), true)
assert.equal(isDockerHeadlessMcpGui({ MANAGER_GUI_MCP_FIRST: '0' } as NodeJS.ProcessEnv), false)

assert.equal(resolveGuiBlockedErrorCode('empty_result'), 'incomplete_task_output')
assert.equal(resolveGuiBlockedErrorCode('need_human'), 'need_human')
assert.equal(resolveGuiBlockedErrorCode('captcha'), 'captcha')
assert.equal(resolveGuiBlockedErrorCode(''), 'task_blocked')
assert.equal(resolveGuiBlockedErrorCode('navigation_unverified'), 'navigation_unverified')

console.log('smoke: gui workflow allowlist ok')
